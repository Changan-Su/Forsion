/**
 * 云端 worker:同会话排在后面的那条消息被取消、前面那条 run 还在跑 —— 前面那条之后按会话读写带的是哪枚令牌。
 * 真 httpWorkerHost + 真 HttpStateStore + 真 runs 路由 + **真 agentLoop 的排队与取消**(enqueueRun / abortRun 没有替身);
 * 对面是状态接口替身(过期令牌回 401)。在跑的那条 run 停在起跑的第一步(替身压着它那次读 run 行不回),不需要模型。
 *
 * HttpStateStore 的会话绑定指向「最近建成的那个 run」的令牌。排队的 run 被取消(routes/runs.ts 的 abort →
 * agentLoop.abortRun → terminalizeQueuedAbort → updateRunStatus('aborted'))之后,它的续期定时器停了,会话上却仍指着它那枚:
 * 前面那条 run 再跑过这枚令牌的有效期,按会话的读写(插用户消息、写待办、落助手消息)就全是 401。
 * 现在取消时把会话绑定交还给同会话还在飞的 run。负对照(去掉 dropRunToken 里交还的那几行,实跑)→ ① 红。
 * 线上没出现过:要一条跑过 30 分钟的云端 run,而访问日志里 7-23 之后没有一次令牌续期(没有 run 活过 24 分钟)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

import { configureTangu } from '../seams/runtime.js';
import type { StateStore } from '../seams/stateStore.js';
import { createTanguProfile } from '../profiles/index.js';
import { createHttpWorkerHost } from '../adapters/httpWorkerHost.js';
import { createHttpStateStore, refreshRunToken } from '../services/stateStore/httpStateStore.js';
import { waitForRunSettlement } from '../services/agentLoop.js';
import runsRouter from './runs.js';

const FLEET = 'fleet-key';
const userOf = (token: string): string => token.split('.')[0];
const sessions = new Map<string, string>(); // 会话 id → 归属
const runs = new Map<string, { id: string; session_id: string; user_id: string; status: string; input: unknown }>();
const expired = new Set<string>();
const seen: string[] = []; // 状态接口收到的「接口:令牌」

let gateway: Server;
let worker: Server;
let base: string;
let state: StateStore;
/**
 * 第一个建成的 run(= 在跑的那条):它起跑第一步读 run 行,替身压着不回,直到测试收尾;放行后一律按「行没了」回,loop 不起跑、直接退出。
 * 按建 run 的先后认它,不按「第一个到的读请求」认:那次读是 handler 里发出去的,和后面的请求谁先到替身没有保证。
 */
let releaseFirstRunRead!: () => void;
const firstRunRead = new Promise<void>((r) => { releaseFirstRunRead = r; });
let heldRunId: string | undefined;

beforeAll(async () => {
  const api = express();
  api.use(express.json());
  api.use((req, res, next) => {
    if (req.headers['x-fleet-auth'] !== FLEET) return res.status(401).json({ detail: 'Unauthorized' });
    const token = String(req.headers.authorization ?? '').slice('Bearer '.length);
    const p = req.path.replace('/api/agent-state', '');
    seen.push(`${p.endsWith('/agent-config') ? 'config' : p.endsWith('/status') ? 'status' : p}:${token}`);
    if (!token || expired.has(token)) return res.status(401).json({ detail: 'Token expired' });
    (req as any).uid = userOf(token);
    next();
  });
  api.get('/api/agent-state/sessions/:id/owner', (req, res) => res.json({ owner: sessions.get(req.params.id) ?? null }));
  api.post('/api/agent-state/sessions', (req, res) => { if (!sessions.has(req.body.id)) sessions.set(req.body.id, (req as any).uid); res.json({ ok: true }); });
  api.post('/api/agent-state/runs', (req, res) => {
    heldRunId ??= req.body.id;
    runs.set(req.body.id, { id: req.body.id, session_id: req.body.sessionId, user_id: (req as any).uid, status: 'queued', input: req.body.input });
    res.json({ ok: true });
  });
  api.get('/api/agent-state/runs/:id', async (req, res) => {
    if (req.params.id === heldRunId) { await firstRunRead; return res.status(404).json({ detail: 'Run not found' }); }
    const run = runs.get(req.params.id);
    return run ? res.json(run) : res.status(404).json({ detail: 'Run not found' });
  });
  api.post('/api/agent-state/runs/:id/status', (req, res) => { const run = runs.get(req.params.id); if (run) run.status = req.body.status; res.json({ ok: true }); });
  api.post('/api/agent-state/runs/:id/stream', (_req, res) => res.json({ ok: true, lastSeq: 0 }));
  api.get('/api/agent-state/sessions/:id/agent-config', (_req, res) => res.json({ agentConfig: null }));
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
  app.use(runsRouter);
  worker = app.listen(0);
  base = `http://127.0.0.1:${(worker.address() as any).port}`;
  await import('../services/delegateTranscript.js'); // 发消息的路由里现加载的那个模块:先在这里加载,不占第一条用例的时限
}, 30_000);
afterAll(async () => {
  releaseFirstRunRead();
  if (heldRunId) await waitForRunSettlement(heldRunId, 5000); // 等被压着的那条 run 读到「行没了」退出,再关服务
  worker?.close(); gateway?.close();
});

const post = async (path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'X-Fleet-Auth': FLEET, 'X-Forsion-User': userOf(token), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const send = (token: string, sessionId: string) => post('/agent/runs', token, { session_id: sessionId, model_id: 'm1', message: 'hi' });

describe('云端 worker:排队的消息被取消之后', () => {
  it('① 前面那条还在跑的 run 按会话读写,带的是它自己续期后的令牌,不是被取消那条留下的', async () => {
    const first = await send('u1.a', 's-queue');
    const second = await send('u1.b', 's-queue'); // 第一条还在跑 → 这条排队
    expect([first.status, second.status]).toEqual([200, 200]);

    const aborted = await post(`/agent/runs/${second.body.runId}/abort`, 'u1.c');
    expect(aborted.body).toMatchObject({ success: true, settled: true, status: 'aborted' });

    refreshRunToken(first.body.runId, 'u1.a2'); // 第一条跑到续期点(定时器到点后调的就是它)
    expired.add('u1.a'); expired.add('u1.b');
    seen.length = 0;
    await state.getAgentConfig('s-queue'); // 第一条 run 在 loop 里(没有请求作用域)按会话读
    expect(seen).toEqual(['config:u1.a2']);
  }, 30_000);
});
