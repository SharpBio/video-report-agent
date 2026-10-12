/**
 * 把「看不见的错误」变成看得见的。
 *
 * 弹窗一关、offscreen 文档一销毁，控制台就都没了；而 chrome://extensions 的错误
 * 列表只给 message，不给堆栈。这里把完整堆栈落到 chrome.storage.local，
 * 弹窗下次打开时会把它显示出来。
 */
const KEY = 'vraLastError';

/**
 * 存一条错误。
 *
 * 两个落点：
 *   1. chrome.storage.local —— 弹窗、设置页、service worker 都能直接写；
 *   2. 写不了时（offscreen 文档里 `chrome.storage` 是 undefined）转给 service worker 代写。
 * 第 2 条很关键：offscreen 正好是整条流水线跑的地方，那里的错误最需要看到。
 */
export async function recordError(context, error) {
  const reason = error instanceof Error ? error : new Error(String(error));
  const entry = {
    context,
    message: reason.message,
    stack: reason.stack || '',
    at: Date.now(),
  };
  console.error(`[${context}]`, reason);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [KEY]: entry });
      return entry;
    }
  } catch {
    /* 落到下面：转给 service worker */
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'diag/error', payload: entry }).catch(() => {});
    }
  } catch {
    /* 连消息都发不出去，至少已经打了控制台 */
  }
  return entry;
}

export async function lastError() {
  if (!chrome.storage?.local) return null;
  const bag = await chrome.storage.local.get(KEY);
  return bag?.[KEY] || null;
}

export async function clearError() {
  if (!chrome.storage?.local) return;
  await chrome.storage.local.remove(KEY);
}

/** 挂到 window 上，捕获同步错误与未处理的 Promise 拒绝。 */
export function installErrorTrap(context) {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    recordError(context, event.error || new Error(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordError(context, event.reason);
  });
}

/** 取堆栈里第一个有效位置，用于塞进状态栏。 */
export function firstFrame(entry) {
  const line = (entry?.stack || '').split('\n').find((l) => l.trim().startsWith('at '));
  return line ? line.trim() : '';
}
