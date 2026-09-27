/**
 * 设备能力 MCP 方案 P0 · 第三轮 · 集成(引擎 × 桌面接缝)。桌面 D1 让设备页的主机文件读范围只认「无远程标记」的会话目录
 * (desktop/electron/unitLocalRoots.ts hasRemoteOrigin);这份文件钉住引擎那一半:远端能让一个目录进 project_path 的路,
 * 引擎都给会话盖 agent_config.remoteOrigin,本机的整对象写回也抹不掉它。
 *
 *   I1 远端 PATCH /agent/sessions/:id 把 project_path 改成别的目录 → 同一条 UPDATE 盖标记(已有标记原样保留;本机改 / 远端只改标题 / 路径没变 → 不盖)。
 *   I2 远程污点的 dispatchProjectSession(start_project_session 派生会话)→ 会话存值带标记;首个 run 的 agentConfig 不带(run 的污点是 input.remote)。
 *   I3 本机 PUT /agent/sessions/:id/config(整对象替换)/ PATCH null 抹不掉已有标记;本机写加标记不拦。
 *   I4 钉桩:桌面登记表 <userData>/unit-local-project-roots.json 落在 C4 凭据清单里 —— 远程写硬拒、本机写要批(完全通行也要)、结构化读硬拒。
 *      修复在引擎第三轮 E2(整片 userData 进 credentialPaths),这里只钉住桌面新文件确实被覆盖。
 *
 * 真 express + 真 sessions 路由 + 内存 SQLite(agentLoop 换桩:run 只落库不执行);I4 走真 gateToolCall。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/services/agentLoop.js', () => ({
  enqueueRun: vi.fn(), abortRun: vi.fn(), enqueueSteer: vi.fn(() => true), expediteSteer: vi.fn(() => true), cancelSteer: vi.fn(() => true),
  waitForRunSettlement: vi.fn(async () => true), sessionHasActiveRun: vi.fn(() => false),
}));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import sessionsRouter from '../src/routes/sessions.js';
import { gateToolCall } from '../src/services/approvals.js';
import { subscribe } from '../src/services/eventBus.js';
import { checkReadPath, protectedLocalWrite, protectedRemoteWrite } from '../src/tools/fsPolicy.js';
import { dispatchProjectSession } from '../src/tools/builtin/startProjectSession.js';
import type { ToolCall } from '../src/core/types.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const REMOTE_HDR = { 'x-forsion-remote': 'lan' };
const REMOTE = { via: 'lan' as const, marked: false };
let srv: Server;
let base: string;
let home: string;
let ws: string;
let userData: string;
const prevAmadeus = process.env.FORSION_AMADEUS_CONFIG;
const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const json = (v: any): any => (typeof v === 'string' ? JSON.parse(v) : v);
const rowOf = async (id: string): Promise<{ cfg: any; path: string | null }> => {
  const [r] = await query<any[]>(`SELECT agent_config, project_path FROM chat_sessions WHERE id = ?`, [id]);
  return { cfg: json(r.agent_config), path: r.project_path };
};
const addSession = (id: string, cfg: unknown, projectPath: string | null = null) =>
  query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, project_path, agent_config) VALUES (?, 'u1', 'tangu', 't', 'm1', 'user', ?, ?, ?)`,
    [id, projectPath ? 0 : 1, projectPath, cfg == null ? null : JSON.stringify(cfg)]);
const dir = (name: string): string => { const d = join(ws, name); mkdirSync(d, { recursive: true }); return realpathSync(d); };
const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;
async function gate(runId: string, c: ToolCall, ctx: Record<string, any>): Promise<{ asked: boolean; action: string; rejectReason?: string }> {
  const ac = new AbortController();
  let asked = false;
  const off = subscribe(runId, (ev) => { if (ev.type === 'approval_request') { asked = true; ac.abort(); } });
  try {
    const d = await gateToolCall(runId, c, { sessionId: 'GS', execMode: 'host', cwd: ws, profile, ...ctx } as any, ac.signal);
    return { asked, action: d.action, rejectReason: d.rejectReason };
  } finally { off(); }
}

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-r3-integ-')));
  process.env.TANGU_HOME = home;
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-r3-integ-ws-')));
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-r3-integ-ud-')));
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile });
  await runMigration();
  const app = express(); app.use(express.json()); app.use(sessionsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  if (prevAmadeus === undefined) delete process.env.FORSION_AMADEUS_CONFIG; else process.env.FORSION_AMADEUS_CONFIG = prevAmadeus;
  for (const d of [home, ws, userData]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('I1 远端 PATCH project_path → 会话盖远程标记', () => {
  it('远端把本机会话的项目路径改到别的目录:路径与标记同时落库(修复前:路径改了、agent_config 原样无标记)', async () => {
    const local = dir('I1-local');
    const elsewhere = dir('I1-elsewhere');
    await addSession('I1a', { agentSlug: 'a1', approvalMode: 'auto-edit' }, local);
    const r = await send('PATCH', '/agent/sessions/I1a', { project_path: elsewhere }, REMOTE_HDR);
    expect(r.status).toBe(200);
    const row = await rowOf('I1a');
    expect(row.path).toBe(elsewhere);
    expect(row.cfg).toEqual({ agentSlug: 'a1', approvalMode: 'auto-edit', remoteOrigin: { via: 'lan', marked: false, at: expect.any(String) } });
    expect(r.body.session.agent_config.remoteOrigin).toMatchObject({ via: 'lan' }); // 响应就是新行:桌面拿到的同一份
  });

  it('没有 agent_config 的老会话同样盖上;已有标记原样保留(不刷新 at、不换 via)', async () => {
    await addSession('I1b', null, dir('I1b-old'));
    expect((await send('PATCH', '/agent/sessions/I1b', { project_path: dir('I1b-new') }, REMOTE_HDR)).status).toBe(200);
    expect((await rowOf('I1b')).cfg).toEqual({ remoteOrigin: { via: 'lan', marked: false, at: expect.any(String) } });

    const first = { via: 'tunnel', marked: true, at: '2026-01-01T00:00:00.000Z' };
    await addSession('I1c', { remoteOrigin: first, thinkingLevel: 'low' }, dir('I1c-old'));
    expect((await send('PATCH', '/agent/sessions/I1c', { project_path: dir('I1c-new') }, REMOTE_HDR)).status).toBe(200);
    expect((await rowOf('I1c')).cfg).toEqual({ remoteOrigin: first, thinkingLevel: 'low' });
  });

  it('正对照:本机改路径、远端只改标题 / 归档、远端写回同一路径、远端清空路径 → 都不盖标记', async () => {
    const p = dir('I1d');
    await addSession('I1d', { agentSlug: 'a1' }, p);
    expect((await send('PATCH', '/agent/sessions/I1d', { project_path: dir('I1d-local-move') })).status).toBe(200);
    expect((await rowOf('I1d')).cfg).toEqual({ agentSlug: 'a1' });
    const moved = (await rowOf('I1d')).path!;
    expect((await send('PATCH', '/agent/sessions/I1d', { title: 'renamed', archived: false }, REMOTE_HDR)).status).toBe(200);
    expect((await send('PATCH', '/agent/sessions/I1d', { project_path: moved }, REMOTE_HDR)).status).toBe(200);
    expect((await send('PATCH', '/agent/sessions/I1d', { project_path: null }, REMOTE_HDR)).status).toBe(200);
    const row = await rowOf('I1d');
    expect(row.cfg).toEqual({ agentSlug: 'a1' });
    expect(row.path).toBeNull();
  });

  it('远端改路径被 C8 拒(400)时什么都不落库', async () => {
    await addSession('I1e', { agentSlug: 'a1' }, dir('I1e'));
    const r = await send('PATCH', '/agent/sessions/I1e', { project_path: home }, REMOTE_HDR);
    expect(r.status).toBe(400);
    expect(await rowOf('I1e')).toEqual({ cfg: { agentSlug: 'a1' }, path: join(ws, 'I1e') });
  });
});

describe('I2 远程污点的派生项目会话带标记', () => {
  it('dispatchProjectSession({remote}) → 会话存值有 remoteOrigin,首个 run 的 agentConfig 没有、input.remote 有(修复前:会话无标记)', async () => {
    const proj = dir('I2-proj');
    const { sessionId, runId } = await dispatchProjectSession({ userId: 'u1', appId: 'tangu', modelId: 'm1', projectPath: proj, message: 'go', remote: REMOTE });
    const row = await rowOf(sessionId);
    expect(row.path).toBe(proj);
    expect(row.cfg).toMatchObject({ execMode: 'host', cwd: proj, remoteOrigin: { via: 'lan', marked: false, at: expect.any(String) } });
    const [run] = await query<any[]>(`SELECT input FROM agent_runs WHERE id = ?`, [runId]);
    const input = json(run.input);
    expect(input.remote).toEqual(REMOTE);
    expect(input.agentConfig.remoteOrigin).toBeUndefined();
  });

  it('正对照:本机派生 → 无标记', async () => {
    const { sessionId } = await dispatchProjectSession({ userId: 'u1', appId: 'tangu', modelId: 'm1', projectPath: dir('I2-local'), message: 'go' });
    expect((await rowOf(sessionId)).cfg.remoteOrigin).toBeUndefined();
  });
});

describe('I3 本机写配置抹不掉已有标记', () => {
  const MARK = { via: 'p2p', marked: true, at: '2026-02-02T00:00:00.000Z' };

  it('本机 PUT 整对象替换(客户端旧缓存不带标记)→ 标记保留,其余键照写(修复前:标记被抹)', async () => {
    await addSession('I3a', { agentSlug: 'a1', remoteOrigin: MARK }, dir('I3a'));
    const r = await send('PUT', '/agent/sessions/I3a/config', { agentSlug: 'a1', thinkingLevel: 'high' });
    expect(r.status).toBe(200);
    expect(r.body.agent_config).toEqual({ agentSlug: 'a1', thinkingLevel: 'high', remoteOrigin: MARK });
    expect((await rowOf('I3a')).cfg).toEqual({ agentSlug: 'a1', thinkingLevel: 'high', remoteOrigin: MARK });
  });

  it('本机 PATCH remoteOrigin:null / 换一个值 → 存值原样', async () => {
    await addSession('I3b', { remoteOrigin: MARK }, dir('I3b'));
    expect((await send('PATCH', '/agent/sessions/I3b/config', { remoteOrigin: null, thinkingLevel: 'low' })).status).toBe(200);
    expect((await rowOf('I3b')).cfg).toEqual({ remoteOrigin: MARK, thinkingLevel: 'low' });
    expect((await send('PATCH', '/agent/sessions/I3b/config', { remoteOrigin: { via: 'lan', marked: false } })).status).toBe(200);
    expect((await rowOf('I3b')).cfg.remoteOrigin).toEqual(MARK);
  });

  it('正对照:本机给无标记会话写配置 → 仍无标记;本机写加标记不拦(只会收紧)', async () => {
    await addSession('I3c', { agentSlug: 'a1' }, dir('I3c'));
    expect((await send('PUT', '/agent/sessions/I3c/config', { agentSlug: 'a1', thinkingLevel: 'high' })).status).toBe(200);
    expect((await rowOf('I3c')).cfg).toEqual({ agentSlug: 'a1', thinkingLevel: 'high' });
    expect((await send('PATCH', '/agent/sessions/I3c/config', { remoteOrigin: MARK })).status).toBe(200);
    expect((await rowOf('I3c')).cfg.remoteOrigin).toEqual(MARK);
  });

  it('远端写配置同样动不了标记(C7 白名单,回归)', async () => {
    await addSession('I3d', { remoteOrigin: MARK }, dir('I3d'));
    expect((await send('PATCH', '/agent/sessions/I3d/config', { remoteOrigin: null, thinkingLevel: 'low' }, REMOTE_HDR)).status).toBe(200);
    expect((await rowOf('I3d')).cfg).toEqual({ remoteOrigin: MARK, thinkingLevel: 'low' });
  });
});

describe('I4 钉桩:桌面本机项目根登记表在 C4 凭据清单里', () => {
  it('<userData>/unit-local-project-roots.json:远程写硬拒、本机写(完全通行)要批、结构化读硬拒', async () => {
    process.env.FORSION_AMADEUS_CONFIG = join(userData, 'amadeus-config.json');
    const registry = join(userData, 'unit-local-project-roots.json');
    writeFileSync(registry, JSON.stringify({ v: 1, seeded: true, roots: [] }));
    try {
      expect(protectedRemoteWrite(registry)).not.toBeNull();
      expect(protectedLocalWrite(registry)).not.toBeNull();
      expect(checkReadPath(registry).ok).toBe(false);
      const w = call('write_file', { path: registry, content: '{"v":1,"seeded":true,"roots":["/"]}' });
      const remote = await gate('I4r', w, { approvalMode: 'full-auto', remote: REMOTE });
      expect(remote.action).toBe('reject');
      expect(remote.asked).toBe(false);
      expect(remote.rejectReason).toMatch(/Remote sessions cannot write protected/);
      const local = await gate('I4l', w, { approvalMode: 'full-auto' });
      expect(local.asked).toBe(true);
    } finally {
      delete process.env.FORSION_AMADEUS_CONFIG;
    }
  });
});
