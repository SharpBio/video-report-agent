/**
 * Static checks on assembled HTML — the cheap half of report inspection.
 * The DOM half (overflow, clipping, broken images) lives in ./page-check.js.
 *
 * Findings are candidates, not a quality score: the revision pass decides.
 */

const SOURCE_ATTR = /data-source-units="([^"]*)"/g;
const UNIT_ID = /^unit-\d{6}$/;

export function collectSourceRefs(html) {
  const refs = [];
  for (const match of html.matchAll(SOURCE_ATTR)) {
    const ids = match[1].split(/[\s,;]+/).filter(Boolean);
    refs.push({ ids });
  }
  return refs;
}

/**
 * @param {string} html
 * @param {Set<string>|Array<string>} validIds
 * @returns {Array<{kind:string, detail:string, invalidIds?:string[]}>}
 */
export function validateReport(html, validIds = []) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds);
  const findings = [];

  for (const match of html.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
    findings.push({ kind: 'unfilled_placeholder', detail: `模板占位符未替换：{{${match[1]}}}` });
  }

  const refs = collectSourceRefs(html);
  if (!refs.length) {
    findings.push({ kind: 'missing_source_bindings', detail: '报告没有任何 data-source-units 绑定。' });
  }
  if (valid.size) {
    const invalid = new Set();
    for (const ref of refs) {
      for (const id of ref.ids) if (!UNIT_ID.test(id) || !valid.has(id)) invalid.add(id);
    }
    if (invalid.size) {
      findings.push({
        kind: 'invalid_source_ids',
        detail: `${invalid.size} 个来源单元 id 不在转写中：${[...invalid].slice(0, 8).join(' ')}`,
        invalidIds: [...invalid],
      });
    }
  }

  const opens = (html.match(/<section\b/g) || []).length;
  const closes = (html.match(/<\/section>/g) || []).length;
  if (opens !== closes) {
    findings.push({ kind: 'unbalanced_sections', detail: `<section> ${opens} 个，</section> ${closes} 个。` });
  }

  const empty = [...html.matchAll(/<section id="(s\d+)">([\s\S]*?)<\/section>/g)]
    .filter((match) => !/<(p|h3|ul|ol|table|div|figure|svg)\b/.test(match[2]))
    .map((match) => match[1]);
  if (empty.length) {
    findings.push({ kind: 'empty_section', detail: `章节没有正文：${empty.join('、')}` });
  }

  const scripts = (html.match(/<script\b/g) || []).length;
  if (scripts > 1) {
    findings.push({ kind: 'unexpected_script', detail: `报告中出现 ${scripts} 个 <script>，应只有导航脚本。` });
  }

  const headings = [...html.matchAll(/<span class="num">(\d+)<\/span>/g)].map((m) => Number(m[1]));
  for (let i = 0; i < headings.length; i += 1) {
    if (headings[i] !== i + 1) {
      findings.push({ kind: 'section_number_gap', detail: `章节序号不连续：第 ${i + 1} 处为 ${headings[i]}。` });
      break;
    }
  }

  return findings;
}

/** Only these kinds are worth spending a revision pass on. */
const REVISION_WORTHY = new Set([
  'invalid_source_ids', 'missing_source_bindings', 'empty_section',
  'horizontal_overflow', 'possible_vertical_clipping', 'broken_image',
  'unbalanced_sections', 'resource_or_script_error',
]);

export function revisionWorthy(findings) {
  return findings.filter((item) => REVISION_WORTHY.has(item.kind));
}

export function findingsSummary(findings) {
  if (!findings.length) return '（无）';
  return findings.map((item, index) => `${index + 1}. [${item.kind}] ${item.detail}`).join('\n');
}
