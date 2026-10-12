/**
 * PNG stitching: scroll-and-capture strips joined into one full-page image.
 * Runs in the offscreen document, which is the only context with both a canvas
 * and enough lifetime for a multi-megapixel encode.
 */

const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 268435456; // Chrome's total-area limit.

export function canvasFits(width, height) {
  if (width <= 0 || height <= 0) return false;
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) return false;
  return width * height <= MAX_CANVAS_AREA;
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * @param {Array<{blob:Blob, top:number, width:number, height:number}>} strips
 * @param {{width:number, height:number, onProgress?:Function}} options
 * @returns {Promise<{blob:Blob, width:number, height:number}>}
 */
/**
 * 画布装不下时把整图等比缩到能装下为止。
 *
 * `captureVisibleTab` 是按设备像素比出图的（150% 缩放的笔记本上 1 CSS px = 1.5 px），
 * 而 Chrome 的画布单边上限是 16384 —— 一份 20000 px 高的报告乘以 1.5 就直接超了。
 * 与其报错，不如整体缩一点。返回 1 表示不用缩。
 */
export function fitScaleToCanvas(width, height) {
  if (width <= 0 || height <= 0) return 1;
  let fit = 1;
  const side = Math.max(width, height);
  if (side > MAX_CANVAS_SIDE) fit = Math.min(fit, MAX_CANVAS_SIDE / side);
  const area = width * height;
  if (area > MAX_CANVAS_AREA) fit = Math.min(fit, Math.sqrt(MAX_CANVAS_AREA / area));
  return fit > 0 && fit < 1 ? fit : 1;
}

/**
 * 这一屏的图从哪儿来。
 *
 * **Blob 不能跨上下文传**：`chrome.runtime.sendMessage` 走的是 JSON 风格的序列化，
 * 一个 Blob 到了对面就变成空对象 `{}`，`createImageBitmap` 于是抛
 * "The provided value is not of type '(Blob or ...)'" —— 长图跑到最后一步才炸，
 * 而且报错跟「没传过来」一点关系都看不出来。所以截图那头只能给 data URL。
 *
 * @returns {'blob'|'dataUrl'|null}
 */
export function stripSource(strip) {
  if (!strip) return null;
  if (strip.blob && typeof strip.blob.arrayBuffer === 'function') return 'blob';
  if (typeof strip.dataUrl === 'string' && strip.dataUrl.startsWith('data:')) return 'dataUrl';
  return null;
}

async function blobOf(strip) {
  const kind = stripSource(strip);
  if (kind === 'blob') return strip.blob;
  if (kind === 'dataUrl') return (await fetch(strip.dataUrl)).blob();
  throw new Error('这一屏既没有 blob 也没有 dataUrl —— Blob 跨上下文传不过来，请传 data URL。');
}

/**
 * 去掉重复位置、并保证按纵向顺序排列。
 *
 * 页面滚不到位时，好几屏会拍到同一个偏移 —— 画上去就是实打实的重影。
 * 这里做最后一道兜底：同一偏移只留一张，并按顺序画（后面的盖住前面的，
 * 正好是「最后一屏补全底部」想要的效果）。
 */
export function dedupeStrips(strips) {
  const seen = new Set();
  const out = [];
  for (const strip of strips || []) {
    if (!strip) continue;
    const top = Math.max(0, Math.round(Number(strip.top) || 0));
    if (seen.has(top)) continue;
    seen.add(top);
    out.push({ ...strip, top });
  }
  return out.sort((a, b) => a.top - b.top);
}

export async function stitchStrips(strips, { width, height, onProgress = () => {} }) {
  const list = dedupeStrips(strips);
  if (!list.length) throw new Error('没有截到任何一屏。');
  const bad = list.find((strip) => !stripSource(strip));
  if (bad) {
    throw new Error('截图数据没有传过来（Blob 会被消息序列化吃掉，必须传 data URL）。');
  }

  // 先量第一屏，拿到设备像素比；后面所有坐标都按这个比例换算。
  const probe = await createImageBitmap(await blobOf(list[0]));
  const dpr = stripScale(probe.width, list[0].width || width);
  probe.close?.();

  const fit = fitScaleToCanvas(Math.round(width * dpr), Math.round(height * dpr));
  const outWidth = Math.round(width * dpr * fit);
  const outHeight = Math.round(height * dpr * fit);
  if (outWidth <= 0 || outHeight <= 0) throw new Error('报告尺寸异常，无法生成长图。');

  const canvas = makeCanvas(outWidth, outHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建绘图上下文。');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outWidth, outHeight);

  let index = 0;
  for (const strip of list) {
    const bitmap = await createImageBitmap(await blobOf(strip));
    try {
      // 每屏按原尺寸画到它自己的纵向偏移上；整体缩放交给画布尺寸。
      const drawWidth = Math.max(1, Math.round(bitmap.width * fit));
      const drawHeight = Math.max(1, Math.round(bitmap.height * fit));
      ctx.drawImage(bitmap, 0, Math.round((strip.top || 0) * dpr * fit), drawWidth, drawHeight);
    } finally {
      bitmap.close?.();
    }
    index += 1;
    onProgress({ done: index, total: list.length });
  }

  const blob = canvas instanceof OffscreenCanvas
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return { blob, width: outWidth, height: outHeight };
}

/** Scale a captured strip back to CSS pixels if the display is not 1:1. */
export function stripScale(bitmapWidth, cssWidth) {
  if (!cssWidth || !bitmapWidth) return 1;
  const ratio = bitmapWidth / cssWidth;
  return ratio > 0.9 && ratio < 4 ? ratio : 1;
}
