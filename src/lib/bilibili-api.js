/**
 * Bilibili public APIs. Replaces yt-dlp for metadata and stream URLs.
 *
 * Two entry points matter:
 *   x/web-interface/view       → title / uploader / description / page cid
 *   x/player/wbi/playurl       → DASH or legacy stream URLs
 *
 * Both need wbi signing; playurl additionally benefits from login cookies.
 */
import { getWbiKeys, signedQuery } from './wbi.js';
import { fetchWithLadder } from './http.js';
import { fail } from './errors.js';
import { pickPage } from './bilibili-page.js';

const API_ORIGIN = 'https://api.bilibili.com';
export const MAX_VIDEO_SECONDS = 5 * 60 * 60;
export const V1_MAX_SECONDS = 60 * 60;

/** Requested quality ordering; the API returns the best it will grant. */
const QN_ORDER = [127, 126, 125, 120, 116, 112, 80, 74, 64, 32, 16];

/**
 * 走 ladder 而不是写死 credentials:'include' —— 带凭证的跨域请求在扩展里
 * 拿不到 CORS 豁免，会直接 TypeError: Failed to fetch（src/lib/http.js 有说明）。
 * @returns {Promise<{response:Response, credentials:string}>}
 */
function jsonGet(url, { headers = {}, fetchFn, signal } = {}) {
  return fetchWithLadder(url, { headers, fetchFn, signal, timeoutMs: 30000 });
}

async function readApi(response, code) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw fail.api(code, `Bilibili 接口返回了非 JSON 响应（HTTP ${response.status}）。`, {
      http_status: response.status,
    });
  }
  if (!response.ok) {
    throw fail.api(code, `Bilibili 接口返回 HTTP ${response.status}。`, {
      http_status: response.status,
    });
  }
  if (payload?.code !== 0) {
    const providerCode = payload?.code;
    const message = payload?.message || '';
    if (providerCode === -404 || providerCode === 62002) {
      throw fail.input('VIDEO_NOT_FOUND', '视频不存在或已被删除。', { provider_code: providerCode });
    }
    if (providerCode === -403 || providerCode === -401) {
      throw fail.api('VIDEO_ACCESS_DENIED', '需要登录或该地区不可访问此视频。', {
        provider_code: providerCode, message,
      });
    }
    if (providerCode === -509) {
      throw fail.api('RATE_LIMITED', '请求过于频繁，请稍后重试。', { provider_code: providerCode });
    }
    throw fail.api(code, `Bilibili 接口错误 ${providerCode}：${message}`, {
      provider_code: providerCode, message,
    });
  }
  return payload.data;
}

/**
 * Video metadata.
 * @returns {{bvid:string, title:string, uploader:string, description:string,
 *            durationMs:number, cid:number, pageNumber:number, pages:Array,
 *            canonicalUrl:string, publishedAt:number|null}}
 */
export async function fetchView({ bvid, pageNumber = 1, fetchFn } = {}) {
  if (!bvid) throw fail.input('URL_INVALID', '缺少 BV 号。');
  const keys = await getWbiKeys({ fetchFn });
  const query = signedQuery({ bvid }, keys);
  let response;
  try {
    ({ response } = await jsonGet(`${API_ORIGIN}/x/web-interface/view?${query}`, { fetchFn }));
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw fail.api('VIDEO_METADATA_UNAVAILABLE', `连不上 Bilibili 视频信息接口（${error?.message || ''}）`, {
      cause: error?.message,
    });
  }
  const data = await readApi(response, 'VIDEO_METADATA_UNAVAILABLE');

  const pages = Array.isArray(data.pages) ? data.pages : [];
  const wanted = Math.max(1, Math.floor(Number(pageNumber) || 1));
  // 按 page 字段找，不要按下标取 —— 分 P 列表可能缺项或乱序。
  const page = pickPage(pages, wanted) || {};
  const index = Number(page.page) || Math.min(wanted, Math.max(1, pages.length));
  const durationMs = Number(page.duration ?? data.duration ?? 0) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw fail.input('VIDEO_DURATION_INVALID', '无法确认视频时长，不能处理此视频。');
  }
  if (pages.length && index !== wanted) {
    // 要的那一 P 不存在（比如链接写 ?p=99）。说清楚，别让人以为拿对了。
    throw fail.input('VIDEO_NOT_FOUND', `这个视频只有 ${pages.length} 个分 P，没有第 ${wanted} 个。`,
      { requested: wanted, available: pages.length });
  }
  return {
    bvid,
    title: String(data.title || bvid).trim() || bvid,
    uploader: String(data.owner?.name || '').trim(),
    description: String(data.desc || '').trim(),
    durationMs,
    cid: Number(page.cid || data.cid || 0),
    pageNumber: index,
    pageCount: pages.length || 1,
    pageTitle: String(page.part || '').trim(),
    pages: pages.map((item) => ({
      page: item.page,
      cid: item.cid,
      part: String(item.part || '').trim(),
      durationMs: Number(item.duration || 0) * 1000,
    })),
    // 分 P 必须写进链接：不写的话「跳回原视频」和历史里存的地址都会回到第 1 个。
    canonicalUrl: `https://www.bilibili.com/video/${bvid}/`
      + (index > 1 ? `?p=${index}` : ''),
    publishedAt: Number.isFinite(Number(data.pubdate)) ? Number(data.pubdate) * 1000 : null,
    pic: data.pic || null,
  };
}

/**
 * Stream URLs. Returns both DASH audio/video candidates and legacy durl entries.
 * The caller picks the audio stream for ASR.
 */
export async function fetchPlayUrl({ bvid, cid, qn = null, fetchFn } = {}) {
  if (!bvid || !cid) throw fail.input('URL_INVALID', '缺少 BV 号或 cid。');
  const keys = await getWbiKeys({ fetchFn });
  const base = {
    bvid,
    cid,
    fnval: 4048, // DASH + HDR + 杜比 + 8K flags; the API degrades gracefully.
    fnver: 0,
    fourk: 1,
    otype: 'json',
    platform: 'pc',
    high_quality: 1,
  };
  let lastError = null;
  const qualityOrder = qn ? [qn] : QN_ORDER;
  for (const quality of qualityOrder) {
    const query = signedQuery({ ...base, qn: quality }, keys);
    let response;
    try {
      response = (await jsonGet(`${API_ORIGIN}/x/player/wbi/playurl?${query}`, { fetchFn })).response;
    } catch (error) {
      lastError = fail.api('STREAM_UNAVAILABLE', '无法连接 Bilibili 播放地址接口。', {
        cause: error?.message,
      });
      break;
    }
    if (response.status === 412) {
      throw fail.api('DOWNLOAD_ERROR', 'Bilibili 拒绝了播放地址请求（HTTP 412），请稍后重试。', {
        http_status: 412,
      });
    }
    let data;
    try {
      data = await readApi(response, 'STREAM_UNAVAILABLE');
    } catch (error) {
      if (error?.diagnostics?.http_status) throw error;
      lastError = error;
      continue;
    }
    const parsed = parseStreams(data);
    if (parsed.audio.length || parsed.video.length || parsed.durl.length) {
      return { ...parsed, quality: data.quality ?? quality, bvid, cid };
    }
  }
  throw lastError || fail.api('STREAM_UNAVAILABLE', '没有可用的播放地址。');
}

function parseStreams(data) {
  const audio = [];
  const video = [];
  const dash = data?.dash || null;
  for (const track of dash?.audio || []) {
    audio.push({
      url: track.baseUrl || track.base_url || '',
      backup: (track.backup_url || []).filter(Boolean),
      bandwidth: Number(track.bandwidth || 0),
      codecs: track.codecs || '',
      mime: track.mime_type || track.mimeType || '',
    });
  }
  for (const track of dash?.video || []) {
    video.push({
      url: track.baseUrl || track.base_url || '',
      backup: (track.backup_url || []).filter(Boolean),
      bandwidth: Number(track.bandwidth || 0),
      width: Number(track.width || 0),
      height: Number(track.height || 0),
      codecs: track.codecs || '',
    });
  }
  audio.sort((a, b) => b.bandwidth - a.bandwidth);
  video.sort((a, b) => b.bandwidth - a.bandwidth);
  const durl = (data?.durl || []).map((item) => ({
    url: item.url || '',
    backup: (item.backup_url || []).filter(Boolean),
    size: Number(item.size || 0),
    lengthMs: Number(item.length || 0),
  }));
  return { audio, video, durl, durationMs: Number(data?.timelength || 0) };
}

/**
 * Duration guard: the Python pipeline allows five hours, the extension caps v1
 * at one hour because there is no ffmpeg to trim or split.
 */
export function checkDuration(durationMs, { allowLong = false } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw fail.input('VIDEO_DURATION_INVALID', '无法确认视频时长，不能处理此视频。');
  }
  if (durationMs > MAX_VIDEO_SECONDS * 1000) {
    throw fail.input('VIDEO_TOO_LONG', '单个视频最长支持 5 小时。');
  }
  if (!allowLong && durationMs > V1_MAX_SECONDS * 1000) {
    throw fail.input(
      'VIDEO_TOO_LONG',
      '当前版本插件只处理 60 分钟以内的视频；更长的视频请用命令行版本。',
      { duration_seconds: Math.round(durationMs / 1000) },
    );
  }
  return durationMs;
}
