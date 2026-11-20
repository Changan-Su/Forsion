/**
 * 重试升级(中断任务续跑方案 6.7,第 3 步)的仪器:
 *  ① 指数退避 1s 起翻倍、上限 30s、±20% 抖动(rng 可注入)
 *  ② Retry-After(秒 / 毫秒 / HTTP-date),≤60s 照等、>60s 不重试,且这段等待不吃 60s 预算
 *  ③ 服务过载(529 / 503 / overloaded)给 6 次
 *  ④ 等网络:断网类报错 + 探网确认 → 不算预算,整 run 至多 2 次免费重发;探得通 / 探不出(代理)就照常扣次数
 *  ⑤ 睡眠:睡眠区间不算预算(睡前花的照算);本地传输中断跨过睡眠 → 免费重发(同一个 2 次额度);HTTP 503 不给
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/llm/retryUpgrade.test.ts src/llm/netWait.test.ts
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  llmBackoffMs, parseRetryAfterMs, withRetryAfter, isOverloadedLlmError, isRetryableLlmError, LlmRetryChain, withLlmRetry,
  probeBeforeResume, retryAfterVerdict, createRunNetLedger, RUN_MAX_FREE_RETRIES,
  MODEL_MAX_RETRIES, MODEL_OVERLOAD_MAX_RETRIES, MODEL_RETRY_MAX_MS, RETRY_AFTER_MAX_MS, SLOW_FAIL_NO_RETRY_MS,
} from './retry.js';
import { __setNetworkProbeForTests, NETWORK_WAIT_MAX_MS } from './netWait.js';
import { __recordSleepForTests, __resetSleepForTests } from './sleepDetector.js';
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

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
/** 本机 shell 里导出的代理变量会让探网直接判 unknown:用例一律先清掉。 */
const clearProxyEnv = (): void => { for (const k of PROXY_VARS) delete process.env[k]; };
beforeEach(clearProxyEnv);
afterEach(() => {
  __setNetworkProbeForTests(null);
  __resetSleepForTests();
  clearProxyEnv();
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
  it('秒数 / 小数秒 / 毫秒头 / HTTP-date / 过去的日期 / 没有', () => {
    const now = Date.parse('Fri, 20 Nov 2026 05:00:00 GMT');
    expect(parseRetryAfterMs(H({ 'retry-after': '7' }), now)).toBe(7000);
    expect(parseRetryAfterMs(H({ 'retry-after': '1.5' }), now)).toBe(1500);
    expect(parseRetryAfterMs(H({ 'retry-after-ms': '250', 'retry-after': '9' }), now)).toBe(250); // 毫秒头优先
    expect(parseRetryAfterMs(H({ 'retry-after': 'Fri, 20 Nov 2026 05:00:30 GMT' }), now)).toBe(30_000);
    expect(parseRetryAfterMs(H({ 'retry-after': 'Fri, 20 Nov 2026 04:59:00 GMT' }), now)).toBe(0); // 过去 = 现在就行
    expect(parseRetryAfterMs(H({}), now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
  it('写了但不合法 / 溢出 → Infinity(按超限处理,不重试)', () => {
    expect(parseRetryAfterMs(H({ 'retry-after': 'soon' }))).toBe(Infinity);
    expect(parseRetryAfterMs(H({ 'retry-after': '-5' }))).toBe(Infinity);
    expect(parseRetryAfterMs(H({ 'retry-after': '9'.repeat(400) }))).toBe(Infinity);
    expect(parseRetryAfterMs(H({ 'retry-after-ms': 'NaN' }))).toBe(Infinity);
    expect(retryAfterVerdict(Object.assign(new LlmError(429, 'x'), { retryAfterMs: Number.NaN }))).toEqual({ kind: 'refuse' });
    expect(retryAfterVerdict(Object.assign(new LlmError(429, 'x'), { retryAfterMs: -1 }))).toEqual({ kind: 'refuse' });
    expect(retryAfterVerdict(Object.assign(new LlmError(429, 'x'), { retryAfterMs: Infinity }))).toEqual({ kind: 'refuse' });
    expect(retryAfterVerdict(new LlmError(429, 'x'))).toEqual({ kind: 'none' });
  });
  it('withRetryAfter 把它挂到报错上', () => {
    const err = withRetryAfter(new LlmError(429, 'Rate limit reached'), H({ 'retry-after': '12' }));
    expect(err.retryAfterMs).toBe(12_000);
    expect(withRetryAfter(new LlmError(429, 'x'), H({})).retryAfterMs).toBeUndefined();
  });
  it('≤60s 照它等(+ 小抖动),等待总长不越过 60s;>60s 不重试', () => {
    const plan = new LlmRetryChain(() => 1).plan(Object.assign(new LlmError(429, 'Rate limit reached'), { retryAfterMs: 45_000 }));
    expect(plan).toMatchObject({ attempt: 1, retryAfterMs: 45_000 });
    expect(plan!.waitMs).toBeGreaterThanOrEqual(45_000);
    expect(plan!.waitMs).toBeLessThanOrEqual(46_000);
    expect(new LlmRetryChain(() => 1).plan(Object.assign(new LlmError(429, 'x'), { retryAfterMs: RETRY_AFTER_MAX_MS }))!.waitMs).toBe(RETRY_AFTER_MAX_MS);
    expect(new LlmRetryChain(() => 1).plan(Object.assign(new LlmError(429, 'x'), { retryAfterMs: 59_500 }))!.waitMs).toBe(RETRY_AFTER_MAX_MS);
    expect(new LlmRetryChain().plan(Object.assign(new LlmError(429, 'x'), { retryAfterMs: RETRY_AFTER_MAX_MS + 1 }))).toBeNull();
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
  it('超限的 Retry-After 不能被探网分支放行:504 + 120s,网断过又回来也不重发', async () => {
    __setNetworkProbeForTests(vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true), 5);
    const onWaiting = vi.fn();
    const err = Object.assign(new LlmError(504, 'stream idle timeout'), { localTransport: true, retryAfterMs: 120_000 });
    await expect(new LlmRetryChain().recover(err, Date.now(), { network: { target: 'https://api.example.com', onWaiting } })).rejects.toBe(err);
    expect(onWaiting).not.toHaveBeenCalled();
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

  it('ENOTFOUND + 探网确认断了 → 等到网回来,免费重发(不扣次数);每段等待只报一次', async () => {
    const probes = probeSeq([false, false, false, true]);
    const onWaiting = vi.fn();
    const onBack = vi.fn();
    const chain = new LlmRetryChain(() => 0.5);
    const free = await chain.recover(enotfound(), Date.now(), { network: { target: 'https://api.example.com/v1', onWaiting, onBack } });
    expect(free).toBe(true);
    expect(onWaiting).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
    expect(probes[0]).toBe('api.example.com:443');
    expect(chain.plan(new LlmError(502, 'x'))?.attempt).toBe(1); // 次数没被吃
  });

  it(`整 run 免费重发至多 ${RUN_MAX_FREE_RETRIES} 次:ENOTFOUND ×5 → 前 2 次免费、后 3 次扣次数,成功;×6 → 失败`, async () => {
    const run = async (fails: number) => {
      let calls = 0;
      let probeN = 0;
      __setNetworkProbeForTests(async () => (probeN++ % 2 === 1), 5); // 每次失败:第一探断、第二探通
      const onWaiting = vi.fn();
      const onRetry = vi.fn();
      vi.useFakeTimers();
      const p = withLlmRetry(async () => { if (++calls <= fails) throw enotfound(); return 'ok'; }, onRetry, undefined, undefined, { target: 'https://api.example.com', onWaiting });
      const settled = p.then(() => 'ok', () => 'fail');
      await vi.runAllTimersAsync();
      const r = await settled;
      vi.useRealTimers();
      return { r, calls, waits: onWaiting.mock.calls.length, retries: onRetry.mock.calls.map((c) => c[0]) };
    };
    expect(await run(5)).toEqual({ r: 'ok', calls: 6, waits: 5, retries: [1, 2, 3] });
    expect(await run(6)).toMatchObject({ r: 'fail', calls: 6, retries: [1, 2, 3] });
  });

  it('同一 run 的账本共用:两条链(首帧前 / build-payload)合计免费重发也只有 2 次', async () => {
    let probeN = 0;
    __setNetworkProbeForTests(async () => (probeN++ % 2 === 1), 5);
    const ledger = createRunNetLedger();
    const net = { target: 'https://api.example.com', ledger };
    await expect(new LlmRetryChain().recover(enotfound(), Date.now(), { network: net })).resolves.toBe(true);
    await expect(new LlmRetryChain().recover(enotfound(), Date.now(), { network: net })).resolves.toBe(true);
    vi.useFakeTimers();
    const third = new LlmRetryChain(() => 0.5).recover(enotfound(), Date.now(), { network: net });
    await vi.runAllTimersAsync();
    await expect(third).resolves.toBe(false); // 第三次:等过网,但扣次数
    expect(ledger.freeRetries).toBe(2);
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

  it('配了代理:探网结果记「无法确认」,不进长等,按普通错误重试', async () => {
    const probe = vi.fn(async () => false); // 若真去探,会说断了
    __setNetworkProbeForTests(probe, 5);
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    vi.useFakeTimers();
    const onWaiting = vi.fn();
    let calls = 0;
    const p = withLlmRetry(async () => { calls++; throw enotfound(); }, undefined, undefined, undefined, { target: 'https://api.example.com', onWaiting });
    const assertion = expect(p).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(MODEL_MAX_RETRIES + 1);
    expect(onWaiting).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
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

  it('次数用完时本地传输中断(ECONNRESET)→ 再探一次,真断了照样等网', async () => {
    let calls = 0;
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    __setNetworkProbeForTests(probe, 5);
    const onWaiting = vi.fn();
    vi.useFakeTimers();
    const p = withLlmRetry(async () => { if (++calls <= 4) throw econnreset(); return 'ok'; }, undefined, undefined, undefined, { target: 'https://api.example.com', onWaiting });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(5);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it('HTTP 504 响应(不是本地超时)放弃前不探网', async () => {
    const probe = vi.fn(async () => false);
    __setNetworkProbeForTests(probe, 5);
    vi.useFakeTimers();
    const p = withLlmRetry(async () => { throw new LlmError(504, 'Gateway Timeout'); }, undefined, undefined, undefined, { target: 'https://api.example.com' });
    const assertion = expect(p).rejects.toMatchObject({ status: 504 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(probe).not.toHaveBeenCalled();
  });

  it('醒着等满 30 分钟还没网 → 抛原错', async () => {
    __setNetworkProbeForTests(async () => false, 5_000);
    vi.useFakeTimers();
    const p = new LlmRetryChain().recover(enotfound(), Date.now(), { network: { target: 'https://api.example.com' } });
    const assertion = expect(p).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(NETWORK_WAIT_MAX_MS + 10_000);
    await assertion;
  });

  it('醒着等网的 30 分钟整 run 共用一本账:前面已等 29 分 59 秒,这次只再等 1s 就放弃;等过的时间记进账本', async () => {
    vi.useFakeTimers();
    __setNetworkProbeForTests(async () => false, 5_000);
    const ledger = createRunNetLedger();
    ledger.awakeMs = NETWORK_WAIT_MAX_MS - 1_000;
    const p = new LlmRetryChain().recover(enotfound(), Date.now(), { network: { target: 'https://api.example.com', ledger } });
    const assertion = expect(p).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(ledger.awakeMs).toBeGreaterThanOrEqual(NETWORK_WAIT_MAX_MS);
    // 另一条链(中流 / build-payload)拿同一本账:一上来就没得等,也不报「网络已断开」
    const onWaiting = vi.fn();
    const q = new LlmRetryChain().recover(enotfound(), Date.now(), { network: { target: 'https://api.example.com', ledger, onWaiting } });
    const qa = expect(q).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(100);
    await qa;
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('等网的醒着时长记进账本(合盖那段不记)', async () => {
    vi.useFakeTimers();
    let n = 0;
    __setNetworkProbeForTests(async () => n++ >= 3, 5_000);
    const ledger = createRunNetLedger();
    const p = new LlmRetryChain().recover(enotfound(), Date.now(), { network: { target: 'https://api.example.com', ledger } });
    await vi.advanceTimersByTimeAsync(5_000);
    const s0 = Date.now();
    vi.setSystemTime(s0 + 3_600_000);
    __recordSleepForTests(s0, Date.now());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe(true);
    expect(ledger.awakeMs).toBe(15_000);
  });

  it('免费重发也照等 ≤60s 的 Retry-After:网回来后先等满它再发', async () => {
    vi.useFakeTimers();
    let n = 0;
    __setNetworkProbeForTests(async () => n++ > 0, 5);
    const err = Object.assign(new LlmError(0, 'fetch failed'), { cause: enotfound().cause, retryAfterMs: 3_000 });
    let done = false;
    const p = new LlmRetryChain(() => 0).recover(err, Date.now(), { network: { target: 'https://api.example.com' } }).then((v) => { done = true; return v; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false); // 网早回来了,但还在等 Retry-After
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(p).resolves.toBe(true);
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
    const t0 = Date.now();
    __setNetworkProbeForTests(async () => (n++ > 0 && Date.now() >= t0 + 600_000), 5_000);
    const chain = new LlmRetryChain(() => 0.5);
    const p = chain.recover(enotfound(), t0, { network: { target: 'https://api.example.com' } });
    await vi.advanceTimersByTimeAsync(610_000);
    await expect(p).resolves.toBe(true);
    expect(chain.plan(new LlmError(502, 'x'))).not.toBeNull();
  });
});

describe('中流续写前探网', () => {
  it('流断(ECONNRESET)且探网确认断了 → down(调用方先落库再等)', async () => {
    __setNetworkProbeForTests(async () => false, 5);
    await expect(probeBeforeResume(econnreset(), Date.now(), { network: { target: 'https://api.example.com' } })).resolves.toBe('down');
  });
  it('网是通的 / HTTP 状态错 / 没开等网 / 配了代理 → no', async () => {
    const probe = vi.fn(async () => true);
    __setNetworkProbeForTests(probe, 5);
    await expect(probeBeforeResume(econnreset(), Date.now(), { network: { target: 'https://api.example.com' } })).resolves.toBe('no');
    await expect(probeBeforeResume(new LlmError(502, 'Overloaded'), Date.now(), { network: { target: 'https://api.example.com' } })).resolves.toBe('no');
    expect(probe).toHaveBeenCalledOnce(); // HTTP 502 不探
    await expect(probeBeforeResume(econnreset(), Date.now(), {})).resolves.toBe('no');
    __setNetworkProbeForTests(async () => false, 5);
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    await expect(probeBeforeResume(econnreset(), Date.now(), { network: { target: 'https://api.example.com' } })).resolves.toBe('no');
  });
  it('本地中断跨过睡眠、网通 → woke', async () => {
    __setNetworkProbeForTests(async () => true, 5);
    const started = Date.now() - 60_000;
    __recordSleepForTests(started + 1_000, Date.now() - 1_000);
    await expect(probeBeforeResume(econnreset(), started, { network: { target: 'https://api.example.com' } })).resolves.toBe('woke');
  });
});

describe('睡眠', () => {
  it('请求跨过一次睡眠:墙钟 70s、醒着 1s 不按慢失败否决;没有睡眠的同样请求被否决(负对照)', async () => {
    vi.useFakeTimers();
    const run = async (sleptMidway: boolean): Promise<number> => {
      let calls = 0;
      const p = withLlmRetry(async () => {
        calls++;
        if (calls === 1) {
          const t = Date.now();
          vi.advanceTimersByTime(70_000);
          if (sleptMidway) __recordSleepForTests(t + 500, Date.now() - 500); // 中间 69s 睡着
          throw new LlmError(504, 'stream idle timeout');
        }
        return 'ok';
      });
      const settled = p.then(() => 'ok', () => 'fail');
      await vi.runAllTimersAsync();
      await settled;
      __resetSleepForTests();
      return calls;
    };
    expect(await run(true)).toBe(2);
    expect(await run(false)).toBe(1);
  });
  it('睡前已花的预算照算:睡前 59s + 醒后 1.5s → 超 60s 不再重发', () => {
    vi.useFakeTimers();
    const chain = new LlmRetryChain(() => 0.5);
    vi.advanceTimersByTime(59_000);
    const sleepStart = Date.now();
    vi.advanceTimersByTime(3_600_000);
    __recordSleepForTests(sleepStart, Date.now());
    vi.advanceTimersByTime(1_500);
    expect(chain.budgetUsed()).toBe(60_500);
    expect(chain.budgetExceeded()).toBe(true);
  });
  it('等网跨过睡眠:等网区间与睡眠区间重叠只扣一次,不出负数', async () => {
    vi.useFakeTimers();
    const chain = new LlmRetryChain(() => 0.5);
    vi.advanceTimersByTime(10_000); // 请求本身 10s
    let n = 0;
    __setNetworkProbeForTests(async () => n++ > 2, 5_000);
    const p = chain.recover(enotfound(), Date.now() + 1, { network: { target: 'https://api.example.com' } });
    await vi.advanceTimersByTimeAsync(5_000);
    const s0 = Date.now();
    vi.setSystemTime(s0 + 7_200_000); // 等网途中合盖 2 小时
    __recordSleepForTests(s0, Date.now());
    await vi.advanceTimersByTimeAsync(10_000); // 醒后第 2 探通了 → 网回来,当场重发
    await expect(p).resolves.toBe(true);
    // 只剩请求本身那 10s:等网区间 ∪ 睡眠区间按并集扣(重叠 2h 扣一次);扣两次会被夹成 0
    expect(chain.budgetUsed()).toBe(10_000);
  });
  it('开了等网:本地中断跨睡眠、探网是通的 → 免费重发一次(不扣次数),新请求不再算跨睡眠', async () => {
    __setNetworkProbeForTests(async () => true, 5);
    const started = Date.now() - 5_000;
    __recordSleepForTests(started + 1_000, Date.now() - 1_000);
    const chain = new LlmRetryChain(() => 0.5);
    await expect(chain.recover(Object.assign(new LlmError(504, 'stream idle timeout'), { localTransport: true }), started, { network: { target: 'https://api.example.com' } })).resolves.toBe(true);
    expect(chain.plan(new LlmError(502, 'x'))?.attempt).toBe(1);
    vi.useFakeTimers();
    const again = chain.recover(new LlmError(502, 'x'), Date.now(), { network: { target: 'https://api.example.com' } });
    await vi.runAllTimersAsync();
    await expect(again).resolves.toBe(false);
  });
  it('拿到 HTTP 响应的 503 跨过睡眠:不给免费重发(照常扣次数)', async () => {
    const probe = vi.fn(async () => true);
    __setNetworkProbeForTests(probe, 5);
    const started = Date.now() - 5_000;
    __recordSleepForTests(started + 1_000, Date.now() - 1_000);
    vi.useFakeTimers();
    const p = new LlmRetryChain(() => 0.5).recover(new LlmError(503, 'Service Unavailable'), started, { network: { target: 'https://api.example.com' } });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
  it('跨睡眠的免费重发整 run 也只有 2 次', async () => {
    __setNetworkProbeForTests(async () => true, 5);
    const ledger = createRunNetLedger();
    const net = { target: 'https://api.example.com', ledger };
    const local = () => Object.assign(new LlmError(504, 'stream idle timeout'), { localTransport: true });
    const results: boolean[] = [];
    vi.useFakeTimers();
    for (let i = 0; i < 4; i++) {
      const started = Date.now() - 5_000;
      __recordSleepForTests(started + 1_000, Date.now() - 1_000);
      const p = new LlmRetryChain(() => 0.5).recover(local(), started, { network: net });
      await vi.runAllTimersAsync();
      results.push(await p);
    }
    expect(results).toEqual([true, true, false, false]);
  });
  it('跨睡眠的免费重发不越过 Retry-After:65s 的照样放弃,短的照样等', async () => {
    __setNetworkProbeForTests(async () => true, 5);
    const started = Date.now() - 5_000;
    __recordSleepForTests(started + 1_000, Date.now() - 1_000);
    const long = Object.assign(new TypeError('fetch failed'), { retryAfterMs: 65_000 });
    await expect(new LlmRetryChain().recover(long, started, { network: { target: 'https://api.example.com' } })).rejects.toBe(long);
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const short = Object.assign(new LlmError(0, 'fetch failed'), { retryAfterMs: 3_000 });
    const p = new LlmRetryChain(() => 0).recover(short, started, { network: { target: 'https://api.example.com' }, onRetry });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(false);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ retryAfterMs: 3_000 });
  });
});

describe('canRetry 在等完、真要重发之前再问一次', () => {
  it('退避期间被推过成本上限(canRetry 变 false)→ 不再发,抛原错', async () => {
    vi.useFakeTimers();
    let closed = false;
    let calls = 0;
    const p = withLlmRetry(async () => { calls++; throw new LlmError(502, 'Bad Gateway'); }, () => { closed = true; }, undefined, () => !closed);
    const assertion = expect(p).rejects.toMatchObject({ status: 502 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(1);
  });
});

describe('可重试判定没被改坏', () => {
  it('529 可重试;额度用完的 503 不重试', () => {
    expect(isRetryableLlmError(new LlmError(529, 'Overloaded'))).toBe(true);
    expect(isRetryableLlmError(new LlmError(503, 'insufficient_quota'))).toBe(false);
  });
});
