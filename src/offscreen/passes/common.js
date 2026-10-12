/**
 * One agentic pass: stream a chat turn, run any tool calls locally, repeat until
 * the model stops asking or the round budget runs out.
 *
 * Native tool calling is used when the provider supports it; otherwise the model
 * emits fenced ```tool blocks that are parsed here. Both paths end in the same
 * executor, so the draft state behaves identically.
 */
import { chat } from '../../lib/llm.js';
import { TOOL_SCHEMAS, parseTextToolCalls } from '../../lib/tools.js';
import { resource } from '../../lib/prompts.js';

const DEFAULT_MAX_ROUNDS = 8;

function toolMessagesFor(calls, executor) {
  return Promise.all(calls.map(async (call) => {
    const output = await executor.dispatch(call);
    return {
      role: 'tool',
      tool_call_id: call.id,
      name: call.name,
      content: JSON.stringify(output ?? null),
    };
  }));
}

/**
 * @param {object} args
 * @param {object} args.settings
 * @param {Array}  args.messages     starting messages (system + user)
 * @param {object} args.executor     from createExecutor()
 * @param {string} [args.stage]
 * @param {number} [args.maxRounds]
 * @param {AbortSignal} [args.signal]
 * @param {(text:string)=>void} [args.onDelta]
 * @returns {Promise<{rounds:number, usage:object, text:string, toolCalls:number}>}
 */
export async function runPass({
  settings,
  messages,
  executor,
  stage = 'pass',
  maxRounds = DEFAULT_MAX_ROUNDS,
  signal = null,
  isFinished = () => false,
  onDelta = () => {},
}) {
  const native = settings.llm.toolsMode !== 'text';
  const history = [...messages];
  if (!native) {
    history.push({ role: 'system', content: await resource.prompt('tool-fallback.md') });
  }

  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastText = '';
  let rounds = 0;
  let toolCalls = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    const result = await chat({
      settings,
      messages: history,
      tools: native ? TOOL_SCHEMAS : null,
      signal,
      onDelta,
    });
    usage.promptTokens += result.usage?.promptTokens || 0;
    usage.completionTokens += result.usage?.completionTokens || 0;
    usage.totalTokens += result.usage?.totalTokens || 0;
    lastText = result.content || lastText;

    let calls = result.toolCalls || [];

    if (!calls.length && !native) {
      const parsed = parseTextToolCalls(result.content || '');
      calls = parsed.calls;
      if (calls.length) {
        history.push({ role: 'assistant', content: parsed.text || '（已提交工具调用）' });
      }
    } else if (calls.length) {
      history.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
        })),
      });
    } else {
      history.push({ role: 'assistant', content: result.content || '' });
      break;
    }

    if (!calls.length) break;
    toolCalls += calls.length;
    const toolMessages = await toolMessagesFor(calls, executor);
    history.push(...toolMessages);

    if (isFinished()) break;
  }

  return { rounds, usage, text: lastText, toolCalls };
}

/** Cheap guard so a runaway pass cannot burn the whole budget on one chapter. */
export function roundBudgetFor(unitCount) {
  if (unitCount <= 60) return 6;
  if (unitCount <= 200) return 8;
  return 10;
}
