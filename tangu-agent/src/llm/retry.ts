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

/**
 * 给一次性的 LLM 前置调用(resolve / build-payload)套同一套有界重试。
 *
 * 这两步此前在 agentLoop 的重试圈**外面**(build-payload 在圈前构建 payload),结构上零重试:
 * 托管面一次秒级 `fetch failed` 就能报废一个已经跑了几分钟的 run(2026-08-27 桌面端 2.8.1 实证)。
 * 慢失败一票否决照旧 —— 撞满超时的大 body 上传重试 4 次只是把干等 ×4。
 */
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void,
  signal?: AbortSignal,
): Promise<T> {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      return await fn();
    } catch (err) {
      // 慢失败按**累计**耗时判,不只看本次尝试:网关在完整收下大 body 后于 59s 回 502,逐次判定
      // 每次都「不算慢」,4 次重传一个数 MB 的 build-payload ≈ 249s + 4 倍上行(Codex 评审逮到)。
      // 整条重试链共用与单次慢失败同一个 60s 预算,便宜的秒级抖动照旧能重试满。
      const spent = Date.now() - t0;
      const slowFail = Date.now() - started >= SLOW_FAIL_NO_RETRY_MS || spent >= SLOW_FAIL_NO_RETRY_MS;
      // 退避期间用户点了停 → 立刻放弃并抛 AbortError,否则最终抛的是传输错、run 被误记成 failed。
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (slowFail || attempt >= MODEL_MAX_RETRIES || !isRetryableLlmError(err)) throw err;
      const wait = MODEL_RETRY_BASE_MS * (attempt + 1);
      onRetry?.(attempt + 1, wait, err);
      await sleepOrAbort(wait, signal);
    }
  }
}

/** 可中止的退避等待:signal 一 abort 就抛 AbortError,不再干等完整退避窗口。 */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
  });
}
