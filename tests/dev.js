/**
 * Dev harness — the case list is the single source of truth for this project's
 * contracts: URL validation, base-URL validation, transcript format,
 * deterministic assembly, ASR normalisation.
 *
 * How to run it (file:// does NOT work — Chrome blocks ES modules there):
 *   1. Headless, no browser:   node tests/run.mjs
 *   2. In the browser, as an extension page:
 *        chrome-extension://<extension-id>/tests/dev.html
 *   3. In the browser, over http:
 *        python -m http.server 8765 --directory <extension-dir>
 *        then open http://127.0.0.1:8765/tests/dev.html
 */
import { md5 } from '../src/lib/md5.js';
import { encWbi } from '../src/lib/wbi.js';
import { parseBilibiliUrl, attributionFor, watchUrl } from '../src/lib/url.js';
import { pickPage, probeMatches, readInitialState } from '../src/lib/bilibili-page.js';
import { validateBaseUrl } from '../src/lib/validate-settings.js';
import {
  buildTranscript, parseTranscript, sectionTimeFor, unitId, unitsFromSegments, formatClock,
} from '../src/lib/transcript.js';
import { assembleReport, stripComments, timeForSection } from '../src/lib/assemble.js';
import { fillVideoDescription } from '../src/lib/postprocess.js';
import { validateReport } from '../src/lib/validate.js';
import { normalizeAsrSegments } from '../src/lib/asr-normalize.js';
import { planFor, candidateUrls, referrersFor } from '../src/background/tab-fetch.js';
import { rulesFor, MEDIA_HOSTS } from '../src/background/dnr.js';
import { describeProbe } from '../src/lib/netprobe.js';
import { fetchWithLadder } from '../src/lib/http.js';
import { promptPath } from '../src/lib/prompts.js';
import { describeBilibiliApi, bilibiliApiOk } from '../src/lib/netprobe.js';
import {
  runDir, ensureDir, writeBytes, appendChunks, fileSize,
} from '../src/lib/opfs.js';
import {
  filterRuns, statsFor, formatBytes, formatDuration, relativeTime, formatTokens,
} from '../src/lib/history-query.js';
import {
  canvasFits, stripScale, fitScaleToCanvas, stripSource, dedupeStrips,
} from '../src/lib/stitch.js';
import { nextShotDelay, planStrips } from '../src/background/capture.js';
/** Exported so tests/run.mjs can reuse the exact same cases under Node. */
export const rows = [];

function eq(actual, expected, label = '') {
  if (actual !== expected) {
    throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  return `${label}${JSON.stringify(expected)}`;
}

function ok(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
  return message || 'ok';
}

async function test(name, fn) {
  try {
    rows.push({ name, pass: true, detail: (await fn()) || '' });
  } catch (error) {
    rows.push({ name, pass: false, detail: error?.message || String(error) });
  }
}

/* ---------------- md5 / wbi ---------------- */

await test('md5 向量', () => {
  eq(md5(''), 'd41d8cd98f00b204e9800998ecf8427e', 'empty ');
  eq(md5('hello'), '5d41402abc4b2a76b9719d911017c592', 'hello ');
  eq(md5('中文'), 'a7bac2239fcdcb3a067903d8077c4a07', 'zh ');
  return '三个向量一致';
});

await test('wbi 签名结构', () => {
  const signed = encWbi({ bvid: 'BV1iSbX6DEFH', foo: 2 },
    { imgKey: 'a'.repeat(32), subKey: 'b'.repeat(32) });
  ok(/^[0-9a-f]{32}$/.test(signed.w_rid), 'w_rid 不是 32 位小写十六进制');
  ok(Number.isFinite(signed.wts), '缺少 wts');
  eq(Object.keys(signed).slice(0, 2).join(','), 'bvid,foo', '参数按名排序 ');
  return `w_rid=${signed.w_rid.slice(0, 8)}…`;
});

await test("wbi 过滤 !'()* 后再编码", () => {
  const signed = encWbi({ bvid: "BV1!'()*x" }, { imgKey: 'a'.repeat(32), subKey: 'b'.repeat(32) });
  ok(/^[0-9a-f]{32}$/.test(signed.w_rid), '签名异常');
  return '签名仍为合法 md5';
});

/* ---------------- URL ---------------- */

const URL_CASES = [
  ['https://www.bilibili.com/video/BV1iSbX6DEFH/', true, 'BV1iSbX6DEFH', 1],
  ['https://www.bilibili.com/video/BV1iSbX6DEFH/?p=3', true, 'BV1iSbX6DEFH', 3],
  ['BV1iSbX6DEFH', true, 'BV1iSbX6DEFH', 1],
  ['【标题】 https://www.bilibili.com/video/BV1iSbX6DEFH/', true, 'BV1iSbX6DEFH', 1],
  ['[标题](https://www.bilibili.com/video/BV1iSbX6DEFH/)', true, 'BV1iSbX6DEFH', 1],
  ['www.bilibili.com/video/BV1iSbX6DEFH/', true, 'BV1iSbX6DEFH', 1],
  ['https://www.bilibili.com/video/BV1iSbX6DEFH/#frag', false],
  ['http://www.bilibili.com/video/BV1iSbX6DEFH/', false],
  ['https://www.bilibili.com:8443/video/BV1iSbX6DEFH/', false],
  ['https://user:pw@www.bilibili.com/video/BV1iSbX6DEFH/', false],
  ['https://www.bilibili.com/video/BV1iSbX6DEFH/?p=1&p=2', false],
  ['https://www.bilibili.com/video/BV1iSbX6DEFH/?p=x', false],
  ['https://example.com/video/BV1iSbX6DEFH/', false],
  ['https://www.bilibili.com/list/watchlater?bvid=BV1iSbX6DEFH', false],
];

for (const [input, expected, bvid, page] of URL_CASES) {
  await test(`URL：${input}`, async () => {
    let parsed = null;
    let error = null;
    try {
      parsed = await parseBilibiliUrl(input);
    } catch (caught) {
      error = caught;
    }
    if (expected) {
      ok(!error, `应通过但被拒：${error?.message}`);
      eq(parsed.bvid, bvid, 'bvid ');
      eq(parsed.pageNumber, page, 'page ');
      return parsed.canonicalUrl;
    }
    ok(!!error, '应拒绝但通过了');
    return `已拒绝（${error.code || error.message}）`;
  });
}

/* ---------------- 分 P：多 P 视频必须拿到指定那一 P ---------------- */

const PAGES = [
  { page: 1, cid: 111, duration: 100 },
  { page: 2, cid: 222, duration: 200 },
  { page: 3, cid: 333, duration: 300 },
];

await test('分 P 选择：按 page 字段找，不按下标', () => {
  eq(pickPage(PAGES, 2).cid, 222, '第 2 个 ');
  eq(pickPage(PAGES, 3).cid, 333, '第 3 个 ');
  eq(pickPage([{ page: 5, cid: 555 }, { page: 2, cid: 222 }], 2).cid, 222, '乱序也能找对 ');
  eq(pickPage([{ page: 1, cid: 1 }, { page: 3, cid: 3 }], 2).cid, 3, '缺项退回最后存在的 ');
  eq(pickPage(PAGES, 99).cid, 333, '越界退回最后一个 ');
  eq(pickPage([], 2), null, '没有分 P 列表 ');
  return '按 page 字段匹配，越界退回最后一个';
});

await test('页面探测：URL 的 ?p= 才是当前分 P（state 里没有这个字段）', () => {
  const win = (search, extra = {}) => ({
    location: { href: `https://www.bilibili.com/video/BV1xx411c7mD/${search}`, search },
    __INITIAL_STATE__: { ...extra, videoData: { bvid: 'BV1xx411c7mD', pages: PAGES } },
  });
  // 关键回归：新版的 __INITIAL_STATE__ 里根本没有当前分 P 字段，旧实现会算成 1，
  // 于是「多 P 视频永远拿到第一个」。
  const third = readInitialState(win('?p=3'));
  eq(third.pageNumber, 3, '分 P 号 ');
  eq(third.cid, 333, '第 3 个的 cid ');
  eq(third.durationMs, 300000, '第 3 个的时长 ');
  eq(readInitialState(win('?p=3', { p: 1 })).cid, 333, 'URL 优先于 state.p ');
  eq(readInitialState(win('')).pageNumber, 1, '没有 ?p= 就是第 1 个 ');
  return `P3 → cid ${third.cid}`;
});

await test('探测结果必须是同一个视频的同一个分 P，否则不能用', () => {
  const probeOf = (bvid, pageNumber) => ({ ok: true, video: { bvid, pageNumber, cid: 1 } });
  const source = { bvid: 'BV1xx411c7mD', pageNumber: 3 };
  eq(probeMatches(probeOf('BV1xx411c7mD', 3), source), true, '完全一致 ');
  eq(probeMatches(probeOf('BV1xx411c7mD', 1), source), false, '同一视频不同分 P ');
  eq(probeMatches(probeOf('BVother12345', 3), source), false, '另一个视频 ');
  eq(probeMatches({ ok: false }, source), false, '探测失败 ');
  eq(probeMatches(null, source), false, '没有探测 ');
  return '粘贴的链接不会被当前打开的页面顶掉';
});

await test('跳回原视频要带上分 P', () => {
  eq(watchUrl('BV1xx411c7mD', 3), 'https://www.bilibili.com/video/BV1xx411c7mD/?p=3', '第 3 个 ');
  eq(watchUrl('BV1xx411c7mD', 1), 'https://www.bilibili.com/video/BV1xx411c7mD/', '第 1 个不写 p ');
  eq(watchUrl('BV1xx411c7mD', 0), 'https://www.bilibili.com/video/BV1xx411c7mD/', '异常值按第 1 个 ');
  eq(watchUrl('', 2), '', '没有 BV 号 ');
  return '分 P 写在地址里';
});

/* ---------------- base URL ---------------- */

const BASE_CASES = [
  ['https://api.deepseek.com/v1', true, 'https://api.deepseek.com'],
  ['https://api.deepseek.com/v1/', true, 'https://api.deepseek.com'],
  ['https://api.example.com', true, 'https://api.example.com'],
  ['http://api.example.com/v1', false],
  ['https://user:pw@api.example.com/v1', false],
  ['https://api.example.com/v1?key=1', false],
  ['https://api.example.com/v1#frag', false],
  ['ftp://api.example.com', false],
  ['javascript:alert(1)', false],
  ['', false],
];

for (const [value, expected, origin] of BASE_CASES) {
  await test(`接口地址：${value || '（空）'}`, () => {
    const check = validateBaseUrl(value);
    eq(check.ok, expected, 'ok ');
    if (expected) eq(check.origin, origin, 'origin ');
    return check.ok ? check.origin : check.message;
  });
}

await test('本地地址默认拒绝', () => {
  ok(!validateBaseUrl('http://localhost:11434/v1').ok, 'localhost 应默认被拒绝');
  ok(validateBaseUrl('http://localhost:11434/v1', { allowInsecureLocalhost: true }).ok,
    '显式允许时应通过');
  return '默认拒绝，显式允许可用';
});

/* ---------------- transcript ---------------- */

await test('转写往返', () => {
  const units = [
    { unitId: unitId(1), startMs: 90, endMs: 3790, text: '第一句' },
    { unitId: unitId(2), startMs: 3790, endMs: 8000, text: '第二句' },
  ];
  const text = buildTranscript({ title: '标题', attribution: 'Bilibili；UP；《标题》；url', units });
  const parsed = parseTranscript(text);
  eq(parsed.title, '标题', 'title ');
  eq(parsed.units.length, 2, 'units ');
  eq(parsed.units[0].startMs, 90, 'start ');
  eq(parsed.units[1].text, '第二句', 'text ');
  ok(text.includes('[unit-000001 | 0.090–3.790s]'), '应为 U+2013 + 三位小数');
  return '两个单元无损往返';
});

await test('转写兼容 ASCII 短横线', () => {
  eq(parseTranscript('[unit-000001 | 0.000-1.000s] 内容').units.length, 1, 'units ');
  return 'U+2013 / U+2014 / - 均可解析';
});

await test('章节时间由来源单元计算', () => {
  eq(sectionTimeFor([
    { unitId: 'a', startMs: 0, endMs: 60000 },
    { unitId: 'b', startMs: 120000, endMs: 180500 },
  ], { hours: false }), '00:00–01:00；02:00–03:01', '');
  return '不连续区间用中文分号连接';
});

await test('超过一小时使用 HH:MM:SS', () => {
  eq(sectionTimeFor([{ unitId: 'a', startMs: 3661000, endMs: 3720000 }], { hours: true }),
    '01:01:01–01:02:00', '');
  return 'HH:MM:SS';
});

await test('unitsFromSegments 与 formatClock', () => {
  const units = unitsFromSegments([{ ordinal: 1, startMs: 0, endMs: 61000, text: 'a' }]);
  eq(units[0].unitId, 'unit-000001', 'unitId ');
  eq(formatClock(61000), '01:01', 'mm:ss ');
  eq(formatClock(3661000), '01:01:01', 'hh:mm:ss ');
  return '编号与时间格式正确';
});

/* ---------------- assembly ---------------- */

const TEMPLATE = '<!doctype html><html><head><title>{{TITLE}}</title></head><body><main class="paper">'
  + '<header class="intro"><h1>{{TITLE}}</h1><p class="subtitle">{{SUBTITLE}}</p>'
  + '<p class="lead">{{LEAD}}</p><p class="meta">{{ATTRIBUTION}}</p></header>'
  + '<!-- 注释 -->{{VIDEO_DESCRIPTION}}{{BODY}}'
  + '<details><summary>来源</summary>{{SOURCES}}</details>'
  + '<footer><span>视频报告·精读</span><a class="footer-link" href=":)">:)</a></footer>'
  + '</main></body></html>';

await test('装配：占位符、序号、章节时间、页尾', () => {
  const units = [
    { unitId: 'unit-000001', startMs: 0, endMs: 60000 },
    { unitId: 'unit-000002', startMs: 60000, endMs: 120000 },
  ];
  const html = assembleReport({
    template: TEMPLATE,
    meta: { title: '标<题', subtitle: '', lead: '导语', attribution: attributionFor('UP', '标<题', 'https://x/') },
    sections: [
      { id: 'a', order: 1, title: '第一章', html: '<p data-source-units="unit-000001">正文一</p>', sourceUnits: ['unit-000001'] },
      { id: 'b', order: 2, title: '第二章', html: '<p data-source-units="unit-000002">正文二</p>', sourceUnits: ['unit-000002'] },
    ],
    units,
    totalDurationMs: 120000,
    footerUrl: 'https://github.com/SharpBio/video-report-agent',
  });
  ok(!html.includes('{{'), '仍有未替换的占位符');
  ok(html.includes('<title>标&lt;题</title>'), 'title 未转义');
  ok(!html.includes('class="subtitle"'), '空副标题应删除元素');
  ok(html.includes('<span class="num">1</span>'), '缺少章节序号');
  ok(html.includes('<span class="section-time">00:00–01:00</span>'), '章节时间错误');
  ok(!html.includes('report-nav'), '少于三章不应生成目录');
  ok(html.includes('github.com/SharpBio/video-report-agent'), '页尾链接未替换');
  ok(!html.includes('<!-- 注释 -->'), '注释未剥离');
  return '全部结构由运行时生成';
});

await test('装配：三章以上生成目录', () => {
  const html = assembleReport({
    template: TEMPLATE,
    meta: { title: 'T', subtitle: 'S', lead: 'L', attribution: 'A' },
    sections: [
      { id: 'a', order: 1, title: '一', html: '<p>1</p>' },
      { id: 'b', order: 2, title: '二', html: '<p>2</p>' },
      { id: 'c', order: 3, title: '三', html: '<p>3</p>', nav: '三短' },
    ],
    units: [],
    footerUrl: '',
  });
  ok(html.includes('<nav class="report-nav"'), '缺少目录');
  ok(html.includes('<a href="#s3">三短</a>'), '目录短标签未生效');
  return '目录与短标签';
});

await test('章节时间回退到 unitRange', () => {
  const units = [
    { unitId: 'unit-000001', startMs: 0, endMs: 1000 },
    { unitId: 'unit-000002', startMs: 2000, endMs: 3000 },
  ];
  eq(timeForSection({ unitRange: [1, 2], sourceUnits: [] }, units, false), '00:00–00:03', '');
  return '没有 sourceUnits 时用区间';
});

await test('剥离注释但保留简介标记', () => {
  const result = stripComments('<!-- a -->x<!-- VIDEO_DESCRIPTION_START -->y<!-- VIDEO_DESCRIPTION_END -->');
  ok(!result.includes('<!-- a -->'), '普通注释未剥离');
  ok(result.includes('VIDEO_DESCRIPTION_START'), '简介标记被误删');
  return '只保留简介边界';
});

await test('简介填充幂等', () => {
  const once = fillVideoDescription('{{VIDEO_DESCRIPTION}}', '简介 & 原文');
  const twice = fillVideoDescription(once, '简介 & 原文');
  eq((twice.match(/VIDEO_DESCRIPTION_START/g) || []).length, 1, '标记数 ');
  ok(twice.includes('&amp;'), '简介未转义');
  ok(!fillVideoDescription(twice, '').includes('VIDEO_DESCRIPTION'), '空简介应整块移除');
  return '填充两次不叠加，清空可移除';
});

/* ---------------- validation ---------------- */

await test('检查：非法来源 id', () => {
  const findings = validateReport('<p data-source-units="unit-000001 unit-999999 bad">x</p>', ['unit-000001']);
  const invalid = findings.find((item) => item.kind === 'invalid_source_ids');
  ok(invalid, '未发现非法 id');
  eq(invalid.invalidIds.length, 2, '非法数量 ');
  return 'unit-999999 与 bad 均被标记';
});

await test('检查：缺少绑定与空章节', () => {
  const findings = validateReport('<section id="s1"><h2><span class="num">1</span></h2></section>', ['unit-000001']);
  ok(findings.some((item) => item.kind === 'missing_source_bindings'), '未发现缺少绑定');
  ok(findings.some((item) => item.kind === 'empty_section'), '未发现空章节');
  return '两类问题都被发现';
});

/* ---------------- ASR ---------------- */

await test('ASR 片段：序号可断、重叠致命', () => {
  const out = normalizeAsrSegments([
    { start: 0, end: 1, text: 'a', ordinal: 1 },
    { start: 1, end: 2, text: 'b', ordinal: 3 },
  ]);
  eq(out.segments.length, 2, 'segments ');
  let threw = false;
  try {
    normalizeAsrSegments([
      { start: 0, end: 1.5, text: 'a' },
      { start: 1, end: 2, text: 'b' },
    ]);
  } catch {
    threw = true;
  }
  ok(threw, '重叠片段应报错');
  return '断号允许，重叠致命';
});

/* ---------------- 取流组合 ---------------- */

await test('取流尝试顺序：omit + 显式 Referer 排在最前', () => {
  const plan = planFor(['https://www.bilibili.com/video/BV1ueHs6kEgy/']);
  ok(plan.length >= 4, '至少四种组合');
  eq(plan[0].init.credentials, 'omit', '首选凭证 ');
  eq(plan[0].init.referrerPolicy, 'unsafe-url', '首选 referrerPolicy ');
  ok(
    String(plan[0].init.referrer).startsWith('https://www.bilibili.com/'),
    '首选必须带显式 Referer',
  );
  // 兜底组合不能带 referrer，否则永远测不出「页面默认策略」行不行。
  const last = plan.at(-1);
  eq(last.init.referrer, undefined, '兜底组合不指定 referrer ');
  return `${plan.length} 种组合，omit 优先`;
});

await test('候选地址：http:// 先升 https:// 再保留原样', () => {
  const urls = candidateUrls(['http://a.mcdn.bilivideo.cn:8082/x.m4s']);
  eq(urls.length, 2, '变体数 ');
  eq(urls[0], 'https://a.mcdn.bilivideo.cn:8082/x.m4s', 'https 变体 ');
  eq(urls[1], 'http://a.mcdn.bilivideo.cn:8082/x.m4s', '原始地址 ');
  eq(candidateUrls(['https://x/y.m4s']).length, 1, 'https 不额外造变体 ');
  return 'http 升级在前，https 原样';
});

await test('Referer 候选：视频页优先、去重、拒绝外站', () => {
  const refs = referrersFor('https://www.bilibili.com/video/BV1ueHs6kEgy/?p=1');
  eq(refs[0], 'https://www.bilibili.com/video/BV1ueHs6kEgy/?p=1', '视频页 ');
  eq(refs.length, 2, '去重后 ');
  const fallback = referrersFor('https://evil.example.com/video/BV1');
  eq(fallback.length, 1, '外站只留主页 ');
  eq(fallback[0], 'https://www.bilibili.com/', '主页兜底 ');
  return '视频页 → 主页，去重生效';
});

await test('DNR 规则覆盖带端口的 CDN 域名', () => {
  ok(MEDIA_HOSTS.includes('bilivideo.cn'), '必须含 bilivideo.cn（主力 CDN 后缀）');
  for (const rule of rulesFor()) {
    ok(/\^$/.test(rule.condition.urlFilter), `urlFilter 应以 ^ 结尾：${rule.condition.urlFilter}`);
    ok(
      rule.condition.resourceTypes.includes('xmlhttprequest'),
      '页面 fetch 属于 xmlhttprequest，必须覆盖',
    );
  }
  return `${rulesFor().length} 条规则，urlFilter 均以 ^ 结尾`;
});

/* ---------------- OPFS ---------------- */

/**
 * Node 里没有 OPFS，但 `runDir` 的 bug 恰恰是「少写 await」这种纯逻辑错，
 * 用假句柄就能测出来 —— 真机上它的表现是 "parent.getDirectoryHandle is not a function"。
 */
function mockOpfs() {
  const files = new Map();
  const makeDir = (name) => {
    const children = new Map();
    return {
      kind: 'directory',
      name,
      async getDirectoryHandle(child) {
        if (!children.has(child)) children.set(child, makeDir(child));
        return children.get(child);
      },
      async getFileHandle(child, { create = false } = {}) {
        const key = `${name}/${child}`;
        if (!files.has(key) && !create) throw new Error(`NotFound: ${key}`);
        if (!files.has(key)) files.set(key, []);
        return {
          kind: 'file',
          async createWritable() {
            const chunks = [];
            return {
              async write(bytes) { chunks.push(bytes); },
              async close() { files.set(key, chunks); },
            };
          },
          async getFile() {
            return { name: child, size: (files.get(key) || []).reduce((n, c) => n + c.length, 0) };
          },
        };
      },
      async removeEntry() {},
    };
  };
  return { getDirectory: async () => makeDir('root') };
}

await test('OPFS 逐级 await：runDir 必须返回目录句柄', async () => {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: mockOpfs() }, configurable: true, writable: true,
  });
  try {
    const dir = await runDir('run-1');
    ok(typeof dir?.getFileHandle === 'function', 'runDir 应返回目录句柄');
    ok(typeof dir?.getDirectoryHandle === 'function', '返回值应能再开子目录');

    await writeBytes('run-1', 'audio.m4a', new Uint8Array([1, 2, 3]));
    await appendChunks('run-1', 'notes.txt', [new Uint8Array([4, 5])]);
    eq(await fileSize('run-1', 'audio.m4a'), 3, 'audio 大小 ');
    eq(await fileSize('run-1', 'notes.txt'), 2, 'notes 大小 ');
    eq(await fileSize('run-1', '不存在.m4a'), 0, '缺失文件 ');
    return 'runDir / writeBytes / appendChunks / fileSize 全通';
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: original, configurable: true, writable: true,
    });
  }
});

await test('OPFS 防御：传 Promise 进去会给出人话报错', async () => {
  let message = '';
  try {
    await ensureDir(Promise.resolve({}), 'x');
  } catch (error) {
    message = error?.message || '';
  }
  ok(/await/.test(message) || /目录句柄/.test(message), `报错应点名 await，实际：${message}`);
  return message;
});

await test('连通性探针：三种结果都能说人话', () => {
  ok(/HTTP 200/.test(describeProbe({ ok: true, status: 200, ms: 42 })), '成功应带状态码');
  const timedOut = describeProbe({ ok: false, name: 'TimeoutError', message: 'x', ms: 9000 });
  ok(/超时/.test(timedOut), `超时应说超时，实际：${timedOut}`);
  const failed = describeProbe({ ok: false, name: 'TypeError', message: 'Failed to fetch', ms: 5 });
  ok(/Failed to fetch/.test(failed), '失败应保留原始原因');
  ok(!/\bundefined\b/.test(failed), '不该出现 undefined');
  return `${timedOut} / ${failed}`;
});

/* ---------------- 跨域取请求（凭证 ladder） ---------------- */

/**
 * 这组用例守的是同一个坑的两次翻车：
 * 扩展里 credentials:'include' 的跨域请求拿不到 CORS 豁免，B 站又不给
 * chrome-extension:// 的 origin 回 CORS 头，于是只剩一句 "Failed to fetch"。
 * 所以必须 omit 优先，且失败时要把每种模式的原因都列出来。
 */
function fakeFetch({ succeedOn = 'omit', throwOn = [] } = {}) {
  const calls = [];
  return {
    calls,
    fn: async (url, options) => {
      calls.push(options?.credentials);
      if (throwOn.includes(options?.credentials)) {
        const error = new Error('Failed to fetch');
        error.name = 'TypeError';
        throw error;
      }
      if (options?.credentials === succeedOn) return { ok: true, status: 200 };
      const error = new Error('Failed to fetch');
      error.name = 'TypeError';
      throw error;
    },
  };
}

await test('ladder：omit 通就不再试 include', async () => {
  const fake = fakeFetch({ succeedOn: 'omit' });
  const got = await fetchWithLadder('https://api.bilibili.com/x', { fetchFn: fake.fn });
  ok(got.credentials === 'omit', '生效模式应为 omit');
  ok(fake.calls.length === 1, `只应发一次请求，实际 ${fake.calls.length} 次`);
  ok(fake.calls[0] === 'omit', '第一次必须是 omit');
});

await test('ladder：omit 被拒时降级到 include', async () => {
  const fake = fakeFetch({ succeedOn: 'include', throwOn: ['omit'] });
  const got = await fetchWithLadder('https://api.bilibili.com/x', { fetchFn: fake.fn });
  ok(got.credentials === 'include', '应降级到 include');
  ok(fake.calls.join(',') === 'omit,include', `顺序应为 omit,include，实际 ${fake.calls.join(',')}`);
});

await test('ladder：全失败时把两种模式的原因都列出来', async () => {
  const fake = fakeFetch({ succeedOn: 'none', throwOn: ['omit', 'include'] });
  let message = '';
  try {
    await fetchWithLadder('https://api.bilibili.com/x', { fetchFn: fake.fn });
  } catch (error) {
    message = error?.message || '';
  }
  ok(message.includes('omit'), `报错要带 omit 的原因：${message}`);
  ok(message.includes('include'), `报错要带 include 的原因：${message}`);
});

await test('ladder：超时不降级，直接抛', async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    const error = new Error('timed out');
    error.name = 'AbortError';
    throw error;
  };
  let name = '';
  try {
    await fetchWithLadder('https://api.bilibili.com/x', { fetchFn: fn });
  } catch (error) {
    name = error?.name || '';
  }
  ok(name === 'AbortError', `应原样抛出 AbortError，实际 ${name}`);
  ok(calls === 1, `超时不该重试，实际发了 ${calls} 次`);
});

await test('ladder：指定 credentials 时只用那一种', async () => {
  const fake = fakeFetch({ succeedOn: 'include', throwOn: ['omit'] });
  const got = await fetchWithLadder('https://api.bilibili.com/x', {
    credentials: 'include', fetchFn: fake.fn,
  });
  ok(fake.calls.join(',') === 'include', `应只发 include，实际 ${fake.calls.join(',')}`);
  ok(got.credentials === 'include', '生效模式应为 include');
});

await test('自检结论：nav 只要有一种模式通就算可用', () => {
  const report = {
    nav: { omit: { ok: false, name: 'TypeError' }, include: { ok: true, status: 200 } },
  };
  ok(bilibiliApiOk(report) === true, 'include 通就该算通');
  ok(bilibiliApiOk({ nav: { omit: { ok: false }, include: { ok: false } } }) === false,
    '两种都不通才算不通');
  const text = describeBilibiliApi(report, 'SW');
  ok(text.includes('omit'), '描述里要区分 omit');
  ok(text.includes('include'), '描述里要区分 include');
});

/* ---------------- 打包资源路径 ---------------- */

/**
 * 守的是同一个坑：prompt() 会给名字再补一次 `.md`，而调用方传的已经带 `.md`，
 * 于是变成 `plan-schema.md.md` —— 文件不在包里，Chrome 让 fetch 直接 reject，
 * 报错只有一句 "Failed to fetch"，看不出行号以外的任何线索。
 */
await test('资源路径：已带 .md 不再重复拼接', () => {
  eq(promptPath('plan-schema.md'), 'prompts/plan-schema.md', '带后缀 ');
  eq(promptPath('plan-schema'), 'prompts/plan-schema.md', '不带后缀 ');
  eq(promptPath('system-append.md'), 'prompts/system-append.md', 'system-append ');
  ok(!promptPath('components.md').endsWith('.md.md'), '绝不能出现 .md.md');
  return '四种写法都归一到 prompts/<name>.md';
});

/* ---------------- offscreen 生命周期 ---------------- */

/**
 * 守的坑：offscreen 文档一创建，它的整张 ES 模块图就固化了。改完源码只刷新
 * service worker（甚至什么都不刷）时，旧文档仍被复用，于是继续跑旧代码 ——
 * 现象是堆栈行号永远停在改之前的那一版。所以开跑前必须能重建；
 * 但如果里面还有任务在跑，重建就是拦腰截断，必须先问 busy。
 */
async function withFakeOffscreen(busy, fn) {
  const saved = globalThis.chrome;
  const state = { exists: true, calls: [] };
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async () => ({ ok: true, value: { busy } }),
      onMessage: { addListener() {}, removeListener() {} },
      lastError: null,
    },
    offscreen: {
      hasDocument: async () => state.exists,
      closeDocument: async () => { state.calls.push('close'); state.exists = false; },
      createDocument: async () => { state.calls.push('create'); state.exists = true; },
    },
  };
  try {
    return await fn(state);
  } finally {
    globalThis.chrome = saved;
  }
}

await test('offscreen 正在跑任务时不得重建', async () => {
  await withFakeOffscreen(true, async (state) => {
    const host = await import('../src/background/offscreen-host.js?case=busy');
    const recreated = await host.recreateOffscreen();
    eq(recreated, false, '忙时应返回 false ');
    eq(state.calls.join(','), '', '忙时一次都不能关闭文档 ');
  });
  return 'busy=true 时只查询、不重建';
});

await test('offscreen 空闲时重建：先关再建', async () => {
  await withFakeOffscreen(false, async (state) => {
    const host = await import('../src/background/offscreen-host.js?case=free');
    const recreated = await host.recreateOffscreen();
    eq(recreated, true, '空闲时应返回 true ');
    eq(state.calls.join(','), 'close,create', '顺序必须是先关再建 ');
    eq(state.exists, true, '重建后文档必须存在 ');
  });
  return 'busy=false 时 close→create，跑的是磁盘上的最新代码';
});

/* ---------------- 历史页的筛选与统计 ---------------- */

/**
 * 历史页声称「按状态筛选 / 关键字搜索 / 排序」，这些最容易在 UI 里写死然后悄悄错，
 * 所以全部走纯函数，在这里断言。
 */
const FIXTURE = [
  { id: 'a', title: '航母的蒸汽弹射', state: 'RENDERED', createdAt: 3000, finishedAt: 4000, durationMs: 600000, bvid: 'BV1aa1111111', usage: { totalTokens: 12000 }, outputBytes: 204800 },
  { id: 'b', title: '为什么西瓜那么贵', state: 'FAILED', createdAt: 2000, durationMs: 0, bvid: 'BV1bb2222222', error: { message: 'boom' } },
  { id: 'c', title: '在路上的一年', state: 'GENERATING', createdAt: 1000, durationMs: 1800000, bvid: 'BV1cc3333333' },
  { id: 'd', title: '（无标题）', state: 'CANCELLED', createdAt: 500, durationMs: 0 },
];

await test('历史筛选：关键字要命中标题和 BV 号', () => {
  eq(filterRuns(FIXTURE, { query: '西瓜' }).length, 1, '按标题 ');
  eq(filterRuns(FIXTURE, { query: 'bv1bb' }).length, 1, 'BV 号不区分大小写 ');
  ok(filterRuns(FIXTURE, { query: '  ' }).length === 4, '空白关键字不该过滤掉任何东西');
  eq(filterRuns(FIXTURE, { query: '不存在的词' }).length, 0, '无命中 ');
  return '标题 / BV 号 / 空串都正确';
});

await test('历史筛选：状态分组互不串台', () => {
  eq(filterRuns(FIXTURE, { status: 'done' }).map((r) => r.id).join(''), 'a', '已完成 ');
  eq(filterRuns(FIXTURE, { status: 'failed' }).map((r) => r.id).join(''), 'b', '失败 ');
  eq(filterRuns(FIXTURE, { status: 'active' }).map((r) => r.id).join(''), 'c', '进行中 ');
  eq(filterRuns(FIXTURE, { status: 'cancelled' }).map((r) => r.id).join(''), 'd', '已取消 ');
  eq(filterRuns(FIXTURE, { status: 'all' }).length, 4, '全部 ');
  return 'done / failed / active / cancelled 各归各';
});

await test('历史排序：默认最新在前，可切换', () => {
  eq(filterRuns(FIXTURE, {}).map((r) => r.id).join(''), 'abcd', '创建时间倒序 ');
  eq(filterRuns(FIXTURE, { sort: 'created-asc' }).map((r) => r.id).join(''), 'dcba', '正序 ');
  eq(filterRuns(FIXTURE, { sort: 'duration-desc' })[0].id, 'c', '时长最长 ');
  eq(filterRuns(FIXTURE, { sort: 'finished-desc' })[0].id, 'a', '最近完成 ');
  const byTitle = filterRuns(FIXTURE, { sort: 'title-asc' });
  ok(byTitle.length === 4, '按标题排序不能丢条目（空标题也不能炸）');
  return '五种排序都不丢条目';
});

await test('历史统计：成功/失败/进行中加总等于总数', () => {
  const s = statsFor(FIXTURE);
  eq(s.total, 4, '总数 ');
  eq(s.done, 1, '已完成 ');
  eq(s.failed, 1, '失败 ');
  eq(s.active, 1, '进行中 ');
  eq(s.cancelled, 1, '已取消 ');
  eq(s.done + s.failed + s.active + s.cancelled, s.total, '分组加总 ');
  eq(s.totalDurationMs, 2400000, '累计时长 ');
  eq(s.totalTokens, 12000, '累计 token ');
  eq(statsFor(null).total, 0, '空输入 ');
  eq(statsFor([null, undefined]).total, 0, '空洞条目要跳掉 ');
  return '分组加总守恒，空输入不炸';
});

await test('历史格式化：字节 / 时长 / 时间 / token', () => {
  eq(formatBytes(0), '—', '零 ');
  eq(formatBytes(512), '512 B', 'B ');
  eq(formatBytes(204800), '200 KB', 'KB ');
  eq(formatBytes(5 * 1048576), '5.0 MB', 'MB ');
  eq(formatDuration(0), '—', '零时长 ');
  eq(formatDuration(600000), '10:00', '分秒 ');
  eq(formatDuration(3600000 + 65000), '1:01:05', '时分秒 ');
  eq(formatTokens(0), '—', '零 ');
  eq(formatTokens(12000), '12.0k', 'k ');
  eq(formatTokens(2500000), '2.50M', 'M ');
  eq(relativeTime(0), '—', '无时间 ');
  eq(relativeTime(Date.now() - 30 * 60000, Date.now()), '30 分钟前', '分钟 ');
  eq(relativeTime(Date.now() - 3 * 3600000, Date.now()), '3 小时前', '小时 ');
  return '各档位都对';
});

await test('长图画布上限与缩放：超尺寸要提前拒绝，屏带缩放要还原', () => {
  eq(canvasFits(920, 10000), true, '常见长图可以 ');
  eq(canvasFits(920, 300000), false, '超过总像素上限 ');
  eq(canvasFits(20000, 100), false, '单边超限 ');
  eq(canvasFits(0, 100), false, '零宽度 ');
  // captureVisibleTab 在高分屏上返回的是物理像素，拼回去时要按 CSS 宽度还原。
  eq(stripScale(1840, 920), 2, '2 倍屏 ');
  eq(stripScale(920, 920), 1, '1 倍屏 ');
  eq(stripScale(10, 920), 1, '离谱的比值按 1 处理 ');
  eq(stripScale(0, 920), 1, '零宽度 ');
  return '上限与缩放都判断正确';
});

test('长图超画布上限要整体缩放而不是直接报错', () => {
  eq(fitScaleToCanvas(920, 5000), 1, '装得下就不缩 ');
  // 150% 缩放的笔记本：920 × 30000 的报告出图是 1380 × 45000，单边已超 16384
  const fit = fitScaleToCanvas(1380, 45000);
  eq(fit < 1, true, '超了必须缩 ');
  eq(Math.round(45000 * fit) <= 16384, true, '缩完单边不超 16384 ');
  eq(canvasFits(Math.round(1380 * fit), Math.round(45000 * fit)), true, '缩完画布装得下 ');
  eq(fitScaleToCanvas(0, 100), 1, '异常输入不炸 ');
  return `缩放系数 ${fit.toFixed(3)}`;
});

test('长图屏只能走 data URL：被序列化吃掉的 Blob 要当场认出来', () => {
  eq(stripSource({ blob: new Blob(['x'], { type: 'image/png' }) }), 'blob', '真 Blob ');
  eq(stripSource({ dataUrl: 'data:image/png;base64,AAAA' }), 'dataUrl', 'data URL ');
  // 关键回归：chrome.runtime.sendMessage 走 JSON 风格序列化，Blob 到了对面是 {}。
  // 以前拿着 {} 直接喂 createImageBitmap，报错跟「没传过来」毫无关系，极难定位。
  eq(stripSource({ blob: {} }), null, '被吃掉的 Blob 必须判为无效 ');
  eq(stripSource({}), null, '空条目 ');
  eq(stripSource(null), null, 'null ');
  return 'Blob / dataUrl / 失效三种情况都能分辨';
});

/* ---------------- 分屏计划：顺序错了长图就重影 ---------------- */

await test('分屏偏移必须递增且不越界（非整数倍高度最容易踩）', () => {
  // 2000 高、视口 900：旧实现会算出 [0, 900, 1800, 1100] —— 顺序是乱的，
  // 1800 那屏画上去又被 1100 那屏盖掉一块，用户看到的就是「有地方重叠」。
  const p = planStrips(2000, 900);
  eq(p.join(','), '0,900,1100', '非整数倍：最后一屏排在最后 ');
  eq(p.every((top, i) => i === 0 || top > p[i - 1]), true, '严格递增 ');
  eq(p[p.length - 1], 2000 - 900, '最后一屏正好贴底 ');
  eq(planStrips(2700, 900).join(','), '0,900,1800', '整数倍不多拍一屏 ');
  eq(planStrips(500, 900).join(','), '0', '不足一屏只拍一次 ');
  eq(planStrips(900, 900).join(','), '0', '正好一屏 ');
  return `2000/900 → [${p.join(', ')}]`;
});

await test('分屏不能超过页面真能滚到的距离', () => {
  // scrollHeight 里含了底部留白，实际最多只能滚到 1500 —— 超出部分拍回来跟上一屏一样。
  const p = planStrips(2600, 900, 1500);
  eq(Math.max(...p) <= 1500, true, '不超过 maxScroll ');
  eq(p[p.length - 1], 1500, '最后一屏停在真能到的地方 ');
  eq(p.every((top, i) => i === 0 || top > p[i - 1]), true, '仍然严格递增 ');
  return `maxScroll 生效：[${p.join(', ')}]`;
});

await test('滚不到位拍到的重复屏要在拼图前丢掉', () => {
  const out = dedupeStrips([
    { top: 900, dataUrl: 'data:image/png;base64,b' },
    { top: 0, dataUrl: 'data:image/png;base64,a' },
    { top: 900, dataUrl: 'data:image/png;base64,c' },
  ]);
  eq(out.length, 2, '重复的一屏丢掉 ');
  eq(out.map((s) => s.top).join(','), '0,900', '按纵向顺序排好 ');
  eq(dedupeStrips([]).length, 0, '空数组 ');
  eq(dedupeStrips([null, undefined]).length, 0, '空条目也过滤 ');
  return '重复屏与乱序都会被兜住';
});

/* ---------------- 长图截图配额（Chrome 每秒最多 2 次） ---------------- */

test('截图节流：没到配额就不等', () => {
  const now = 1_000_000;
  eq(nextShotDelay([], now), 0, '一次都没拍过 ');
  eq(nextShotDelay([now - 100], now), 0, '只拍过 1 次 ');
  return '前两屏必须立刻拍，否则整条链路会莫名变慢';
});

test('截图节流：1 秒内第 3 屏要退避', () => {
  const now = 1_000_000;
  const delay = nextShotDelay([now - 400, now - 200], now);
  eq(delay > 0, true, '第 3 屏必须等待 ');
  // 窗口 1000 + 余量 150，最早的那一屏在 400ms 前 → 还要等到 1150ms 之后，再加 20ms 保险
  eq(delay, 1150 - 400 + 20, '退避到配额窗口外 ');
  return `第 3 屏退避 ${delay} ms`;
});

test('截图节流：配额窗口滚过去以后恢复', () => {
  const now = 1_000_000;
  eq(nextShotDelay([now - 2000, now - 1900], now), 0, '两屏都是两秒前 ');
  eq(nextShotDelay([now - 1900, now - 200], now), 0, '只有一屏还在窗口内 ');
  return '时间戳会随窗口滑出，不会越跑越慢';
});

test('截图节流：12 屏的总耗时满足每秒 2 次', () => {
  // 模拟真实循环：每次先算要等多久，等完再记一个时间戳。
  const shots = 12;
  const times = [];
  let clock = 0;
  for (let i = 0; i < shots; i += 1) {
    clock += nextShotDelay(times, clock);
    times.push(clock);
  }
  const seconds = clock / 1000;
  // 配额是「任意 1 秒内最多 2 次」→ 12 屏至少 (12-2)/2 = 5 秒
  eq(seconds >= 5, true, `12 屏至少 5 秒（实际 ${seconds.toFixed(1)}s） `);
  eq(seconds <= 8, true, `也不该慢得离谱（实际 ${seconds.toFixed(1)}s） `);
  return `12 屏耗时 ${seconds.toFixed(1)} 秒`;
});

/* ---------------- render ---------------- */

if (typeof document !== 'undefined') render(rows);

function render(list) {
  const tbody = document.getElementById('rows');
  if (!tbody) return;
  for (const row of list) {
    const tr = document.createElement('tr');
    const state = document.createElement('td');
    state.className = row.pass ? 'pass' : 'fail';
    state.textContent = row.pass ? '通过' : '失败';
    const name = document.createElement('td');
    name.textContent = row.name;
    const detail = document.createElement('td');
    detail.textContent = row.detail || '';
    tr.append(state, name, detail);
    tbody.appendChild(tr);
  }

  const failed = list.filter((row) => !row.pass).length;
  document.getElementById('summary').textContent =
    `${list.length} 个用例，${list.length - failed} 通过，${failed} 失败。`;
}
