/**
 * 装配检查：不看代码逻辑，只确认「这个扩展能装起来、能加载」。
 *
 *   node tests/links.mjs
 *
 * 查五件事（都是浏览器里才会暴露、而且往往只报一句没上下文的错）：
 *   1. manifest.json 是合法 JSON，里面指到的文件都在磁盘上；
 *   2. 每个 HTML 里 <script src> / <link href> 指到的文件都在；
 *   3. 每个 import 的相对路径都能解析到真实文件；
 *   4. 每个具名 import 在目标模块里真的被 export 了；
 *   5. declarativeNetRequest 要注入请求头的域名，manifest 里得有对应主机权限。
 *
 * 第 4 条的意义：`import { foo }` 而 foo 没导出，在真机上整段模块加载失败，
 * 报错信息是 "does not provide an export named"，但不会告诉你是哪个调用方引入的。
 *
 * 第 5 条的意义：B 站主力媒体 CDN 是 `*.bilivideo.cn`，曾经 manifest 只写了
 * `*.bilivideo.com`。规则照样能装、自检照样显示「5 条规则生效」，但一条都匹配不上，
 * 实际表现只是页面取流 403。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const problems = [];
const note = (m) => problems.push(m);

const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * 去掉注释，免得注释里的示例代码被当成真的 import / export。
 *
 * 只认**行首**的块注释：无脑匹配起始那两个字符，会撞上权限匹配模式里
 * 「星号 冒号 双斜杠 星号 斜杠 星号」那一串（host_permissions 用的就是它），
 * 于是从那里一路吃到下一个结束符，把中间真代码整个吞掉 —— 表现为某个明明存在的
 * 导出被当成不存在（本次事故：`hasCapturePermission`）。
 */
const strip = (src) => src
  .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* ---------- 1) manifest ---------- */

let manifest;
try {
  manifest = JSON.parse(read('manifest.json'));
} catch (error) {
  note(`manifest.json 解析失败：${error.message}`);
}

if (manifest) {
  const refs = [
    ['background.service_worker', manifest.background?.service_worker],
    ['action.default_popup', manifest.action?.default_popup],
    ['options_ui.page', manifest.options_ui?.page],
    ...(manifest.sandbox?.pages || []).map((p) => ['sandbox.pages', p]),
    ...(manifest.web_accessible_resources || []).flatMap((g) => (g.resources || []).map((r) => ['web_accessible_resources', r])),
  ];
  for (const [where, file] of refs) {
    if (!file) continue;
    if (!exists(file)) note(`manifest 的 ${where} 指向不存在的文件：${file}`);
  }
  if (manifest.background?.type !== 'module') {
    note('background.type 必须是 module，否则 service worker 里的 import 全部失败。');
  }
  const csp = manifest.content_security_policy?.extension_pages || '';
  if (!csp.includes("script-src 'self'")) {
    note('extension_pages CSP 缺少 script-src \'self\'，内联脚本会被拒（HTML 里不要写 <script> 块）。');
  }
  if (/\bcontent_scripts\b/.test(JSON.stringify(manifest)) === false) {
    /* 没有 content script 是正常的：本项目用 scripting.executeScript 注入 */
  }
}

/* ---------- 收集所有 js / html ---------- */

/**
 * 本地专属目录（.gitignore 里的目录条目）不是扩展的一部分：里面的文件不进仓库，
 * 也不该参与「这个扩展能不能装起来」的检查。
 * 典型情况是 runs/ 下历史流水线的产物报告——它们带内联 <script>，
 * 但那是给读者直接打开的成品，不是扩展页，扫进来只会误报。
 */
const LOCAL_DIRS = new Set(
  (fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.endsWith('/') && !/[*?![\]\\]/.test(line))
    .map((line) => line.replace(/\/$/, ''))
);

const jsFiles = [];
const htmlFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (e.isDirectory()) {
      if (LOCAL_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) jsFiles.push(path.join(dir, e.name));
    else if (e.name.endsWith('.html')) htmlFiles.push(path.join(dir, e.name));
  }
})('.');

/* ---------- 2) HTML 里的资源引用 ---------- */

for (const html of htmlFiles) {
  const src = read(html);
  for (const m of src.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/g)) {
    const target = path.normalize(path.join(path.dirname(html), m[1]));
    if (!exists(target)) note(`${html} 引用了不存在的脚本：${m[1]}`);
  }
  for (const m of src.matchAll(/<link[^>]*\shref\s*=\s*["']([^"']+)["']/g)) {
    const href = m[1];
    if (/^(https?:|data:|#)/.test(href)) continue;
    const target = path.normalize(path.join(path.dirname(html), href));
    if (!exists(target)) note(`${html} 引用了不存在的样式/资源：${href}`);
  }
// 扩展页 CSP 禁止内联脚本，写了就整页脚本不执行。
// skills/ 与 prompts/ 是运行时 fetch 的模板资源（不是页面），里面的 <script> 是要
// 注入成品报告里的，不算违规。
const isExtensionPage = (p) => !/^(skills|prompts)[/\\]/.test(p);
const INLINE_SCRIPT_RE = /<script(?![^>]*\ssrc\s*=)[^>]*>[\s\S]*?<\/script>/;
if (isExtensionPage(html) && INLINE_SCRIPT_RE.test(src)) {
    note(`${html} 里有内联 <script>，会被扩展页 CSP 拒绝执行（应改用外部 .js 文件）。`);
  }
}

/* ---------- 3) + 4) 模块导入 ---------- */

/** 收集一个模块对外导出的名字。 */
const exportCache = new Map();
function exportsOf(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const names = new Set();
  exportCache.set(file, names); // 先占位，避免循环 import 死递归
  const src = strip(read(file));

  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s*\{([\s\S]*?)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const seg = t.split(/\s+as\s+/);
      let name = (seg[1] || seg[0]).trim();
      if (name === '*') name = seg[1]?.trim();       // export * as ns from
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  if (/^export\s+default\b/m.test(src)) names.add('default');

  // export ... from './x.js' 会把 x 的导出透传出来
  for (const m of src.matchAll(/^export\s+(?:\*|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/gm)) {
    const target = resolveFrom(file, m[1]);
    if (target) for (const n of exportsOf(target)) names.add(n);
  }
  return names;
}

function resolveFrom(file, spec) {
  if (!spec.startsWith('.')) return null;
  const target = path.normalize(path.join(path.dirname(file), spec));
  return exists(target) ? target : null;
}

/** 解析 import 子句里的具名导入。 */
function namedImports(clause) {
  const out = [];
  const braces = /\{([\s\S]*?)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('//')) continue;
      const seg = t.split(/\s+as\s+/);
      const name = seg[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
    }
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /(?:^|[^.\w])(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

let importCount = 0;

for (const file of jsFiles) {
  const src = strip(read(file));

  for (const m of src.matchAll(IMPORT_RE)) {
    const [, clause, spec] = m;
    if (!spec.startsWith('.')) continue; // 裸模块名（真机上会失败，但本项目没有用到）
    const target = resolveFrom(file, spec);
    if (!target) {
      note(`${file} 导入了不存在的模块：${spec}`);
      continue;
    }
    importCount += 1;
    if (/^\s*\*\s+as\s+/.test(clause.trim())) continue; // 命名空间导入，不逐个校验
    const avail = exportsOf(target);
    for (const name of namedImports(clause)) {
      if (!avail.has(name)) {
        note(`${file} 从 ${spec} 导入了 ${name}，但该模块没有导出这个名字。`);
      }
    }
  }

  for (const m of src.matchAll(DYNAMIC_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    // `?case=busy` 这类查询串是测试用来拿一份独立模块实例的，不是真实路径。
    const bare = spec.replace(/\?.*$/, '');
    if (!resolveFrom(file, bare)) note(`${file} 动态 import 了不存在的模块：${spec}`);
  }
}

/* ---------- 6) 打包资源：代码会读的路径必须真的在包里 ---------- */

/**
 * 扩展资源不存在时，Chrome 让 fetch **直接 reject**（"Failed to fetch"），
 * 不会返回 404 —— 所以 `response.ok` 那道判断根本挡不住，运行时只剩一句没有出处的错。
 * 这里按 prompts.js 的真实拼接逻辑算出每个会被读取的路径，逐个验证文件存在。
 * 上一版 `prompt()` 把调用方已经带上的 `.md` 又拼一次（变成 `.md.md`），
 * 就是靠这条能在跑之前被抓出来的那类问题。
 */
const { promptPath } = await import('../src/lib/prompts.js');
const { PROFILE_REFERENCES } = await import('../src/lib/prompts.js');

const readJs = (file) => strip(fs.readFileSync(file, 'utf8'));
const assetTargets = new Map(); // 路径 → 来源文件

for (const file of jsFiles) {
  const src = readJs(file);
  for (const m of src.matchAll(/resource\.prompt\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    assetTargets.set(promptPath(m[1]), file);
  }
  for (const m of src.matchAll(/resource\.mode\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    assetTargets.set(`skills/video-report/modes/${m[1]}.md`, file);
  }
}
for (const name of Object.values(PROFILE_REFERENCES)) {
  assetTargets.set(`skills/video-report/references/${name}.md`, 'PROFILE_REFERENCES');
}
assetTargets.set('skills/video-report/SKILL.md', 'resource.skill()');
assetTargets.set('skills/video-report/assets/report-template.html', 'resource.template()');

for (const [asset, from] of assetTargets) {
  if (!exists(asset)) note(`${from} 会读取打包资源 ${asset}，但它不在包里（fetch 会直接失败，不返回 404）`);
}

/* ---------- 汇总 ---------- */

/* ---------- 5) DNR 媒体域名必须有主机权限 ---------- */

if (manifest) {
  const { MEDIA_HOSTS } = await import(pathToFileURL(path.join(ROOT, 'src/background/dnr.js')).href);
  const granted = manifest.host_permissions || [];
  for (const host of MEDIA_HOSTS) {
    if (!granted.some((pattern) => pattern.includes(host))) {
      note(`dnr.js 会给 ${host} 注入 Referer/UA，但 manifest 的 host_permissions 没有它 —— 规则装得上但匹配不到。`);
    }
  }
}

if (problems.length) {
  console.log(problems.map((p) => `  · ${p}`).join('\n'));
  console.log(`\n装配检查：${problems.length} 个问题。`);
  process.exit(1);
}
console.log(`装配检查通过：${jsFiles.length} 个 JS、${htmlFiles.length} 个 HTML，${importCount} 处静态导入全部可解析。`);
