/**
 * 失败 run 的类别(引擎半):手里有 LlmError 时先按状态码 / code 判(比原文准:402、xAI 用 502 包的认证失败、Codex 流里的 502 + rate_limit code),
 * 认不出再按原文(contracts/runErrorKind.ts classifyRunErrorText,桌面同一份)。error 事件带它;落库的 run 只有原文,按原文现判。
 */
import { LlmError } from '../core/types.js';
import { classifyRunErrorText, isRunErrorKind, type RunErrorKind } from '../contracts/runErrorKind.js';
import { isAuthExpiredLlmError, isQuotaExhaustedLlmError, isRateLimitedLlmError } from './retry.js';
import { isLocalTransportError } from './netWait.js';
import { isContextOverflowError } from '../services/contextWindowStore.js';

export function classifyRunError(err: unknown, message?: string): RunErrorKind {
  if (err instanceof LlmError) {
    if (isQuotaExhaustedLlmError(err)) return 'quota';
    if (isRateLimitedLlmError(err)) return 'rate_limit';
    if (isAuthExpiredLlmError(err) || err.status === 403) return 'auth';
    if (isContextOverflowError(err)) return 'context';
    if (isLocalTransportError(err)) return 'network';
  }
  // 不是 LlmError 的(undici「fetch failed」这类裸传输错、引擎自己的错误码)按原文认
  return classifyRunErrorText(message ?? (err as { message?: string })?.message ?? String(err ?? ''));
}

/** 落库 run 的类别:result.errorKind(留给以后要落库时)认得就用,否则按 error 列的原文现判。 */
export function errorKindOfRun(run: { result?: unknown; error?: unknown } | null | undefined): RunErrorKind {
  let r: any = run?.result;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
  return isRunErrorKind(r?.errorKind) ? r.errorKind : classifyRunErrorText(typeof run?.error === 'string' ? run.error : '');
}
