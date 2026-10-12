/**
 * 连通性探针：把「配置对不对 / 网络通不通 / 这个上下文能不能发出去」三件事一次测清。
 *
 * 之所以要**分上下文各测一次**：同样的 `fetch` 在 service worker 里能过、
 * 在 offscreen 文档里未必能过（反之亦然）。只在一个上下文测，会把另一半的可能性
 * 全部留在猜测里 —— 而这类失败的报错都只是一句 "Failed to fetch"。
 */
import { fetchView } from './bilibili-api.js';

const NAV_ENDPOINT = 'https://api.bilibili.com/x/web-interface/nav';

/**
 * 一次请求，两种凭证模式都测。
 *
 * 扩展里带凭证的跨域请求拿不到 CORS 豁免（见 src/lib/http.js），所以
 * 「omit 通 / include 炸」是最典型的失败形态 —— 只测一种永远看不出来。
 */
export async function probeCredentials(url, { timeoutMs = 15000 } = {}) {
  return {
    omit: await probeUrl({ url, credentials: 'omit', timeoutMs }),
    include: await probeUrl({ url, credentials: 'include', timeoutMs }),
  };
}

/**
 * 复现真实的元数据链路：nav（wbi 密钥）＋ view（标题/时长）。
 * 这里故意走 fetchView 本尊，而不是自己拼一个请求 —— 自检要验的就是生产路径。
 */
export async function probeBilibiliApi({ bvid = '' } = {}) {
  const nav = await probeCredentials(NAV_ENDPOINT);
  const out = { nav };
  if (bvid) {
    const started = Date.now();
    try {
      const video = await fetchView({ bvid });
      out.view = { ok: true, ms: Date.now() - started, title: video.title, ms2: video.durationMs };
    } catch (error) {
      out.view = {
        ok: false,
        ms: Date.now() - started,
        name: error?.name || 'Error',
        message: redact(error?.message || String(error)),
      };
    }
  }
  return out;
}

/** 把 probeBilibiliApi 的结果压成一句能直接显示的话。 */
export function describeBilibiliApi(report, label = '') {
  const prefix = label ? `${label} ` : '';
  if (!report?.nav) return `${prefix}没有返回结果`;
  const parts = [
    `nav omit ${describeProbe(report.nav.omit)}`,
    `nav include ${describeProbe(report.nav.include)}`,
  ];
  if (report.view) {
    parts.push(report.view.ok
      ? `view 取到《${report.view.title}》`
      : `view 失败 ${report.view.name}: ${report.view.message}`);
  }
  return prefix + parts.join('；');
}

/** 两种模式都不通才算失败；只要有一条路能走，流水线就能跑。 */
export function bilibiliApiOk(report) {
  return Boolean(report?.nav?.omit?.ok || report?.nav?.include?.ok);
}

function redact(value) {
  return String(value || '')
    .replace(/(?:https?:\/\/|oss:\/\/)[^\s"'<>]+/g, '[url]')
    .replace(/\b(?:sk-[\w-]+|Bearer\s+\S+)/g, '[credential]');
}

/**
 * @returns {Promise<{ok:boolean, status?:number, ms:number, name?:string,
 *                    message?:string, snippet?:string}>}
 * 不抛异常：结论本身就是要给出去看的信息。
 */
export async function probeUrl({
  url, method = 'GET', headers = {}, body = null, timeoutMs = 15000, credentials = 'omit',
} = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body || undefined,
      credentials,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let snippet = '';
    try {
      snippet = redact(await response.clone().text()).slice(0, 200).trim();
    } catch {
      /* 读不到正文就算了，状态码才是重点 */
    }
    return { ok: true, status: response.status, ms: Date.now() - started, snippet };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      name: error?.name || 'Error',
      message: redact(error?.message || String(error)),
    };
  }
}

/** 把探针结果压成一句能直接显示的话。 */
export function describeProbe(result, label = '') {
  const prefix = label ? `${label} ` : '';
  if (!result) return `${prefix}没有返回结果`;
  if (result.ok) return `${prefix}HTTP ${result.status}（${result.ms} ms）`;
  if (result.name === 'TimeoutError' || result.name === 'AbortError') {
    return `${prefix}超时（${result.ms} ms）`;
  }
  return `${prefix}失败 ${result.name}: ${result.message}`;
}
