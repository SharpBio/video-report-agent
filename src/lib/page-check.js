/**
 * DOM half of report inspection: overflow, clipping, broken images.
 * Ported from inspect_report.py::PAGE_CHECK. Runs inside the viewer page.
 */

export function pageCheck() {
  const findings = [];
  const refs = [];
  const label = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id,
    text: (el.textContent || '').trim().slice(0, 160),
  });
  for (const el of document.querySelectorAll('body *')) {
    if (el.hasAttribute('data-source-units')) {
      refs.push({ ...label(el), ids: el.getAttribute('data-source-units') });
    }
    const box = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    if (!box.width || !box.height || css.visibility === 'hidden'
      || (el.closest('details:not([open])') && !el.closest('summary'))) continue;
    if (box.left < -2 || box.right > window.innerWidth + 2) {
      findings.push({
        kind: 'horizontal_overflow',
        ...label(el),
        left: Math.round(box.left),
        right: Math.round(box.right),
      });
    }
    // Candidates only: deliberate clipping can be valid design.
    if (['hidden', 'clip'].includes(css.overflowY)
      && el.scrollHeight > el.clientHeight + 3 && el.clientHeight > 0
      && (el.textContent || '').trim()) {
      findings.push({
        kind: 'possible_vertical_clipping',
        ...label(el),
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      });
    }
    if (el.tagName === 'IMG' && (!el.complete || el.naturalWidth === 0)) {
      findings.push({ kind: 'broken_image', ...label(el) });
    }
  }
  return {
    findings,
    refs,
    title: document.title,
    width: window.innerWidth,
    height: document.documentElement.scrollHeight,
  };
}

/** Serialise so the result survives a runtime message. */
export const PAGE_CHECK_SOURCE = `(${pageCheck.toString()})()`;

export function normalizeFindings(result, validIds = []) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds);
  const findings = [...(result?.findings || [])];
  for (const ref of result?.refs || []) {
    const ids = String(ref.ids || '').split(/[\s,;]+/).filter(Boolean);
    if (valid.size && (!ids.length || ids.some((id) => !valid.has(id)))) {
      findings.push({
        kind: 'invalid_source_ids',
        tag: ref.tag,
        id: ref.id,
        text: ref.text,
        invalidIds: ids.filter((id) => !valid.has(id)),
      });
    }
  }
  if (!(result?.refs || []).length) {
    findings.push({ kind: 'missing_source_bindings', detail: '页面没有找到来源绑定元素。' });
  }
  return findings;
}
