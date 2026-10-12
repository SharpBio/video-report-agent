/**
 * Offscreen entry point. Owns the long-running pipeline and any canvas work;
 * it is created by the service worker and torn down by Chrome when idle.
 */
import { onMessage, broadcast, send, setErrorContext } from '../lib/bus.js';
import { MSG } from '../lib/protocol.js';
import { loadSettings } from '../lib/settings.js';
import { log, trace } from '../lib/log.js';
import * as db from '../lib/db.js';
import * as opfs from '../lib/opfs.js';
import { requestPersistence } from '../lib/opfs.js';
import { executeRun, cancelRun, resumableRuns } from './orchestrator.js';
import { runOffscreenSelfTest } from './selftest.js';
import { prune } from '../lib/retention.js';
import { disposeSandbox } from '../lib/sandbox.js';
import { installErrorTrap } from '../lib/diag.js';
import { probeUrl, probeBilibiliApi } from '../lib/netprobe.js';

// offscreen 文档无法像普通页面那样打开 DevTools，把错误连堆栈存起来，
// 弹窗下次打开时会显示（src/lib/diag.js）。
installErrorTrap('offscreen');
// 流水线跑在这里，这里的错误最需要看得见；offscreen 读不到 chrome.storage，
// diag.js 会自动把记录转给 service worker 代写。
setErrorContext('offscreen');

const running = new Set();
// 启动恢复（bootstrap）跑的那批任务不在 running 里，但同样不能被重建打断。
let bootBusy = false;
// 模块加载的时刻就是文档创建的时刻 —— 日志里带上它，能一眼看出跑的是不是刚刷新的代码。
const BOOT_AT = Date.now();

async function keepAwake(runId) {
  const timer = setInterval(() => {
    db.updateRun(runId, { heartbeatAt: Date.now() }).catch(() => {});
  }, 20000);
  return () => clearInterval(timer);
}

/**
 * 设置来自 service worker。offscreen 文档里 `chrome.storage` 取不到，
 * 所以一律走消息（SETTINGS_GET）；只有消息也失败时才退回本地读一次。
 */
async function settingsFromHost(fallback = null) {
  try {
    const settings = await send(MSG.SETTINGS_GET);
    if (settings && typeof settings === 'object') return settings;
  } catch {
    /* 落到下面 */
  }
  return fallback || loadSettings();
}

async function handleRun({ runId, resumed, settings: carried }) {
  if (running.has(runId)) return { started: false, reason: 'already-running' };
  running.add(runId);
  const stopHeartbeat = await keepAwake(runId);
  try {
    // 这条日志是「代码新鲜度」的锚点：offscreen 文档会带着旧模块图活很久，
    // 出问题时要先确认 bootAt 是不是你刚才刷新扩展的那一刻。
    await log(runId, 'info', 'env', 'offscreen 上下文', {
      bootAt: new Date(BOOT_AT).toISOString(),
      ageSec: Math.round((Date.now() - BOOT_AT) / 1000),
      version: chrome.runtime.getManifest?.().version || '（未知）',
    });
    const settings = carried || await settingsFromHost();
    await requestPersistence();
    const result = await executeRun(runId, settings, { resumed });
    await prune(settings.retention).catch(() => {});
    return result;
  } finally {
    stopHeartbeat();
    running.delete(runId);
    disposeSandbox();
  }
}

onMessage(MSG.OFFSCREEN_TASK, async (payload) => {
  switch (payload.kind) {
    case 'run':
      return handleRun(payload);
    case 'cancel':
      cancelRun(payload.runId);
      return { cancelled: true };
    case 'resume':
      return handleRun({ runId: payload.runId, resumed: true, settings: payload.settings });
    case 'stitch': {
      const { strips, width, height, download, title, runId } = payload;
      const { stitchStrips } = await import('../lib/stitch.js');
      const result = await stitchStrips(strips, { width, height });
      // 存档只是顺手：写不进去（目录没了 / 配额）也不能把已经拼好的图扔掉，
      // 下载才是用户真正要的东西。
      await opfs.writeBytes(runId, 'report.png', result.blob).catch(() => {});
      if (download) {
        const { downloadFile, safeFilename } = await import('../lib/export.js');
        // 长图不弹「另存为」：点了就直接存到下载目录，右上角下载条会提示。
        const downloadId = await downloadFile(result.blob, safeFilename(title || 'report', 'png'),
          'image/png', { saveAs: false });
        // downloadFile 失败时会静默退回 <a> 点击（在 offscreen 里未必真的下得下来），
        // 所以这里主动回头看一眼：被浏览器拦下的下载当场报错，而不是假装成功。
        if (downloadId != null && chrome.downloads?.search) {
          const [item] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
          if (item && item.state === 'interrupted') {
            throw new Error(`下载被浏览器中断：${item.error || '未知原因'}`);
          }
        }
      }
      return { bytes: result.blob.size, width: result.width, height: result.height };
    }
    case 'export': {
      // 下载必须在有 DOM 的上下文里做：service worker 里创建的 blob: URL
      // 会在 worker 休眠时失效，chrome.downloads 拿到的是一个已经死掉的链接
      // —— 表现就是「点了没反应，也没有报错」。offscreen 文档一直活着，没问题。
      const { downloadFile, safeFilename } = await import('../lib/export.js');
      const what = payload.what || 'html';
      const run = await db.get(db.STORE.RUNS, payload.runId);
      if (what === 'transcript') {
        const transcript = await db.get(db.STORE.TRANSCRIPTS, payload.runId);
        if (!transcript?.text) throw new Error('没有可导出的转写。');
        await downloadFile(transcript.text,
          safeFilename(transcript.title || run?.title || 'transcript', 'md'),
          'text/markdown;charset=utf-8');
        return { ok: true, bytes: transcript.text.length };
      }
      const output = await db.get(db.STORE.OUTPUTS, payload.runId);
      if (!output?.html) throw new Error('这份任务还没有报告。');
      await downloadFile(output.html,
        safeFilename(run?.title || 'report', 'html'),
        'text/html;charset=utf-8');
      return { ok: true, bytes: output.html.length };
    }
    case 'purge': {
      await opfs.removeRun(payload.runId);
      return { ok: true };
    }
    case 'purge-many': {
      // 历史页批量删除：记录删了，媒体文件也得跟着走。
      const ids = Array.isArray(payload.runIds) ? payload.runIds : [];
      for (const id of ids) await opfs.removeRun(id).catch(() => {});
      return { ok: true, removed: ids.length };
    }
    case 'ping':
      return { ok: true, bootAt: BOOT_AT };
    case 'busy':
      // service worker 想在重建文档前确认这里没有活儿在跑。
      return { busy: running.size > 0 || bootBusy, running: [...running] };
    case 'netprobe':
      // 在 offscreen 这个上下文里真发一次请求 —— service worker 能过不代表这里也能过。
      return probeUrl(payload.probe);
    case 'apiprobe':
      // 同上，但走的是真实的元数据链路（nav + view），含 wbi 签名。
      return probeBilibiliApi(payload || {});
    case 'selftest':
      return runOffscreenSelfTest();
    default:
      throw new Error(`未知任务：${payload.kind}`);
  }
});

onMessage(MSG.RUN_LIST, async () => {
  const runs = await db.listRuns();
  return runs.map(({ id, state, progress, message, title, createdAt, finishedAt, durationMs }) => ({
    id, state, progress, message, title, createdAt, finishedAt, durationMs,
  }));
});

onMessage(MSG.RUN_RESUME, async ({ runId, settings }) => {
  const run = await db.get(db.STORE.RUNS, runId);
  if (!run) throw new Error('任务不存在。');
  return handleRun({ runId, resumed: true, settings });
});

/* Resume anything still marked active from a previous browser session. */
(async function bootstrap() {
  bootBusy = true;
  try {
    await requestPersistence();
    const pending = (await resumableRuns()).filter(Boolean);
    if (!pending.length) return;
    const settings = await settingsFromHost();
    await log('bootstrap', 'info', 'resume', `发现 ${pending.length} 个未完成任务`);
    for (const run of pending.slice(0, 1)) {
      await db.updateRun(run.id, { resumeAttempts: (run.resumeAttempts || 0) + 1 });
      handleRun({ runId: run.id, resumed: true, settings }).catch((error) => {
        trace.error(run.id, 'resume', error?.message || String(error));
      });
    }
  } catch (error) {
    console.warn('[offscreen] 启动恢复失败', error?.message);
  } finally {
    bootBusy = false;
  }
})();

broadcast(MSG.OFFSCREEN_RESULT, { ready: true });
