/**
 * 云端 worker 按会话取哪枚令牌(真 httpWorkerHost + 真 HttpStateStore + 真 runs 路由;对面是照 server
 * microserver/agent-core/stateApi.ts 写的替身:带过期令牌的请求一律 401,建 run / 读会话配置按令牌的用户验归属)。
 *
 * 线上的样子(2026-10-10 查 api.forsion.net 访问日志):会话在某个 worker 上的第一条消息过去 30 分钟(派发令牌的缺省
 * 有效期)后再发消息,读归属带的是会话上绑着的旧令牌 → 401 → POST /agent/runs 回 500,重试也一样,直到 worker 重启。
 * 7–9 月共 21 个会话、63 次。原因是 HttpStateStore 按会话取令牌时先用会话上绑的那枚,建 run 时又把同一枚绑回去,
 * 请求自己的新令牌从没用上。
 *
 * 现在:handler 期(应答还没发完、且不在 run 上下文里)只用请求自己的令牌;loop 期照旧先用绑定的(它在续期);
 * 建 run 被拒 / 失败不留绑定。每条用例的负对照(改 httpStateStore.ts 后实跑,共 6 种改法):
 *   - tokenForSession 改回「先绑定的」                    → ①②⑥ 红(⑥:别人的建 run 带着会话主人的令牌出去,被收下了)
 *   - 改成任何时候都先用请求的                            → ③④⑤ 红
 *   - 去掉「应答还没发完」这个条件(只看 run 上下文)      → ④ 红
 *   - 去掉「不在 run 上下文里」这个条件(只看应答)        → ⑤ 红
 *   - createRun 改回先绑再发                              → ⑥ 红
 *   - run 终态时把会话上的绑定一并删掉(没有别的 run 在飞时) → ⑦ 红
 * 续期在这里用 refreshRunToken 直接换(定时器到点后调的就是它),不等真的定时器。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';

vi.mock('../services/agentLoop.js', () => ({
  enqueueRun: vi.fn(), abortRun: vi.fn(), enqueueSteer: vi.fn(), expediteSteer: vi.fn(), cancelSteer: vi.fn(), waitForRunSettlement: vi.fn(),
}));

import { configureTangu } from '../seams/runtime.js';
import { enterRunContext } from '../seams/runContext.js';
import type { StateStore } from '../seams/stateStore.js';
import { createTanguProfile } from '../profiles/index.js';
import { createHttpWorkerHost } from '../adapters/httpWorkerHost.js';
import { createHttpStateStore, refreshRunToken } from '../services/stateStore/httpStateStore.js';
import { enqueueRun } from '../services/agentLoop.js';
import runsRouter from './runs.js';

const FLEET = 'fleet-key';
/** 令牌写成「用户.序号」:替身按点号前那段认用户。 */
const userOf = (token: string): string => token.split('.')[0];
const sessions = new Map<string, string>(); // 会话 id → 归属
const expired = new Set<string>(); // 过了有效期的令牌
const seen: Array<{ call: string; token: string }> = []; // 状态接口收到的每个请求:哪条接口、带的哪枚令牌

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

let gateway: Server; // 状态接口的替身
let worker: Server;
let base: string;
let state: StateStore;
/** worker 上最近一次应答结束(= 那次请求的 handler 期结束)。 */
let responseClosed = deferred();

beforeAll(async () => {
  const api = express();
  api.use(express.json());
  const call = (req: express.Request): string => {
    const p = req.path.replace('/api/agent-state', '');
    if (p.endsWith('/owner')) return 'owner';
    if (p.endsWith('/agent-config')) return 'config';
    if (p.endsWith('/status')) return 'status';
    return p === '/sessions' ? 'session' : p === '/runs' ? 'run' : p;
  };
  api.use((req, res, next) => {
    if (req.headers['x-fleet-auth'] !== FLEET) return res.status(401).json({ detail: 'Unauthorized' });
    const token = String(req.headers.authorization ?? '').slice('Bearer '.length);
    seen.push({ call: call(req), token });
    if (!token || expired.has(token)) return res.status(401).json({ detail: 'Token expired' });
    (req as any).uid = userOf(token);
    next();
  });
  const ownSession = (req: express.Request, res: express.Response, sessionId: string): boolean => {
    const owner = sessions.get(sessionId);
    if (!owner) { res.status(404).json({ detail: 'Session not found' }); return false; }
    if (owner !== (req as any).uid) { res.status(403).json({ detail: 'Forbidden' }); return false; }
    return true;
  };
  api.get('/api/agent-state/sessions/:id/owner', (req, res) => res.json({ owner: sessions.get(req.params.id) ?? null }));
  api.post('/api/agent-state/sessions', (req, res) => {
    if (!sessions.has(req.body.id)) sessions.set(req.body.id, (req as any).uid); // ON CONFLICT (id) DO NOTHING
    res.json({ ok: true });
  });
  api.post('/api/agent-state/runs', (req, res) => { if (ownSession(req, res, req.body.sessionId)) res.json({ ok: true }); });
  api.post('/api/agent-state/runs/:id/status', (_req, res) => res.json({ ok: true }));
  api.get('/api/agent-state/sessions/:id/agent-config', (req, res) => { if (ownSession(req, res, req.params.id)) res.json({ agentConfig: null }); });
  gateway = api.listen(0);

  const { host } = createHttpWorkerHost({ fleetSecret: FLEET });
  state = createHttpStateStore({ cloudUrl: `http://127.0.0.1:${(gateway.address() as any).port}`, fleetSecret: FLEET });
  configureTangu({
    host,
    state,
    brain: new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any,
    billing: new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.once('close', () => responseClosed.resolve()); next(); });
  app.use(runsRouter);
  // 探针:handler 里直接建 run(真路由在建 run 之前就把别人的会话挡掉了,走不到被拒的那一步)。
  app.post('/probe/create/:sid', host.authMiddleware, async (req, res) => {
    const run = { id: randomUUID(), sessionId: req.params.sid, userId: (req as any).user.userId, appId: 'tangu', modelId: 'm1', assistantMessageId: randomUUID(), input: {} };
    res.json({ error: await state.createRun(run).then(() => null, (e) => String(e?.message || e)) });
  });
  // 探针:应答发出之前就在某个 run 的上下文里按会话读(先 await 一次再进上下文,离开按连接复用的那一帧)。
  app.post('/probe/inline/:sid/:runId', host.authMiddleware, async (req, res) => {
    await Promise.resolve();
    enterRunContext((req as any).user.userId, req.params.runId);
    res.json({ error: await state.getAgentConfig(req.params.sid).then(() => null, (e) => String(e?.message || e)) });
  });
  worker = app.listen(0);
  base = `http://127.0.0.1:${(worker.address() as any).port}`;
  await import('../services/delegateTranscript.js'); // 发消息的路由里现加载的那个模块:先在这里加载,不占第一条用例的时限
}, 30_000);
afterAll(() => { worker?.close(); gateway?.close(); });
beforeEach(() => { sessions.clear(); expired.clear(); seen.length = 0; responseClosed = deferred(); vi.mocked(enqueueRun).mockReset(); });

/** 网关派给 worker 的请求:受信头带用户 id,Authorization 是这次请求新铸的派发令牌。 */
const post = async (path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'X-Fleet-Auth': FLEET, 'X-Forsion-User': userOf(token), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const send = (token: string, sessionId: string) => post('/agent/runs', token, { session_id: sessionId, model_id: 'm1', message: 'hi' });
/** 这一段里状态接口收到的令牌(按接口)。 */
const tokens = (): string[] => seen.map((s) => `${s.call}:${s.token}`);

/**
 * 假 loop:由真 handler 里的 enqueueRun 起,继承到的异步上下文是真的(请求作用域 = 起它的那次请求)。
 * 等测试放行后按会话读一次配置 —— 那时应答早已结束,请求作用域里那枚令牌也已过期。
 */
const fakeLoop = (opts: { runContext: boolean }): { go: () => void; result: Promise<string | null> } => {
  const gate = deferred();
  let settle!: (v: string | null) => void;
  const result = new Promise<string | null>((r) => { settle = r; });
  vi.mocked(enqueueRun).mockImplementation((sessionId: string, runId: string) => {
    void (async () => {
      await Promise.resolve();
      if (opts.runContext) enterRunContext('u1', runId);
      await gate.promise;
      settle(await state.getAgentConfig(sessionId).then(() => null, (e) => String(e?.message || e)));
    })();
  });
  return { go: gate.resolve, result };
};

describe('云端 worker 按会话取令牌', () => {
  it('① 第一条消息的令牌过期之后再发:用这次请求自己的令牌,照常起 run', async () => {
    const first = await send('u1.a', 's-expired');
    expect(first.status).toBe(200);
    await state.updateRunStatus(first.body.runId, 'done');
    expired.add('u1.a');
    seen.length = 0;

    const again = await send('u1.b', 's-expired');
    expect(again.status).toBe(200);
    expect(tokens()).toEqual(['owner:u1.b', 'run:u1.b']);
  });

  it('② 旧令牌还没过期时再发:新 run 绑的是这次请求的令牌,不是把旧的再绑一遍', async () => {
    const first = await send('u1.a', 's-rebind');
    await state.updateRunStatus(first.body.runId, 'done');
    seen.length = 0;

    expect((await send('u1.b', 's-rebind')).status).toBe(200);
    expect(tokens()).toEqual(['owner:u1.b', 'run:u1.b']);
    // 旧令牌到期后,这个 run 在 loop 里(没有请求作用域)按会话读,带的是建它时绑的新令牌
    expired.add('u1.a');
    seen.length = 0;
    await state.getAgentConfig('s-rebind');
    expect(tokens()).toEqual(['config:u1.b']);
  });

  it('③ 跑了很久的 run:loop 里按会话读,带的是续期后的令牌,不是起它的那次请求的', async () => {
    const loop = fakeLoop({ runContext: true });
    const first = await send('u1.a', 's-long');
    expect(first.status).toBe(200);
    await responseClosed.promise;
    refreshRunToken(first.body.runId, 'u1.a2');
    expired.add('u1.a');
    seen.length = 0;

    loop.go();
    expect(await loop.result).toBeNull();
    expect(tokens()).toEqual(['config:u1.a2']);
  });

  it('④ 应答结束后、还没进 run 上下文的那一段(排队的 run 起跑时先按会话读配置)同样用绑定的令牌', async () => {
    const loop = fakeLoop({ runContext: false });
    const first = await send('u1.a', 's-queued');
    await responseClosed.promise;
    refreshRunToken(first.body.runId, 'u1.a2');
    expired.add('u1.a');
    seen.length = 0;

    loop.go();
    expect(await loop.result).toBeNull();
    expect(tokens()).toEqual(['config:u1.a2']);
  });

  it('⑤ 应答发出之前就在 run 上下文里干活的 handler:按会话读用那个 run 绑定的令牌', async () => {
    const first = await send('u1.a', 's-inline');
    refreshRunToken(first.body.runId, 'u1.a2');
    seen.length = 0;

    expect((await post(`/probe/inline/s-inline/${first.body.runId}`, 'u1.x')).body).toEqual({ error: null });
    expect(tokens()).toEqual(['config:u1.a2']);
  });

  it('⑥ 建 run 被拒:不把自己的令牌留在会话上,会话里在飞的 run 照旧用它自己的', async () => {
    expect((await send('u1.a', 's-refused')).status).toBe(200);
    seen.length = 0;

    const refused = await post('/probe/create/s-refused', 'u2.a');
    expect(refused.body.error).toContain('Forbidden');
    expect(tokens()).toEqual(['run:u2.a']); // 带的是它自己的令牌,所以 server 那道「建 run 验归属」拒得掉
    seen.length = 0;
    await state.getAgentConfig('s-refused'); // 在飞的 run 在 loop 里按会话读
    expect(tokens()).toEqual(['config:u1.a']);
  });

  it('⑦ 会话里最后一条 run 结束后绑定原样留着:它收尾时还要按会话写', async () => {
    const only = await send('u1.a', 's-tail');
    await state.updateRunStatus(only.body.runId, 'done');
    seen.length = 0;
    await state.getAgentConfig('s-tail');
    expect(tokens()).toEqual(['config:u1.a']);
  });
});
