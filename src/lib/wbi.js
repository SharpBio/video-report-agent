/**
 * Bilibili wbi request signing.
 * SubtleCrypto has no MD5, so signing goes through ./md5.js.
 */
import { md5 } from './md5.js';
import { fetchWithLadder } from './http.js';

/** The fixed 64-entry permutation used to scramble img_key + sub_key. */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 57, 37, 45, 10, 31, 35, 40,
  30, 27, 51, 12, 48, 55, 43, 33, 58, 28, 5, 34, 22, 49, 62, 9,
  16, 61, 7, 20, 25, 36, 11, 44, 26, 39, 29, 21, 17, 3, 14, 50,
  54, 6, 4, 19, 38, 41, 60, 63, 24, 42, 52, 59, 1, 13, 0, 56,
];

const NAV_ENDPOINT = 'https://api.bilibili.com/x/web-interface/nav';
const KEY_TTL_MS = 12 * 60 * 60 * 1000;

function mixinKey(orig) {
  let temp = '';
  for (const index of MIXIN_KEY_ENC_TAB) temp += orig[index];
  return temp.slice(0, 32);
}

/** Drop the characters Bilibili strips before signing — must run before encoding. */
function filterValue(value) {
  return String(value).replace(/[!'()*]/g, '');
}

/**
 * Add `wts` and `w_rid` to a plain parameter object.
 * @param {Record<string, string|number>} params
 * @param {{imgKey:string, subKey:string}} keys
 * @returns {Record<string, string>}
 */
export function encWbi(params, keys) {
  if (!keys?.imgKey || !keys?.subKey) {
    throw new Error('wbi keys are missing');
  }
  const signed = { ...params };
  delete signed.w_rid;
  delete signed.wts;
  signed.wts = Math.floor(Date.now() / 1000);

  const query = Object.keys(signed)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(filterValue(signed[key]))}`)
    .join('&');

  const raw = query + mixinKey(keys.imgKey + keys.subKey);
  return { ...signed, w_rid: md5(raw) };
}

/** Query string for a signed parameter object. */
export function signedQuery(params, keys) {
  const signed = encWbi(params, keys);
  return Object.entries(signed)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function basenameKey(url) {
  const match = /\/([0-9a-zA-Z]+)\.[a-z]+$/.exec(String(url || ''));
  return match ? match[1] : '';
}

/**
 * Fetch fresh wbi keys from the nav endpoint.
 * Runs wherever the caller lives: background, offscreen or a dev page.
 */
export async function fetchWbiKeys({ fetchFn, credentials = null } = {}) {
  // 走 ladder：扩展里带凭证的跨域请求拿不到 CORS 豁免，include 单独用会直接
  // TypeError: Failed to fetch（见 src/lib/http.js 的说明）。
  const { response } = await fetchWithLadder(NAV_ENDPOINT, {
    credentials, timeoutMs: 20000, fetchFn,
  });
  if (!response.ok) throw new Error(`nav 接口返回 ${response.status}`);
  const payload = await response.json();
  const img = basenameKey(payload?.data?.wbi_img?.img_url);
  const sub = basenameKey(payload?.data?.wbi_img?.sub_url);
  if (!img || !sub) throw new Error('nav 接口没有返回 wbi 密钥');
  return { imgKey: img, subKey: sub, fetchedAt: Date.now() };
}

/**
 * Read cached keys, refreshing when stale. Cache lives in chrome.storage.local
 * (never synced) and falls back to a module-scoped copy outside an extension context.
 */
let memoryKeys = null;

export async function getWbiKeys({ force = false, fetchFn, credentials = null } = {}) {
  if (!force && memoryKeys && Date.now() - memoryKeys.fetchedAt < KEY_TTL_MS) {
    return memoryKeys;
  }
  let cached = null;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get('wbiKeys');
      cached = stored.wbiKeys || null;
    } catch {
      cached = null;
    }
  }
  if (!force && cached?.imgKey && cached?.subKey && Date.now() - cached.fetchedAt < KEY_TTL_MS) {
    memoryKeys = cached;
    return cached;
  }
  const keys = await fetchWbiKeys({ fetchFn, credentials });
  memoryKeys = keys;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      await chrome.storage.local.set({ wbiKeys: keys });
    } catch {
      /* cache is best-effort */
    }
  }
  return keys;
}
