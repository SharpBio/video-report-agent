import { send } from './bus.js';
import { MSG } from './protocol.js';

/**
 * Bilibili cookies. Only usable from the background service worker
 * (`chrome.cookies` is not exposed to offscreen documents or content scripts).
 *
 * 注意：本模块会被 service worker 静态导入，所以里面不能有动态 `import()` ——
 * ServiceWorkerGlobalScope 禁止动态 import（w3c/ServiceWorker#1356）。
 */

const COOKIE_HOSTS = ['.bilibili.com', 'bilibili.com'];

/** @returns {Promise<Array<{name:string,value:string}>>} */
export async function bilibiliCookies() {
  if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) return [];
  const collected = [];
  const seen = new Set();
  for (const domain of COOKIE_HOSTS) {
    let list = [];
    try {
      list = await chrome.cookies.getAll({ domain });
    } catch {
      continue;
    }
    for (const cookie of list) {
      if (seen.has(cookie.name)) continue;
      seen.add(cookie.name);
      collected.push({ name: cookie.name, value: cookie.value });
    }
  }
  return collected;
}

/** Cookie header value for manual fetch calls. */
export async function cookieHeader() {
  const cookies = await bilibiliCookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export function isLoggedIn(cookies) {
  return Boolean(cookies?.some((cookie) => cookie.name === 'SESSDATA' && cookie.value));
}

/** Ask the background for cookies; used by the offscreen document. */
export async function requestCookies() {
  try {
    const response = await send(MSG.PROBE_PAGE, { scope: 'cookies' });
    return response?.cookies || [];
  } catch {
    return [];
  }
}
