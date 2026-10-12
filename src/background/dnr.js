/**
 * Header injection for media CDNs.
 *
 * `Referer` is a forbidden header name, so a plain fetch() from an extension
 * page cannot set it. Bilibili's media hosts reject requests without it, so a
 * session rule adds it for requests we initiate.
 *
 * R1: whether declarativeNetRequest applies to extension-origin requests is
 *     verified at runtime by ./probe.js; if it does not, the pipeline falls
 *     back to fetching through an open Bilibili tab.
 */

const RULE_ID_BASE = 1000;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Hosts that expect a Bilibili referer.
 *
 * 注意 `.cn`：B 站现在的主力媒体 CDN 是 `*.bilivideo.cn`（例如
 * `xy42x202x158x41xy.mcdn.bilivideo.cn:8082`），不是 `.com`。曾经只写了 `.com`，
 * 结果规则一条都没匹配上，页面里取流一律 403，而报错只有一句 "Failed to fetch"。
 */
export const MEDIA_HOSTS = [
  'bilivideo.cn', 'bilivideo.com', 'hdslb.com', 'akamaized.net', 'akamaihd.net', 'bilibili.com',
];

export function ruleFor(index, host, referer) {
  return {
    id: RULE_ID_BASE + index,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: referer },
        { header: 'User-Agent', operation: 'set', value: DESKTOP_UA },
      ],
    },
    condition: {
      // 结尾用 `^`（分隔符）：CDN 域名带端口（`:8082`），写成 `||host/` 会因为
      // 端口挡在中间而匹配不上 —— 规则照样装得上、自检照样显示「N 条规则生效」，
      // 但一条都不会命中。
      urlFilter: `||${host}^`,
      resourceTypes: ['xmlhttprequest', 'media', 'other'],
    },
  };
}

export function rulesFor(referer = 'https://www.bilibili.com/') {
  return MEDIA_HOSTS.map((host, index) => ruleFor(index, host, referer));
}

export async function installRules(referer) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return false;
  const addRules = rulesFor(referer);
  const removeRuleIds = addRules.map((rule) => rule.id);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    return true;
  } catch (error) {
    console.warn('[dnr] 规则安装失败', error?.message);
    return false;
  }
}

export async function removeRules() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  const removeRuleIds = rulesFor().map((rule) => rule.id);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
  } catch {
    /* nothing to remove */
  }
}

/**
 * Canary: ask a referer-echo endpoint whether our header actually arrived.
 * Returns true / false / null (unknown).
 */
export async function probeRefererInjection() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return null;
  const installed = await installRules();
  if (!installed) return null;
  try {
    // 自检会直接调这个函数，没有超时的话一次网络抖动就会把整份清单卡住。
    const response = await fetch('https://httpbin.org/headers', {
      credentials: 'omit',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const headers = payload?.headers || {};
    const key = Object.keys(headers).find((name) => name.toLowerCase() === 'referer');
    return Boolean(key);
  } catch {
    return null;
  }
}
