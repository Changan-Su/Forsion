/**
 * 设备能力 MCP 方案 P0 ④ · 路由侧(契约 C1):unitWeb 盖了 x-forsion-remote 的请求。真 express + 真路由 + 内存 SQLite,
 * 只把 agentLoop 的入队 / 在飞状态换成桩(run 只落库不执行)。负对照都在修复前的代码上实跑为红。
 *   POST /agent/runs:input.remote 落库;agent_config 剥 verifyCommand / engineId / extraRoots / 设备能力,审批档钳到上限;
 *                    本机请求原样(负对照)。
 *   POST /agent/sessions:远程建会话的初始配置同样钳 + 记远程标记;分支:远端发起的分支记标记,源会话的标记随 agent_config 照抄。
 *   PATCH / PUT /agent/sessions/:id/config:远程抬不过上限、设不了 / 删不掉受保护键(verifyCommand / devices …)。
 *   POST /agent/runs/:id/steer:远端 steer 本机 run → 染色(之后按远程钳,闸那半见 remoteClampGate)。
 *   POST /agent/special/muse/todos/inject:注入 run 带污点、照抄的会话配置同样过钳。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/services/agentLoop.js', () => ({
  enqueueRun: vi.fn(), abortRun: vi.fn(), enqueueSteer: vi.fn(() => true), expediteSteer: vi.fn(() => true), cancelSteer: vi.fn(() => true),
  waitForRunSettlement: vi.fn(async () => true), sessionHasActiveRun: vi.fn(() => false),
}));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import runsRouter from '../src/routes/runs.js';
import sessionsRouter from '../src/routes/sessions.js';
import specialRouter from '../src/routes/special.js';
import { effectiveRemote } from '../src/services/remoteOrigin.js';
import { enqueueSteer } from '../src/services/agentLoop.js';

let srv: Server;
let base: string;
let home: string;
const REMOTE = { 'x-forsion-remote': 'tunnel' };
const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const json = (v: any): any => (typeof v === 'string' ? JSON.parse(v) : v);
const runInput = async (runId: string): Promise<any> => json((await query<any[]>(`SELECT input FROM agent_runs WHERE id = ?`, [runId]))[0].input);
const cfgOf = async (id: string): Promise<any> => json((await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [id]))[0].agent_config);
const addSession = (id: string, cfg: unknown) => query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES (?, 'u1', 'tangu', 't', 'm1', 'user', 1, ?)`, [id, JSON.stringify(cfg)]);
const HOSTILE = { execMode: 'host', approvalMode: 'full-auto', verifyCommand: 'echo pwned > /tmp/x', engineId: 'codex', extraRoots: ['/'], clientCapabilities: ['phone_ui'], devices: ['phone-1'], thinkingLevel: 'low' };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-remote-routes-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express(); app.use(express.json()); app.use(runsRouter); app.use(sessionsRouter); app.use(specialRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('POST /agent/runs', () => {
  it('远程:落 input.remote、剥受保护字段、审批档钳到上限(负对照:本机请求原样)', async () => {
    const r = await send('POST', '/agent/runs', { session_id: 'RS1', model_id: 'm1', message: 'hi', agent_config: HOSTILE }, REMOTE);
    expect(r.status).toBe(200);
    const input = await runInput(r.body.runId);
    expect(input.remote).toEqual({ via: 'tunnel', marked: false });
    expect(input.agentConfig).toEqual({ execMode: 'host', approvalMode: 'auto-edit', thinkingLevel: 'low' });
    expect(input.origin).toBe('client');

    const l = await send('POST', '/agent/runs', { session_id: 'RS2', model_id: 'm1', message: 'hi', agent_config: HOSTILE });
    const local = await runInput(l.body.runId);
    expect(local.remote).toBeUndefined();
    expect(local.agentConfig).toEqual(HOSTILE);
  });

  it('请求体里自带 remote / 自称的污点字段不作数:只认头(本机请求 = 无污点;远程 = 按头重建)', async () => {
    const l = await send('POST', '/agent/runs', { session_id: 'RS3', model_id: 'm1', message: 'hi', remote: { via: 'lan' }, agent_config: { remote: { via: 'lan' } } });
    expect((await runInput(l.body.runId)).remote).toBeUndefined();
  });

  it('远端 steer 本机在飞 run → 该 run 染色(负对照:本机 steer 不染)', async () => {
    await addSession('ST1', {});
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('st-local', 'ST1', 'u1', 'running', '{}')`);
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('st-remote', 'ST1', 'u1', 'running', '{}')`);
    expect((await send('POST', '/agent/runs/st-local/steer', { message: 'also do x' })).status).toBe(200);
    expect(effectiveRemote({ runId: 'st-local' })).toBeUndefined();
    expect((await send('POST', '/agent/runs/st-remote/steer', { message: 'also do x' }, REMOTE)).status).toBe(200);
    expect(effectiveRemote({ runId: 'st-remote' })).toEqual({ via: 'tunnel', marked: false });
    // 没入队成功(run 已结束 → 409)的远程 steer 不登记染色(Codex 评审:失败请求不许占表)
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('st-done', 'ST1', 'u1', 'done', '{}')`);
    (enqueueSteer as any).mockReturnValueOnce(false);
    expect((await send('POST', '/agent/runs/st-done/steer', { message: 'x' }, REMOTE)).status).toBe(409);
    expect(effectiveRemote({ runId: 'st-done' })).toBeUndefined();
  });
});

describe('会话路由', () => {
  it('POST /agent/sessions:远程建会话的初始配置过钳 + 记远程标记(负对照:本机原样)', async () => {
    const r = await send('POST', '/agent/sessions', { title: 'x', agent_config: HOSTILE }, REMOTE);
    const cfg = r.body.session.agent_config;
    expect(cfg).toMatchObject({ execMode: 'host', approvalMode: 'auto-edit', thinkingLevel: 'low', remoteOrigin: { via: 'tunnel', marked: false } });
    for (const k of ['verifyCommand', 'engineId', 'extraRoots', 'clientCapabilities', 'devices']) expect(cfg[k]).toBeUndefined();
    const l = await send('POST', '/agent/sessions', { title: 'x', agent_config: HOSTILE });
    expect(l.body.session.agent_config).toEqual(HOSTILE);
  });

  it('PATCH config:远程改档抬不过上限、verifyCommand / devices 设不上也删不掉(负对照:本机照改)', async () => {
    await addSession('C1', { approvalMode: 'readonly', verifyCommand: 'npm test' });
    expect((await send('PATCH', '/agent/sessions/C1/config', { approvalMode: 'full-auto', verifyCommand: 'echo pwned', devices: ['p'] }, REMOTE)).status).toBe(200);
    expect(await cfgOf('C1')).toEqual({ approvalMode: 'auto-edit', verifyCommand: 'npm test' });
    await send('PATCH', '/agent/sessions/C1/config', { verifyCommand: null }, REMOTE);
    expect((await cfgOf('C1')).verifyCommand).toBe('npm test');
    await send('PATCH', '/agent/sessions/C1/config', { approvalMode: 'full-auto', verifyCommand: 'make' });
    expect(await cfgOf('C1')).toEqual({ approvalMode: 'full-auto', verifyCommand: 'make' });
  });

  it('PUT config:远程整对象替换保留受保护键、同值不降档(老客户端回写整对象)', async () => {
    await addSession('C2', { approvalMode: 'full-auto', extraRoots: ['/data'], engineId: 'codex' });
    await send('PUT', '/agent/sessions/C2/config', { approvalMode: 'full-auto', thinkingLevel: 'high' }, REMOTE);
    expect(await cfgOf('C2')).toEqual({ approvalMode: 'full-auto', thinkingLevel: 'high', extraRoots: ['/data'], engineId: 'codex' });
    await send('PUT', '/agent/sessions/C2/config', { approvalMode: 'custom' }, REMOTE);
    expect((await cfgOf('C2')).approvalMode).toBe('full-auto');
  });

  it('分支:远端发起的分支记标记;远程建的会话被本机分支,标记随 agent_config 照抄(负对照:本机分支本机会话无标记)', async () => {
    await addSession('B1', { approvalMode: 'auto-edit' });
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('b1m', 'B1', 'user', 'hi', 1)`);
    const local = await send('POST', '/agent/sessions/B1/branch', { message_id: 'b1m' });
    expect(local.body.session.agent_config.remoteOrigin).toBeUndefined();
    const remote = await send('POST', '/agent/sessions/B1/branch', { message_id: 'b1m' }, REMOTE);
    expect(remote.body.session.agent_config.remoteOrigin).toMatchObject({ via: 'tunnel' });
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('b2m', ?, 'user', 'hi', 1)`, [remote.body.session.id]);
    const again = await send('POST', `/agent/sessions/${remote.body.session.id}/branch`, { message_id: 'b2m' });
    expect(again.body.session.agent_config.remoteOrigin).toMatchObject({ via: 'tunnel' });
  });
});

describe('Muse TODO 注入', () => {
  it('远程注入:run 带污点,照抄的会话配置过钳(负对照:本机注入原样)', async () => {
    await addSession('M1', { execMode: 'host', approvalMode: 'full-auto', verifyCommand: 'npm test' });
    await query(`INSERT INTO muse_todos (id, user_id, title, status) VALUES ('t1', 'u1', 'do it', 'pending')`);
    const r = await send('POST', '/agent/special/muse/todos/inject', { todoIds: ['t1'], sessionId: 'M1' }, REMOTE);
    expect(r.status).toBe(200);
    const input = await runInput(r.body.runId);
    expect(input.remote).toEqual({ via: 'tunnel', marked: false });
    expect(input.agentConfig).toEqual({ execMode: 'host', approvalMode: 'auto-edit' });
    await query(`INSERT INTO muse_todos (id, user_id, title, status) VALUES ('t2', 'u1', 'do it', 'pending')`);
    const l = await send('POST', '/agent/special/muse/todos/inject', { todoIds: ['t2'], sessionId: 'M1' });
    const local = await runInput(l.body.runId);
    expect(local.remote).toBeUndefined();
    expect(local.agentConfig.verifyCommand).toBe('npm test');
  });
});
