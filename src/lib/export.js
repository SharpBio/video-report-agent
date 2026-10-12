/**
 * Deliverables: report.html / report.png / transcript.md.
 * Uses chrome.downloads when it is available (background), otherwise an
 * object-URL anchor click (viewer page).
 */

function blobFor(content, type) {
  return content instanceof Blob ? content : new Blob([content], { type });
}

async function viaDownloads(blob, filename, saveAs) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename,
      // saveAs 会弹「另存为」对话框。长图要的是「点了就下载」，所以那条路传 false。
      saveAs,
      conflictAction: 'uniquify',
    });
    return id;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function viaAnchor(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function downloadFile(content, filename, type = 'text/plain;charset=utf-8', { saveAs = true } = {}) {
  const blob = blobFor(content, type);
  if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
    try {
      return await viaDownloads(blob, filename, saveAs);
    } catch {
      /* fall through to the anchor path */
    }
  }
  viaAnchor(blob, filename);
  return null;
}

/** Windows-forbidden characters and a length cap keep downloads predictable. */
export function safeFilename(title, extension) {
  const base = String(title || 'report')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'report'}.${extension}`;
}

export function zipNotSupported() {
  return new Error('打包导出需要原生解压工具，插件版只提供单文件导出。');
}
