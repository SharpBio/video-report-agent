/** Structured run log — the browser equivalent of run.trace.jsonl. */
import * as db from './db.js';

export async function log(runId, level, stage, message, data) {
  const entry = { runId, at: Date.now(), level, stage, message };
  if (data !== undefined) entry.data = data;
  try {
    await db.put(db.STORE.LOGS, entry);
  } catch {
    /* logging must never break the pipeline */
  }
  const prefix = `[${stage}]`;
  if (level === 'error') console.error(prefix, message, data ?? '');
  else if (level === 'warn') console.warn(prefix, message, data ?? '');
  else console.log(prefix, message, data ?? '');
}

export const trace = {
  info: (runId, stage, message, data) => log(runId, 'info', stage, message, data),
  warn: (runId, stage, message, data) => log(runId, 'warn', stage, message, data),
  error: (runId, stage, message, data) => log(runId, 'error', stage, message, data),
};

/** Measure and record one stage; rethrows so callers keep their own error handling. */
export async function span(runId, stage, fn) {
  const started = performance.now();
  try {
    const value = await fn();
    await log(runId, 'info', stage, `完成，耗时 ${Math.round(performance.now() - started)} ms`);
    return value;
  } catch (error) {
    await log(runId, 'error', stage, `失败，耗时 ${Math.round(performance.now() - started)} ms`, {
      message: error?.message || String(error),
    });
    throw error;
  }
}
