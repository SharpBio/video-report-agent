import { send } from '../lib/bus.js';
import { MSG } from '../lib/protocol.js';

/**
 * The offscreen document is where the long work happens: it survives longer than
 * the service worker, has DOM + OPFS + IndexedDB, and can host the sandbox iframe.
 * The service worker only keeps it alive and forwards messages.
 *
 * 注意：本模块跑在 service worker 里，ServiceWorkerGlobalScope 禁止动态 `import()`
 * （w3c/ServiceWorker#1356），所以所有依赖必须是静态导入。
 */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const REASONS = ['DOM_PARSER', 'BLOBS', 'IFRAME_SCRIPTING', 'DOM_SCRAPING'];
const JUSTIFICATION = '生成报告：解析转写、访问对象存储文件、在沙箱中执行模型代码。';

let creating = null;

export function offscreenUrl() {
  return chrome.runtime.getURL(OFFSCREEN_URL);
}

export async function hasOffscreen() {
  if (!chrome.offscreen?.hasDocument) return false;
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return false;
  }
}

export async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (creating) return creating;
  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: offscreenUrl(),
        reasons: REASONS,
        justification: JUSTIFICATION,
      });
      return true;
    } catch (error) {
      console.warn('[offscreen] 创建失败', error?.message);
      throw error;
    } finally {
      creating = null;
    }
  })();
  return creating;
}

export async function closeOffscreen() {
  if (!chrome.offscreen?.closeDocument) return;
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

/** 问 offscreen 自己：现在有任务在跑吗？重建前必须问，否则会拦腰截断正在跑的任务。 */
export async function isOffscreenBusy() {
  if (!(await hasOffscreen())) return false;
  try {
    const reply = await withTimeout(send(MSG.OFFSCREEN_TASK, { kind: 'busy' }), 2000);
    return Boolean(reply?.busy);
  } catch {
    // 问不到（文档已死 / 无应答）时就当它不忙，交给重建路径。
    return false;
  }
}

/**
 * 关掉再建一次 offscreen 文档。
 *
 * 为什么必须能重建：offscreen 文档一创建，它的整个 ES 模块图就固化了。
 * 改动源码后只刷新 service worker（或什么都不刷）时，旧文档仍被复用，
 * 于是继续跑旧代码 —— 现象就是堆栈行号永远停在改之前的那一版
 * （本次事故：prompts.js:10:26，而修好的文件里第 10 行已经是注释）。
 * 所以每次真正开跑之前都重建一次，保证跑的是磁盘上最新的代码。
 */
export async function recreateOffscreen({ force = false } = {}) {
  if (!force && await isOffscreenBusy()) return false;
  await closeOffscreen();
  await ensureOffscreen();
  return true;
}

/**
 * Forward a task and wait for its result. Recreates the document once if it was
 * torn down (Chrome closes it after ~30s idle, or on browser restart).
 */
export async function runTask(task, { timeoutMs = 0 } = {}) {
  await ensureOffscreen();
  try {
    return await withTimeout(send(MSG.OFFSCREEN_TASK, task), timeoutMs);
  } catch (error) {
    const stale = /接收方不存在|Extension context|message port closed/i.test(error?.message || '');
    if (!stale) throw error;
    await closeOffscreen();
    await ensureOffscreen();
    return withTimeout(send(MSG.OFFSCREEN_TASK, task), timeoutMs);
  }
}

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('任务超时。')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
