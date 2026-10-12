/**
 * Service worker. Keeps the offscreen worker alive, answers UI requests, and
 * owns every API that only exists here (tabs, cookies, downloads, windows).
 */
import { MSG, STATE, ACTIVE_STATES } from '../lib/protocol.js';
import { createRouter, install } from './router.js';
import { loadSettings, patchSettings } from '../lib/settings.js';
import { validateSettings } from '../lib/validate-settings.js';
import { probe } from '../lib/llm.js';
import * as db from '../lib/db.js';
import { log } from '../lib/log.js';
import { asRunError, fail } from '../lib/errors.js';
import { parseBilibiliUrl, watchUrl } from '../lib/url.js';
import { probeMatches } from '../lib/bilibili-page.js';
import { bilibiliCookies, cookieHeader } from '../lib/cookies.js';
import { ensureOffscreen, runTask, closeOffscreen, recreateOffscreen } from './offscreen-host.js';
import { ensureAlarm, onAlarm, sweep } from './supervisor.js';
import { installRules } from './dnr.js';
import { requestOrigins } from './permissions.js';
import { probeTab, probeActiveTab, activeTab } from './probe.js';
import {
  fetchViaTab, ensureBilibiliTab, releaseBilibiliTab, referrersFor,
} from './tab-fetch.js';
import { captureReport } from './capture.js';
import { broadcast } from '../lib/bus.js';
import { recordError } from '../lib/diag.js';
import { runSelfTest } from './selftest.js';
import { openMini, closeMini, installMiniTracker } from './mini.js';

const router = createRouter();

/* ---------------- lifecycle ---------------- */

installMiniTracker();

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await installRules();
  await patchSettings({});
  // 旧 offscreen 文档会带着旧模块图活下来，安装/更新时先把它关掉。
  await closeOffscreen().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await installRules();
  await closeOffscreen().catch(() => {});
});

onAlarm(async () => {
  await sweep({
    listActiveRuns: async () => {
      const runs = await db.listRuns();
      return runs.filter((run) => ACTIVE_STATES.includes(run.state));
    },
    resumeRun: async (runId) => {
      await db.updateRun(runId, { resumeAttempts: ((await db.get(db.STORE.RUNS, runId))?.resumeAttempts || 0) + 1 });
      // 超时的任务多半死在旧文档里，恢复前同样换一个新 offscreen。
      await recreateOffscreen().catch(() => {});
      await runTask({ kind: 'run', runId, resumed: true, settings: await loadSettings() });
    },
    failRun: async (runId, code, message) => {
      await db.updateRun(runId, {
        state: STATE.FAILED,
        message,
        finishedAt: Date.now(),
        error: { category: 'EXECUTION_TIMEOUT', code, message },
      });
      broadcast(MSG.RUN_EVENT, { runId, state: STATE.FAILED, message });
    },
  });
});

/* ---------------- handlers ---------------- */

router.on(MSG.PING, async () => ({ ok: true, version: chrome.runtime.getManifest().version }));

router.on(MSG.ENSURE_OFFSCREEN, async () => {
  await ensureOffscreen();
  return { ok: true };
});

// 浮层：弹窗关掉之后，让人还能看见进度。开关在设置里，默认开。
router.on(MSG.MINI_OPEN, async ({ runId }) => {
  let target = runId;
  if (!target) {
    const runs = await db.listRuns();
    target = runs.find((run) => ACTIVE_STATES.includes(run.state))?.id || runs[0]?.id || '';
  }
  return openMini({ runId: target, reason: runId ? 'manual' : 'auto' });
});

router.on(MSG.MINI_CLOSE, async () => closeMini());

router.on(MSG.PROBE_PAGE, async ({ tabId, scope }) => {
  if (scope === 'cookies') {
    const cookies = await bilibiliCookies();
    return { cookies, header: await cookieHeader() };
  }
  const probeResult = tabId ? await probeTab(tabId) : await probeActiveTab();
  if (!probeResult) return { ok: false, message: '当前不是可识别的 B 站视频页。' };
  return probeResult;
});

/**
 * Settings live in the service worker: `chrome.storage` is not reachable from the
 * offscreen document, so every run carries its settings in the task payload.
 */
router.on(MSG.SETTINGS_GET, async () => loadSettings());

// 设置页的「运行自检」：把只能在真机上验证的运行时假设列成清单。
// 自检也要跑最新代码，否则「自检全绿、生成失败」这种事还会再发生一次。
router.on(MSG.SELFTEST, async () => {
  await recreateOffscreen().catch(() => {});
  return runSelfTest();
});

// offscreen / viewer 拿不到 chrome.storage，把它们的错误代写到 local，供弹窗显示。
router.on(MSG.DIAG_ERROR, async (entry) => {
  const error = new Error(entry?.message || '未知错误');
  // 堆栈是定位的唯一线索，不能在这一跳里丢掉。
  if (entry?.stack) error.stack = entry.stack;
  await recordError(entry?.context || 'unknown', error);
  return true;
});

router.on(MSG.REQUEST_PERMISSION, async ({ origins }) => {
  const granted = await requestOrigins(origins || []);
  if (granted) await installRules();
  return { granted };
});

router.on(MSG.TEST_CONNECTION, async ({ target }) => {
  const settings = await loadSettings();
  if (target === 'asr') {
    if (!settings.asr.apiKey) throw fail.input('ASR_KEY_MISSING', '还没有填语音识别 API Key。');
    const response = await fetch(`${settings.asr.baseUrl.replace(/\/$/, '')}/services/audio/asr/transcription`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.asr.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'invalid-probe', input: { file_urls: [] } }),
    });
    // A 400 means the key was accepted and the payload was rejected.
    return { ok: response.status !== 401 && response.status !== 403, status: response.status };
  }
  const result = await probe(settings);
  return { ok: true, ...result };
});

/* ---------------- 历史 ---------------- */

const BV_RE = /BV[0-9A-Za-z]{10}/;

/**
 * 任务里只存了 canonicalUrl，历史页要能跳回原视频，就把 BV 号还原成地址。
 * **分 P 必须保留**：以前只把 BV 号抠出来拼地址，多 P 视频一律跳回第 1 个。
 */
function videoUrlFor(run) {
  const raw = String(run?.url || run?.canonicalUrl || '');
  const match = BV_RE.exec(raw);
  if (!match) return raw;
  const fromUrl = /[?&]p=(\d+)/.exec(raw);
  return watchUrl(match[0], Number(fromUrl?.[1] ?? run?.pageNumber) || 1);
}

function bvidFor(run) {
  return BV_RE.exec(run?.url || run?.canonicalUrl || '')?.[0] || '';
}

function briefUsage(record) {
  if (!record) return null;
  return {
    totalTokens: Number(record.totalTokens || 0),
    promptTokens: Number(record.promptTokens || 0),
    completionTokens: Number(record.completionTokens || 0),
    requests: Number(record.requests || 0),
  };
}

router.on(MSG.RUN_LIST, async () => {
  const runs = await db.listRuns();
  // 用量一次读完再匹配，别为每条任务各开一次事务。
  const usageAll = await db.getAll(db.STORE.USAGE).catch(() => []);
  const usageById = new Map((usageAll || []).filter(Boolean).map((item) => [item.runId, item]));
  return runs.map((run) => ({
    id: run.id,
    state: run.state,
    progress: run.progress || 0,
    message: run.message || '',
    title: run.title || '',
    url: run.url || '',
    videoUrl: videoUrlFor(run),
    bvid: bvidFor(run),
    pageNumber: Number(run.pageNumber || 0),
    pageCount: Number(run.pageCount || 0),
    pageTitle: String(run.pageTitle || ''),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt || null,
    durationMs: run.durationMs || 0,
    unitCount: run.unitCount || 0,
    reportMode: run.reportMode || 'standard',
    transcriptMode: run.transcriptMode || '',
    imageBytes: run.imageBytes || 0,
    outputBytes: run.outputBytes || 0,
    stage: run.errorStage || run.stage || '',
    error: run.error
      ? {
        code: run.error.code || '',
        category: run.error.category || '',
        stage: run.error.stage || '',
        message: run.error.message || '',
      }
      : null,
    usage: briefUsage(usageById.get(run.id)),
  }));
});

router.on(MSG.RUN_DETAIL, async ({ runId }) => {
  const run = await db.get(db.STORE.RUNS, runId);
  if (!run) throw fail.input('RUN_NOT_FOUND', '任务不存在。');
  const [logs, usage, output, transcript, input] = await Promise.all([
    db.logsFor(runId).catch(() => []),
    db.get(db.STORE.USAGE, runId).catch(() => null),
    db.get(db.STORE.OUTPUTS, runId).catch(() => null),
    db.get(db.STORE.TRANSCRIPTS, runId).catch(() => null),
    db.get(db.STORE.INPUTS, runId).catch(() => null),
  ]);
  return {
    run: {
      id: run.id,
      title: run.title || '',
      state: run.state,
      url: run.url || '',
      videoUrl: videoUrlFor(run),
      bvid: bvidFor(run),
      pageNumber: Number(run.pageNumber || 0),
      pageCount: Number(run.pageCount || 0),
      pageTitle: String(run.pageTitle || ''),
      createdAt: run.createdAt,
      finishedAt: run.finishedAt || null,
      durationMs: run.durationMs || 0,
      unitCount: run.unitCount || 0,
      reportMode: run.reportMode || 'standard',
      transcriptMode: run.transcriptMode || '',
      error: run.error || null,
      errorStage: run.errorStage || '',
    },
    logs: (logs || []).sort((a, b) => (a.at || 0) - (b.at || 0)),
    usage: usage || null,
    output: output
      ? {
        sectionCount: output.sectionCount || 0,
        bytes: output.bytes || (output.html || '').length,
        findings: output.findings || [],
        savedAt: output.savedAt || 0,
      }
      : null,
    transcript: transcript
      ? { source: transcript.source || '', attribution: transcript.attribution || '', units: (transcript.units || []).length }
      : null,
    input: input ? { source: input.source || null, transcriptPasted: Boolean(input.transcriptText) } : null,
  };
});

router.on(MSG.RUN_RENAME, async ({ runId, title }) => {
  const next = String(title || '').trim().slice(0, 200);
  if (!next) throw fail.input('TITLE_EMPTY', '标题不能为空。');
  await db.updateRun(runId, { title: next });
  return { ok: true, title: next };
});

/**
 * 批量清理。删除不只是删记录 —— 音频还在 OPFS 里，得让 offscreen 一起清掉，
 * 否则「删了任务但磁盘没变小」。
 */
router.on(MSG.RUN_CLEAR, async ({ scope = 'all', days = 0, ids = null }) => {
  const runs = await db.listRuns();
  const cutoff = Date.now() - Math.max(0, Number(days) || 0) * 86400000;
  const pick = (run) => {
    if (Array.isArray(ids)) return ids.includes(run.id);
    if (scope === 'completed') return run.state === STATE.RENDERED;
    if (scope === 'failed') return run.state === STATE.FAILED || run.state === STATE.CANCELLED;
    if (scope === 'older') return (run.createdAt || 0) < cutoff;
    return true;
  };
  const victims = runs.filter(pick);
  for (const run of victims) await db.deleteRun(run.id);
  if (victims.length) {
    await runTask({ kind: 'purge-many', runIds: victims.map((run) => run.id) }).catch(() => {});
  }
  return { deleted: victims.length, ids: victims.map((run) => run.id) };
});

router.on(MSG.STORAGE_STATS, async () => {
  const runs = await db.listRuns().catch(() => []);
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  return {
    usage: estimate?.usage || 0,
    quota: estimate?.quota || 0,
    runs: runs.length,
    active: runs.filter((run) => ACTIVE_STATES.includes(run.state)).length,
  };
});

router.on(MSG.RUN_DELETE, async ({ runId }) => {
  await db.deleteRun(runId);
  await runTask({ kind: 'purge', runId }).catch(() => {});
  return { ok: true };
});

/**
 * 导出一律转给 offscreen 去做。
 *
 * 不能在 service worker 里直接下载：它创建的 `blob:` URL 属于 worker 上下文，
 * worker 一休眠链接就失效，`chrome.downloads` 拿到的已经是一条死链 ——
 * 现象正是「点了没反应，也不报错」。offscreen 文档常驻，blob 才活得下来。
 */
router.on(MSG.EXPORT_HTML, async ({ runId }) => {
  const output = await db.get(db.STORE.OUTPUTS, runId);
  if (!output?.html) throw fail.input('REPORT_MISSING', '还没有生成报告。');
  return runTask({ kind: 'export', what: 'html', runId });
});

router.on(MSG.EXPORT_TRANSCRIPT, async ({ runId }) => {
  const transcript = await db.get(db.STORE.TRANSCRIPTS, runId);
  if (!transcript?.text) throw fail.input('TRANSCRIPT_MISSING', '没有可导出的转写。');
  const result = await runTask({ kind: 'export', what: 'transcript', runId });
  return { text: transcript.text, title: transcript.title, ...result };
});

router.on(MSG.VIEWER_LOAD, async ({ runId }) => {
  const output = await db.get(db.STORE.OUTPUTS, runId);
  const transcript = await db.get(db.STORE.TRANSCRIPTS, runId);
  return {
    html: output?.html || null,
    error: output?.error || null,
    title: transcript?.title || '',
  };
});

router.on(MSG.RUN_START, async (payload) => {
  const settings = await loadSettings();
  const input = { ...payload };
  // A pasted transcript never touches ASR, so its credentials are not required.
  const needsAsr = !input.transcriptText && settings.asr.enabled;
  const check = validateSettings({
    ...settings,
    asr: { ...settings.asr, enabled: needsAsr },
  });
  if (!check.ok) {
    throw fail.input('SETTINGS_INVALID', check.errors[0], { problems: check.errors });
  }

  // 块外（下面建任务时）还要用，所以声明必须在 if 之外：let 是块级作用域。
  let probeResult = null;
  let probeNote = '';
  if (!input.transcriptText) {
    if (input.tabId && input.tabId !== 'current') {
      probeResult = await probeTab(input.tabId).catch(() => null);
    } else {
      probeResult = await probeActiveTab().catch(() => null);
    }
    const url = input.url || probeResult?.canonicalUrl || probeResult?.url;
    if (!url) {
      throw fail.input('URL_INVALID', '请打开 B 站视频页或粘贴一个视频链接。');
    }
    const source = await parseBilibiliUrl(url);
    input.url = source.canonicalUrl;
    input.source = source;
    /**
     * 探测到的是「当前打开的那一页」，只有它和用户要处理的是同一个 BV 号、
     * 同一个分 P 时才能用。以前无脑塞进去，于是：
     *   - 在看 P1、却粘贴了 P3 的链接 → 用的还是 P1 的 cid；
     *   - 页面本身在 P3，但 __INITIAL_STATE__ 里没有当前分 P 字段 → 按 P1 算。
     * 不匹配就走公开接口，链接里的 ?p= 才是准的。
     */
    if (probeMatches(probeResult, source)) {
      input.probe = probeResult;
      // 页面切了分 P 之后，__playinfo__ 可能还是上一 P 的（时长对不上就是了）。
      // 这时宁可走接口按 cid 重新取，也不能拿错的那一段去识别。
      if (probeResult.streamsStale) {
        input.probe = { ...probeResult, streams: null };
        probeNote = '页面里的播放地址还是上一个分 P 的，改用公开接口按 cid 重新取流';
      }
    } else if (probeResult?.ok) {
      probeNote = `当前页面是 ${probeResult.video?.bvid || '?'} 第 `
        + `${probeResult.video?.pageNumber || 1} 个分 P，与要处理的 `
        + `${source.bvid} 第 ${source.pageNumber} 个不是同一个，改用公开接口读取`;
    } else {
      probeNote = `页面探测没拿到数据${probeResult?.note ? `（${probeResult.note}）` : ''}，改用公开接口读取`;
    }
  }

  if (input.transcriptText && !input.transcriptText.trim()) {
    throw fail.input('TRANSCRIPT_EMPTY', '粘贴的转写是空的。');
  }

  const runId = db.newRunId();
  // 标题兜底：探测没拿到时至少留个 BV 号，任务列表里不出现「（无标题）」。
  const fallbackTitle = input.source?.bvid || input.title || '';
  await db.createRun({
    id: runId,
    state: STATE.QUEUED,
    stage: STATE.QUEUED,
    progress: 0,
    message: '排队中',
    reportMode: settings.report.mode,
    transcriptMode: input.transcriptText ? 'paste' : 'asr-only',
    title: input.title || probeResult?.video?.title || fallbackTitle,
    url: input.url || '',
  });
  await db.put(db.STORE.INPUTS, { runId, ...input, createdAt: Date.now() });
  await log(runId, 'info', 'queued', `任务创建：${input.url || '粘贴转写'}`);
  if (!input.transcriptText && probeNote) {
    // 探测拿不到数据不致命（还有公开接口），但要留痕：
    // 走接口就拿不到 __playinfo__ 里已签名的流地址，只能靠 API 给的码率。
    await log(runId, 'warn', 'probe', probeNote);
  }

  // Fire and forget: the popup will close, and progress arrives as events.
  // settings 随任务带过去 —— offscreen 里没有 chrome.storage。
  // 开跑前重建 offscreen：不重建就会复用上一版的模块图，改过的代码根本不生效。
  await recreateOffscreen().catch(() => {});
  // 弹窗随时可能被点没，浮层在设置里开着的话就让它在后台接着显示进度。
  openMini({ runId, reason: 'auto' }).catch(() => {});
  runTask({ kind: 'run', runId, settings }).catch((error) => {
    const runError = asRunError(error);
    // 落盘堆栈：只存 message 的话，"Failed to fetch" 这种错永远定位不到出处。
    recordError('service-worker-run', error).catch(() => {});
    db.updateRun(runId, {
      state: STATE.FAILED,
      message: runError.message,
      finishedAt: Date.now(),
      error: runError.toJSON(),
    });
    broadcast(MSG.RUN_EVENT, { runId, state: STATE.FAILED, message: runError.message });
  });

  return { runId };
});

router.on(MSG.RUN_CANCEL, async ({ runId }) => {
  await runTask({ kind: 'cancel', runId }).catch(() => {});
  await db.updateRun(runId, { state: STATE.CANCELLED, message: '已取消', finishedAt: Date.now() });
  broadcast(MSG.RUN_EVENT, { runId, state: STATE.CANCELLED, message: '已取消' });
  return { ok: true };
});

router.on(MSG.RUN_RESUME, async ({ runId }) => {
  await recreateOffscreen().catch(() => {});
  runTask({ kind: 'run', runId, resumed: true, settings: await loadSettings() }).catch(() => {});
  return { ok: true };
});

router.on(MSG.AUDIO_FETCH, async ({ runId, url, urls, videoUrl }) => {
  // 没有已打开的 B 站页面就自己开一个后台标签页，用完关掉。
  const { tab, created } = await ensureBilibiliTab(videoUrl);
  try {
    const result = await fetchViaTab(tab.id, urls?.length ? urls : url, {
      referrers: referrersFor(videoUrl || tab.url),
      onChunk: (chunk) => {
        chrome.runtime.sendMessage({
          type: MSG.AUDIO_CHUNK,
          payload: { runId, chunk },
        }).catch(() => {});
      },
    });
    return result;
  } finally {
    await releaseBilibiliTab(tab, created);
  }
});

router.on(MSG.CAPTURE_PNG, async ({ runId, width }) => {
  const settings = await loadSettings();
  const run = await db.get(db.STORE.RUNS, runId);
  await ensureOffscreen();
  const result = await captureReport(runId, {
    width: width || settings.report.imageWidth,
    title: run?.title || 'report',
    download: true,
    // 长图是逐屏截图，慢且没有任何反馈，用户只会以为「点了没反应」。
    onProgress: ({ done, total }) => {
      broadcast(MSG.CAPTURE_PROGRESS, { runId, done, total, stage: 'capture' });
    },
  });
  broadcast(MSG.CAPTURE_PROGRESS, { runId, done: 1, total: 1, stage: 'done' });
  await db.updateRun(runId, { imageBytes: result.bytes, imageHeight: result.height });
  return result;
});

router.on(MSG.SETTINGS_CHANGED, async () => {
  await installRules();
  return { ok: true };
});

// 报告页就绪只是通知，不需要回复；capture.js 那边自己在等这条消息。
router.on(MSG.VIEWER_READY, async () => ({ ok: true }));

install(router);

/* ---------------- action ---------------- */

chrome.action?.onClicked?.addListener(async () => {
  // The popup handles clicks; this only matters when no popup is configured.
  const tab = await activeTab();
  if (tab?.url) await patchSettings({});
});

chrome.runtime.onSuspend?.addListener(() => {
  closeOffscreen().catch(() => {});
});
