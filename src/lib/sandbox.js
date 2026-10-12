/**
 * Run model-supplied JavaScript in a sandboxed iframe.
 * The sandbox page has relaxed CSP (eval allowed) but no chrome.* access and no
 * extension origin, so model code cannot reach storage, downloads or settings.
 */

const EVAL_TIMEOUT_MS = 5000;
const FRAME_LOAD_TIMEOUT_MS = 10000;
const MAX_RESULT_CHARS = 8000;

let frame = null;
let readyPromise = null;
let pending = new Map();
let sequence = 0;

/**
 * 建 iframe 并等它真正就绪。
 *
 * **这里的顺序是修 bug 的关键**：`appendChild` 之后 `contentWindow` 立刻就有值，
 * 但里面的文档还没跑起来。曾经「有 contentWindow 就 postMessage」，结果消息被丢进
 * 未加载的文档，表现是每次都等到超时。必须等 `load`（或子页面自己发的 ready）。
 */
function ensureFrame() {
  if (frame && frame.isConnected && readyPromise) return readyPromise;

  const element = document.createElement('iframe');
  element.setAttribute('sandbox', 'allow-scripts');
  element.style.display = 'none';
  frame = element;

  readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('沙箱 iframe 加载超时。')), FRAME_LOAD_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onReady);
    };
    const onReady = (event) => {
      if (event.source !== element.contentWindow) return;
      if (!event.data || event.data.ready !== true) return;
      cleanup();
      resolve(element);
    };
    window.addEventListener('message', onReady);
    element.addEventListener('load', () => {
      cleanup();
      resolve(element);
    }, { once: true });
    element.addEventListener('error', () => {
      cleanup();
      reject(new Error('沙箱 iframe 加载失败。'));
    }, { once: true });
  });

  element.src = chrome.runtime.getURL('sandbox/eval.html');
  document.body.appendChild(element);
  return readyPromise;
}

function listen() {
  if (listen.installed) return;
  listen.installed = true;
  window.addEventListener('message', (event) => {
    if (event.source !== frame?.contentWindow) return;
    const { id, ok, value, error } = event.data || {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(value);
    else entry.reject(new Error(error || '沙箱执行失败。'));
  });
}

/**
 * @returns {Promise<{ok:boolean, value?:unknown, error?:string}>}
 * Never throws: failures are returned so the model can react and simplify.
 */
export async function execJs(code, args = []) {
  listen();
  let element;
  try {
    element = await ensureFrame();
  } catch (error) {
    disposeSandbox();
    return { ok: false, error: `沙箱不可用：${error.message}` };
  }

  return new Promise((resolve) => {
    const id = `js-${++sequence}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      // A synchronous infinite loop cannot be interrupted; drop the frame.
      disposeSandbox();
      resolve({ ok: false, error: `执行超时（>${EVAL_TIMEOUT_MS} ms），已终止。` });
    }, EVAL_TIMEOUT_MS);

    pending.set(id, {
      timer,
      resolve: (value) => {
        clearTimeout(timer);
        let serialized = value;
        try {
          serialized = JSON.parse(JSON.stringify(value ?? null));
        } catch {
          serialized = String(value);
        }
        let text = '';
        try {
          text = JSON.stringify(serialized);
        } catch {
          text = String(serialized);
        }
        resolve({ ok: true, value: serialized, truncated: text.length > MAX_RESULT_CHARS });
      },
      reject: (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: error.message });
      },
    });

    element.contentWindow?.postMessage({ id, code, args }, '*');
  });
}

export function disposeSandbox() {
  frame?.remove();
  frame = null;
  readyPromise = null;
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending = new Map();
}
