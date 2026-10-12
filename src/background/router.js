/** Message router: one place where every incoming message type is declared. */
import { recordError } from '../lib/diag.js';

export function createRouter() {
  const handlers = new Map();

  return {
    on(type, handler) {
      handlers.set(type, handler);
    },

    /** Returns true when the message was claimed and answered asynchronously. */
    dispatch(message, sender, sendResponse) {
      const handler = handlers.get(message?.type);
      if (!handler) return false;
      const result = (async () => handler(message.payload ?? {}, sender))();
      result.then(
        (value) => sendResponse({ ok: true, value: value ?? null }),
        (error) => {
          // 这里吞掉的错误不会出现在 chrome://extensions，所以自己存一份带堆栈的。
          recordError('service-worker', error).catch(() => {});
          sendResponse({
            ok: false,
            error: {
              message: error?.message || String(error),
              name: error?.name,
              code: error?.code,
              category: error?.category,
            },
          });
        },
      );
      return true;
    },
  };
}

/** Install the router as the only onMessage listener. */
export function install(router) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    return router.dispatch(message, sender, sendResponse);
  });
}
