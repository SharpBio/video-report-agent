/**
 * offscreen 文档内部能力自检。
 *
 * 这些都需要 document / canvas / iframe，service worker 里测不了，
 * 所以由 sw 通过 OFFSCREEN_TASK kind='selftest' 转过来跑。
 */
import { execJs, disposeSandbox } from '../lib/sandbox.js';
import { verifyResources } from '../lib/prompts.js';

// 1×1 透明 PNG，用来验证 createImageBitmap —— 长图拼接的第一步。
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function pngBlob() {
  const bytes = Uint8Array.from(atob(PNG_1PX), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

async function check(name, fn) {
  try {
    const detail = await fn();
    return { name, ok: true, detail: detail == null ? '通过' : String(detail) };
  } catch (error) {
    return { name, ok: false, detail: error?.message || String(error) };
  }
}

async function checkDom() {
  if (!document?.createElement) throw new Error('document 不可用。');
  return 'DOM 可用';
}

async function checkParser() {
  const doc = new DOMParser().parseFromString('<p id="a">hi</p>', 'text/html');
  const text = doc.getElementById('a')?.textContent;
  if (text !== 'hi') throw new Error('DOMParser 解析结果不对。');
  return 'DOMParser 可用';
}

async function checkCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('取不到 2d 上下文。');
  ctx.fillStyle = '#123456';
  ctx.fillRect(0, 0, 8, 8);
  const [r, g, b] = ctx.getImageData(1, 1, 1, 1).data;
  if (r !== 0x12 || g !== 0x34 || b !== 0x56) throw new Error(`像素不对：${r},${g},${b}`);
  return 'canvas 2d 可用，像素读写正确';
}

async function checkImageBitmap() {
  const bitmap = await createImageBitmap(pngBlob());
  // 必须在 close() 之前读：ImageBitmap 被 close 后 width/height 会变成 0
  // （规范如此）—— 曾经先 close 再判断，把好端端的解码报成「尺寸不对」。
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close?.();
  if (width !== 1 || height !== 1) {
    throw new Error(`解码出的尺寸不对：${width}×${height}（应为 1×1）`);
  }
  return `createImageBitmap 可用（${width}×${height}），长图拼接可走通`;
}

async function checkSandbox() {
  const result = await execJs('return 6 * 7');
  disposeSandbox();
  if (!result.ok) throw new Error(result.error || '沙箱没返回结果。');
  if (result.value !== 42) throw new Error(`结果不对：${JSON.stringify(result.value)}`);
  return '沙箱 eval 可用（exec_js 工具会正常工作）';
}

/**
 * 逐个读流水线真正会用到的每一个打包资源。
 *
 * 以前只直接 fetch 了 `prompts/system-append.md` 一个，结果 prompt() 里
 * 「把 .md 又拼一次」的 bug 自检全绿，到 plan 那一轮才炸（报错还只是
 * "Failed to fetch"，因为扩展资源不存在时 fetch 会直接 reject，不给 404）。
 */
async function checkAssetFetch() {
  const results = await verifyResources();
  const list = (Array.isArray(results) ? results : []).filter(Boolean);
  if (!list.length) throw new Error('没有返回任何资源检查结果。');
  const bad = list.filter((item) => !item.ok);
  const total = list.reduce((sum, item) => sum + (item.chars || 0), 0);
  if (bad.length) {
    throw new Error(`${bad.length}/${list.length} 个资源读不到：${
      bad.map((item) => `${item.label}（${item.error}）`).join('；')}`);
  }
  return `${list.length} 个打包资源全部可读（共 ${total} 字符）`;
}

/**
 * 预期 offscreen 读不到 chrome.storage。如果这条变成「能读」，
 * 说明 Chrome 行为变了，settings 的传递方式可以简化。
 */
async function checkStorageIsolation() {
  const reachable = Boolean(typeof chrome !== 'undefined' && chrome.storage?.local);
  return reachable
    ? '注意：offscreen 现在能读 storage 了（与预期不同，可简化设置传递）'
    : '符合预期：offscreen 读不到 storage，设置由 service worker 传入';
}

/**
 * 真机验证「拼接长图」这条链路（不含截图：截图要真的开窗口，自检里不做）。
 *
 * 送两张 1×1 的纯色条进去，验证 offscreen 的 canvas 能编码出 PNG ——
 * 也就是验证「画布没有被污染」。曾经试过用 SVG foreignObject 直接渲染报告，
 * Chrome 会因为 foreignObject 把画布标记为 tainted，convertToBlob() 直接抛
 * `Tainted "OffscreenCanvas" may not be exported`，这条自检就是那个坑的哨兵。
 */
async function checkStitch() {
  const { stitchStrips } = await import('../lib/stitch.js');
  const strips = [
    { blob: pngBlob(), top: 0, width: 1, height: 1 },
    { blob: pngBlob(), top: 1, width: 1, height: 1 },
  ];
  const { blob, width, height } = await stitchStrips(strips, { width: 1, height: 2 });
  if (!blob || blob.size < 50) throw new Error(`没产出图片（${blob?.size || 0} 字节）。`);
  if (width !== 1 || height !== 2) throw new Error(`尺寸不对：${width}×${height}`);
  return `长图拼接可用（${width}×${height}，${blob.size} 字节，画布未被污染）`;
}

export async function runOffscreenSelfTest() {
  const items = [];
  items.push(await check('offscreen · DOM', checkDom));
  items.push(await check('offscreen · DOMParser', checkParser));
  items.push(await check('offscreen · canvas', checkCanvas));
  items.push(await check('offscreen · createImageBitmap', checkImageBitmap));
  items.push(await check('offscreen · 沙箱 eval', checkSandbox));
  items.push(await check('offscreen · 打包资源读取', checkAssetFetch));
  items.push(await check('offscreen · storage 隔离', checkStorageIsolation));
  items.push(await check('offscreen · 长图拼接', checkStitch));
  return items;
}
