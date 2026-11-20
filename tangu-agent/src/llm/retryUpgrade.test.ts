/**
 * 重试升级(中断任务续跑方案 6.7,第 3 步)的仪器:
 *  ① 指数退避 1s 起翻倍、上限 30s、±20% 抖动(rng 可注入)
 *  ② Retry-After(秒 / 毫秒 / HTTP-date),≤60s 照等、>60s 不重试,且这段等待不吃 60s 预算
 *  ③ 服务过载(529 / 503 / overloaded)给 6 次
 *  ④ 等网络:断网类报错 + 探网确认 → 不扣次数、不算预算;探得通就照常扣次数(分类错了也不白送)
 *  ⑤ 睡眠:跨过睡眠的请求不吃慢失败否决、免费重发一次
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/llm/retryUpgrade.test.ts src/llm/netWait.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  llmBackoffMs, parseRetryAfterMs, withRetryAfter, isOverloadedLlmError, isRetryableLlmError, LlmRetryChain, withLlmRetry,
  awaitNetworkBeforeResume, MODEL_MAX_RETRIES, MODEL_OVERLOAD_MAX_RETRIES, MODEL_RETRY_MAX_MS, RETRY_AFTER_MAX_MS, SLOW_FAIL_NO_RETRY_MS,
} from './retry.js';
import { __setNetworkProbeForTests, NETWORK_WAIT_MAX_MS } from './netWait.js';
import { __setLastWakeAtForTests } from './sleepDetector.js';
import { LlmError } from '../core/types.js';

/** 确定性的伪随机(mulberry32):同一种子同一序列。 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const enotfound = (host = 'api.example.com'): TypeError =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: host }) });
const econnreset = (): TypeError =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }) });

afterEach(() => {
  __setNetworkProbeForTests(null);
  __setLastWakeAtForTests(0);
  vi.useRealTimers();
});

describe('指数退避', () => {
  it('中位(rng=0.5):1/2/4/8/16s,第 6 次卡在 30s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => llmBackoffMs(n, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
  it('抖动 ±20% 的两端;上限在抖动之后再卡,30s 是硬顶', () => {
    expect([1, 2, 3, 6].map((n) => llmBackoffMs(n, () => 0))).toEqual([800, 1600, 3200, 25600]);
    expect([1, 2, 3, 6].map((n) => llmBackoffMs(n, () => 1))).toEqual([1200, 2400, 4800, MODEL_RETRY_MAX_MS]);
  });
  it('种子相同 → 序列相同;每一项都在 [0.8×, min(1.2×, 30s)] 内', () => {
    const a = seeded(42);
    const b = seeded(42);
    const seqA = [1, 2, 3, 4, 5, 6].map((n) => llmBackoffMs(n, a));
    const seqB = [1, 2, 3, 4, 5, 6].map((n) => llmBackoffMs(n, b));
    expect(seqA).toEqual(seqB);
    seqA.forEach((w, i) => {
      const base = 1000 * 2 ** i;
      expect(w).toBeGreaterThanOrEqual(Math.min(0.8 * base, MODEL_RETRY_MAX_MS));
      expect(w).toBeLessThanOrEqual(Math.min(1.2 * base, MODEL_RETRY_MAX_MS));
    });
    expect(new Set(seqA.slice(0, 5).map((w, i) => w / 2 ** i)).size).toBeGreaterThan(1); // 真有抖动,不是固定倍数
  });
  it('重试链按注入的 rng 排退避', () => {
    const chain = new LlmRetryChain(() => 0.5);
    expect([1, 2, 3].map(() => chain.plan(new LlmError(502, 'Bad Gateway'))?.waitMs)).toEqual([1000, 2000, 4000]);
    expect(chain.plan(new LlmError(502, 'Bad Gateway'))).toBeNull(); // 第 4 次:用完了
  });
});

describe('Retry-After', () => {
  const H = (h: Record<string, string>): Headers => new Headers(h);
  it('秒数 / 小数秒 / 毫秒头 / HTTP-date / 过去的日期 / 乱写 / 没有', () => {
    const now = Date.parse('Fri, 20 Nov 2026 05:00:00 GMT');
    expect(parseRetryAfterMs(H({ 'retry-after': '7' }), now)).toBe(7000);
    expect(parseRetryAfterMs(H({ 'retry-after': '1.5' }), now)).toBe(1500);
    expect(parseRetryAfterMs(H({ 'retry-after-ms': '250', 'retry-after': '9' }), now)).toBe(250); // 毫秒头优先
    expect(parseRetryAfterMs(H({ 'retry-after': 'Fri, 20 Nov 2026 05:00:30 GMT' }), now)).toBe(30_000);
    expect(parseRetryAfterMs(H({ 'retry-after': 'Fri, 20 Nov 2026 04:59:00 GMT' }), now)).toBe(0);
    expect(parseRetryAfterMs(H({ 'retry-after': 'soon' }), now)).toBeUndefined();
    expect(parseRetryAfterMs(H({}), now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
  it('withRetryAfter 把它挂到报错上', () => {
    const err = withRetryAfter(new LlmError(429, 'Rate limit reached'), H({ 'retry-after': '12' }));
    expect(err.retryAfterMs).toBe(12_000);
    expect(withRetryAfter(new LlmError(429, 'x'), H({})).retryAfterMs).toBeUndefined();
  });
  it('≤60s 照它等(+ 小抖动);>60s 不重试', () => {
    const chain = new LlmRetryChain(() => 1);
    const plan = chain.plan(Object.assign(new LlmError(429, 'Rate limit reached'), { retryAfterMs: 45_000 }));
    expect(plan).toMatchObject({ attempt: 1, retryAfterMs: 45_000 });
    expect(plan!.waitMs).toBeGreaterThanOrEqual(45_000);
    expect(plan!.waitMs).toBeLessThanOrEqual(46_000);
    expect(new LlmRetryChain().plan(Object.assign(new LlmError(429, 'x'), { retryAfterMs: RETRY_AFTER_MAX_MS + 1 }))).toBeNull();
    expect(new LlmRetryChain().plan(Object.assign(new LlmError(429, 'x'), { retryAfterMs: RETRY_AFTER_MAX_MS }))).not.toBeNull();
  });
  it('60s 的 Retry-After 不被 60s 预算否决:前面请求已耗 30s 照样等满再发,成功', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = withLlmRetry(async () => {
      calls++;
      if (calls === 1) {
        vi.advanceTimersByTime(30_000); // 请求本身耗 30s
        throw Object.assign(new LlmError(429, 'Rate limit reached'), { retryAfterMs: RETRY_AFTER_MAX_MS });
      }
      return 'ok';
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(2);
  });
  it('61s 的 Retry-After:不等,按失败处理', async () => {
    let calls = 0;
    await expect(withLlmRetry(async () => {
      calls++;
      throw Object.assign(new LlmError(429, 'Rate limit reached'), { retryAfterMs: 61_000 });
    })).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(1);
  });
});

describe('服务过载给 6 次', () => {
  it('认得出:529 / 503 / 流里的 overloaded_error / 「服务繁忙」;不认:限流、普通 500、额度用完', () => {
    expect(isOverloadedLlmError(new LlmError(529, 'Overloaded'))).toBe(true);
    expect(isOverloadedLlmError(new LlmError(503, 'Service Unavailable'))).toBe(true);
    expect(isOverloadedLlmError(Object.assign(new LlmError(502, 'Request failed'), { code: 'overloaded_error' }))).toBe(true);
    expect(isOverloadedLlmError(new LlmError(500, '服务繁忙，请稍后再试'))).toBe(true);
    expect(isOverloadedLlmError(new LlmError(429, 'Rate limit reached for requests'))).toBe(false);
    expect(isOverloadedLlmError(new LlmError(500, 'Internal Server Error'))).toBe(false);
    expect(isOverloadedLlmError(new LlmError(503, 'insufficient_quota'))).toBe(false);
    expect(isOverloadedLlmError(new TypeError('fetch failed'))).toBe(false);
  });
  const countCalls = async (err: () => unknown): Promise<number> => {
    vi.useFakeTimers();
    let calls = 0;
    const p = withLlmRetry(async () => { calls++; throw err(); });
    const assertion = expect(p).rejects.toBeTruthy();
    await vi.runAllTimersAsync();
    await assertion;
    return calls;
  };
  it('529 重试 6 次(退避合计 ~61s 也不被 60s 预算截断)', async () => {
    expect(await countCalls(() => new LlmError(529, 'Overloaded'))).toBe(MODEL_OVERLOAD_MAX_RETRIES + 1);
  });
  it('503 同样 6 次;流里的 overloaded_error 也是', async () => {
    expect(await countCalls(() => new LlmError(503, 'Service Unavailable'))).toBe(7);
    expect(await countCalls(() => Object.assign(new LlmError(502, 'Overloaded'), { code: 'overloaded_error' }))).toBe(7);
  });
  it('负对照:普通 502 仍是 3 次', async () => {
    expect(await countCalls(() => new LlmError(502, 'Bad Gateway'))).toBe(MODEL_MAX_RETRIES + 1);
  });
  it('重试计划标 overload,界面据此说「服务繁忙」', () => {
    expect(new LlmRetryChain(() => 0.5).plan(new LlmError(529, 'Overloaded'))).toMatchObject({ attempt: 1, max: 6, overload: true });
    expect(new LlmRetryChain(() => 0.5).plan(new LlmError(502, 'Bad Gateway'))).toMatchObject({ attempt: 1, max: 3, overload: false });
  });
});

describe('等网络(重试链)', () => {
  /** 按序列回答探网;序列用完 = 一直通。 */
  const probeSeq = (seq: boolean[]) => {
    const calls: string[] = [];
    __setNetworkProbeForTests(async (t) => { calls.push(`${t.host}:${t.port}`); return seq.length ? seq.shift()! : true; }, 5);
    return calls;
  };

  it('ENOTFOUND + 探网确认断了 → 等到网回来,不扣次数;每段等待只报一次', async () => {
    const probes = probeSeq([false, false, false, true]);
    const onWaiting = vi.fn();
    const onBack = vi.fn();
    const chain = new LlmRetryChain(() => 0.5);
    const free = await chain.recover(enotfound(), Date.now(), { network: { target: 'https://api.example.com/v1', onWaiting, onBack } });
    expect(free).toBe(true);
    expect(onWaiting).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
    expect(probes[0]).toBe('api.example.com:443'); // 探的是报错里那个连不上的主机
    expect(chain.plan(new LlmError(502, 'x'))?.attempt).toBe(1); // 次数没被吃
  });

  it('7 次 ENOTFOUND(超过两种上限)都等网,第 8 次成功', async () => {
    let calls = 0;
    let probeN = 0;
    __setNetworkProbeForTests(async () => (probeN++ % 2 === 1), 5); // 每次失败:第一探断、第二探通
    const onWaiting = vi.fn();
    const onRetry = vi.fn();
    const r = await withLlmRetry(async () => { if (++calls <= 7) throw enotfound(); return 'ok'; }, onRetry, undefined, undefined, { target: 'https://api.example.com', onWaiting });
    expect(r).toBe('ok');
    expect(calls).toBe(8);
    expect(onWaiting).toHaveBeenCalledTimes(7);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('负对照:报错像断网但探得通(本机模型没起 / 代理没开)→ 照常扣次数,有上界', async () => {
    probeSeq([]); // 一直通
    let calls = 0;
    const refused = (): TypeError => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 11434 }) });
    vi.useFakeTimers();
    const onWaiting = vi.fn();
    const p = withLlmRetry(async () => { calls++; throw refused(); }, undefined, undefined, undefined, { target: 'http://127.0.0.1:11434/v1', onWaiting });
    const assertion = expect(p).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(MODEL_MAX_RETRIES + 1);
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('没传 network(resolve / 子代理 / 压缩):不探网,照旧按次数失败', async () => {
    const probe = vi.fn(async () => false);
    __setNetworkProbeForTests(probe, 5);
    vi.useFakeTimers();
    let calls = 0;
    const p = withLlmRetry(async () => { calls++; throw enotfound(); });
    const assertion = expect(p).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(MODEL_MAX_RETRIES + 1);
    expect(probe).not.toHaveBeenCalled();
  });

  it('次数用完时报错可能是断网(ECONNRESET)→ 再探一次,真断了照样等网', async () => {
    let calls = 0;
    // 前 4 次照常重试(探都不探);放弃前探一次:断 → 等 → 通
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    __setNetworkProbeForTests(probe, 5);
    const onWaiting = vi.fn();
    vi.useFakeTimers();
    const p = withLlmRetry(async () => { if (++calls <= 4) throw econnreset(); return 'ok'; }, undefined, undefined, undefined, { target: 'https://api.example.com', onWaiting });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(5);
    expect(probe).toHaveBeenCalledTimes(2); // 前 3 次重试一次都没探
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it('等满 30 分钟还没网 → 抛原错', async () => {
    __setNetworkProbeForTests(async () => false, 5_000);
    vi.useFakeTimers();
    const p = new LlmRetryChain().recover(enotfound(), Date.now(), { network: { target: 'https://api.example.com' } });
    const assertion = expect(p).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(NETWORK_WAIT_MAX_MS + 10_000);
    await assertion;
  });

  it('等网时用户点停 → 立刻 AbortError', async () => {
    __setNetworkProbeForTests(async () => false, 5_000);
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 30);
    await expect(new LlmRetryChain().recover(enotfound(), Date.now(), { signal: ac.signal, network: { target: 'https://api.example.com' } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('等网的时间不算进 60s 预算:等了 10 分钟回来,下一次普通失败照样能重试', async () => {
    vi.useFakeTimers();
    let n = 0;
    __setNetworkProbeForTests(async () => (n++ > 0 && Date.now() >= t0 + 600_000), 5_000);
    const t0 = Date.now();
    const chain = new LlmRetryChain(() => 0.5);
    const p = chain.recover(enotfound(), t0, { network: { target: 'https://api.example.com' } });
    await vi.advanceTimersByTimeAsync(610_000);
    await expect(p).resolves.toBe(true);
    expect(chain.plan(new LlmError(502, 'x'))).not.toBeNull();
  });
});

describe('中流续写前等网', () => {
  it('流断(ECONNRESET)且探网确认断了 → 等网,免费续写', async () => {
    __setNetworkProbeForTests(vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true), 5);
    const onWaiting = vi.fn();
    await expect(awaitNetworkBeforeResume(econnreset(), Date.now(), { network: { target: 'https://api.example.com', onWaiting } })).resolves.toBe(true);
    expect(onWaiting).toHaveBeenCalledOnce();
  });
  it('网是通的 / HTTP 状态错 / 没开等网 → false(照常按次数续写)', async () => {
    const probe = vi.fn(async () => true);
    __setNetworkProbeForTests(probe, 5);
    await expect(awaitNetworkBeforeResume(econnreset(), Date.now(), { network: { target: 'https://api.example.com' } })).resolves.toBe(false);
    await expect(awaitNetworkBeforeResume(new LlmError(502, 'Overloaded'), Date.now(), { network: { target: 'https://api.example.com' } })).resolves.toBe(false);
    expect(probe).toHaveBeenCalledOnce(); // HTTP 502 不探
    await expect(awaitNetworkBeforeResume(econnreset(), Date.now(), {})).resolves.toBe(false);
  });
});

describe('睡眠', () => {
  it('请求跨过一次睡眠:耗时 70s 也不按慢失败否决;没有睡眠的同样请求被否决(负对照)', async () => {
    vi.useFakeTimers();
    const run = async (sleptMidway: boolean): Promise<number> => {
      let calls = 0;
      const p = withLlmRetry(async () => {
        calls++;
        if (calls === 1) {
          vi.advanceTimersByTime(70_000);
          if (sleptMidway) __setLastWakeAtForTests(Date.now() - 1_000); // 醒来后 1s 报错
          throw new LlmError(504, 'stream idle timeout');
        }
        return 'ok';
      });
      const settled = p.then(() => 'ok', () => 'fail');
      await vi.runAllTimersAsync();
      await settled;
      __setLastWakeAtForTests(0);
      return calls;
    };
    expect(await run(true)).toBe(2);
    expect(await run(false)).toBe(1);
  });
  it('开了等网:跨睡眠的请求探网是通的 → 免费重发一次(不扣次数),新请求不再算跨睡眠', async () => {
    __setNetworkProbeForTests(async () => true, 5);
    const started = Date.now() - 5_000;
    __setLastWakeAtForTests(Date.now() - 1_000);
    const chain = new LlmRetryChain(() => 0.5);
    await expect(chain.recover(new LlmError(504, 'stream idle timeout'), started, { network: { target: 'https://api.example.com' } })).resolves.toBe(true);
    expect(chain.plan(new LlmError(502, 'x'))?.attempt).toBe(1);
    // 醒来之后才开始的请求:照常走计划(扣次数)
    vi.useFakeTimers();
    const again = chain.recover(new LlmError(502, 'x'), Date.now(), { network: { target: 'https://api.example.com' } });
    await vi.runAllTimersAsync();
    await expect(again).resolves.toBe(false);
  });
  it('预算从醒来那刻起算', () => {
    vi.useFakeTimers();
    const chain = new LlmRetryChain(() => 0.5);
    vi.advanceTimersByTime(SLOW_FAIL_NO_RETRY_MS + 5_000);
    expect(chain.budgetExceeded()).toBe(true);
    __setLastWakeAtForTests(Date.now() - 2_000);
    expect(chain.budgetExceeded()).toBe(false);
  });
});

describe('可重试判定没被改坏', () => {
  it('529 可重试;额度用完的 503 不重试', () => {
    expect(isRetryableLlmError(new LlmError(529, 'Overloaded'))).toBe(true);
    expect(isRetryableLlmError(new LlmError(503, 'insufficient_quota'))).toBe(false);
  });
});
