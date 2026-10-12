/**
 * OpenAI-compatible chat completions client with streaming and tool calls.
 * Streaming matters here: a long generation must be able to report idle timeouts
 * instead of hanging until the socket dies.
 */
import { fail } from './errors.js';
import { chatEndpoint } from './providers.js';

const DEFAULT_IDLE_MS = 120000;

function headers(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function bodyFor({ model, messages, tools, maxTokens, temperature, thinking, stream }) {
  const body = {
    model,
    messages,
    stream: Boolean(stream),
    max_tokens: maxTokens,
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (thinking && thinking !== 'off') {
    // Providers differ; both spellings are accepted and ignored when unsupported.
    body.thinking = { type: thinking === 'high' ? 'enabled' : 'auto' };
    body.enable_thinking = true;
  }
  return body;
}

function classifyHttp(response, raw) {
  const snippet = redact(String(raw).slice(0, 300));
  if (response.status === 401 || response.status === 403) {
    return fail.model('AUTH_OR_QUOTA_FAILURE', '模型服务认证失败或额度不足。', {
      httpStatus: response.status, detail: snippet,
    });
  }
  if (response.status === 429) {
    return fail.model('RATE_LIMITED', '模型服务请求过多，请稍后再试。', {
      httpStatus: response.status, detail: snippet,
    });
  }
  if (response.status >= 500) {
    return fail.model('PROVIDER_UNAVAILABLE', `模型服务暂时不可用（HTTP ${response.status}）。`, {
      httpStatus: response.status, detail: snippet,
    });
  }
  return fail.model('INVALID_PROVIDER_REQUEST', `模型服务拒绝了请求（HTTP ${response.status}）。`, {
    httpStatus: response.status, detail: snippet,
  });
}

function redact(value) {
  return String(value || '').replace(/\b(?:sk-[\w-]+|Bearer\s+\S+)/g, '[credential removed]');
}

/** Merge streaming tool-call deltas, which arrive one fragment at a time. */
function applyToolDelta(calls, delta) {
  if (!Array.isArray(delta)) return;
  for (const piece of delta) {
    const index = typeof piece.index === 'number' ? piece.index : calls.length;
    let call = calls[index];
    if (!call) {
      call = { id: piece.id || '', name: '', arguments: '' };
      calls[index] = call;
    }
    if (piece.id) call.id = piece.id;
    if (piece.function?.name) call.name = piece.function.name;
    if (piece.function?.arguments) call.arguments += piece.function.arguments;
  }
}

function parseSseChunk(buffer, onDelta, onToolDelta, onUsage) {
  const lines = buffer.split('\n');
  const remainder = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.usage) onUsage(event.usage);
    const choice = event.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) onDelta(delta.content);
    if (delta.tool_calls) onToolDelta(delta.tool_calls);
    if (choice.finish_reason) onUsage({ finish_reason: choice.finish_reason });
  }
  return remainder;
}

/**
 * One chat turn.
 * @returns {{content:string, reasoning:string, toolCalls:Array, usage:object, finishReason:string}}
 */
export async function chat({
  settings, messages, tools = null, maxTokens, temperature = 0.3,
  signal = null, onDelta = () => {}, onStage = () => {},
}) {
  const llm = settings.llm;
  const endpoint = chatEndpoint(llm.baseUrl);
  const idleMs = Math.min(llm.timeoutMs, DEFAULT_IDLE_MS * 5);
  const body = bodyFor({
    model: llm.model,
    messages,
    tools,
    maxTokens: maxTokens || llm.maxOutputTokens,
    temperature,
    thinking: llm.thinking,
    stream: true,
  });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  const idle = setTimeout(() => controller.abort(new Error('IDLE')), idleMs);

  let response;
  try {
    onStage('request');
    response = await fetch(endpoint, {
      method: 'POST',
      headers: headers(llm.apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(idle);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (error?.message === 'IDLE') {
      throw fail.model('REQUEST_TIMEOUT', '模型请求长时间没有响应。', {});
    }
    throw fail.model('NETWORK_FAILURE', '无法连接模型服务，请检查网络与接口地址。', {
      cause: redact(error?.message),
    });
  }
  clearTimeout(idle);
  if (signal) signal.removeEventListener('abort', onAbort);

  if (!response.ok || !response.body) {
    const raw = await response.text().catch(() => '');
    throw classifyHttp(response, raw);
  }

  onStage('stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, finishReason: '' };

  const heartbeat = setInterval(() => {}, 1000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = parseSseChunk(
        buffer + decoder.decode(value, { stream: true }),
        (text) => { content += text; onDelta(text); },
        (delta) => applyToolDelta(toolCalls, delta),
        (patch) => {
          if (patch.prompt_tokens) usage.promptTokens = patch.prompt_tokens;
          if (patch.completion_tokens) usage.completionTokens = patch.completion_tokens;
          if (patch.total_tokens) usage.totalTokens = patch.total_tokens;
          if (patch.finish_reason) usage.finishReason = patch.finish_reason;
        },
      );
    }
  } finally {
    clearInterval(heartbeat);
  }

  const calls = toolCalls
    .filter((call) => call && call.name)
    .map((call) => {
      let args = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }
      return { id: call.id, name: call.name, arguments: args };
    });

  if (!content && !calls.length && !usage.finishReason) {
    throw fail.model('EMPTY_RESPONSE', '模型返回了空响应。', {});
  }
  return { content, reasoning, toolCalls: calls, usage };
}

/** Minimal connectivity probe: one tiny turn, no tools. */
export async function probe(settings) {
  const result = await chat({
    settings,
    messages: [{ role: 'user', content: '回复 OK' }],
    maxTokens: 16,
    temperature: 0,
  });
  return { ok: true, model: settings.llm.model, text: result.content.trim().slice(0, 40) };
}
