/**
 * P_rev — one bounded revision pass driven by programmatic findings.
 *
 * Deliberately narrow: at most two chapters may be rewritten, bindings may never
 * be dropped to silence a warning, and "no real problem" is a valid outcome.
 */
import { reviseMessages } from '../../lib/prompts.js';
import { runPass } from './common.js';
import { createExecutor } from '../../lib/tools.js';

const MAX_REWRITES = 2;

/**
 * @param {object} args
 * @param {Array} args.findings  from validate.js / page-check.js
 * @param {string} args.html     assembled report
 * @param {Array}  args.units
 * @returns {{changed:boolean, usage:object, skipped:string|null}}
 */
export async function runRevise({
  settings, system, findings, html, units, draft, signal = null, onDelta = () => {},
}) {
  const worthy = (findings || []).filter((item) => item.kind !== 'unfilled_placeholder');
  if (!worthy.length) return { changed: false, usage: {}, skipped: 'no_findings' };

  const before = draft.sections.map((item) => item.html || '').join('\n');
  const messages = reviseMessages({ system, reportHtml: html, findings: worthy, unitCount: units.length });
  const executor = createExecutor({ units, draft, settings });

  let rewrites = 0;
  const limitedExecutor = {
    dispatch(call) {
      if (call.name === 'write_section') {
        rewrites += 1;
        if (rewrites > MAX_REWRITES) {
          return { error: `本次修订最多重写 ${MAX_REWRITES} 个章节，请直接调用 finish。` };
        }
      }
      return executor.dispatch(call);
    },
  };

  const result = await runPass({
    settings,
    messages,
    executor: limitedExecutor,
    stage: 'revise',
    maxRounds: 4,
    signal,
    onDelta,
  });

  const after = draft.sections.map((item) => item.html || '').join('\n');
  return { changed: after !== before, usage: result.usage, skipped: null, rewrites };
}
