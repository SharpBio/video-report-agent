/**
 * 静态扫描「未声明就赋值」。
 *
 *   node tests/lint.mjs     （在 extension 目录下运行）
 *
 * ES 模块是严格模式，`x = 1`（漏写 let/const）语法完全合法，`node --check` 抓不到，
 * 只有跑到那一行才抛 ReferenceError —— 真实案例：sw.js 里 `probeResult = ...`。
 *
 * 说明：曾经试过再扫「块级作用域越界」（let 声明在 if 块内、块外又引用），
 * 误报率过高（JSDoc 注释、函数参数、解构模式都会被误判），已移除。
 * 这类问题目前靠人工复查整段函数体。
 */
import fs from 'node:fs';
import path from 'node:path';

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
  }
})('.');

const RESERVED = new Set(['await', 'return', 'case', 'default', 'throw', 'typeof',
  'delete', 'new', 'in', 'of', 'do', 'else', 'yield', 'export', 'import']);

const problems = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const declared = new Set();

  // const / let / var（含解构：把 [ ] { } 抹成空格再按逗号拆）
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([^=;]+?)(?:=|;|\n)/g)) {
    for (const part of m[1].replace(/[\[\]{}]/g, ' ').split(',')) {
      const name = part.trim().replace(/[\[\]{}.:?].*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  for (const m of src.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*,|\{([^}]*)\}|([A-Za-z_$][\w$]*)\s+from)/g)) {
    for (const g of m.slice(1)) {
      if (!g) continue;
      for (const part of g.split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      }
    }
  }
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/[=:].*$/, '').replace(/[\[\]{}?].*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }

  const lines = src.split(/\r?\n/);
  const code = lines.map((l) => l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim());

  /** 上一行以 , { ( = + 结尾 ⇒ 本行是续行（多行解构 / 参数表 / 对象字面量）。 */
  const isContinuation = (i) => {
    for (let k = i - 1; k >= 0; k -= 1) {
      if (code[k]) return /[,{(=+]$/.test(code[k]);
    }
    return false;
  };

  code.forEach((text, i) => {
    if (!text || isContinuation(i)) return;
    const m = /^([A-Za-z_$][\w$]*)\s*(?:=[^=]|\+=|-=|\*=|\/=)/.exec(text);
    if (!m) return;
    const name = m[1];
    if (declared.has(name) || RESERVED.has(name)) return;
    problems.push(`${file}:${i + 1}  未声明就赋值 -> ${name}\n    ${text}`);
  });
}

console.log(problems.length
  ? problems.join('\n')
  : `扫描 ${files.length} 个文件：没有未声明就赋值的情况`);

/* ------------------------------------------------------------------ *
 * 2) service worker 里禁止动态 import()
 *
 * ServiceWorkerGlobalScope 不允许 `import()`（w3c/ServiceWorker#1356），
 * 运行时才报，而且是「点了某个按钮才炸」那种。
 * 做法：从 src/background/*.js 出发做静态导入的可达性闭包，闭包内出现动态 import 就报错。
 * ------------------------------------------------------------------ */

const IMPORT_RE = /(?:^|[^.\w])(?:await\s+)?import\s*\(/;
const STATIC_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const p = path.normalize(path.join(path.dirname(fromFile), spec));
  return fs.existsSync(p) ? p : null;
}

const swEntries = files.filter((f) => f.replace(/\\/g, '/').startsWith('src/background/'));
const seen = new Set();
const queue = [...swEntries];
const swReachable = new Set(swEntries);
const dynamicInSw = [];

while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  // 去掉注释再判断，避免把说明文字当成真代码。
  // 只认行首的块注释：无脑匹配会把 host_permissions 那种「星号 冒号 双斜杠 星号 …」
  // 里的一段当成注释开头，一路吃到下一个结束符，中间真代码就检查不到了。
  const body = src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
  if (IMPORT_RE.test(body)) {
    dynamicInSw.push(`${file}  动态 import() 会出现在 service worker 上下文里`);
  }
  for (const m of body.matchAll(STATIC_RE)) {
    const next = resolveRelative(file, m[1]);
    if (next && !seen.has(next)) {
      swReachable.add(next);
      queue.push(next);
    }
  }
}

if (dynamicInSw.length) {
  console.log(`\n[service worker] 以下 ${dynamicInSw.length} 处动态 import() 会跑在 SW 里：\n  ${dynamicInSw.join('\n  ')}`);
} else {
  console.log(`service worker 可达模块 ${swReachable.size} 个：没有动态 import()`);
}

/* ------------------------------------------------------------------ *
 * 3) 注入页面主世界的函数，不能引用模块作用域的名字
 *
 * `chrome.scripting.executeScript({ func })` 只把**函数体**序列化过去，
 * 外层常量/函数统统不存在。引用了不会有任何静态报错，到了页面里就是一句
 * ReferenceError —— 而它常常被 catch 住，再伪装成 "Failed to fetch"。
 * 真实案例：tab-fetch.js 的 startInPage 用了模块级的 CREDENTIAL_MODES。
 * ------------------------------------------------------------------ */

const PAGE_GLOBALS = new Set([
  'window', 'document', 'console', 'fetch', 'btoa', 'atob', 'location', 'navigator',
  'setTimeout', 'clearTimeout', 'URL', 'URLSearchParams', 'JSON', 'Math', 'Promise',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Error', 'TypeError', 'RegExp',
  'Uint8Array', 'ArrayBuffer', 'Blob', 'File', 'Date', 'Map', 'Set', 'Symbol',
  'structuredClone', 'performance', 'crypto', 'TextDecoder', 'TextEncoder', 'Blob',
]);
const JS_WORDS = new Set([
  'function', 'async', 'await', 'return', 'const', 'let', 'var', 'if', 'else', 'for',
  'while', 'do', 'break', 'continue', 'new', 'typeof', 'instanceof', 'in', 'of',
  'try', 'catch', 'finally', 'throw', 'switch', 'case', 'default', 'delete', 'void',
  'class', 'extends', 'super', 'this', 'null', 'undefined', 'true', 'false', 'yield',
]);

/** 从 `function NAME` 起做花括号配平，取出整个函数体。 */
function functionBody(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const head = re.exec(src);
  if (!head) return null;
  let depth = 0;
  let started = false;
  for (let i = head.index; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return src.slice(head.index, i + 1);
    }
  }
  return null;
}

function paramsOf(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)`);
  const m = re.exec(src);
  if (!m) return [];
  return m[1].split(',').map((p) => p.trim().replace(/[=:].*$/, '').replace(/[\[\]{}?.].*$/, '').trim());
}

/** 模块顶层声明的名字（就是注入函数拿不到的那些）。 */
function moduleScopeNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return names;
}

function identifierRefs(body) {
  // 先去掉注释与字符串，再去掉 `.foo` 形式的属性访问
  const clean = body
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:(?!`)[^\\]|\\.)*`/g, '``')
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, '.');
  return clean.match(/[A-Za-z_$][\w$]*/g) || [];
}

const injectLeaks = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const injected = new Set();
  for (const m of src.matchAll(/\bfunc\s*:\s*([A-Za-z_$][\w$]*)/g)) injected.add(m[1]);
  for (const m of src.matchAll(/\bfunc\s*:\s*async\s+([A-Za-z_$][\w$]*)/g)) injected.add(m[1]);
  if (!injected.size) continue;

  const moduleNames = moduleScopeNames(src);
  for (const name of injected) {
    const body = functionBody(src, name);
    if (!body) continue;
    const local = new Set([
      ...paramsOf(src, name),
      ...[...body.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      ...[...body.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ]);
    const leaked = new Set();
    for (const token of identifierRefs(body)) {
      if (local.has(token) || PAGE_GLOBALS.has(token) || JS_WORDS.has(token)) continue;
      if (moduleNames.has(token)) leaked.add(token);
    }
    if (leaked.size) {
      injectLeaks.push(`${file}  注入函数 ${name}() 引用了模块作用域的：${[...leaked].join('、')}`);
    }
  }
}

if (injectLeaks.length) {
  console.log(`\n[注入] ${injectLeaks.length} 处会在页面里 ReferenceError：\n  ${injectLeaks.join('\n  ')}`);
  console.log('  修法：把用到的常量/helper 全部写进函数体内部。');
} else {
  console.log('注入页面的函数没有引用模块作用域的名字');
}

/* ------------------------------------------------------------------ *
 * 4) chrome.windows.create 的参数白名单
 *
 * Chrome 对 API 参数做**严格**校验，多给一个字段不是「忽略」而是直接抛：
 * `Error at parameter 'createData': Unexpected property: populate`。
 * 真实案例：照着 Firefox 文档给 windows.create 传了 `populate: true`，
 * 结果点「保存长图」当场报错，整个功能一次都没跑起来。
 * ------------------------------------------------------------------ */

const WIN_CREATE_KEYS = new Set([
  'url', 'tabId', 'left', 'top', 'width', 'height',
  'focused', 'incognito', 'type', 'state', 'setSelfAsOpener',
]);

/** 从 `{` 起配平，返回**顶层**属性名（嵌套对象/数组里的 key 不算）。 */
function topLevelKeys(src, openIdx) {
  const keys = [];
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i));
      if (m) {
        keys.push(m[1]);
        i += m[0].length - 1;
      }
    }
  }
  return keys;
}

const badWindowKeys = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^\s*\/\/.*$/gm, '')
    // 字符串里的 `http:` 之类会被误当成属性名，先抹掉
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:(?!`)[^\\]|\\.)*`/g, '``');
  for (const m of src.matchAll(/windows\.create\s*\(/g)) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0 || src.slice(m.index + m[0].length, open).trim()) continue; // 不是对象字面量
    for (const key of topLevelKeys(src, open)) {
      if (!WIN_CREATE_KEYS.has(key)) {
        badWindowKeys.push(`${file}  windows.create 传了 Chrome 不认识的参数：${key}`);
      }
    }
  }
}

if (badWindowKeys.length) {
  console.log(`\n[windows.create] ${badWindowKeys.length} 处会当场抛 Unexpected property：\n  ${badWindowKeys.join('\n  ')}`);
  console.log(`  合法参数只有：${[...WIN_CREATE_KEYS].join('、')}`);
} else {
  console.log('windows.create 的参数都在 Chrome 的白名单内');
}

/* ------------------------------------------------------------------ *
 * 5) 长图靠截图，权限就必须给足
 *
 * `chrome.tabs.captureVisibleTab` 拍 `chrome-extension://` 自己的页面也要
 * `<all_urls>`（或 activeTab），不给就抛
 * "Either the '<all_urls>' or 'activeTab' permission is required."。
 * 试过绕开它：把报告塞进 SVG 的 foreignObject 再画到 canvas —— Chrome 会因为
 * foreignObject 把画布判成 tainted，`convertToBlob()` 直接抛
 * `Tainted "OffscreenCanvas" may not be exported`，浏览器层面就堵死了。
 * 所以只要源码里还在截图，manifest 就必须声明 `<all_urls>`；
 * 反过来，如果哪天不再截图了，那条权限也不该留着。
 * ------------------------------------------------------------------ */

const captureProblems = [];
let usesCapture = false;
for (const file of files) {
  // 注释里提到这个名字不算（本文件自己就在解释它），tests/ 也不算。
  if (file.replace(/\\/g, '/').startsWith('tests/')) continue;
  const src = fs.readFileSync(file, 'utf8')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
  if (!src.includes('captureVisibleTab')) continue;
  usesCapture = true;
  // Chrome 对 captureVisibleTab 有「每秒最多 2 次」的硬性配额，超了抛
  // MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND —— 表现是窗口闪一下就没了、什么都没存。
  if (!/\b(nextShotDelay|shoot)\b/.test(src)) {
    captureProblems.push(`${file}  调了 captureVisibleTab 却没有节流 —— Chrome 每秒只许 2 次，第 3 屏就会抛配额错误`);
  }
}
try {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const hosts = [...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])];
  const hasAll = hosts.includes('<all_urls>');
  if (usesCapture && !hasAll) {
    captureProblems.push('源码在截图（captureVisibleTab），但 manifest 没声明 <all_urls> —— 长图会当场抛权限错误');
  }
  if (!usesCapture && hasAll) {
    captureProblems.push('已经不截图了，manifest 里的 <all_urls> 该删掉了');
  }
} catch (error) {
  captureProblems.push(`manifest.json 读不出来：${error?.message}`);
}

if (captureProblems.length) {
  console.log(`\n[长图] ${captureProblems.length} 处权限与实现不匹配：\n  ${captureProblems.join('\n  ')}`);
} else {
  console.log(`长图实现与权限一致（${usesCapture ? '截图，已声明 <all_urls>' : '不截图，也没有多余权限'}）`);
}

process.exitCode = (problems.length || dynamicInSw.length || injectLeaks.length
  || badWindowKeys.length || captureProblems.length) ? 1 : 0;
