/**
 * Sandboxed eval host.
 *
 * Runs in a unique opaque origin with no chrome.* access, no extension storage
 * and no network beyond what the code itself attempts — which the sandbox CSP
 * blocks. Model-supplied JavaScript lands here so a hallucinated snippet can
 * never read an API key.
 *
 * Synchronous infinite loops cannot be interrupted; the caller drops the frame
 * on timeout, which destroys this page and its loop with it.
 */
(function () {
  const MAX_RESULT_CHARS = 8000;

  function serialize(value) {
    try {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    } catch {
      return String(value);
    }
  }

  window.addEventListener('message', (event) => {
    const { id, code, args } = event.data || {};
    if (!id || typeof code !== 'string') return;

    const reply = (payload) => event.source?.postMessage({ id, ...payload }, '*');

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('args', `"use strict";${code}`);
      const value = fn(Array.isArray(args) ? args : []);
      Promise.resolve(value).then(
        (resolved) => {
          const serialized = serialize(resolved);
          const text = JSON.stringify(serialized);
          reply({
            ok: true,
            value: serialized,
            truncated: text.length > MAX_RESULT_CHARS,
          });
        },
        (error) => reply({ ok: false, error: `异步执行失败：${error && error.message}` }),
      );
    } catch (error) {
      reply({ ok: false, error: String((error && error.message) || error) });
    }
  });

  window.parent.postMessage({ ready: true }, '*');
})();
