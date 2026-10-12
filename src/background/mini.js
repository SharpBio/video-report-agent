/**
 * 浮层小窗的生命周期。只有 service worker 能开窗口，所以开关放在这里。
 *
 * 任务本来就跑在 offscreen 里，弹窗关掉不影响它 —— 浮层只是让人「看得见」：
 * 它订阅的是流水线广播的 RUN_EVENT，不需要 service worker 一直醒着。
 */
import { loadSettings, patchSettings } from '../lib/settings.js';

const MINI_URL = 'src/mini/mini.html';
const DEFAULT_RECT = { width: 320, height: 174 };

let miniId = null;
let rectTimer = null;

export function miniWindowId() {
  return miniId;
}

export async function openMini({ runId = '', reason = 'auto' } = {}) {
  const settings = await loadSettings().catch(() => null);
  if (reason === 'auto' && !settings?.ui?.floating) return { opened: false, reason: 'disabled' };

  const url = chrome.runtime.getURL(`${MINI_URL}?run=${encodeURIComponent(runId)}`);
  // 已开着就复用，并把地址换成新任务，免得叠出一排小窗。
  if (miniId) {
    try {
      const tabs = await chrome.tabs.query({ windowId: miniId });
      if (tabs?.[0]?.id) await chrome.tabs.update(tabs[0].id, { url });
      await chrome.windows.update(miniId, { focused: true });
      return { opened: true, reused: true, windowId: miniId };
    } catch {
      miniId = null;
    }
  }

  const rect = settings?.ui?.floatingRect || {};
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    focused: false,
    width: rect.width || DEFAULT_RECT.width,
    height: rect.height || DEFAULT_RECT.height,
    ...(rect.left === undefined ? {} : { left: rect.left }),
    ...(rect.top === undefined ? {} : { top: rect.top }),
  });
  miniId = win?.id || null;
  return { opened: Boolean(miniId), windowId: miniId };
}

export async function closeMini() {
  if (!miniId) return { closed: false };
  const id = miniId;
  miniId = null;
  await chrome.windows.remove(id).catch(() => {});
  return { closed: true };
}

/** 记住位置与关窗时机：下次开在原地，窗口被关掉时别再把 miniId 当活的了。 */
export function installMiniTracker() {
  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === miniId) miniId = null;
  });
  chrome.windows.onBoundsChanged.addListener((win) => {
    if (win.id !== miniId) return;
    clearTimeout(rectTimer);
    // 拖动过程中事件是连续的，节流后再写，别把 storage 刷爆。
    rectTimer = setTimeout(() => {
      patchSettings({
        ui: {
          floatingRect: {
            left: win.left, top: win.top, width: win.width, height: win.height,
          },
        },
      }).catch(() => {});
    }, 400);
  });
}
