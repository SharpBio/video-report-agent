/**
 * 一键自检。
 *
 * 这个扩展有几条「只有真跑起来才知道」的运行时假设：
 *   · declarativeNetRequest 的 session rule 会不会改到扩展自己发起的请求（R1）；
 *   · sandboxed iframe 在发布态 CSP 下还能不能 eval；
 *   · offscreen 文档能不能建起来、里面有没有 canvas / DOMParser；
 *   · service worker 拿得到 chrome.storage，offscreen 拿不到。
 * 这些在静态检查里都看不出来，以前只能靠开 DevTools 手动试。
 * 现在设置页点一下「运行自检」就能看到每一项的结论。
 */
import { installRules, probeRefererInjection } from './dnr.js';
import { ensureOffscreen, runTask } from './offscreen-host.js';
import { ensureAlarm, ALARM_NAME } from './supervisor.js';
import { encWbi } from '../lib/wbi.js';
import * as db from '../lib/db.js';
import { originOf, hasOrigins } from './permissions.js';
import { findBilibiliTab, probeMediaInTab } from './tab-fetch.js';
import { loadSettings } from '../lib/settings.js';
import {
  probeUrl, describeProbe, probeBilibiliApi, describeBilibiliApi, bilibiliApiOk,
} from '../lib/netprobe.js';

const PROBE_KEY = 'vraSelftestProbe';

/** 每一项都自己接住异常：自检的目的是给出结论，不是自己崩掉。 */
async function check(name, fn) {
  try {
    const detail = await fn();
    return { name, ok: true, detail: detail == null ? '通过' : String(detail) };
  } catch (error) {
    return { name, ok: false, detail: error?.message || String(error) };
  }
}

async function checkStorage() {
  await chrome.storage.local.set({ [PROBE_KEY]: Date.now() });
  const bag = await chrome.storage.local.get(PROBE_KEY);
  const ok = typeof bag?.[PROBE_KEY] === 'number';
  await chrome.storage.local.remove(PROBE_KEY);
  if (!ok) throw new Error('写入后读不回来。');
  return 'chrome.storage.local 读写正常';
}

async function checkAlarm() {
  await ensureAlarm();
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) throw new Error('闹钟没有创建成功，断线续跑会失效。');
  return `watchdog 已注册，周期 ${Math.round(alarm.periodInMinutes)} 分钟`;
}

async function checkPermissions() {
  const all = await chrome.permissions.getAll();
  const need = ['offscreen', 'declarativeNetRequest', 'downloads', 'storage', 'cookies'];
  const missing = need.filter((p) => !all.permissions?.includes(p));
  if (missing.length) throw new Error(`缺少权限：${missing.join('、')}`);
  return '必需权限齐全';
}

async function checkDnr() {
  const installed = await installRules();
  if (!installed) throw new Error('session rule 安装失败。');
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (!rules.length) throw new Error('规则装了但读不回来。');
  return `${rules.length} 条规则生效（媒体 CDN 的 Referer / UA 注入）`;
}

/**
 * R1 的关键验证：规则装上了，不代表它会作用在扩展自己发起的请求上。
 * 返回 null 表示「测不出来」（多半是没网），不算失败。
 */
async function checkRefererInjection() {
  const result = await probeRefererInjection();
  if (result === true) return 'Referer 确实被注入（走直连下载即可）';
  if (result === false) return '规则没作用在扩展请求上，自动回退到「经标签页取流」';
  return '无法判断（需要外网访问 httpbin）；运行时会自动探测并回退';
}

async function checkIndexedDb() {
  const runs = await db.listRuns();
  return `IndexedDB 可用，现有 ${runs.length} 个任务`;
}

async function checkWbi() {
  const keys = { imgKey: ' '.repeat(32).replace(/ /g, 'a'), subKey: 'b'.repeat(32) };
  const signed = encWbi({ foo: 114, bar: 'x' }, keys);
  if (!/^[0-9a-f]{32}$/.test(String(signed.w_rid))) {
    throw new Error(`w_rid 形态不对：${signed.w_rid}`);
  }
  if (!signed.wts) throw new Error('缺少 wts。');
  return 'wbi 签名自实现可用（wts + 32 位 w_rid）';
}

async function checkHostPermission() {
  const ok = await hasOrigins(['https://www.bilibili.com/']);
  if (!ok) throw new Error('没有 B 站域名的主机权限，公开接口取不到数据。');
  return 'B 站域名已授权';
}

async function checkOffscreen() {
  await ensureOffscreen();
  const result = await runTask({ kind: 'ping' }, { timeoutMs: 15000 });
  if (!result?.ok) throw new Error('offscreen 文档没有响应。');
  return 'offscreen 文档已就绪';
}

/**
 * 最值得验的一条：真在 B 站页面上取一小块音频。
 * 直连下载已经被 R1 证伪，这条链路不通 = 整个流程跑不完。
 * 没有打开的 B 站页面时只能跳过（不算失败）。
 */
async function checkMediaPath() {
  // 探针要从 __playinfo__ 读音频地址，所以必须是视频页。
  const tab = await findBilibiliTab('https://www.bilibili.com/video/');
  if (!tab?.id) return '跳过：当前没有打开的 B 站页面。打开一个视频页再跑才测得出来。';
  // 用标签页自己的地址当 Referer：CDN 认的是「正在看这个视频」的那个页面。
  const outcome = await probeMediaInTab(tab.id, tab.url);
  let host = '';
  try {
    host = outcome.url ? new URL(outcome.url).host : '';
  } catch {
    host = '';
  }
  const suffix = host ? `（${host}）` : '';
  if (!outcome.ok) throw new Error(`${outcome.detail}${suffix}`);
  return `${outcome.detail}${suffix} —— 经标签页取流可用`;
}

/**
 * 远端服务连通性：**两个上下文各测一次**。
 *
 * 只在一个上下文测是不够的 —— 同样的 fetch 在 service worker 里能过、在 offscreen 里
 * 未必能过，而两边的失败都只报一句 "Failed to fetch"，分辨不出来。
 * 这一项会同时给出 host 是否在已授权列表里，因为缺主机权限的表现也是同一句话。
 */
async function checkReach(label, { url, headers, expect }) {
  const mine = await probeUrl({ url, headers, timeoutMs: 20000 });
  let other = null;
  try {
    other = await runTask({
      kind: 'netprobe',
      probe: { url, headers, timeoutMs: 20000 },
    }, { timeoutMs: 30000 });
  } catch (error) {
    other = { ok: false, name: 'Error', message: error?.message || String(error) };
  }

  const origin = originOf(url);
  const granted = origin ? Boolean(await hasOrigins([origin])) : true;
  const text = `SW ${describeProbe(mine)}；offscreen ${describeProbe(other)}`;
  const notes = [];
  if (!granted) {
    notes.push(`主机权限未授予 ${origin}，fetch 会被浏览器直接拒掉（报错同样是 "Failed to fetch"）`);
  }
  if (mine.status === 401 || mine.status === 403) notes.push('401/403 = API Key 不对或没权限');
  const suffix = notes.length ? `（${notes.join('；')}）` : '';

  const good = mine.ok && other?.ok && expect(mine.status);
  if (!good) throw new Error(`${label}：${text}${suffix}`);
  return `${label}：${text}${suffix}`;
}

/**
 * 元数据链路：nav（wbi 密钥）＋ view（标题/时长）—— 流水线真正的第一跳。
 *
 * 之前自检只测了 ASR 和大模型，唯独没测 B 站接口，于是这一跳炸了两轮都没被发现：
 * 它用的 credentials:'include' 在扩展里拿不到 CORS 豁免，报错同样只有一句
 * "Failed to fetch"。所以这里 **omit 和 include 各测一次**。
 */
async function checkBilibiliApi() {
  const tab = await findBilibiliTab('https://www.bilibili.com/video/');
  const bvid = /(BV[0-9A-Za-z]{10})/.exec(String(tab?.url || ''))?.[1] || '';

  const mine = await probeBilibiliApi({ bvid });
  let other = null;
  let otherNote = '';
  try {
    other = await runTask({ kind: 'apiprobe', bvid }, { timeoutMs: 45000 });
  } catch (error) {
    otherNote = `没返回：${error?.message || String(error)}`;
  }

  const text = `SW ${describeBilibiliApi(mine)}；offscreen ${
    other ? describeBilibiliApi(other) : otherNote}`;

  const navOk = bilibiliApiOk(mine) || bilibiliApiOk(other);
  if (!navOk) throw new Error(text);
  // 有 bvid 才要求 view 也过：拿不到标题，后面整条链路都是无标题的。
  if (bvid && !mine.view?.ok && !other?.view?.ok) throw new Error(text);
  return text;
}

async function checkAsrReach() {
  const settings = await loadSettings();
  const base = String(settings.asr?.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('没填语音识别接口地址。');
  if (!settings.asr?.apiKey) throw new Error('没填语音识别的 API Key（设置页「语音识别」一节）。');
  return checkReach('上传凭证接口', {
    url: `${base}/uploads?action=getPolicy&model=${encodeURIComponent(settings.asr.model)}`,
    headers: { Authorization: `Bearer ${settings.asr.apiKey}` },
    expect: (status) => status >= 200 && status < 300,
  });
}

async function checkLlmReach() {
  const settings = await loadSettings();
  const base = String(settings.llm?.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('没填大模型接口地址。');
  if (!settings.llm?.apiKey) throw new Error('没填大模型的 API Key（设置页「大模型」一节）。');
  return checkReach('模型列表接口', {
    url: `${base}/models`,
    headers: { Authorization: `Bearer ${settings.llm.apiKey}` },
    expect: (status) => status >= 200 && status < 300,
  });
}

/** offscreen 里的检查需要 document，只能在那个上下文跑。 */
async function checkOffscreenInternals() {
  await ensureOffscreen();
  const items = await runTask({ kind: 'selftest' }, { timeoutMs: 30000 });
  return Array.isArray(items) ? items : [];
}

/**
 * @returns {Promise<{ok:boolean, items:Array<{name:string, ok:boolean, detail:string}>}>}
 */
export async function runSelfTest() {
  const items = [];

  items.push(await check('storage（service worker 读写设置）', checkStorage));
  items.push(await check('权限', checkPermissions));
  items.push(await check('主机权限（B 站）', checkHostPermission));
  items.push(await check('watchdog 闹钟', checkAlarm));
  items.push(await check('declarativeNetRequest 规则', checkDnr));
  items.push(await check('Referer 注入是否生效（R1）', checkRefererInjection));
  items.push(await check('IndexedDB', checkIndexedDb));
  items.push(await check('wbi 签名（纯本地实现）', checkWbi));
  items.push(await check('offscreen 文档', checkOffscreen));
  items.push(await check('Bilibili 接口连通性（元数据第一跳）', checkBilibiliApi));
  items.push(await check('媒体下载链路（经标签页取流）', checkMediaPath));
  items.push(await check('语音识别（百炼）连通性', checkAsrReach));
  items.push(await check('大模型连通性', checkLlmReach));

// 注意：不能用 check() 包这一项 —— check() 会把返回值 String() 掉，
// 数组就变成 "[object Object],[object Object]..."，7 项自检被压成一行看不出内容。
try {
  const inner = await checkOffscreenInternals();
  if (Array.isArray(inner) && inner.length) items.push(...inner);
  else items.push({ name: 'offscreen 内部能力', ok: false, detail: 'offscreen 没有返回检查项。' });
} catch (error) {
  items.push({ name: 'offscreen 内部能力', ok: false, detail: error?.message || String(error) });
}

  return { ok: items.every((item) => item.ok), items };
}
