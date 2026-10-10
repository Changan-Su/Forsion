/**
 * POST /agent/runs 的会话归属。真 express + fetch 直打;state 是内存替身,建会话照真库的写法(已存在就什么都不做)。
 * 要钉的是「建完再读一次归属」:两个账号用同一个新会话 id 同时发第一条消息时,两边第一次都读到「还没有这个会话」,
 * 后插入的那次是空操作 —— 不复核,它的 run 就建在了先到那个人的会话上。
 * (云端 worker 走 /agent-state/runs 时网关还有一道 ownSession,那里是 403;直接接 SQL 库的宿主只有这一道。)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

// 路由起完 run 就把它交给 agent loop(不等结果)。这里只看路由自己的判断,不跑 loop。
const enqueueRun = vi.hoisted(() => vi.fn());
vi.mock('../services/agentLoop.js', () => ({
  enqueueRun, abortRun: vi.fn(), enqueueSteer: vi.fn(), expediteSteer: vi.fn(), cancelSteer: vi.fn(), waitForRunSettlement: vi.fn(),
}));

import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import runsRouter from './runs.js';

const sessions = new Map<string, string>(); // 会话 id → 归属
const runs: Array<{ sessionId: string; userId: string }> = [];
let ownerReads = 0;
/** 非空时:接下来的 left 次「读归属」各自先读完,再等到全部到齐才返回 —— 几个请求都在别人插入之前读到了「没有」。 */
let together: { left: number; go: Array<() => void> } | null = null;

const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
const strict = (name: string, impl: Record<string, any>): any =>
  new Proxy(impl, { get: (t, k) => (k in t ? t[k as string] : () => { throw new Error(`stub ${name}.${String(k)}`); }) });

let srv: Server;
let base: string;

beforeAll(() => {
  configureTangu({
    // Bearer <用户 id>
    host: strict('host', {
      authMiddleware: (req: any, _res: any, next: any) => { req.user = { userId: String(req.headers.authorization).slice('Bearer '.length) }; next(); },
    }),
    brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }),
    state: strict('state', {
      getSessionOwner: async (id: string) => {
        ownerReads++;
        const owner = sessions.get(id) ?? null;
        const t = together;
        if (t && t.left > 0) await new Promise<void>((r) => { t.go.push(r); if (--t.left === 0) t.go.forEach((g) => g()); });
        return owner;
      },
      // INSERT … ON CONFLICT (id) DO NOTHING
      autoCreateSession: async (s: { id: string; userId: string }) => { if (!sessions.has(s.id)) sessions.set(s.id, s.userId); },
      createRun: async (r: { sessionId: string; userId: string }) => { runs.push({ sessionId: r.sessionId, userId: r.userId }); },
    }),
  });
  const app = express();
  app.use(express.json());
  app.use(runsRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => { srv?.close(); });
beforeEach(() => { sessions.clear(); runs.length = 0; ownerReads = 0; together = null; enqueueRun.mockClear(); });

const send = async (user: string, sessionId: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}/agent/runs`, {
    method: 'POST', headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, model_id: 'm1', message: 'hi' }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const notFound = { status: 404, body: { detail: 'Session not found' } };

describe('POST /agent/runs:会话归属', () => {
  it('新会话的第一条消息:建会话、起 run', async () => {
    const r = await send('u1', 's-new');
    expect(r.status).toBe(200);
    expect(sessions.get('s-new')).toBe('u1');
    expect(runs).toEqual([{ sessionId: 's-new', userId: 'u1' }]);
    expect(enqueueRun).toHaveBeenCalledTimes(1);
    expect(enqueueRun).toHaveBeenCalledWith('s-new', r.body.runId);
  });

  it('自己已有的会话:照常起 run;复核只发生在新建那一次,这里只读一次归属', async () => {
    sessions.set('s-mine', 'u1');
    expect((await send('u1', 's-mine')).status).toBe(200);
    expect(ownerReads).toBe(1);
    expect(runs).toEqual([{ sessionId: 's-mine', userId: 'u1' }]);
  });

  it('别人已有的会话:404,不起 run', async () => {
    sessions.set('s-theirs', 'u2');
    expect(await send('u1', 's-theirs')).toEqual(notFound);
    expect(runs).toEqual([]);
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it('两个账号同时用同一个新会话 id 发第一条:插入落空的那个 404,它的 run 不会建在对方的会话上', async () => {
    together = { left: 2, go: [] };
    const [a, b] = await Promise.all([send('u1', 's-race'), send('u2', 's-race')]);
    const owner = sessions.get('s-race');
    expect(['u1', 'u2']).toContain(owner);
    const [won, lost] = owner === 'u1' ? [a, b] : [b, a];
    expect(won.status).toBe(200);
    expect(lost).toEqual(notFound);
    expect(runs).toEqual([{ sessionId: 's-race', userId: owner }]);
    expect(enqueueRun).toHaveBeenCalledTimes(1);
  });
});
