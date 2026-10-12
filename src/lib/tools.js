/** Tool schemas and the local executor that backs them. */
import { execJs } from './sandbox.js';

const MAX_TOOL_CHARS = 12000;

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_transcript',
      description: '按来源单元区间读取转写原文。区间按 unit 序号（从 1 开始）。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'integer', description: '起始 unit 序号（含）' },
          to: { type: 'integer', description: '结束 unit 序号（含）' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_report',
      description: '读取当前草稿。outline 返回章节清单；section 返回某章 HTML；head 返回题头字段。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['outline', 'section', 'head'] },
          id: { type: 'string', description: 'scope=section 时的章节 id' },
        },
        required: ['scope'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_section',
      description: '写入或覆盖一个正文大章节。html 是 section 内部的完整 HTML，不要包含外层 <section> 与 <h2>。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          order: { type: 'integer' },
          title: { type: 'string' },
          html: { type: 'string' },
          sourceUnits: { type: 'array', items: { type: 'string' } },
          unitRange: { type: 'array', items: { type: 'integer' } },
          nav: { type: 'string' },
        },
        required: ['id', 'title', 'html'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_meta',
      description: '写入题头字段、目录标签或页尾来源说明。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          lead: { type: 'string' },
          nav: { type: 'array', items: { type: 'string' } },
          sourcesHtml: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec_js',
      description: '在沙箱中执行 JavaScript 并返回 JSON 结果，用于精确计算图形坐标。无网络、无文件、无 chrome API。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          args: { type: 'array' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '结束当前轮次。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
      },
    },
  },
];

/**
 * Create a tool executor bound to one run's draft state.
 * `draft` is mutated in place; the caller persists it.
 */
export function createExecutor({ units, draft, settings }) {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));

  const sectionText = (section) => {
    const order = section.order ?? draft.sections.length + 1;
    const lines = [`第 ${order} 章 · ${section.title}`, `id=${section.id}`, ''];
    lines.push(section.html || '(空)');
    return lines.join('\n');
  };

  const handlers = {
    read_transcript: ({ from, to }) => {
      const start = Math.max(1, Number(from) || 1);
      const end = Math.min(units.length, Number(to) || units.length);
      if (end < start) return { error: '区间无效。' };
      const slice = units.slice(start - 1, end);
      let text = slice
        .map((unit) => `[${unit.unitId} | ${(unit.startMs / 1000).toFixed(3)}–${(unit.endMs / 1000).toFixed(3)}s] ${unit.text}`)
        .join('\n');
      let truncated = false;
      if (text.length > MAX_TOOL_CHARS) {
        text = text.slice(0, MAX_TOOL_CHARS);
        truncated = true;
      }
      return { from: start, to: end, count: slice.length, text, truncated };
    },

    read_report: ({ scope, id }) => {
      if (scope === 'head') {
        return { head: { ...(draft.meta || {}) }, unitCount: units.length };
      }
      if (scope === 'section') {
        const section = draft.sections.find((item) => item && item.id === id);
        if (!section) {
          return { error: `没有 id=${id} 的章节。`, sections: draft.sections.filter(Boolean).map((s) => s.id) };
        }
        return { section: sectionText(section) };
      }
      return {
        outline: draft.sections.map((section, index) => ({
          order: section.order ?? index + 1,
          id: section.id,
          title: section.title,
          chars: (section.html || '').length,
          sourceUnits: section.sourceUnits || [],
          unitRange: section.unitRange || [],
        })),
        totalSections: draft.sections.length,
      };
    },

    write_section: (args) => {
      const id = String(args.id || '').trim();
      if (!id) return { error: '缺少章节 id。' };
      const existing = draft.sections.findIndex((item) => item.id === id);
      const record = {
        id,
        order: Number(args.order) || (existing >= 0 ? draft.sections[existing].order : draft.sections.length + 1),
        title: String(args.title || '').trim() || (existing >= 0 ? draft.sections[existing].title : id),
        html: String(args.html || ''),
        sourceUnits: Array.isArray(args.sourceUnits) ? args.sourceUnits.filter((u) => byId.has(u)) : [],
        unitRange: Array.isArray(args.unitRange) ? args.unitRange.map(Number) : [],
        nav: args.nav ? String(args.nav) : null,
      };
      if (existing >= 0) draft.sections[existing] = record;
      else draft.sections.push(record);
      draft.sections.sort((a, b) => (a.order || 0) - (b.order || 0));
      return { ok: true, id, sections: draft.sections.length, chars: record.html.length };
    },

    write_meta: (args) => {
      draft.meta = draft.meta || {};
      for (const key of ['title', 'subtitle', 'lead', 'nav', 'sourcesHtml']) {
        if (args[key] !== undefined) draft.meta[key] = args[key];
      }
      return { ok: true, meta: draft.meta };
    },

    exec_js: async ({ code, args }) => {
      if (settings?.report?.disableExecJs) {
        return { ok: false, error: 'exec_js 已禁用；请改用文字、表格或公式表达。' };
      }
      const result = await execJs(String(code || ''), Array.isArray(args) ? args : []);
      if (!result.ok) return { ok: false, error: result.error };
      let text = JSON.stringify(result.value ?? null);
      if (text.length > MAX_TOOL_CHARS) {
        text = `${text.slice(0, MAX_TOOL_CHARS)}…（已截断）`;
      }
      return { ok: true, value: result.value, json: text };
    },

    finish: ({ summary }) => {
      draft.finished = true;
      return { ok: true, summary: summary || '' };
    },
  };

  return {
    async dispatch(call) {
      const handler = handlers[call.name];
      if (!handler) return { error: `未知工具：${call.name}` };
      try {
        return await handler(call.arguments || {});
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    },
  };
}

/** Text-mode fallback: parse fenced ```tool blocks when native tools are unavailable. */
export const TOOL_FENCE = /```tool\s*\n([\s\S]*?)\n```/g;

export function parseTextToolCalls(content) {
  const calls = [];
  for (const match of content.matchAll(TOOL_FENCE)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed.name === 'string') {
        calls.push({ id: `text-${calls.length}`, name: parsed.name, arguments: parsed.arguments || {} });
      }
    } catch {
      /* malformed block: ignore */
    }
  }
  return { calls, text: content.replace(TOOL_FENCE, '').trim() };
}
