/**
 * Input stages: metadata → audio → ASR → transcript.
 * Everything that needs the network lives here so the orchestrator stays a
 * sequence of durable checkpoints.
 */
import * as db from '../lib/db.js';
import * as opfs from '../lib/opfs.js';
import { trace, span } from '../lib/log.js';
import { fail, asRunError } from '../lib/errors.js';
import { parseBilibiliUrl, attributionFor } from '../lib/url.js';
import { fetchView, fetchPlayUrl, checkDuration } from '../lib/bilibili-api.js';
import { downloadFirstAvailable, opfsFile } from '../lib/audio-download.js';
import { normalizeAsrSegments } from '../lib/asr-normalize.js';
import { unitsFromSegments, buildTranscript, parseTranscript } from '../lib/transcript.js';
import { transcribeFile, AsrTaskSubmitted } from '../lib/dashscope.js';
import { send } from '../lib/bus.js';
import { MSG } from '../lib/protocol.js';

export const AUDIO_NAME = 'audio.m4a';

/* ---------------- metadata ---------------- */

/**
 * @returns {{meta:object, streams:object|null, source:string}}
 */
export async function resolveMetadata(runId, input, settings, signal) {
  if (input.transcriptText) {
    return { meta: null, streams: null, source: 'paste' };
  }

  // A probe taken from an open tab already carries title/streams; trust it.
  if (input.probe?.video?.bvid && input.probe?.video?.cid) {
    const video = input.probe.video;
    checkDuration(video.durationMs || 0, { allowLong: settings.ingest.truncateTo60Min });
    const meta = {
      bvid: video.bvid,
      cid: video.cid,
      pageNumber: video.pageNumber || 1,
      pageCount: video.pageCount || 1,
      pageTitle: String(video.pageTitle || '').trim(),
      title: video.title || video.bvid,
      uploader: video.uploader || '',
      description: video.description || '',
      durationMs: video.durationMs || 0,
      canonicalUrl: input.source?.canonicalUrl || `https://www.bilibili.com/video/${video.bvid}/`,
      videoId: input.source?.videoId || `bilibili-${video.bvid}-p${video.pageNumber || 1}`,
    };
    // 页面探测不一定带得出现成的流（页面切分 P 时 __playinfo__ 可能是旧的，
    // 后台会把它判成 streamsStale 并置空）。这时候按 cid 重新问接口要，
    // 别直接报「没有可用的音频流」。
    let streams = input.probe?.streams || null;
    if (!streams) {
      streams = await span(runId, 'playurl', () => fetchPlayUrl({
        bvid: meta.bvid, cid: meta.cid,
      })).catch((error) => {
        trace.warn(runId, 'playurl', '播放地址不可用', { message: error?.message });
        return null;
      });
    }
    return { meta, streams, source: 'page' };
  }

  const source = await parseBilibiliUrl(input.url);
  const video = await span(runId, 'metadata', () => fetchView({
    bvid: source.bvid, pageNumber: source.pageNumber,
  }));
  checkDuration(video.durationMs, { allowLong: settings.ingest.truncateTo60Min });

  const meta = {
    bvid: video.bvid,
    cid: video.cid,
    pageNumber: video.pageNumber,
    pageCount: video.pageCount || 1,
    pageTitle: video.pageTitle || '',
    title: video.title,
    uploader: video.uploader,
    description: video.description,
    durationMs: video.durationMs,
    canonicalUrl: source.canonicalUrl,
    videoId: source.videoId,
  };
  let streams = null;
  try {
    streams = await span(runId, 'playurl', () => fetchPlayUrl({ bvid: video.bvid, cid: video.cid }));
  } catch (error) {
    trace.warn(runId, 'playurl', '播放地址不可用', { message: error?.message });
  }
  return { meta, streams, source: 'api' };
}

/* ---------------- audio ---------------- */

function audioCandidates(streams) {
  if (!streams) return [];
  const raw = [];
  for (const track of streams.audio || []) raw.push(track.url, ...(track.backup || []));
  for (const item of streams.durl || []) raw.push(item.url, ...(item.backup || []));
  // http:// 的下载地址在 https 页面上会被当混合内容拦掉，先试 https 版本。
  const urls = [];
  for (const url of raw.filter(Boolean)) {
    if (url.startsWith('http://')) urls.push(`https://${url.slice(7)}`);
    urls.push(url);
  }
  return urls;
}

/**
 * Download the audio track. Direct fetch first (with the injected Referer);
 * if the CDN refuses, fall back to fetching through an open Bilibili tab.
 */
export async function obtainAudio(runId, meta, streams, settings, signal, onProgress) {
  const candidates = audioCandidates(streams);
  if (!candidates.length) {
    throw fail.api('STREAM_UNAVAILABLE', '没有可用的音频流，可能需要登录或该视频不支持。');
  }

  try {
    return await span(runId, 'download', () => downloadFirstAvailable({
      runId,
      name: AUDIO_NAME,
      candidates,
      headers: { Accept: '*/*' },
      maxBytes: settings.asr.maxAudioBytes,
      signal,
      onProgress,
    }));
  } catch (error) {
    if (error?.code === 'RUN_CANCELLED' || error?.code === 'AUDIO_TOO_LARGE') throw error;
    trace.warn(runId, 'download', '直连下载失败，改用页面下载', { message: error?.message });
    // 备用地址一并交给页面去试：CDN 节点会挑 Referer，单个地址常有一半概率 403。
    return viaTab(runId, candidates, { videoUrl: meta?.canonicalUrl || '', onProgress });
  }
}

/** Ask the background to pull the file through a tab; chunks arrive by message. */
async function viaTab(runId, urls, { videoUrl = '', onProgress } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const chunks = [];
  const collector = (message) => {
    if (message?.type !== MSG.AUDIO_CHUNK || message.payload?.runId !== runId) return;
    chunks.push(message.payload.chunk);
  };
  chrome.runtime.onMessage.addListener(collector);
  try {
    const result = await send(MSG.AUDIO_FETCH, {
      runId, url: list[0], urls: list.slice(0, 6), videoUrl,
    });
    await opfs.appendChunks(runId, AUDIO_NAME, chunks);
    onProgress?.({ received: result?.bytes || 0, total: result?.bytes || 0 });
    return { bytes: result?.bytes || 0, contentType: result?.contentType || '', via: 'tab' };
  } finally {
    chrome.runtime.onMessage.removeListener(collector);
  }
}

/* ---------------- transcript ---------------- */

export function transcriptFromPaste(runId, input) {
  const parsed = parseTranscript(input.transcriptText);
  if (!parsed.units.length) {
    throw fail.input('TRANSCRIPT_EMPTY', '没有解析出任何来源单元，请检查转写格式。');
  }
  const durationMs = parsed.units.at(-1)?.endMs || 0;
  const title = input.title || parsed.title || '粘贴的转写';
  const attribution = input.attribution || parsed.attribution || '';
  return {
    units: parsed.units,
    title,
    attribution,
    durationMs,
    description: input.description || '',
    source: 'paste',
    text: buildTranscript({ title, attribution, units: parsed.units }),
  };
}

export async function transcribeAudio(runId, meta, settings, signal, onProgress) {
  const file = await opfsFile(runId, AUDIO_NAME, `${meta?.bvid || 'audio'}.m4a`);
  const checkpoint = (await db.get(db.STORE.ASR, runId)) || null;
  const asrCheckpoint = checkpoint?.taskId
    ? { taskId: checkpoint.taskId, objectKey: checkpoint.objectKey }
    : null;

  const result = await span(runId, 'asr', () => transcribeFile({
    baseUrl: settings.asr.baseUrl,
    apiKey: settings.asr.apiKey,
    model: settings.asr.model,
    blob: file,
    filename: file.name,
    pollSeconds: settings.asr.pollSeconds,
    maxWaitSeconds: settings.asr.maxWaitSeconds,
    checkpoint: asrCheckpoint,
    onProgress,
  }));

  await db.put(db.STORE.ASR, {
    runId,
    taskId: result.taskId,
    objectKey: result.objectKey,
    model: settings.asr.model,
    rows: result.rows,
    savedAt: Date.now(),
  });

  const normalized = normalizeAsrSegments(result.rows);
  if (!normalized.segments.length) {
    throw fail.api('ASR_EMPTY', '语音识别没有返回任何片段。');
  }
  return { segments: normalized.segments, dropped: normalized.dropped, asr: result };
}

/**
 * @returns {{units:Array, title:string, attribution:string, durationMs:number,
 *            description:string, source:string, text:string}}
 */
export async function buildTranscriptFor(runId, input, settings, signal, onProgress = () => {}) {
  if (input.transcriptText) return transcriptFromPaste(runId, input);

  const { meta, streams } = await resolveMetadata(runId, input, settings, signal);
  await db.updateRun(runId, {
    title: meta.title,
    bvid: meta.bvid,
    pageNumber: meta.pageNumber,
    pageCount: meta.pageCount,
    pageTitle: meta.pageTitle,
    videoId: meta.videoId,
    durationMs: meta.durationMs,
    description: meta.description,
    uploader: meta.uploader,
    canonicalUrl: meta.canonicalUrl,
  });

  await obtainAudio(runId, meta, streams, settings, signal, (progress) => onProgress({
    stage: 'download', ...progress,
  }));

  const { segments } = await transcribeAudio(runId, meta, settings, signal, (progress) => onProgress({
    stage: 'asr', ...progress,
  }));

  const units = unitsFromSegments(segments);
  const title = meta.title;
  const attribution = attributionFor(meta.uploader, meta.title, meta.canonicalUrl);
  const durationMs = Math.max(meta.durationMs || 0, units.at(-1)?.endMs || 0);
  return {
    units,
    title,
    attribution,
    durationMs,
    description: meta.description || '',
    source: 'asr',
    text: buildTranscript({ title, attribution, units }),
  };
}

export { asRunError, AsrTaskSubmitted };
