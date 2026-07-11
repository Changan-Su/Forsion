import { LlmError } from '../core/types.js';

/** 有界重试判别:LLM 流式调用抛的错是否值得重试。
 *  - 用户主动 abort(name==='AbortError')→ 否(标 aborted,不是失败)
 *  - LlmError:4xx 客户端错(除 408/425/429)不重试;5xx / 408 / 425 / 429 / status 0(含 idle 504)→ 是
 *  - 其余(纯传输错,如 undici "fetch failed" 的 TypeError)→ 是
 *  注意:调用方还须自守「本次尝试已吐过帧就不重试」,否则会向客户端重复流。 */
export function isRetryableLlmError(err: unknown): boolean {
  if ((err as any)?.name === 'AbortError') return false;
  if (err instanceof LlmError) {
    const s = err.status;
    return s === 0 || s === 408 || s === 425 || s === 429 || s >= 500;
  }
  return true;
}

export const MODEL_MAX_RETRIES = 2; // 首次 + 至多 2 次重试 = 3 次尝试
export const MODEL_RETRY_BASE_MS = 400; // 线性退避 400 / 800ms
