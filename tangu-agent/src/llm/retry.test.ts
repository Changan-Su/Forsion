import { describe, it, expect, vi } from 'vitest';
import { isRetryableLlmError, isAuthExpiredLlmError, withLlmRetry, llmRetryBudgetExceeded, sleepOrAbort, MODEL_MAX_RETRIES, MODEL_RETRY_BASE_MS, SLOW_FAIL_NO_RETRY_MS } from './retry.js';
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

  it('quota / subscription usage exhaustion is not retried even as 429; rate limits still are (R5)', () => {
    for (const m of ['The usage limit has been reached', 'usage_limit_reached', 'You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota']) {
      expect(isRetryableLlmError(new LlmError(429, m))).toBe(false);
    }
    expect(isRetryableLlmError(new LlmError(429, 'Rate limit reached for requests'))).toBe(true);
  });

  it('does not retry user abort', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(isRetryableLlmError(e)).toBe(false);
  });
});

/**
 * withLlmRetry:resolve / build-payload 的有界重试(2026-08-27 复盘的仪器)。
 * 这两步此前在 agentLoop 的重试圈外,结构上零重试 —— 一次秒级 fetch failed 就报废整个 run。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/llm/retry.test.ts
 */
describe('withLlmRetry', () => {
  it('canRetry 返回 false(本次已吐过帧)→ 可重试错误也不重发', async () => {
    const fn = vi.fn().mockRejectedValue(new LlmError(502, 'x'));
    await expect(withLlmRetry(fn, undefined, undefined, () => false)).rejects.toMatchObject({ status: 502 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('已经取消时不启动第一次请求', async () => {
    const ac = new AbortController(); ac.abort();
    const fn = vi.fn();
    await expect(withLlmRetry(fn, undefined, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('59s 失败加退避将超过累计预算时不再启动下一次请求', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(async () => {
        vi.advanceTimersByTime(SLOW_FAIL_NO_RETRY_MS - 1000);
        throw new TypeError('fetch failed');
      });
      await expect(withLlmRetry(fn)).rejects.toThrow('fetch failed');
      expect(fn).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('便宜的传输错重试后成功', async () => {
    let calls = 0;
    const r = await withLlmRetry(async () => {
      if (++calls === 1) throw new TypeError('fetch failed');
      return 'ok';
    });
    expect(r).toBe('ok');
    expect(calls).toBe(2);
  }, 10_000);

  it('慢失败一票否决:单次尝试耗满窗口就不重试', async () => {
    let calls = 0;
    vi.useFakeTimers();
    try {
      await expect(
        withLlmRetry(async () => {
          calls++;
          vi.advanceTimersByTime(SLOW_FAIL_NO_RETRY_MS + 1); // 模拟这次尝试等满超时
          throw new TypeError('fetch failed');
        }),
      ).rejects.toThrow('fetch failed');
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBe(1);
  });

  it('用户 abort 不重试', async () => {
    let calls = 0;
    await expect(
      withLlmRetry(async () => {
        calls++;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }),
    ).rejects.toThrow('aborted');
    expect(calls).toBe(1);
  });

  it('累计耗时也算慢失败:大 body 不会被完整重传 4 次', async () => {
    let calls = 0;
    vi.useFakeTimers();
    try {
      const p = withLlmRetry(async () => {
        calls++;
        vi.advanceTimersByTime(SLOW_FAIL_NO_RETRY_MS / 2 + 1); // 单次不算慢,累计会越线
        throw new TypeError('fetch failed');
      });
      const assertion = expect(p).rejects.toThrow('fetch failed');
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBe(2); // 第 3 次尝试前累计已超预算(只按单次判会跑满 4 次)
  });

  it('退避期间用户点停 → 立刻抛 AbortError,不再空转', async () => {
    const ac = new AbortController();
    let calls = 0;
    const t0 = Date.now();
    await expect(
      withLlmRetry(
        async () => {
          calls++;
          if (calls === 1) setTimeout(() => ac.abort(), 10);
          throw new TypeError('fetch failed');
        },
        undefined,
        ac.signal,
      ),
    ).rejects.toThrow('aborted');
    expect(calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(MODEL_RETRY_BASE_MS); // 没有干等完整退避窗口
  });

  it('重试次数有上界', async () => {
    let calls = 0;
    vi.useFakeTimers();
    try {
      const p = withLlmRetry(async () => { calls++; throw new TypeError('fetch failed'); });
      const assertion = expect(p).rejects.toThrow('fetch failed');
      await vi.runAllTimersAsync(); // 把线性退避全部快进掉
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBe(MODEL_MAX_RETRIES + 1); // 首次 + 至多 3 次重试
  });
});

describe('stream retry primitives', () => {
  it('共享累计预算包括下一次退避,不只计算刚失败的尝试', () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      vi.advanceTimersByTime(40_000);
      expect(llmRetryBudgetExceeded(started, 1500)).toBe(false);
      vi.advanceTimersByTime(19_000);
      expect(llmRetryBudgetExceeded(started, 1500)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('中流续写和首帧前重试的退避都可被即时取消,并清理 timer', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const pending = sleepOrAbort(4500, ac.signal);
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      ac.abort();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('isAuthExpiredLlmError', () => {
  it('401,以及 xAI CLI proxy 用 502 包装的认证失败(看正文)', () => {
    expect(isAuthExpiredLlmError(new LlmError(401, 'Unauthorized'))).toBe(true);
    expect(isAuthExpiredLlmError(new LlmError(502, '{"error":"Invalid or expired credentials (auth_kind=bearer, x_xai_token_auth=xai-grok-cli, upstream=PermissionDenied, reason=no auth context)"}'))).toBe(true);
    expect(isAuthExpiredLlmError(new LlmError(403, 'The access token has expired'))).toBe(true);
  });
  it('负对照:普通网关错 / 限流 / 传输错不算', () => {
    expect(isAuthExpiredLlmError(new LlmError(502, 'Bad Gateway'))).toBe(false);
    expect(isAuthExpiredLlmError(new LlmError(429, 'Rate limit reached'))).toBe(false);
    expect(isAuthExpiredLlmError(new TypeError('fetch failed'))).toBe(false);
  });
});
