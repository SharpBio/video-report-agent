/**
 * P0 — planning. Reads the whole unit index and returns the structure contract:
 * profiles, head fields, and the section list with unit ranges.
 * No report text is written here.
 */
import { planMessages } from '../../lib/prompts.js';
import { runPass } from './common.js';
import { createExecutor } from '../../lib/tools.js';
import { formatClock } from '../../lib/transcript.js';

const FENCED = /```(?:json)?\s*([\s\S]*?)\s*```/g;

function extractJson(text) {
  const candidates = [];
  for (const match of String(text || '').matchAll(FENCED)) candidates.push(match[1]);
  const first = String(text || '').indexOf('{');
  const last = String(text || '').lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(String(text).slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function sanitizeId(value, index) {
  const raw = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  return raw ? raw.slice(0, 40) : `sec-${index + 1}`;
}

/** Normalise whatever the model produced into the contract we can assemble. */
export function normalizePlan(payload, units, fallbackTitle) {
  const raw = Array.isArray(payload?.sections) ? payload.sections : [];
  const total = units.length || 1;
  const sections = raw
    .map((item, index) => {
      const range = Array.isArray(item?.unitRange) ? item.unitRange.map(Number) : [];
      const from = Number.isFinite(range[0]) ? Math.min(Math.max(1, Math.floor(range[0])), total) : 1;
      const to = Number.isFinite(range[1]) ? Math.min(Math.max(from, Math.floor(range[1])), total) : total;
      return {
        id: sanitizeId(item?.id || item?.slug, index),
        order: index + 1,
        title: String(item?.title || `第 ${index + 1} 部分`).trim(),
        intent: String(item?.intent || '').trim(),
        timeHint: String(item?.timeHint || '').trim(),
        nav: String(item?.nav || '').trim() || null,
        unitRange: [from, to],
      };
    })
    .filter(Boolean);

  return {
    profile_primary: String(payload?.profile_primary || '').trim(),
    profile_secondary: String(payload?.profile_secondary || '').trim(),
    title: String(payload?.title || fallbackTitle || '').trim(),
    subtitle: String(payload?.subtitle || '').trim(),
    lead: String(payload?.lead || '').trim(),
    nav: Array.isArray(payload?.nav) ? payload.nav.map(String) : [],
    sections,
  };
}

/**
 * Fallback used only when the model cannot produce valid JSON twice.
 * Splits by time so every unit is still covered by exactly one section.
 */
export function fallbackPlan(units, { title, targetSections = 5, windowMinutes = 6 }) {
  const total = units.length;
  const count = Math.max(1, Math.min(targetSections, Math.ceil(total / 8) || 1));
  const perSection = Math.ceil(total / count);
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const from = index * perSection + 1;
    const to = Math.min(total, (index + 1) * perSection);
    if (from > total) break;
    const start = units[from - 1]?.startMs ?? 0;
    const end = units[to - 1]?.endMs ?? 0;
    sections.push({
      id: `sec-${index + 1}`,
      order: index + 1,
      title: `第 ${index + 1} 部分（${formatClock(start)}–${formatClock(end)}）`,
      intent: '按时间顺序整理本段内容。',
      timeHint: '',
      nav: null,
      unitRange: [from, to],
    });
  }
  return {
    profile_primary: 'narrative',
    profile_secondary: '',
    title: title || '',
    subtitle: '',
    lead: '按来源顺序整理视频内容。',
    nav: [],
    sections,
    fallback: true,
    windowMinutes,
  };
}

/**
 * @returns {{plan:object, usage:object, raw:string, fallback:boolean}}
 */
export async function runPlan({
  settings, units, title, attribution, durationMs, signal = null, onDelta = () => {},
}) {
  const messages = await planMessages({ title, attribution, durationMs, units });
  const draft = { sections: [], meta: {}, finished: false };
  const executor = createExecutor({ units, draft, settings });

  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const history = attempt === 1
      ? messages
      : [...messages, {
        role: 'user',
        content: '上一次输出不是合法 JSON。请只输出一个 JSON 对象，不要任何说明文字、不要代码块围栏。',
      }];
    const result = await runPass({
      settings, messages: history, executor, stage: 'plan',
      maxRounds: 2, signal, onDelta,
    });
    attempts.push(result);
    const parsed = extractJson(result.text);
    if (parsed?.sections?.length) {
      return {
        plan: normalizePlan(parsed, units, title),
        usage: result.usage,
        raw: result.text,
        fallback: false,
      };
    }
  }

  return {
    plan: fallbackPlan(units, { title }),
    usage: attempts.at(-1)?.usage || {},
    raw: attempts.at(-1)?.text || '',
    fallback: true,
  };
}
