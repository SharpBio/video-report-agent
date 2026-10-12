/** Thin wrapper over chrome.runtime messaging with broadcast support. */
import { recordError } from './diag.js';

const listeners = new Set();

/**
 * 当前上下文的名字。设置了之后，本上下文里被 onMessage 接住的错误会连堆栈落盘，
 * 否则 chrome://extensions 上只剩一句没有堆栈的 message，根本没法定位。
 */
let errorContext = null;

export function setErrorContext(name) {
  errorContext = name;
}

export function onMessage(type, handler) {
  const wrapped = (message, sender, sendResponse) => {
    if (!message || message.type !== type) return false;
    const result = handler(message.payload ?? {}, sender);
    if (result && typeof result.then === 'function') {
      result.then(
        (value) => sendResponse({ ok: true, value }),
        (error) => {
          if (errorContext) recordError(errorContext, error).catch(() => {});
          sendResponse({
            ok: false,
            error: { message: error?.message || String(error), name: error?.name },
          });
        },
      );
      return true; // keep the channel open for the async reply
    }
    sendResponse({ ok: true, value: result });
    return true;
  };
  listeners.add(wrapped);
  chrome.runtime.onMessage.addListener(wrapped);
  return () => {
    chrome.runtime.onMessage.removeListener(wrapped);
    listeners.delete(wrapped);
  };
}

function unwrap(response) {
  if (!response) {
    const last = chrome.runtime.lastError;
    throw new Error(last?.message || '消息接收方不存在（上下文可能已被销毁）。');
  }
  if (!response.ok) {
    const error = new Error(response.error?.message || '未知错误。');
    if (response.error?.name) error.name = response.error.name;
    throw error;
  }
  return response.value;
}

export async function send(type, payload = {}) {
  return unwrap(await chrome.runtime.sendMessage({ type, payload }));
}

export async function sendToTab(tabId, type, payload = {}) {
  return unwrap(await chrome.tabs.sendMessage(tabId, { type, payload }));
}

/** Fire-and-forget broadcast; popups that are closed simply miss it. */
export function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}
