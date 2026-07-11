import { describe, it, expect } from 'vitest';
import { isRetryableLlmError } from './retry.js';
import { LlmError } from '../core/types.js';

describe('isRetryableLlmError', () => {
  it('retries transport errors (fetch failed)', () => {
    expect(isRetryableLlmError(new TypeError('fetch failed'))).toBe(true);
  });

  it('retries 5xx / 408 / 425 / 429 / idle-504 / status 0', () => {
    for (const s of [0, 408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableLlmError(new LlmError(s, 'x'))).toBe(true);
    }
  });

  it('does not retry 4xx client errors', () => {
    for (const s of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableLlmError(new LlmError(s, 'x'))).toBe(false);
    }
  });

  it('does not retry user abort', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(isRetryableLlmError(e)).toBe(false);
  });
});
