import { describe, it, expect, vi } from 'vitest';
import { isRetryableLlmError, withLlmRetry, MODEL_MAX_RETRIES, MODEL_RETRY_BASE_MS, SLOW_FAIL_NO_RETRY_MS } from './retry.js';
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

/**
 * withLlmRetry:resolve / build-payload 的有界重试(2026-08-27 复盘的仪器)。
 * 这两步此前在 agentLoop 的重试圈外,结构上零重试 —— 一次秒级 fetch failed 就报废整个 run。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/llm/retry.test.ts
 */
describe('withLlmRetry', () => {
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
