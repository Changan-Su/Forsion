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

export const MODEL_MAX_RETRIES = 3; // 首次 + 至多 3 次重试 = 4 次尝试
export const MODEL_RETRY_BASE_MS = 1500; // 线性退避 1.5/3/4.5s:扛 Wi-Fi 切换级别的网络抖动(旧 400ms 兜不住真实断网)
/**
 * 单次尝试耗时超过此值就不再重试(慢失败一票否决,优先级高于 isRetryableLlmError)。
 *
 * 重试的前提是「失败很便宜」:fetch failed / 502 / 429 都是秒级崩,重试三次几乎不花用户时间。
 * 而上游静默到 idle 看门狗超时是分钟级——服务端 180s idle 504 若照旧重试三次,最终失败要
 * 4×180+9 = 729s(~12min),用户体感和「一直没反应」没差别。按耗时判而非按 status 判,
 * 是为了让未来任何新增的慢失败路径自动落进这条保护里。
 */
export const SLOW_FAIL_NO_RETRY_MS = Number(process.env.TANGU_SLOW_FAIL_NO_RETRY_MS) || 60_000;
