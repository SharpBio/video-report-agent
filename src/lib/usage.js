/**
 * Token accounting. Mirrors usage.py's shape so cost stays comparable
 * with the Python baseline.
 */

export function emptyUsage() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
    byStage: {},
  };
}

export function addUsage(target, delta, stage) {
  if (!delta) return target;
  const prompt = Number(delta.prompt_tokens || delta.promptTokens || 0);
  const completion = Number(delta.completion_tokens || delta.completionTokens || 0);
  const total = Number(delta.total_tokens || delta.totalTokens || 0) || prompt + completion;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += total || prompt + completion;
  target.requests += 1;
  if (stage) {
    target.byStage[stage] = target.byStage[stage] || { promptTokens: 0, completionTokens: 0, requests: 0 };
    target.byStage[stage].promptTokens += prompt;
    target.byStage[stage].completionTokens += completion;
    target.byStage[stage].requests += 1;
  }
  return target;
}

/** Rough character estimate when the provider reports no usage block. */
export function estimateTokens(text) {
  const chars = String(text || '').length;
  // Chinese prose averages well under one token per character; stay conservative.
  return Math.ceil(chars / 2.5);
}

export function formatUsage(usage) {
  if (!usage) return '';
  const parts = [`${usage.requests} 次请求`];
  if (usage.totalTokens) parts.push(`${usage.totalTokens} tokens`);
  return parts.join(' · ');
}
