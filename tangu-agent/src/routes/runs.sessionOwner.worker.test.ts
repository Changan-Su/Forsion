/**
 * POST /agent/runs 的会话归属 —— 云端 worker 这条路(真 httpWorkerHost + 真 HttpStateStore,对面是照 server
 * microserver/agent-core/stateApi.ts 的三条路由写的替身:读归属如实返回、建会话已存在就什么都不做、建 run 按令牌的用户验归属)。
 *
 * 加这道复核时(2026-10-10 上午)server 那道「建 run 验归属」在这里兜不住:HttpStateStore 给会话选令牌时先用「这个会话
 * 绑定的令牌」(createRun 时绑),再才是本次请求自己的。两个账号抢同一个新会话 id、都读到「还没有」之后:
 *   - 先到的那个 run 已建(它的令牌已绑到会话)→ 后到的那个 createRun 拿到的是**对方的令牌**,server 验归属通过,
 *     后到者写的话就以对方的身份、在对方的会话里起了 run;
 *   - 后到的那个先 createRun → 被 server 拒,但它的令牌已经绑到会话 → 先到者自己的 run 反而被拒。
 * 路由建完会话后再读一次归属(读归属不看令牌是谁的),后到者在 createRun 之前就被挡下,两种次序都不再发生。
 *
 * 当天下午 HttpStateStore 改成 handler 期只用请求自己的令牌、建成了才绑(见 runs.sessionToken.worker.test.ts),server 那道检查
 * 在这里也生效了。实跑:去掉路由的复核,后两条仍红,但红成 500 Forbidden(走到建 run 被 server 拒),不再是以对方的身份起 run、
 * 也不再连累先到者。复核照旧留着:走到建 run 之前就给出 404。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

vi.mock('../services/agentLoop.js', () => ({
  enqueueRun: vi.fn(), abortRun: vi.fn(), enqueueSteer: vi.fn(), expediteSteer: vi.fn(), cancelSteer: vi.fn(), waitForRunSettlement: vi.fn(),
}));

import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createHttpWorkerHost } from '../adapters/httpWorkerHost.js';
import { createHttpStateStore } from '../services/stateStore/httpStateStore.js';
import runsRouter from './runs.js';

const FLEET = 'fleet-key';
const sessions = new Map<string, string>(); // 会话 id → 归属
const runs: Array<{ sessionId: string; userId: string; message: unknown }> = []; // server 收下的 run:userId 是令牌的用户
const refused: string[] = []; // 被「建 run 验归属」拒掉的:令牌的用户
/** 每条用例自己排次序用的钩子。 */
let hooks: { ownerRead?: () => Promise<void>; beforeInsert?: (user: string) => Promise<void>; afterInsert?: (user: string) => Promise<void>; onRun?: () => void } = {};

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
/** 前 n 次调用各自等到 n 个都到齐才放行(几个请求都在别人插入之前读到了「没有」),之后的直接过。 */
const together = (n: number) => {
  const go: Array<() => void> = [];
  return (): Promise<void> => (n <= 0 ? Promise.resolve() : new Promise<void>((r) => { go.push(r); if (--n === 0) go.forEach((g) => g()); }));
};

let gateway: Server; // 状态接口的替身
let worker: Server;
let base: string;

beforeAll(async () => {
  const api = express();
  api.use(express.json());
  const tokenUser = (req: express.Request): string => String(req.headers.authorization).slice('Bearer tok-'.length);
  api.use((req, res, next) => (req.headers['x-fleet-auth'] === FLEET ? next() : res.status(401).json({ detail: 'Unauthorized' })));
  api.get('/api/agent-state/sessions/:id/owner', async (req, res) => {
    const owner = sessions.get(req.params.id) ?? null;
    await hooks.ownerRead?.();
    res.json({ owner });
  });
  api.post('/api/agent-state/sessions', async (req, res) => {
    const user = tokenUser(req);
    await hooks.beforeInsert?.(user);
    if (!sessions.has(req.body.id)) sessions.set(req.body.id, user); // ON CONFLICT (id) DO NOTHING
    await hooks.afterInsert?.(user);
    res.json({ ok: true });
  });
  api.post('/api/agent-state/runs', (req, res) => {
    const user = tokenUser(req);
    const owner = sessions.get(req.body.sessionId);
    if (!owner) return res.status(404).json({ detail: 'Session not found' });
    if (owner !== user) { refused.push(user); return res.status(403).json({ detail: 'Forbidden' }); }
    runs.push({ sessionId: req.body.sessionId, userId: user, message: req.body.input?.message });
    res.json({ ok: true });
    hooks.onRun?.();
  });
  gateway = api.listen(0);

  configureTangu({
    host: createHttpWorkerHost({ fleetSecret: FLEET }).host,
    state: createHttpStateStore({ cloudUrl: `http://127.0.0.1:${(gateway.address() as any).port}`, fleetSecret: FLEET }),
    brain: new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any,
    billing: new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  const app = express();
  app.use(express.json());
  app.use(runsRouter);
  worker = app.listen(0);
  base = `http://127.0.0.1:${(worker.address() as any).port}`;
});
afterAll(() => { worker?.close(); gateway?.close(); });
beforeEach(() => { sessions.clear(); runs.length = 0; refused.length = 0; hooks = {}; });

/** 网关派给 worker 的请求:受信头带用户 id,Authorization 是给这个用户铸的派发令牌。 */
const send = async (user: string, sessionId: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}/agent/runs`, {
    method: 'POST',
    headers: { 'X-Fleet-Auth': FLEET, 'X-Forsion-User': user, Authorization: `Bearer tok-${user}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, model_id: 'm1', message: `from ${user}` }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const notFound = { status: 404, body: { detail: 'Session not found' } };

describe('POST /agent/runs:会话归属(云端 worker)', () => {
  it('新会话的第一条消息:建完再读到的归属就是自己,照常起 run', async () => {
    expect((await send('u1', 'w-new')).status).toBe(200);
    expect(runs).toEqual([{ sessionId: 'w-new', userId: 'u1', message: 'from u1' }]);
  });

  it('抢同一个新会话 id,对方的 run 已经建好:后到者 404,它写的话不会以对方的身份在对方的会话里起 run', async () => {
    const u1Ran = deferred();
    hooks = {
      ownerRead: together(2),
      beforeInsert: (user) => (user === 'u2' ? u1Ran.promise : Promise.resolve()), // u2 的插入落在 u1 的 run 建好之后:那时会话上绑的是 u1 的令牌
      onRun: u1Ran.resolve,
    };
    const [a, b] = await Promise.all([send('u1', 'w-race-1'), send('u2', 'w-race-1')]);
    expect(a.status).toBe(200);
    expect(b).toEqual(notFound);
    expect(runs).toEqual([{ sessionId: 'w-race-1', userId: 'u1', message: 'from u1' }]);
  });

  it('抢同一个新会话 id,后到者先走到建 run:它 404 且不留下自己的令牌,先到者自己的 run 照常建成', async () => {
    const u1Inserted = deferred();
    const u2Done = deferred();
    hooks = {
      ownerRead: together(2),
      beforeInsert: (user) => (user === 'u2' ? u1Inserted.promise : Promise.resolve()), // u1 的插入先落
      afterInsert: async (user) => { if (user === 'u1') { u1Inserted.resolve(); await u2Done.promise; } }, // 但 u1 要等 u2 整个请求走完才收到应答
    };
    const pa = send('u1', 'w-race-2');
    const b = await send('u2', 'w-race-2');
    u2Done.resolve();
    const a = await pa;
    expect(b).toEqual(notFound);
    expect(refused).toEqual([]);
    expect(a.status).toBe(200);
    expect(runs).toEqual([{ sessionId: 'w-race-2', userId: 'u1', message: 'from u1' }]);
  });
});
