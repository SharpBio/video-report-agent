/**
 * Post-assembly fixes owned by the runtime, never by the model.
 * Ported from report_content.py so the same file stays valid in both worlds.
 */

export const VIDEO_DESCRIPTION_PLACEHOLDER = '{{VIDEO_DESCRIPTION}}';
export const VIDEO_DESCRIPTION_START = '<!-- VIDEO_DESCRIPTION_START -->';
export const VIDEO_DESCRIPTION_END = '<!-- VIDEO_DESCRIPTION_END -->';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function boundarySpan(html) {
  const startCount = html.split(VIDEO_DESCRIPTION_START).length - 1;
  const endCount = html.split(VIDEO_DESCRIPTION_END).length - 1;
  if (startCount !== endCount) return { error: '视频简介标记不配对。' };
  if (startCount > 1) return { error: '视频简介标记重复。' };
  if (startCount === 0) return null;
  const start = html.indexOf(VIDEO_DESCRIPTION_START);
  const end = html.indexOf(VIDEO_DESCRIPTION_END);
  if (end < start) return { error: '视频简介结束标记在起始标记之前。' };
  return { start, end: end + VIDEO_DESCRIPTION_END.length };
}

function render(description) {
  return `${VIDEO_DESCRIPTION_START}\n<details><summary>视频简介（展开）</summary>`
    + `<div class="video-description-text">${escapeHtml(description)}</div></details>\n`
    + VIDEO_DESCRIPTION_END;
}

/**
 * Idempotent: filling twice never accumulates a second disclosure block, and a
 * placeholder inside an already-filled block counts as user content.
 */
export function fillVideoDescription(html, description) {
  const boundary = boundarySpan(html);
  if (boundary?.error) throw new Error(boundary.error);

  let outside = html;
  if (boundary) outside = html.slice(0, boundary.start) + html.slice(boundary.end);
  const placeholders = outside.split(VIDEO_DESCRIPTION_PLACEHOLDER).length - 1;
  if (placeholders > 1) throw new Error('视频简介占位符重复。');
  if (boundary && placeholders) throw new Error('视频简介同时存在标记与占位符。');

  const text = String(description || '').trim();
  if (!text) {
    if (boundary) return html.slice(0, boundary.start) + html.slice(boundary.end);
    if (placeholders) return html.replace(VIDEO_DESCRIPTION_PLACEHOLDER, '');
    return html;
  }
  if (boundary) {
    return html.slice(0, boundary.start) + render(text) + html.slice(boundary.end);
  }
  if (placeholders === 1) return html.replace(VIDEO_DESCRIPTION_PLACEHOLDER, render(text));
  throw new Error('非空视频简介需要一个占位符或完整标记。');
}

/** Replace the template's `:)` footer placeholder with a real link. */
export function applyFooter(html, footerUrl) {
  const url = String(footerUrl || '').trim();
  if (!url) return html;
  const label = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return html.replace(
    /<a class="footer-link" href=":\)">:\)<\/a>/g,
    `<a class="footer-link" href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
  );
}

/** Page <title> must track the report title after a revision renames it. */
export function syncTitle(html, title) {
  const value = String(title || '').trim();
  if (!value) return html;
  return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(value)}</title>`);
}
