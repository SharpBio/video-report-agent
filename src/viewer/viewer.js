/**
 * Report viewer. 也兼作长图的截图承载面：`?capture=1` 时先把自己的几何尺寸报给
 * service worker，随后按指令滚到指定偏移，让 captureVisibleTab 逐屏拍。
 */
import { send, onMessage, setErrorContext } from '../lib/bus.js';
import { MSG } from '../lib/protocol.js';
import { installErrorTrap } from '../lib/diag.js';

installErrorTrap('viewer');
setErrorContext('viewer');

const params = new URLSearchParams(location.search);
const runId = params.get('run') || '';
const captureMode = params.get('capture') === '1';

const stage = document.getElementById('stage');
const empty = document.getElementById('empty');
const chromeBar = document.getElementById('chrome');

if (captureMode) {
  document.body.classList.add('capture');
  stage.classList.add('capture');
  // 报告模板里有 `html{scroll-behavior:smooth}`（给读者点目录用的）。它会把
  // scrollTo 变成动画：等几十毫秒就截图的话根本还没滚到位，于是每一屏都拍到
  // 差不多的位置，拼起来就是一整片重影。截图必须关掉它。
  const shotFix = document.createElement('style');
  shotFix.textContent = 'html{scroll-behavior:auto !important;scroll-padding:0 !important}';
  document.head.appendChild(shotFix);
  document.documentElement.style.scrollBehavior = 'auto';
}

/**
 * 把 fixed / sticky 的元素按回到普通文档流里。
 *
 * `captureVisibleTab` 只拍视口，而 fixed 元素在**每一屏**的同一个位置都会出现
 * （模板的 `.report-nav` 侧边目录就是 fixed）。逐屏拼起来，它就被画了 N 遍 ——
 * 用户看到的就是「有一块地方叠了一坨」。sticky 同理，只是范围小一点。
 */
function unpin(root) {
  for (const el of root.querySelectorAll('*')) {
    const position = getComputedStyle(el).position;
    if (position === 'fixed') el.style.setProperty('display', 'none', 'important');
    else if (position === 'sticky') el.style.setProperty('position', 'static', 'important');
  }
}

/**
 * 等滚动真的停下来。
 *
 * 平滑滚动、懒加载、字体替换都会让 scrollY 连着变好几帧。以前只等两个
 * requestAnimationFrame 就拍，等于拍在半路上。
 */
function waitScrollSettled(maxFrames = 60) {
  return new Promise((resolve) => {
    let last = NaN;
    let stable = 0;
    let frames = 0;
    function step() {
      const y = window.scrollY;
      stable = Math.abs(y - last) < 0.5 ? stable + 1 : 0;
      last = y;
      frames += 1;
      if (stable >= 3 || frames >= maxFrames) resolve(Math.round(y));
      else requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

async function load() {
  /**
   * 内容宽度必须**等于视口宽度**，不能等于设置里的 imageWidth：
   * `windows.create` 的 width 是窗口外框尺寸，视口还要再窄十几像素，按 imageWidth
   * 设 body 宽度的话右边会溢出、被裁掉一条。出图宽度因此比设置值小一点点。
   */
  if (captureMode) document.body.style.width = `${window.innerWidth}px`;
  document.getElementById('chrome-title').textContent = '加载中…';

  const data = await send(MSG.VIEWER_LOAD, { runId });
  if (!data?.html) {
    empty.textContent = data?.error?.message || '这份任务还没有报告。';
    empty.classList.remove('hidden');
    return;
  }

  // innerHTML keeps <style> and body content while dropping <html>/<head>,
  // and never executes the report's inline script.
  stage.innerHTML = data.html;
  empty.remove();
  document.getElementById('chrome-title').textContent = data.title || '报告';
  document.title = data.title || '报告';

  await settle();
  // 报告是别处生成的 HTML，里面可能有 fixed 的侧边目录 —— 拼长图前先按回文档流。
  if (captureMode) unpin(stage);
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  if (captureMode) announce();
}

async function settle() {
  await Promise.all([
    document.fonts?.ready,
    ...[...document.images].map((image) => {
      image.loading = 'eager';
      return image.decode().catch(() => {});
    }),
  ]);
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function announce() {
  send(MSG.VIEWER_READY, {
    runId,
    ok: true,
    height: document.documentElement.scrollHeight,
    // 最大可滚动距离才是真实的「最后一屏」起点，比 scrollHeight 更靠谱。
    maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
  }).catch(() => {});
}

onMessage(MSG.CAPTURE_STRIP, async ({ top }) => {
  window.scrollTo({ top, left: 0, behavior: 'auto' });
  // 回传**实际**停在哪里：滚不到位就是滚不到位，让拼图那边按真实位置摆，
  // 免得按请求的坐标去画，把上一屏的内容又画一遍。
  const actual = await waitScrollSettled();
  return {
    top: actual,
    requested: top,
    height: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  };
});

onMessage(MSG.CAPTURE_DONE, async () => ({ ok: true }));

onMessage(MSG.PAGE_CHECK, async () => {
  const { pageCheck } = await import('../lib/page-check.js');
  return pageCheck();
});

/* ---------------- actions ---------------- */

/** 按钮点了必须看得见变化 —— 「没反应」比报错更让人无从下手。 */
function feedback(button, label) {
  return {
    async done(text, back = 1500) {
      button.textContent = text;
      setTimeout(() => { button.textContent = label; button.disabled = false; }, back);
    },
    async fail(error) {
      button.textContent = error?.message || '失败';
      setTimeout(() => { button.textContent = label; button.disabled = false; }, 2500);
    },
    start(text = '处理中…') {
      button.disabled = true;
      button.textContent = text;
    },
  };
}

document.getElementById('btn-png').addEventListener('click', () => {
  const button = document.getElementById('btn-png');
  const ui = feedback(button, '导出长图');
  ui.start('生成中…');
  (async () => {
    const result = await send(MSG.CAPTURE_PNG, { runId });
    ui.done(`已保存 ${Math.round(result.height)} px`);
  })().catch((error) => ui.fail(error));
});

document.getElementById('btn-html').addEventListener('click', () => {
  const button = document.getElementById('btn-html');
  const ui = feedback(button, '导出 HTML');
  ui.start('导出中…');
  (async () => {
    // 页面上下文里的 blob URL 生命周期跟着页面走，比 service worker 里可靠。
    const data = await send(MSG.VIEWER_LOAD, { runId });
    if (!data?.html) throw new Error('这份任务还没有报告。');
    const { downloadFile, safeFilename } = await import('../lib/export.js');
    await downloadFile(data.html, safeFilename(data.title || 'report', 'html'), 'text/html;charset=utf-8');
    ui.done('已保存');
  })().catch((error) => ui.fail(error));
});

document.getElementById('btn-md').addEventListener('click', () => {
  const button = document.getElementById('btn-md');
  const ui = feedback(button, '导出转写');
  ui.start('导出中…');
  (async () => {
    const data = await send(MSG.VIEWER_LOAD, { runId });
    const { downloadFile, safeFilename } = await import('../lib/export.js');
    const transcript = await send(MSG.EXPORT_TRANSCRIPT, { runId }).catch(() => null);
    if (!transcript?.text) throw new Error('没有可导出的转写。');
    await downloadFile(transcript.text, safeFilename(data.title || 'transcript', 'md'), 'text/markdown;charset=utf-8');
    ui.done('已保存');
  })().catch((error) => ui.fail(error));
});

if (chromeBar && !captureMode) chromeBar.style.display = '';
load().catch((error) => {
  empty.textContent = error?.message || '加载失败。';
});
