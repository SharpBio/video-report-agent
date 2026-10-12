/**
 * Fallback media download through an open Bilibili tab.
 *
 * A fetch() from the extension cannot set the Referer header, and some media
 * hosts reject requests without it. Fetching in the page's main world keeps the
 * browser's own Referer and cookies, so it works where a direct fetch does not.
 * Chunks are pulled one at a time to stay inside the script-injection result
 * size limit.
 */

const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * 下面带 `InPage` 后缀的函数会被 `chrome.scripting.executeScript` 注入页面主世界。
 *
 * **硬约束：注入的函数只带函数体，引用不到本模块的任何外层变量/常量。**
 * 所以它们只做「拿参数、跑、回结果」三件事，所有常量和组合都由本模块算好再传进去。
 * 曾经把凭证模式数组放在模块作用域，注入后直接 ReferenceError，报错还伪装成一句
 * "Failed to fetch" —— `tests/lint.mjs` 现在会静态拦住这种写法。
 *
 * 两个决定成败的细节：
 *
 * 1. **凭证顺序**：B 站媒体 CDN 普遍返回 `Access-Control-Allow-Origin: *`，而
 *    **带凭证**的跨域请求在 ACAO 为 `*` 时会被浏览器直接拒掉 —— 连 HTTP 状态码
 *    都拿不到，只有一个 `TypeError: Failed to fetch`。播放器自己取流是不带凭证的，
 *    所以先 omit，include 留作兜底。
 *
 * 2. **Referer 必须显式给**：`Referer` 是禁止头，`headers` 里写了会被静默忽略。
 *    但页面里可以用 `referrer` + `referrerPolicy: 'unsafe-url'` 指定它 —— 这是能
 *    覆盖页面 `<meta name="referrer">` 的唯一方式。B 站视频页的 referrer 策略常让
 *    跨域请求不带 Referer，CDN 就直接回 403。
 */

/* eslint-disable no-undef */
/** 全量下载到页面内存里，之后由 pullFromPageInPage 分块取回。 */
async function startInPage(candidates, plan) {
  const state = '__vraAudioFetch';
  const failures = [];
  for (const step of plan) {
    for (const url of candidates) {
      try {
        const response = await fetch(url, step.init);
        if (!response.ok) {
          failures.push(`${step.label} HTTP ${response.status}`);
          continue;
        }
        const buffer = await response.arrayBuffer();
        window[state] = { bytes: new Uint8Array(buffer), offset: 0 };
        return {
          ok: true,
          size: buffer.byteLength,
          url,
          label: step.label,
          contentType: response.headers.get('content-type') || '',
          failures,
        };
      } catch (error) {
        failures.push(`${step.label} ${(error && error.name) || 'Error'}: ${(error && error.message) || '未知'}`);
      }
    }
  }
  // 把所有尝试的原因都带回去：只给一个 "Failed to fetch" 是没法排错的。
  return { ok: false, message: `页面内下载失败（${failures.join('；')}）`, failures };
}

function pullFromPageInPage(offset, length) {
  const state = '__vraAudioFetch';
  const held = window[state];
  if (!held) return { ok: false, message: '没有进行中的下载。' };
  const end = Math.min(held.bytes.length, offset + length);
  if (offset >= end) {
    delete window[state];
    return { ok: true, done: true };
  }
  const slice = held.bytes.subarray(offset, end);
  let binary = '';
  const block = 0x8000;
  for (let i = 0; i < slice.length; i += block) {
    binary += String.fromCharCode.apply(null, slice.subarray(i, i + block));
  }
  return { ok: true, base64: btoa(binary), length: slice.length };
}

/** 从页面自己的 __playinfo__ 里拿音频地址（含备用地址），用来做连通性探针。 */
function readAudioUrlsInPage() {
  const info = window.__playinfo__;
  const data = info && info.data;
  const out = [];
  const audio = (data && data.dash && data.dash.audio) || [];
  for (const track of audio) {
    if (track.baseUrl) out.push(track.baseUrl);
    if (track.base_url) out.push(track.base_url);
    for (const backup of track.backup_url || []) if (backup) out.push(backup);
    if (out.length) break; // 第一条音轨够用了，别把整页地址都试一遍
  }
  const durl = (data && data.durl) || [];
  if (!out.length && durl[0]) {
    if (durl[0].url) out.push(durl[0].url);
    for (const backup of durl[0].backup_url || []) if (backup) out.push(backup);
  }
  return out;
}

/**
 * 只取第一块就取消，验证「凭证 + Referer + CORS」这条路通不通。
 * 刻意不加 Range 头 —— Range 不在 CORS 安全清单里，加了会触发预检，
 * 预检失败会伪装成下载失败，把探针的结论带偏。
 */
async function tryMediaInPage(candidates, plan) {
  const failures = [];
  for (const step of plan) {
    for (const url of candidates) {
      try {
        const response = await fetch(url, step.init);
        if (!response.ok) {
          failures.push(`${step.label} HTTP ${response.status}`);
          continue;
        }
        const reader = response.body.getReader();
        const first = await reader.read();
        await reader.cancel().catch(() => {});
        return {
          ok: true,
          bytes: first.value ? first.value.byteLength : 0,
          status: response.status,
          url,
          label: step.label,
          failures,
        };
      } catch (error) {
        failures.push(`${step.label} ${(error && error.name) || 'Error'}: ${(error && error.message) || '未知'}`);
      }
    }
  }
  return { ok: false, failures };
}
/* eslint-enable no-undef */

/**
 * 在 service worker 侧算好尝试顺序（注入的函数拿不到模块作用域，只能靠参数）。
 *
 * @param {string[]} referrers 显式 Referer 候选，按「最像播放器」排序。
 * @returns {Array<{label:string, init:object}>}
 */
export function planFor(referrers = []) {
  const refs = (Array.isArray(referrers) ? referrers : [referrers]).filter(Boolean);
  const out = [];
  const push = (label, init) => out.push({ label, init });
  const short = (url) => String(url).replace(/^https?:\/\//, '');

  for (const referrer of refs) {
    push(`credentials=omit referrer=${short(referrer)}`, {
      credentials: 'omit', mode: 'cors', referrer, referrerPolicy: 'unsafe-url',
    });
    push(`credentials=include referrer=${short(referrer)}`, {
      credentials: 'include', mode: 'cors', referrer, referrerPolicy: 'unsafe-url',
    });
  }
  // 兜底：不指定 referrer，让浏览器按页面自己的策略来。
  push('credentials=omit referrer=默认', { credentials: 'omit', mode: 'cors' });
  push('credentials=include referrer=默认', { credentials: 'include', mode: 'cors' });
  return out;
}

/** http:// 在 https 页面上会被当混合内容拦掉，先试 https 版本。 */
export function candidateUrls(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const out = [];
  for (const url of list) {
    if (url.startsWith('http://')) out.push(`https://${url.slice(7)}`);
    out.push(url);
  }
  return out;
}

/** 页面里能用的 Referer 候选，按「最像播放器」排序。 */
export function referrersFor(videoUrl = '') {
  const out = [];
  const push = (value) => {
    if (value && !out.includes(value)) out.push(value);
  };
  if (/^https:\/\/(www\.)?bilibili\.com\//.test(String(videoUrl || ''))) push(videoUrl);
  push('https://www.bilibili.com/');
  return out;
}

function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param {number} tabId
 * @param {string|string[]} urls 按顺序尝试；第一个成功的就用它。
 * @returns {Promise<{bytes:number, contentType:string, via:'tab', url:string}>}
 */
export async function fetchViaTab(tabId, urls, {
  referrers = [], onChunk = () => {}, onProgress = () => {},
} = {}) {
  if (!chrome.scripting?.executeScript) throw new Error('当前浏览器不支持脚本注入。');
  const candidates = candidateUrls(urls).slice(0, 8);
  if (!candidates.length) throw new Error('没有可下载的音频地址。');

  const started = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: startInPage,
    args: [candidates, planFor(referrers)],
  });
  const result = started?.[0]?.result;
  if (!result?.ok) throw new Error(result?.message || '页面下载失败。');

  const total = result.size;
  let received = 0;
  for (;;) {
    const pulled = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: pullFromPageInPage,
      args: [received, CHUNK_BYTES],
    });
    const chunk = pulled?.[0]?.result;
    if (!chunk?.ok) throw new Error(chunk?.message || '读取下载数据失败。');
    if (chunk.done) break;
    const bytes = decodeBase64(chunk.base64);
    if (!bytes.length) break;
    received += bytes.length;
    await onChunk(bytes);
    onProgress({ received, total });
    if (received >= total) break;
  }
  return {
    bytes: received,
    contentType: result.contentType || '',
    url: result.url || candidates[0],
    via: 'tab',
  };
}

/**
 * 找一个能注入的 B 站页面。
 *
 * @param {string} [preferUrl] 视频页地址；给了就优先挑**正在看这个视频**的标签页。
 *   原因：CDN 会看 Referer。用首页当跳板时 Referer 是 `https://www.bilibili.com/`，
 *   少数节点会据此返回 403 —— 复用视频页最稳。
 */
export async function findBilibiliTab(preferUrl = '') {
  if (!chrome.tabs?.query) return null;
  const tabs = await chrome.tabs.query({ url: ['*://*.bilibili.com/*'] });
  const usable = (tabs || []).filter((tab) => tab?.id && !tab.discarded);
  const bvid = /(BV[0-9A-Za-z]{10})/.exec(String(preferUrl || ''))?.[1];
  if (bvid) {
    const onVideo = usable.find((tab) => String(tab.url || '').includes(bvid));
    if (onVideo) return onVideo;
  }
  if (/\/video\//.test(String(preferUrl || ''))) {
    const anyWatch = usable.find((tab) => /\/video\//.test(String(tab.url || '')));
    if (anyWatch) return anyWatch;
  }
  return usable[0] || null;
}

function waitForComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        reject(new Error('标签页已关闭，无法注入。'));
        return;
      }
      if (tab?.status === 'complete') {
        resolve(tab);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('页面加载超时，无法注入下载脚本。'));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

/**
 * 保证有一个能注入脚本的 B 站页面。
 *
 * 直连下载已经被 R1 证伪（declarativeNetRequest 不会改扩展自己发出的请求），
 * 所以「经标签页取流」是主路径，不是兜底 —— 没有标签页就得自己开一个，
 * 否则「粘贴链接 + 点生成」这条最自然的用法根本跑不通。
 *
 * @returns {Promise<{tab:object, created:boolean}>}
 */
export async function ensureBilibiliTab(videoUrl = '') {
  const existing = await findBilibiliTab(videoUrl);
  if (existing?.id) return { tab: existing, created: false };

  const safe = /^https:\/\/(www\.)?bilibili\.com\/\S+$/.test(videoUrl)
    ? videoUrl
    : 'https://www.bilibili.com/';
  const created = await chrome.tabs.create({ url: safe, active: false });
  if (!created?.id) throw new Error('无法打开 B 站页面。');
  const ready = await waitForComplete(created.id, 25000);
  return { tab: ready, created: true };
}

/**
 * 连通性探针：在当前 B 站视频页上真取一小块音频，验证整条下载链路。
 * 只用一个已存在的标签页，不会自己开页面。
 */
export async function probeMediaInTab(tabId, videoUrl = '') {
  if (!chrome.scripting?.executeScript) {
    return { ok: false, detail: '当前浏览器不支持脚本注入。' };
  }
  const read = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: readAudioUrlsInPage,
  });
  const urls = (read?.[0]?.result || []).filter(Boolean);
  if (!urls.length) {
    return { ok: false, url: '', detail: '页面里读不到音频地址 —— 需要停在视频页上（不是首页/搜索页）。' };
  }
  const tried = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: tryMediaInPage,
    args: [candidateUrls(urls).slice(0, 4), planFor(referrersFor(videoUrl))],
  });
  const outcome = tried?.[0]?.result;
  if (outcome?.ok) {
    return {
      ok: true,
      url: outcome.url,
      detail: `取到 ${outcome.bytes} 字节（HTTP ${outcome.status}，${outcome.label}）`,
    };
  }
  const attempts = (outcome?.failures || []).slice(0, 8);
  return { ok: false, url: urls[0], detail: `${attempts.length} 种组合全部失败：${attempts.join('；')}` };
}

/** 只关掉我们自己开的那个，用户原有的页面不动。 */
export async function releaseBilibiliTab(tab, created) {
  if (!created || !tab?.id) return;
  try {
    await chrome.tabs.remove(tab.id);
  } catch {
    /* 已经被关掉了 */
  }
}
