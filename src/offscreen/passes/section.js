/**
 * P1..N — one chapter per pass.
 *
 * Each pass sees only its own units plus a list of already-written chapters, so
 * the context stays bounded and a crash can resume at the exact chapter.
 * `write_section` is idempotent, so a retried pass overwrites instead of appending.
 */
import { sectionMessages } from '../../lib/prompts.js';
import { runPass, roundBudgetFor } from './common.js';
import { createExecutor } from '../../lib/tools.js';

/**
 * @returns {{ok:boolean, usage:object, chars:number, sourceUnits:number}}
 */
/** 章节数组可能来自模型输出或 IndexedDB 的旧快照，出现空洞会让 .id 直接炸。 */
function safe(list) {
  return (Array.isArray(list) ? list : []).filter(Boolean);
}

export async function runSection({
  settings, system, plan, section, units, draft, totalDurationMs,
  signal = null, onDelta = () => {},
}) {
  draft.sections = safe(draft.sections);
  const done = draft.sections
    .filter((item) => item.id !== section?.id && (item.html || '').trim())
    .map((item) => ({
      order: item.order, title: item.title,
      chars: (item.html || '').length,
      sourceUnits: item.sourceUnits || [],
    }));

  const messages = sectionMessages({
    system, plan, section, units, done, totalDurationMs,
  });
  const executor = createExecutor({ units, draft, settings });
  const before = draft.sections.find((item) => item.id === section.id);

  const result = await runPass({
    settings,
    messages,
    executor,
    stage: `section:${section.id}`,
    maxRounds: roundBudgetFor(units.length),
    signal,
    isFinished: () => Boolean(draft.sections.find((item) => item.id === section.id)?.html?.trim()),
    onDelta,
  });

  const after = draft.sections.find((item) => item.id === section.id);
  const wrote = Boolean(after?.html?.trim());
  if (!wrote && before) {
    // A pass that produced nothing must not leave a half-written chapter behind.
    draft.sections = draft.sections.filter((item) => item.id !== section.id);
  }
  return {
    ok: wrote,
    usage: result.usage,
    chars: after?.html?.length || 0,
    sourceUnits: after?.sourceUnits?.length || 0,
    rounds: result.rounds,
  };
}

/** Sections that still need a pass, in order. */
export function pendingSections(plan, draft) {
  const written = new Set(
    safe(draft.sections).filter((item) => (item.html || '').trim()).map((item) => item.id),
  );
  return safe(plan.sections).filter((section) => !written.has(section.id));
}
