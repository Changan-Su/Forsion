/**
 * 客户端原生动作登记表(services/clientAck.ts)的状态机单测。
 *
 * 为什么值得钉:这张表是「手机执行不执行」的唯一权威(原生没 claim 到 nonce 就不执行)。它出错的方式全是
 * 软故障 —— 放松了不崩,只是伪造 / 重放的 body 也能驱动手机;收紧了也不崩,只是手机那头永远 410。
 * 两种超时文案还决定了模型对用户说「没发生」还是「可能发生了」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import {
  CLIENT_CMD_EVENT, NOT_PICKED_UP_TEXT, NO_REPORT_TEXT, ABORTED_CLAIMED_TEXT, requestClientAction, resolveClientAction,
  makeClientActionRequester, __pendingClientActionsForTest, type ClientActionBinding,
} from './clientAck.js';

const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
let events: Array<{ runId: string; type: string; payload: any }> = [];
let publishImpl: (runId: string, type: string, payload: any) => Promise<number>;
/** 每条用例一个 run 级信号:afterEach 中止它,把用例故意留下的登记清掉(登记表是模块级的,跨用例共享)。 */
let testRun: AbortController;

beforeEach(() => {
  events = [];
  testRun = new AbortController();
  publishImpl = async (runId, type, payload) => { events.push({ runId, type, payload }); return events.length; };
  const fakeState = new Proxy({ appendEvent: (r: string, t: string, p: any) => publishImpl(r, t, p) } as Record<string, any>,
    { get: (t, k) => (k in t ? t[k as string] : () => { throw new Error(`stub state.${String(k)}`); }) });
  configureTangu({ host: stub, brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }), state: fakeState });
});
afterEach(() => { testRun.abort(); vi.useRealTimers(); });

const bind = (over: Partial<ClientActionBinding> = {}): ClientActionBinding => ({ runId: 'r1', sessionId: 's1', caps: ['phone.intents'], runSignal: testRun.signal, ...over });
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** 发起一次动作,等事件发出,返回 promise 与电文。 */
async function start(b = bind(), op = 'view', opts: Parameters<typeof requestClientAction>[2] = {}) {
  const p = requestClientAction(b, { ns: 'phone', op, args: { candidates: ['https://example.com'] } }, opts);
  await Promise.resolve();
  const ev = events[events.length - 1];
  return { p, ev, ackId: ev?.payload.ackId as string, body: ev?.payload.body as string };
}
const claim = (runId: string, ackId: string, body: string) => resolveClientAction(runId, ackId, { phase: 'claim', digest: sha(body) });
const claimAs = (runId: string, ackId: string, body: string, claimant: string) => resolveClientAction(runId, ackId, { phase: 'claim', digest: sha(body), claimant });
const DEV_A = 'devA_0123456789abcdef';
const DEV_B = 'devB_0123456789abcdef';

describe('出向电文', () => {
  it('事件名 client_cmd,且 ≤24 字符(agent_run_events.type 是 VARCHAR(24))', async () => {
    expect(CLIENT_CMD_EVENT).toBe('client_cmd');
    expect(CLIENT_CMD_EVENT.length).toBeLessThanOrEqual(24);
    const { ev, p, ackId, body } = await start();
    expect(ev.type).toBe(CLIENT_CMD_EVENT);
    expect(Object.keys(ev.payload).sort()).toEqual(['ackId', 'body', 'ns']);
    expect(ackId).toMatch(/^cc_[0-9a-z]+_\d+_[A-Za-z0-9_-]{12}$/);
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ v: 1, runId: 'r1', sessionId: 's1', ackId, ns: 'phone', op: 'view', target: { kind: 'origin' } });
    expect(parsed.args).toEqual({ candidates: ['https://example.com'] });
    expect(typeof parsed.iat).toBe('number');
    const c = claim('r1', ackId, body) as any;
    resolveClientAction('r1', ackId, { phase: 'result', nonce: c.nonce, result: { ok: true } });
    await p;
  });

  it('ns 未声明 → undeclared,且根本不发事件;op 非法 → invalid_args', async () => {
    const r = await requestClientAction(bind({ caps: ['camera.basic'] }), { ns: 'phone', op: 'view' });
    expect(r).toMatchObject({ ok: false, code: 'undeclared' });
    expect((await requestClientAction(bind(), { ns: 'phone', op: 'View; rm' })).code).toBe('invalid_args');
    expect((await requestClientAction(bind(), { ns: 'phone', op: 'view', args: [] as any })).code).toBe('invalid_args');
    expect(events).toHaveLength(0);
  });

  it('已中止的 signal → 立即 aborted,不发事件', async () => {
    const ac = new AbortController(); ac.abort();
    expect((await requestClientAction(bind({ runSignal: ac.signal }), { ns: 'phone', op: 'view' })).code).toBe('aborted');
    expect(events).toHaveLength(0);
  });

  it('publish 失败 → 立刻按 error 兑现(不干等 claimMs),并删登记', async () => {
    publishImpl = async () => { throw new Error('insert failed'); };
    const r = await requestClientAction(bind(), { ns: 'phone', op: 'view' });
    expect(r).toMatchObject({ ok: false, code: 'error' });
    expect(__pendingClientActionsForTest()).toBe(0);
  });
});

describe('claim / commit / result 状态机', () => {
  it('正路:claim → nonce;result 带 nonce → 兑现并删除;之后一切 410', async () => {
    const { p, ackId, body } = await start();
    const c = claim('r1', ackId, body) as { nonce: string; execMs: number };
    expect(c.nonce).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(c.execMs).toBe(20_000);
    expect(resolveClientAction('r1', ackId, { phase: 'commit', nonce: c.nonce })).toEqual({});
    const result = { ok: true, app: 'Maps', handoff: true };
    expect(resolveClientAction('r1', ackId, { phase: 'result', nonce: c.nonce, result })).toEqual({});
    expect(await p).toEqual(result);
    expect(__pendingClientActionsForTest()).toBe(0);
    expect(claim('r1', ackId, body)).toBeNull();
    expect(resolveClientAction('r1', ackId, { phase: 'result', nonce: c.nonce, result })).toBeNull();
  });

  it('别的 runId 拿着真 ackId → 410,且不影响合法 claim', async () => {
    const { p, ackId, body } = await start();
    expect(claim('r-other', ackId, body)).toBeNull();
    const c = claim('r1', ackId, body) as any;
    expect(c?.nonce).toBeTruthy();
    expect(resolveClientAction('r-other', ackId, { phase: 'result', nonce: c.nonce, result: { ok: true } })).toBeNull();
    resolveClientAction('r1', ackId, { phase: 'result', nonce: c.nonce, result: { ok: true } });
    await p;
  });

  it('digest 不符 / 畸形 / 缺失 → 410;登记仍在,合法 claim 照样成立(伪造 body 驱动不了手机)', async () => {
    const { p, ackId, body } = await start();
    const forged = body.replace('https://example.com', 'https://evil.example');
    expect(claim('r1', ackId, forged)).toBeNull();
    expect(resolveClientAction('r1', ackId, { phase: 'claim', digest: sha(body).toUpperCase() })).toBeNull();
    expect(resolveClientAction('r1', ackId, { phase: 'claim', digest: undefined })).toBeNull();
    expect(__pendingClientActionsForTest()).toBe(1);
    const c = claim('r1', ackId, body) as any;
    resolveClientAction('r1', ackId, { phase: 'result', nonce: c.nonce, result: { ok: true } });
    await p;
  });

  it('二次 claim 幂等(同一 claimant):同一 nonce,execMs 回剩余时长、不重置计时', async () => {
    vi.useFakeTimers();
    const { p, ackId, body } = await start();
    const c1 = claimAs('r1', ackId, body, DEV_A) as any;
    vi.advanceTimersByTime(7_000);
    const c2 = claimAs('r1', ackId, body, DEV_A) as any;
    expect(c2.nonce).toBe(c1.nonce);
    expect(c2.execMs).toBe(13_000);
    vi.advanceTimersByTime(13_000); // 原期限到 → no_report(重试没把期限往后拖)
    expect(await p).toMatchObject({ ok: false, code: 'no_report' });
  });

  it('重领只认首次的 claimant:另一台设备 / 不带 / 首次就没带 → 410;畸形 claimant 领不到且不占坑', async () => {
    // 同账号两台手机都持有这条 run 的 G2 归属 → 同一条 client_cmd 两台各 claim 一次(digest 与 token 都相同)。
    const a = await start();
    expect(resolveClientAction('r1', a.ackId, { phase: 'claim', digest: sha(a.body), claimant: 'short' })).toBeNull();
    expect(resolveClientAction('r1', a.ackId, { phase: 'claim', digest: sha(a.body), claimant: 42 })).toBeNull();
    const c = claimAs('r1', a.ackId, a.body, DEV_A) as any;
    expect(c?.nonce).toBeTruthy();
    expect(claimAs('r1', a.ackId, a.body, DEV_B)).toBeNull();
    expect(claim('r1', a.ackId, a.body)).toBeNull();
    expect(claimAs('r1', a.ackId, a.body, DEV_A.slice(0, -1) + 'Z')).toBeNull();
    // 输掉的那台拿不到 nonce → 抢不了回执(关着开关的那台回不了 `disabled` 冒充结果)
    resolveClientAction('r1', a.ackId, { phase: 'result', nonce: c.nonce, result: { ok: true, app: 'Maps' } });
    expect(await a.p).toEqual({ ok: true, app: 'Maps' });
    // 老原生(首次不带 claimant):首领照常成功;网关丢响应后的重领 fail closed,绝不再发一次 nonce
    const b = await start();
    expect((claim('r1', b.ackId, b.body) as any)?.nonce).toBeTruthy();
    expect(claim('r1', b.ackId, b.body)).toBeNull();
    expect(claimAs('r1', b.ackId, b.body, DEV_A)).toBeNull();
  });

  it('nonce 错 / 长度不同 / 非字符串 → 410 且不抛(timingSafeEqual 长度不等会抛)', async () => {
    const { p, ackId, body } = await start();
    const c = claim('r1', ackId, body) as any;
    const wrong = c.nonce.slice(0, -1) + (c.nonce.endsWith('A') ? 'B' : 'A');
    for (const n of [wrong, c.nonce + 'x', 'é'.repeat(24), 42, undefined]) {
      expect(resolveClientAction('r1', ackId, { phase: 'result', nonce: n, result: { ok: true } })).toBeNull();
      expect(resolveClientAction('r1', ackId, { phase: 'commit', nonce: n })).toBeNull();
    }
    expect(__pendingClientActionsForTest()).toBe(1);
    resolveClientAction('r1', ackId, { phase: 'result', nonce: c.nonce, result: { ok: true } });
    await p;
  });

  it('没 claim 就交 result / commit → 410(nonce 只能由 claim 发)', async () => {
    const { ackId } = await start();
    expect(resolveClientAction('r1', ackId, { phase: 'result', nonce: 'x'.repeat(24), result: { ok: true } })).toBeNull();
    expect(resolveClientAction('r1', ackId, { phase: 'commit', nonce: 'x'.repeat(24) })).toBeNull();
    expect(resolveClientAction('r1', ackId, { phase: 'bogus' } as any)).toBeNull();
    expect(__pendingClientActionsForTest()).toBe(1);
  });

  it('pending 期 run 级中止:aborted(协议保证没做)、删登记;之后迟到的 claim → 410(手机不会执行)', async () => {
    const ac = new AbortController();
    const { p, ackId, body } = await start(bind({ runSignal: ac.signal }));
    ac.abort();
    expect(await p).toEqual({ ok: false, code: 'aborted', error: 'aborted' });
    expect(__pendingClientActionsForTest()).toBe(0);
    expect(claim('r1', ackId, body)).toBeNull();
  });

  it('claimed 期 run 级中止:aborted_claimed + 「可能发生了」文案、删登记;之后 commit → 410(用户点的确认永不执行)', async () => {
    const ac = new AbortController();
    const { p, ackId, body } = await start(bind({ runSignal: ac.signal }));
    const c = claim('r1', ackId, body) as any;
    ac.abort();
    // 手机已经领走:不需确认的 op 此刻可能已执行完 —— 绝不能再用 pending 那句「什么都没发生」。
    expect(await p).toEqual({ ok: false, code: 'aborted_claimed', error: ABORTED_CLAIMED_TEXT });
    expect(__pendingClientActionsForTest()).toBe(0);
    expect(resolveClientAction('r1', ackId, { phase: 'commit', nonce: c.nonce })).toBeNull();
    expect(resolveClientAction('r1', ackId, { phase: 'result', nonce: c.nonce, result: { ok: true } })).toBeNull();
  });

  it('aborted_claimed 文案:说「可能做了」+ 先看手机,绝不说「没做 / 什么都不会发生」', () => {
    expect(ABORTED_CLAIMED_TEXT).toMatch(/may or may not have happened/);
    expect(ABORTED_CLAIMED_TEXT).toMatch(/check the phone before retrying/);
    expect(ABORTED_CLAIMED_TEXT).not.toMatch(/nothing (further )?(was done|will happen|happened)|did not happen|was not done/i);
  });

  it('调用方(工具作用域)的 signal 中止也生效;两个 signal 都监听(pending / claimed 两态)', async () => {
    const run = new AbortController();
    const tool = new AbortController();
    const { p, ackId, body } = await start(bind({ runSignal: run.signal }), 'view', { signal: tool.signal });
    expect(claim('r1', ackId, body)).toBeTruthy();
    tool.abort();
    expect(await p).toMatchObject({ ok: false, code: 'aborted_claimed' });
    expect(__pendingClientActionsForTest()).toBe(0);
    const tool2 = new AbortController();
    const second = await start(bind({ runSignal: run.signal }), 'view', { signal: tool2.signal });
    tool2.abort();
    expect(await second.p).toMatchObject({ ok: false, code: 'aborted' });
    expect(__pendingClientActionsForTest()).toBe(0);
  });

  it('makeClientActionRequester 绑死 runId:调用方指定不了别的 run', async () => {
    const req = makeClientActionRequester(bind({ runId: 'bound' }));
    const p = req({ ns: 'phone', op: 'torch', args: { on: true } });
    await Promise.resolve();
    const ev = events[events.length - 1];
    expect(ev.runId).toBe('bound');
    expect(JSON.parse(ev.payload.body).runId).toBe('bound');
    const c = resolveClientAction('bound', ev.payload.ackId, { phase: 'claim', digest: sha(ev.payload.body) }) as any;
    resolveClientAction('bound', ev.payload.ackId, { phase: 'result', nonce: c.nonce, result: { ok: true, verified: true } });
    expect(await p).toEqual({ ok: true, verified: true });
  });
});

describe('两段超时与钳制', () => {
  it('pending 超时:not_picked_up + 「什么都没发生」文案;迟到的 claim → 410', async () => {
    vi.useFakeTimers();
    const { p, ackId, body } = await start();
    vi.advanceTimersByTime(15_000);
    const r = await p;
    expect(r).toEqual({ ok: false, code: 'not_picked_up', error: NOT_PICKED_UP_TEXT });
    expect(NOT_PICKED_UP_TEXT).toMatch(/nothing was done/);
    expect(NOT_PICKED_UP_TEXT).toMatch(/phone control may be switched off/);
    expect(NOT_PICKED_UP_TEXT).toMatch(/another device/);
    expect(claim('r1', ackId, body)).toBeNull();
  });

  it('claimed 超时:no_report + 「可能发生了,先让用户看手机」文案;迟到的 result → 410', async () => {
    vi.useFakeTimers();
    const { p, ackId, body } = await start();
    const c = claim('r1', ackId, body) as any;
    vi.advanceTimersByTime(20_000);
    expect(await p).toEqual({ ok: false, code: 'no_report', error: NO_REPORT_TEXT });
    expect(NO_REPORT_TEXT).toMatch(/may or may not have happened/);
    expect(NO_REPORT_TEXT).toMatch(/check the phone before retrying/);
    expect(resolveClientAction('r1', ackId, { phase: 'result', nonce: c.nonce, result: { ok: true } })).toBeNull();
  });

  it('claim 成功重置计时:claimMs 快到时 claim,仍有完整 execMs', async () => {
    vi.useFakeTimers();
    const { p, ackId, body } = await start(bind(), 'view', { claimMs: 3_000, execMs: 5_000 });
    vi.advanceTimersByTime(2_999);
    const c = claim('r1', ackId, body) as any;
    expect(c.execMs).toBe(5_000);
    vi.advanceTimersByTime(4_999);
    expect(__pendingClientActionsForTest()).toBe(1);
    vi.advanceTimersByTime(1);
    expect((await p).code).toBe('no_report');
  });

  it('钳制:claimMs 3–30s、execMs 5–120s;非数字回缺省', async () => {
    vi.useFakeTimers();
    const lo = await start(bind(), 'view', { claimMs: 1, execMs: 1 });
    vi.advanceTimersByTime(2_999);
    expect(__pendingClientActionsForTest()).toBe(1);
    vi.advanceTimersByTime(1);
    expect((await lo.p).code).toBe('not_picked_up');

    const hi = await start(bind(), 'view', { claimMs: 1e9, execMs: 1e9 });
    vi.advanceTimersByTime(29_999);
    expect(__pendingClientActionsForTest()).toBe(1);
    expect((claim('r1', hi.ackId, hi.body) as any).execMs).toBe(120_000);
    const lo2 = await start(bind(), 'view', { execMs: 1 });
    expect((claim('r1', lo2.ackId, lo2.body) as any).execMs).toBe(5_000);
    const nan = await start(bind(), 'view', { claimMs: Number.NaN, execMs: Number.NaN });
    expect((claim('r1', nan.ackId, nan.body) as any).execMs).toBe(20_000);
    vi.advanceTimersByTime(200_000);
    await Promise.all([hi.p, lo2.p, nan.p]);
    expect(__pendingClientActionsForTest()).toBe(0);
  });
});
