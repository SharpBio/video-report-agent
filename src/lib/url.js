/**
 * Bilibili URL parsing — a direct port of ingest.py::_parse_bilibili_url.
 * No yt-dlp here: we only normalise and get a canonical URL.
 */
import { fail } from './errors.js';

export const BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com']);
const BVID_PATTERN = /BV[0-9A-Za-z]{10}/;
const PAGE_PATTERN = /^[0-9]+$/;
const SHORT_HOST = 'b23.tv';

/** Strip the 【title】 prefix that Bilibili puts in front of share text. */
function stripSharePrefix(value) {
  return value.replace(/^【[\s\S]*?】\s*/, '').trim();
}

function unwrapMarkdown(value) {
  const match = /^\[[^\]\r\n]*\]\(((?:https:\/\/|www\.)[^\s()]+)\)$/.exec(value);
  return match ? match[1] : value;
}

/**
 * Resolve a b23.tv short link without following it, then validate the target.
 * Only 3xx with a Location header is accepted.
 */
export async function resolveShortLink(url, { fetchFn } = {}) {
  const doFetch = fetchFn || fetch;
  let response;
  try {
    response = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  } catch (error) {
    throw fail.api('URL_RESOLVE_FAILED', 'Bilibili 短链接无法访问。', { cause: String(error) });
  }
  // The Fetch API reports an opaque redirect as status 0 when redirect: "manual".
  const location = response.headers?.get?.('location');
  if (!location) {
    throw fail.api('URL_RESOLVE_FAILED', 'Bilibili 短链接未返回视频地址。');
  }
  return location;
}

/**
 * @returns {{bvid:string, pageNumber:number, submittedUrl:string,
 *            canonicalUrl:string, videoId:string, cacheKey:string}}
 */
export async function parseBilibiliUrl(input, options = {}) {
  if (typeof input !== 'string') {
    throw fail.input('URL_INVALID', 'URL_INVALID');
  }
  let link = unwrapMarkdown(stripSharePrefix(input));
  if (link.startsWith('www.')) link = `https://${link}`;

  if (link.startsWith(`https://${SHORT_HOST}/`)) {
    const parsed = new URL(link);
    if (!/^\/[A-Za-z0-9]+\/?$/.test(parsed.path) || parsed.hash) {
      throw fail.input('URL_INVALID', '无效的 Bilibili 短链接。');
    }
    link = await resolveShortLink(link, options);
  }

  if (BVID_PATTERN.test(link) && link.startsWith('BV')) {
    link = `https://www.bilibili.com/video/${link}/`;
  }
  if (/^BV[0-9A-Za-z]{10}$/.test(link)) {
    link = `https://www.bilibili.com/video/${link}/`;
  }

  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    throw fail.input('URL_INVALID', '无法解析该链接。');
  }
  if (parsed.protocol !== 'https:') throw fail.input('URL_INVALID', '链接必须使用 https。');
  if (!BILIBILI_HOSTS.has(parsed.hostname)) {
    throw fail.input('URL_INVALID', '只支持 bilibili.com 的视频链接。');
  }
  if (parsed.username || parsed.password) throw fail.input('URL_INVALID', '链接不能包含用户名或密码。');
  if (parsed.port) throw fail.input('URL_INVALID', '链接不能包含端口号。');
  if (parsed.hash) throw fail.input('URL_INVALID', '链接不能包含片段标识符。');

  const match = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(parsed.pathname || '');
  if (!match) throw fail.input('URL_INVALID', '链接路径必须是 /video/BV...。');
  const bvid = match[1];

  const pageValues = [...parsed.searchParams].filter(([key]) => key === 'p').map(([, v]) => v);
  if (pageValues.length > 1) throw fail.input('URL_INVALID', '分 P 参数只能出现一次。');
  let pageNumber = 1;
  if (pageValues.length) {
    if (!PAGE_PATTERN.test(pageValues[0])) throw fail.input('URL_INVALID', '分 P 必须是正整数。');
    pageNumber = Number(pageValues[0]);
    if (pageNumber < 1) throw fail.input('URL_INVALID', '分 P 必须是正整数。');
  }

  const canonicalUrl =
    `https://www.bilibili.com/video/${bvid}/` + (pageValues.length ? `?p=${pageNumber}` : '');
  return {
    bvid,
    pageNumber,
    submittedUrl: input,
    canonicalUrl,
    videoId: `bilibili-${bvid}-p${pageNumber}`,
    cacheKey: `${bvid}/P${pageNumber}`,
  };
}

export function attributionFor(uploader, title, canonicalUrl) {
  return `Bilibili；${uploader}；《${title}》；${canonicalUrl}`;
}

/**
 * 把 BV 号 + 分 P 还原成能打开的观看地址。
 * 分 P 必须写进去：不写的话「跳回原视频」一律跳到第 1 个。
 */
export function watchUrl(bvid, pageNumber = 1) {
  if (!bvid) return '';
  const base = `https://www.bilibili.com/video/${bvid}/`;
  const page = Number(pageNumber);
  return Number.isFinite(page) && page > 1 ? `${base}?p=${page}` : base;
}
