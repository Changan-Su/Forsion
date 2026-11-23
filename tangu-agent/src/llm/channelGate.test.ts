/**
 * 插件开发优化方案 2026-11-23 第三节(限流 / 余额)与第四节 B(按通道排队)的仪器:
 *  ① 报错正文里的等待时间(Codex 流里的错没有响应头):「try again in 3.877s / 928ms / 1m30s」,20ms 不是 20 分钟,超过 60s 照旧不重试
 *  ② 「You have no credits remaining」、402 认成额度用完(走得到额度接力),不当限流白重试
 *  ③ 秒级限流的判别:HTTP 429,以及 Codex 流里的 LlmError(502) + rate_limit_exceeded;额度用完 / 过载不算
 *  ④ 通道闸:并发上限(缺省 3,可配)、撞了限流整条通道暂停到点名时刻、暂停后先放一个试探、中止出队、按通道隔离
 *  ⑤ 失败类别:限流 / 额度 / 登录 / 网络 / 上下文 / 其他(引擎按 LlmError,桌面按原文,同一份规则)
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/llm/channelGate.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LlmError } from '../core/types.js';
import { isQuotaExhaustedLlmError, isRateLimitedLlmError, isRetryableLlmError, retryAfterMsOf, retryAfterVerdict, LlmRetryChain } from './retry.js';
import { acquireChannel, pauseChannel, pauseMsFor, channelKeyOf, queuedSessionIds, __channelState, __resetChannels, CHANNEL_PAUSE_DEFAULT_MS, type ChannelSlot } from './channelGate.js';
import { classifyRunError, errorKindOfRun } from './runErrorKind.js';
import { classifyRunErrorText, tryAgainMsFromText } from '../contracts/runErrorKind.js';
import { DIRECT_MARK } from './openaiCompat.js';

/** 第一轮 dogfood 的原文(docs/ToBeImproved/演示插件_2026-11-19/复盘记录.md)。 */
const TPM_STREAM = 'Rate limit reached for gpt-6.2-sol in organization org-x on tokens per min (TPM): Limit 1000000, Used 955313, Requested 109292. Please try again in 3.877s. Visit https://platform.openai.com/account/rate-limits to learn more.';
const TPM_MS = 'Rate limit reached for gpt-6.2-sol on tokens per min (TPM): Limit 1000000, Used 857943, Requested 157519. Please try again in 928ms.';
const NO_CREDITS = 'You have no credits remaining. Please add credits to continue.';

afterEach(() => { __resetChannels(); vi.useRealTimers(); });

describe('① 正文里的等待时间', () => {
  it('秒 / 毫秒 / 分秒', () => {
    expect(tryAgainMsFromText(TPM_STREAM)).toBe(3877);
    expect(tryAgainMsFromText(TPM_MS)).toBe(928);
    expect(tryAgainMsFromText('Please try again in 1m30s.')).toBe(90_000);
    expect(tryAgainMsFromText('try again in 20ms')).toBe(20);
    expect(tryAgainMsFromText('Please try again in 6m0s')).toBe(360_000);
    expect(tryAgainMsFromText('no hint here')).toBeUndefined();
  });
  it('Codex 流里的错(502 + 正文)按正文等;响应头优先;超过 60s 照旧不重试', () => {
    const stream = Object.assign(new LlmError(502, TPM_STREAM), { code: 'rate_limit_exceeded' });
    expect(retryAfterMsOf(stream)).toBe(3877);
    expect(retryAfterVerdict(stream, () => 0)).toEqual({ kind: 'wait', ms: 3877, retryAfterMs: 3877 });
    const header = Object.assign(new LlmError(429, TPM_STREAM), { retryAfterMs: 500 });
    expect(retryAfterMsOf(header)).toBe(500);
    expect(retryAfterVerdict(new LlmError(429, 'Rate limit reached. Please try again in 6m0s'))).toEqual({ kind: 'refuse' });
    // 重试链照这个等待重试,且等待不吃 60s 预算
    const plan = new LlmRetryChain(() => 0).plan(stream);
    expect(plan).toMatchObject({ attempt: 1, retryAfterMs: 3877, excludedFromBudget: true });
  });
});

describe('② 余额用完 = 额度用完', () => {
  it('no credits / 402 不可重试、走额度接力', () => {
    for (const e of [new LlmError(429, NO_CREDITS), new LlmError(402, NO_CREDITS), new LlmError(402, 'Payment Required')]) {
      expect(isQuotaExhaustedLlmError(e)).toBe(true);
      expect(isRetryableLlmError(e)).toBe(false);
      expect(isRateLimitedLlmError(e)).toBe(false);
    }
    // 「还剩 5 个 credits」不是用完
    expect(isQuotaExhaustedLlmError(new LlmError(400, 'You have 5 credits remaining'))).toBe(false);
  });
});

describe('③ 秒级限流的判别', () => {
  it('429 与流里的 rate_limit_exceeded 算;额度、过载不算', () => {
    expect(isRateLimitedLlmError(new LlmError(429, 'Too Many Requests'))).toBe(true);
    expect(isRateLimitedLlmError(Object.assign(new LlmError(502, TPM_STREAM), { code: 'rate_limit_exceeded' }))).toBe(true);
    expect(isRateLimitedLlmError(new LlmError(429, 'You exceeded your current quota'))).toBe(false);
    expect(isRateLimitedLlmError(new LlmError(529, 'overloaded'))).toBe(false);
    expect(isRateLimitedLlmError(new LlmError(502, 'Bad gateway'))).toBe(false);
    expect(isRateLimitedLlmError(new TypeError('fetch failed'))).toBe(false);
  });
  it('暂停时长:点名照它、没点名 2 秒、超 60 秒不暂停', () => {
    expect(pauseMsFor(new LlmError(429, TPM_MS))).toBe(928);
    expect(pauseMsFor(new LlmError(429, 'Too Many Requests'))).toBe(CHANNEL_PAUSE_DEFAULT_MS);
    expect(pauseMsFor(new LlmError(429, 'Rate limit. Please try again in 6m0s'))).toBeNull();
    expect(pauseMsFor(new LlmError(500, 'boom'))).toBeNull();
  });
});

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('④ 通道闸', () => {
  it('通道 = 提供方 + 地址 + 账号 / key 指纹;托管面按模型', () => {
    const m = { [DIRECT_MARK]: true, provider: 'openai' };
    const a = channelKeyOf(m, 'https://api.openai.com/v1', 'sk-a', 'openai/x');
    expect(a).toBe(channelKeyOf(m, 'https://api.openai.com/v1', 'sk-a', 'openai/y'));
    expect(a).not.toBe(channelKeyOf(m, 'https://api.openai.com/v1', 'sk-b', 'openai/x'));
    expect(a).not.toContain('sk-a');
    expect(channelKeyOf({ provider: 'x' }, undefined, 'tok', 'forsion/a')).not.toBe(channelKeyOf({ provider: 'x' }, undefined, 'tok', 'forsion/b'));
  });

  it('并发上限缺省 3:第 4 个排队(报 busy、带会话 id),前面的放掉一个就轮到它', async () => {
    const slots: ChannelSlot[] = [];
    for (let i = 0; i < 3; i++) slots.push(await acquireChannel('k'));
    const queued: any[] = [];
    let got: ChannelSlot | undefined;
    void acquireChannel('k', { sessionId: 's4', onQueued: (q) => queued.push(q) }).then((s) => { got = s; });
    await flush();
    expect(got).toBeUndefined();
    expect(queued[0]).toMatchObject({ reason: 'busy', position: 1, limit: 3 });
    expect(queuedSessionIds().has('s4')).toBe(true);
    slots[0].release();
    await flush();
    expect(got).toBeDefined();
    expect(queuedSessionIds().has('s4')).toBe(false);
    expect(__channelState('k')).toMatchObject({ inflight: 3, waiting: 0 });
  });

  it('撞了限流:整条通道暂停到点名时刻,其余排队报 rate_limit;到点逐个放,前一个拿到响应头再放下一个', async () => {
    vi.useFakeTimers();
    const first = await acquireChannel('k');
    first.failed(new LlmError(429, TPM_MS)); // 928ms
    first.release();
    const got: string[] = [];
    const infos: any[] = [];
    const slots: Record<string, ChannelSlot> = {};
    for (const id of ['a', 'b', 'c']) void acquireChannel('k', { onQueued: (q) => infos.push([id, q.reason, q.waitMs]) }).then((s) => { got.push(id); slots[id] = s; });
    await flush();
    expect(got).toEqual([]);
    expect(infos.every(([, r]) => r === 'rate_limit')).toBe(true);
    expect(infos[0][2]).toBeGreaterThan(800);
    await vi.advanceTimersByTimeAsync(950);
    expect(got).toEqual(['a']); // 试探
    expect(slots.a.probe).toBe(true);
    slots.a.opened();
    await flush();
    expect(got).toEqual(['a', 'b']);
    slots.b.opened();
    await flush();
    expect(got).toEqual(['a', 'b', 'c']);
    // 排队的放完了:回到正常(新来的直接放,不再逐个)
    slots.c.opened();
    for (const id of ['a', 'b', 'c']) slots[id].release();
    await flush();
    const d = await acquireChannel('k');
    expect(d.probe).toBe(false);
  });

  it('试探又撞限流:重新暂停,其余不放;试探 5 秒没动静也当放行', async () => {
    vi.useFakeTimers();
    pauseChannel('k', 100);
    const got: string[] = [];
    const slots: Record<string, ChannelSlot> = {};
    for (const id of ['a', 'b']) void acquireChannel('k').then((s) => { got.push(id); slots[id] = s; });
    await vi.advanceTimersByTimeAsync(120);
    expect(got).toEqual(['a']);
    slots.a.failed(new LlmError(429, 'Too Many Requests'));
    slots.a.release();
    await flush();
    expect(got).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(CHANNEL_PAUSE_DEFAULT_MS + 50);
    expect(got).toEqual(['a', 'b']); // b 成了新的试探
    expect(slots.b.probe).toBe(true);
    void acquireChannel('k').then(() => got.push('c'));
    await flush();
    expect(got).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(5100); // 试探没报响应头:5 秒后放行
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('排队中中止:出队并抛 AbortError,不占槽位;别的通道不受影响', async () => {
    vi.useFakeTimers();
    pauseChannel('k', 10_000);
    const ac = new AbortController();
    const p = acquireChannel('k', { signal: ac.signal, sessionId: 's' });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(__channelState('k')?.waiting).toBe(0);
    const other = await acquireChannel('other'); // 另一条通道照常
    other.release();
  });

  it('并发上限可配(models.channelConcurrency)', async () => {
    const cfg = await import('../core/config.js');
    const spy = vi.spyOn(cfg, 'getRawSection').mockImplementation(((name: string) => (name === 'models' ? { channelConcurrency: 1 } : undefined)) as any);
    try {
      const a = await acquireChannel('k');
      let got = false;
      void acquireChannel('k').then(() => { got = true; });
      await flush();
      expect(got).toBe(false);
      a.release();
      await flush();
      expect(got).toBe(true);
    } finally { spy.mockRestore(); }
  });
});

describe('⑤ 失败类别', () => {
  it('引擎按 LlmError', () => {
    expect(classifyRunError(Object.assign(new LlmError(502, TPM_STREAM), { code: 'rate_limit_exceeded' }))).toBe('rate_limit');
    expect(classifyRunError(new LlmError(402, 'Payment Required'))).toBe('quota');
    expect(classifyRunError(new LlmError(429, NO_CREDITS))).toBe('quota');
    expect(classifyRunError(new LlmError(401, 'Unauthorized'))).toBe('auth');
    expect(classifyRunError(new LlmError(400, 'Your input exceeds the context window of this model.'))).toBe('context');
    expect(classifyRunError(new LlmError(0, 'socket closed'))).toBe('network');
    expect(classifyRunError(new TypeError('fetch failed'))).toBe('network');
    expect(classifyRunError(new Error('something odd'))).toBe('other');
  });
  it('只看原文(旧引擎 / 落库行)', () => {
    expect(classifyRunErrorText(TPM_STREAM)).toBe('rate_limit');
    expect(classifyRunErrorText(NO_CREDITS)).toBe('quota');
    expect(classifyRunErrorText('token_quota_exceeded')).toBe('quota');
    expect(classifyRunErrorText('Provided authentication token is expired. Please try signing in again.')).toBe('auth');
    expect(classifyRunErrorText('input_too_large')).toBe('context');
    expect(classifyRunErrorText('fetch failed')).toBe('network');
    expect(classifyRunErrorText('')).toBe('other');
    expect(errorKindOfRun({ result: JSON.stringify({ errorKind: 'auth' }), error: TPM_STREAM })).toBe('auth');
    expect(errorKindOfRun({ result: null, error: TPM_STREAM })).toBe('rate_limit');
  });
});

describe('⑥ 评审补丁(11-23 Codex)', () => {
  it('4xx 正文里带 rate_limit 字样不算限流;429 / 502 流里的照算', () => {
    expect(isRateLimitedLlmError(new LlmError(400, 'invalid rate_limit parameter'))).toBe(false);
    expect(isRateLimitedLlmError(new LlmError(502, 'Rate limit reached for gpt. Please try again in 2s'))).toBe(true);
    expect(isRateLimitedLlmError(new LlmError(429, 'slow down'))).toBe(true);
  });
  it('落库原文里的 402 / Payment Required 归额度', () => {
    expect(classifyRunErrorText('HTTP 402: Payment Required')).toBe('quota');
    expect(classifyRunErrorText('Payment Required')).toBe('quota');
    expect(errorKindOfRun({ error: 'upstream 402' })).toBe('quota');
  });
  it('onWaited 抛错也放槽位(并发 1 时通道不卡死)', async () => {
    const key = 'test:onwaited';
    const { withChannelSlot } = await import('./channelGate.js');
    const held = await acquireChannel(key);
    const extra: ChannelSlot[] = [];
    // 先把剩下的并发占满,让下面那个必须排队
    while ((__channelState(key)?.inflight ?? 0) < 3) extra.push(await acquireChannel(key));
    const p = withChannelSlot(key, { onWaited: () => { throw new Error('boom'); } }, async () => 'x');
    held.release();
    await expect(p).rejects.toThrow('boom');
    expect(__channelState(key)?.inflight).toBe(extra.length);
    for (const s of extra) s.release();
    expect(__channelState(key)?.inflight ?? 0).toBe(0);
  });
});
