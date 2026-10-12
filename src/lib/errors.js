/** RunError: mirrors pipeline.py failure classification so logs stay comparable. */
import { CATEGORY } from './protocol.js';

export class RunError extends Error {
  constructor(category, code, message, diagnostics = {}) {
    super(message);
    this.name = 'RunError';
    this.category = category;
    this.code = code;
    this.diagnostics = diagnostics;
  }

  toJSON() {
    return {
      category: this.category,
      code: this.code,
      message: this.message,
      ...this.diagnostics,
    };
  }
}

export const fail = {
  input: (code, message, d) => new RunError(CATEGORY.INPUT_REJECTED, code, message, d),
  api: (code, message, d) => new RunError(CATEGORY.EXTERNAL_API_FAILURE, code, message, d),
  model: (code, message, d) => new RunError(CATEGORY.EXTERNAL_MODEL_FAILURE, code, message, d),
  env: (code, message, d) => new RunError(CATEGORY.ENVIRONMENT_FAILURE, code, message, d),
  impl: (code, message, d) => new RunError(CATEGORY.IMPLEMENTATION_FAILURE, code, message, d),
  timeout: (code, message, d) => new RunError(CATEGORY.EXECUTION_TIMEOUT, code, message, d),
};

/** Normalise anything thrown into a RunError so the caller can always persist it. */
export function asRunError(error) {
  if (error instanceof RunError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return fail.model('REQUEST_TIMEOUT', '模型请求超时。', {});
  }
  const message = error instanceof Error ? error.message : String(error);
  return fail.env('UNCLASSIFIED', message || '未知错误。', {
    errorName: error instanceof Error ? error.name : 'unknown',
  });
}

/** HTTP status → coarse retry policy. 4xx client errors are never retried. */
export function isRetryableStatus(status) {
  if (typeof status !== 'number') return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
