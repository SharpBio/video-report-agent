/** Load bundled skill/prompt text and assemble per-pass message sets. */
import { unitIndex, sectionTimeFor } from './transcript.js';

const SKILL_ROOT = 'skills/video-report';
const PROMPT_ROOT = 'prompts';
const cache = new Map();

/**
 * 打包资源不存在时，Chrome 让 `fetch` 直接 reject（"Failed to fetch"），
 * **不会**返回 404 响应 —— 所以 `response.ok` 那句判断压根到不了。
 * 报错里必须带上完整 URL，否则看到的只有一句没有出处的 "Failed to fetch"。
 */
export async function loadText(path) {
  if (cache.has(path)) return cache.get(path);
  const url = chrome.runtime.getURL(path);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `读不到打包资源：${path}（${url}）—— ${error?.message || ''}。`
      + '文件不在包里（或路径拼错）会让 fetch 直接失败，而不是返回 404。',
    );
  }
  if (!response.ok) throw new Error(`资源缺失：${path}（HTTP ${response.status}）`);
  const text = await response.text();
  cache.set(path, text);
  return text;
}

/** 拼提示词路径。调用方有的带 `.md` 有的不带，这里统一，避免拼出 `.md.md`。 */
export function promptPath(name) {
  const base = String(name || '').replace(/\.md$/i, '');
  return `${PROMPT_ROOT}/${base}.md`;
}

export const resource = {
  skill: () => loadText(`${SKILL_ROOT}/SKILL.md`),
  mode: (mode) => loadText(`${SKILL_ROOT}/modes/${mode}.md`),
  reference: (name) => loadText(`${SKILL_ROOT}/references/${name}.md`),
  template: () => loadText(`${SKILL_ROOT}/assets/report-template.html`),
  prompt: (name) => loadText(promptPath(name)),
};

export const PROFILE_REFERENCES = {
  mechanism: 'mechanism',
  procedure: 'procedure',
  evidence: 'evidence',
  argument: 'argument',
  narrative: 'narrative',
};

/**
 * 自检用：把流水线真正会读的**每一个**打包资源都读一遍。
 *
 * 必须走 `resource.*` 本体而不是自己拼路径 —— 上一版自检只直接 fetch 了
 * `prompts/system-append.md`，于是「prompt() 把 .md 又拼一次变成 .md.md」这个 bug
 * 在自检里全绿，直到 plan 那一轮才炸。教训同 R1：自检要验生产路径本体。
 */
export async function verifyResources() {
  const targets = [
    ['SKILL.md', () => resource.skill()],
    ['modes/standard.md', () => resource.mode('standard')],
    ...Object.values(PROFILE_REFERENCES).map((name) => [
      `references/${name}.md`, () => resource.reference(name),
    ]),
    ['prompts/system-append.md', () => resource.prompt('system-append.md')],
    ['prompts/components.md', () => resource.prompt('components.md')],
    ['prompts/plan-schema.md', () => resource.prompt('plan-schema.md')],
    ['prompts/tool-fallback.md', () => resource.prompt('tool-fallback.md')],
    ['assets/report-template.html', () => resource.template()],
  ];

  const out = [];
  for (const [label, load] of targets) {
    try {
      const text = await load();
      out.push({ label, ok: Boolean(text && String(text).trim()), chars: String(text || '').length });
    } catch (error) {
      out.push({ label, ok: false, error: error?.message || String(error) });
    }
  }
  return out;
}

/**
 * The system message is byte-identical across passes whenever possible, so the
 * provider can reuse its prompt cache.
 */
export async function buildSystem({ profiles = [], includeTemplate = false, includeComponents = true }) {
  const parts = [await resource.skill(), await resource.mode('standard')];
  const names = profiles
    .filter(Boolean)
    .map((name) => PROFILE_REFERENCES[name])
    .filter(Boolean);
  for (const name of [...new Set(names)].slice(0, 2)) {
    parts.push(await resource.reference(name));
  }
  parts.push(await resource.prompt('system-append.md'));
  if (includeComponents) parts.push(await resource.prompt('components.md'));
  if (includeTemplate) parts.push(await resource.template());
  return parts.join('\n\n---\n\n');
}

export function planningSystem(skillText) {
  // The planning pass deliberately omits modes/standard.md so the structure is
  // chosen from the source rather than from the mode's default shapes.
  return skillText;
}

export async function planMessages({ title, attribution, durationMs, units }) {
  const skill = await resource.skill();
  const schema = await resource.prompt('plan-schema.md');
  const index = unitIndex(units);
  const user = [
    '下面是本次任务的来源信息与完整来源单元索引。请通读索引，判断信息结构，然后按契约输出规划 JSON。',
    '',
    `视频标题：${title}`,
    `来源：${attribution}`,
    `时长：${Math.round((durationMs || 0) / 1000)} 秒`,
    `来源单元总数：${units.length}`,
    '',
    '## 来源单元索引',
    ...index,
    '',
    '## 输出契约',
    schema,
  ].join('\n');
  return [
    { role: 'system', content: planningSystem(skill) },
    { role: 'user', content: user },
  ];
}

export function sectionMessages({ system, plan, section, units, done, totalDurationMs }) {
  const from = Math.max(1, Number(section.unitRange?.[0]) || 1);
  const to = Math.min(units.length, Number(section.unitRange?.[1]) || units.length);
  const slice = units.slice(from - 1, to);
  const body = slice
    .map((unit) => `[${unit.unitId} | ${(unit.startMs / 1000).toFixed(3)}–${(unit.endMs / 1000).toFixed(3)}s] ${unit.text}`)
    .join('\n');

  const lines = [
    `本次写第 ${section?.order} 章（共 ${plan?.sections?.length ?? 0} 章），id=${section?.id}。`,
    `本章标题：${section?.title}`,
    `本章意图：${section?.intent || '（未指定）'}`,
    `本章来源单元区间：unit ${from}–${to}（共 ${slice.length} 个）`,
    '',
    '## 已完成章节',
    done.length
      ? done.map((item) => `- ${item.order}. ${item.title}（${item.chars} 字，来源 ${(item.sourceUnits || []).length} 处）`).join('\n')
      : '（还没有）',
    '',
    '## 本章来源原文',
    body,
    '',
    '要求：',
    '- 读完本章原文后调用 write_section 写入 html，并如实填写 sourceUnits / unitRange。',
    '- 不要输出 <section>、<h2>、章节序号或 section-time，这些由运行时装配。',
    '- 保留会改变结论的条件、数字口径、人物归属与不确定性；单元更碎不代表可以省略限定。',
    '- 需要精确图形坐标时用 exec_js 计算；不可用时就地简化为文字、表格或公式。',
  ];
  if (totalDurationMs >= 3600000) {
    lines.push('- 来源总时长超过一小时，图中的事件时间用 HH:MM:SS。');
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
}

export function reviseMessages({ system, reportHtml, findings, unitCount }) {
  const lines = [
    '下面是当前已装配的完整报告 HTML，以及程序检查发现的问题。',
    '',
    '## 检查发现',
    findings.length
      ? findings.map((item, index) => `${index + 1}. [${item.kind}] ${item.detail}`).join('\n')
      : '（无）',
    '',
    '## 修订要求',
    '- 只修订确实存在的问题。possible_vertical_clipping 只是候选，确认真的遮挡正文才修。',
    '- 不得为了消除告警删除内容、限定或 data-source-units 绑定。',
    '- 至多重写 2 个章节（用 write_section 覆盖），其余就地不动。',
    '- 需要补充页尾来源说明时用 write_meta 的 sourcesHtml。',
    `- 报告中合法来源单元形如 unit-NNNNNN，共 ${unitCount} 个；不得使用区间、通配符或自造 id。`,
    '- 修订完成后调用 finish。若检查无实际问题，直接调用 finish，不要为改动而改动。',
    '',
    '## 当前报告 HTML',
    reportHtml,
  ];
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** Deterministic fallback: a section with no declared units gets no time. */
export function computedSectionTime(units, section, totalDurationMs) {
  const range = Array.isArray(section.unitRange) ? section.unitRange : [];
  const ids = Array.isArray(section.sourceUnits) ? section.sourceUnits : [];
  const selected = [];
  if (ids.length) {
    const set = new Set(ids);
    selected.push(...units.filter((unit) => set.has(unit.unitId)));
  }
  if (!selected.length && range.length === 2) {
    selected.push(...units.slice(Math.max(0, range[0] - 1), Math.min(units.length, range[1])));
  }
  return sectionTimeFor(selected, { hours: totalDurationMs >= 3600000 });
}
