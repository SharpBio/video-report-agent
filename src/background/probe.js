/**
 * Read a watch page from the background: inject the probe into the page's main
 * world, where `window.__INITIAL_STATE__` and `window.__playinfo__` live.
 */
import { probePage } from '../lib/bilibili-page.js';
import { fail } from '../lib/errors.js';

export async function activeTab() {
  if (!chrome.tabs?.query) return null;
  // 服务 worker 里没有真正的「当前窗口」，优先用最近聚焦的窗口，再退回 currentWindow。
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused) return focused;
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  return current || null;
}

export async function isBilibiliTab(tab) {
  return Boolean(tab?.url && /^https:\/\/(www\.)?bilibili\.com\//.test(tab.url));
}

export async function probeTab(tabId) {
  if (!chrome.scripting?.executeScript) {
    throw fail.env('PROBE_UNAVAILABLE', '当前浏览器不支持脚本注入。');
  }
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: probePage,
    });
  } catch (error) {
    throw fail.input('PROBE_UNAVAILABLE', '无法读取页面，请刷新视频页面后重试。', {
      cause: error?.message,
    });
  }
  const result = results?.[0]?.result;
  if (!result?.ok) {
    throw fail.input('PROBE_UNAVAILABLE', '这个页面不是可识别的视频页，请打开视频页或粘贴链接。');
  }
  return result;
}

/** Probe the active tab when it is a watch page; otherwise null. */
export async function probeActiveTab() {
  const tab = await activeTab();
  if (!tab || !(await isBilibiliTab(tab))) return null;
  try {
    const probe = await probeTab(tab.id);
    return { ...probe, tabId: tab.id };
  } catch (error) {
    // 探测失败不该中断任务（还能走公开接口），但原因要带出去：
    // 静默返回 null 会让「任务列表里全是（无标题）」这类现象无从排查。
    return { ok: false, note: error?.message || String(error) };
  }
}
