/**
 * 设备能力 MCP 方案 P0 ④ 评审跟进 · 路由这一层(契约 C7 / C8 / C9 + 工作区 realpath 钳制)。真 express + 真路由 + 内存 SQLite,
 * agentLoop 换桩(run 只落库不执行)。只引修复前就存在的出口 —— 整份文件能拷到修复前的提交(9c0f7f79)上跑,负对照都是断言失败。
 *
 *   C8  远程 POST /agent/runs 的 cwd、POST /agent/sessions 的 project_path / agent_config.cwd、PATCH /agent/sessions/:id 的 project_path:
 *       根 / 家目录(含软链过去的)/ 受保护目录的祖先 → 400 REMOTE_CWD_FORBIDDEN;本机请求照旧。
 *   C7  远程建会话 / 写会话配置只收白名单键(muse / systemPrompt / activityAccess / execMode … 不落库)。
 *   C9  远端答审批:approve_always 按 approve 算(本机 run 也一样 —— 看的是答复从哪来);argsOverride 在审批 / 询问 / 异步审批三处都 400。
 *  A#7 工作区 read / download / list / upload / delete(本地会话目录回退):软链逃逸一律拒。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';

const state = vi.hoisted(() => {
  // sessionSandbox 的 BASE_DIR 在模块加载时定:必须早于 import(工作区路由的本地会话目录落这里)。
  process.env.AGENT_SANDBOX_SESSION_DIR = `${process.env.TMPDIR || '/tmp'}/tangu-fu-routes-sessions-${process.pid}`;
  return { publish: vi.fn(async (..._a: any[]) => 1) };
});
vi.mock('../src/services/agentLoop.js', () => ({
  enqueueRun: vi.fn(), abortRun: vi.fn(), enqueueSteer: vi.fn(() => true), expediteSteer: vi.fn(() => true), cancelSteer: vi.fn(() => true),
  waitForRunSettlement: vi.fn(async () => true), sessionHasActiveRun: vi.fn(() => false),
}));
vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: state.publish }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));

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
import approvalsRouter from '../src/routes/approvals.js';
import workspaceRouter from '../src/routes/workspace.js';
import { gateToolCall, isAlwaysAllowed } from '../src/services/approvals.js';
import { getSessionDir } from '../src/sandbox/sessionSandbox.js';
import type { ToolCall } from '../src/core/types.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
let srv: Server;
let base: string;
let home: string;
let proj: string;
const HOME = homedir();
const REMOTE = { 'x-forsion-remote': 'tunnel' };
const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const json = (v: any): any => (typeof v === 'string' ? JSON.parse(v) : v);
const cfgOf = async (id: string): Promise<any> => json((await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [id]))[0].agent_config);
const addSession = (id: string, cfg: unknown) => query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES (?, 'u1', 'tangu', 't', 'm1', 'user', 1, ?)`, [id, JSON.stringify(cfg)]);
const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-fu-routes-'));
  process.env.TANGU_HOME = home;
  proj = mkdtempSync(join(tmpdir(), 'tangu-fu-routes-proj-'));
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile });
  await runMigration();
  const app = express(); app.use(express.json());
  app.use(runsRouter); app.use(sessionsRouter); app.use(specialRouter); app.use(approvalsRouter); app.use(workspaceRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  for (const d of [home, proj, process.env.AGENT_SANDBOX_SESSION_DIR!]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('C8 远程 cwd / project_path', () => {
  it('POST /agent/runs:cwd 是家目录 / 根 / 家目录的祖先 / 软链到家目录 / 受保护目录的祖先 → 400(负对照:本机同 cwd 照起;正常项目照起)', async () => {
    const linkHome = join(proj, 'home-link');
    symlinkSync(HOME, linkHome);
    for (const cwd of [HOME, '/', dirname(HOME), linkHome, dirname(home)]) {
      const r = await send('POST', '/agent/runs', { session_id: `C8R-${cwd.length}`, model_id: 'm1', message: 'hi', agent_config: { execMode: 'host', cwd } }, REMOTE);
      expect(r.status, cwd).toBe(400);
      expect(r.body.code).toBe('REMOTE_CWD_FORBIDDEN');
    }
    expect((await send('POST', '/agent/runs', { session_id: 'C8R-local', model_id: 'm1', message: 'hi', agent_config: { execMode: 'host', cwd: HOME } })).status).toBe(200);
    expect((await send('POST', '/agent/runs', { session_id: 'C8R-ok', model_id: 'm1', message: 'hi', agent_config: { execMode: 'host', cwd: proj } }, REMOTE)).status).toBe(200);
  });

  it('POST /agent/sessions:project_path / agent_config.cwd 同样拒;PATCH /agent/sessions/:id 改 project_path 同样拒(负对照:本机照改)', async () => {
    expect((await send('POST', '/agent/sessions', { title: 'x', project_path: HOME }, REMOTE)).body?.code).toBe('REMOTE_CWD_FORBIDDEN');
    expect((await send('POST', '/agent/sessions', { title: 'x', agent_config: { execMode: 'host', cwd: '/' } }, REMOTE)).body?.code).toBe('REMOTE_CWD_FORBIDDEN');
    expect((await send('POST', '/agent/sessions', { title: 'x', project_path: proj }, REMOTE)).status).toBe(200);
    await addSession('C8P', {});
    const r = await send('PATCH', '/agent/sessions/C8P', { project_path: HOME }, REMOTE);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REMOTE_CWD_FORBIDDEN');
    expect((await query<any[]>(`SELECT project_path FROM chat_sessions WHERE id = 'C8P'`))[0].project_path).toBeNull();
    expect((await send('PATCH', '/agent/sessions/C8P', { project_path: HOME })).status).toBe(200);
  });
});

describe('C7 会话配置远程写 = 白名单', () => {
  it('远程建会话:初始配置只留白名单键 + 远程标记(角色键 / 人格 / execMode 都不落库);负对照:本机原样', async () => {
    const hostile = { execMode: 'host', approvalMode: 'full-auto', thinkingLevel: 'low', agentSlug: 'bo', muse: true, activityAccess: true, systemPrompt: 'evil', toolsMode: 'allow', toolsList: ['run_bash'], verifyCommand: 'echo pwned' };
    const r = await send('POST', '/agent/sessions', { title: 'x', agent_config: hostile }, REMOTE);
    const cfg = r.body.session.agent_config;
    expect(cfg).toMatchObject({ approvalMode: 'auto-edit', thinkingLevel: 'low', agentSlug: 'bo', remoteOrigin: { via: 'tunnel' } });
    for (const k of ['execMode', 'muse', 'activityAccess', 'systemPrompt', 'toolsMode', 'toolsList', 'verifyCommand']) expect(cfg[k], k).toBeUndefined();
    const l = await send('POST', '/agent/sessions', { title: 'x', agent_config: hostile });
    expect(l.body.session.agent_config).toEqual(hostile);
  });

  it('PATCH config:muse / systemPrompt / activityAccess / cwd 设不上;agentSlug / thinkingLevel 照写(负对照:本机照改)', async () => {
    await addSession('C7P', { cwd: '/p', systemPrompt: 'mine' });
    expect((await send('PATCH', '/agent/sessions/C7P/config', { muse: true, systemPrompt: 'evil', activityAccess: true, cwd: '/', agentSlug: 'bo', thinkingLevel: 'high' }, REMOTE)).status).toBe(200);
    expect(await cfgOf('C7P')).toEqual({ cwd: '/p', systemPrompt: 'mine', agentSlug: 'bo', thinkingLevel: 'high' });
    await send('PATCH', '/agent/sessions/C7P/config', { muse: true });
    expect((await cfgOf('C7P')).muse).toBe(true);
  });
});

describe('C9 远端答审批', () => {
  async function pending(runId: string, sessionId: string): Promise<{ id: string; p: Promise<any> }> {
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES (?, ?, 'u1', 'running', '{}')`, [runId, sessionId]);
    const p = gateToolCall(runId, call('run_bash', { command: 'touch x' }), { sessionId, execMode: 'host', cwd: proj, approvalMode: 'auto-edit', profile } as any);
    await vi.waitFor(() => expect(state.publish.mock.calls.some((c: any[]) => c[0] === runId && c[1] === 'approval_request')).toBe(true));
    return { id: state.publish.mock.calls.find((c: any[]) => c[0] === runId && c[1] === 'approval_request')![2].approvalId, p };
  }

  it('本机 run 的审批被远端点「总允许」:按单次批准,不落会话的总允许(负对照:本机点照落)', async () => {
    const a = await pending('C9-remote', 'C9S1');
    expect((await send('POST', `/agent/runs/C9-remote/approvals/${a.id}`, { action: 'approve_always' }, REMOTE)).status).toBe(200);
    expect((await a.p).action).toBe('approve');
    expect(isAlwaysAllowed('C9S1', 'run_bash')).toBe(false);
    const b = await pending('C9-local', 'C9S2');
    expect((await send('POST', `/agent/runs/C9-local/approvals/${b.id}`, { action: 'approve_always' })).status).toBe(200);
    await b.p;
    expect(isAlwaysAllowed('C9S2', 'run_bash')).toBe(true);
  });

  it('远端带 argsOverride:审批 / 询问 / 异步审批三处都 400,审批仍在等(负对照:本机改参照收)', async () => {
    const a = await pending('C9-args', 'C9S3');
    const r = await send('POST', `/agent/runs/C9-args/approvals/${a.id}`, { action: 'approve', argsOverride: { command: 'rm -rf ~' } }, REMOTE);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REMOTE_ARGS_OVERRIDE_FORBIDDEN');
    // 还在等:本机照常能答(且本机改参照收)
    expect((await send('POST', `/agent/runs/C9-args/approvals/${a.id}`, { action: 'approve', argsOverride: { command: 'touch y' } })).status).toBe(200);
    expect((await a.p).action).toBe('approve');
    const q = await send('POST', '/agent/runs/C9-args/inquiries/inq_x', { answer: 'ok', argsOverride: {} }, REMOTE);
    expect(q.status).toBe(400);
    expect(q.body.code).toBe('REMOTE_ARGS_OVERRIDE_FORBIDDEN');
    for (const act of ['approve', 'reject']) {
      const s = await send('POST', `/agent/special/approvals/pa-x/${act}`, { argsOverride: { command: 'x' } }, REMOTE);
      expect(s.status, act).toBe(400);
      expect(s.body.code).toBe('REMOTE_ARGS_OVERRIDE_FORBIDDEN');
    }
  });
});

describe('工作区路由:真实路径钳在会话工作区内(软链逃逸)', () => {
  it('read / download / list / upload / delete 都不跟软链出工作区(负对照:工作区里的普通文件照常)', async () => {
    const sid = 'WS1';
    const dir = await getSessionDir({ userId: 'u1', appId: 'tangu', sessionId: sid, wsProject: null } as any);
    mkdirSync(dir, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'tangu-fu-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
    writeFileSync(join(outside, 'victim.txt'), 'keep me');
    writeFileSync(join(dir, 'ok.txt'), 'inside');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'evil.txt'));
    symlinkSync(outside, join(dir, 'link'));
    try {
      const ok = await send('GET', `/agent/workspace/read?sessionId=${sid}&path=ok.txt`, null);
      expect(ok.status).toBe(200);
      expect(Buffer.from(ok.body.content, 'base64').toString()).toBe('inside');
      expect((await send('GET', `/agent/workspace/read?sessionId=${sid}&path=evil.txt`, null)).status).toBe(404);
      expect((await send('GET', `/agent/workspace/read?sessionId=${sid}&path=link/secret.txt`, null)).status).toBe(404);
      const dl = await fetch(`${base}/agent/workspace/download?sessionId=${sid}&path=evil.txt`, { headers: { Authorization: 'Bearer x' } });
      expect(dl.status).toBe(404);
      const list = await send('GET', `/agent/workspace/list?sessionId=${sid}`, null);
      const paths = list.body.files.map((f: any) => f.path);
      expect(paths).toContain('/ok.txt');
      expect(paths).not.toContain('/evil.txt');
      const up = await send('POST', '/agent/workspace/upload', { sessionId: sid, files: [{ path: 'link/pwned.txt', content: 'x' }, { path: 'evil.txt', content: 'overwrite' }, { path: 'new/a.txt', content: 'fine' }] });
      expect(up.body.saved).toBe(1);
      expect(existsSync(join(outside, 'pwned.txt'))).toBe(false);
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('OUTSIDE-SECRET');
      expect(existsSync(join(dir, 'new', 'a.txt'))).toBe(true);
      // 悬空软链(目标还不存在):上传不许跟着它在工作区外建文件(Codex 评审 09-27 跟进轮)
      symlinkSync(join(outside, 'created-via-dangle.txt'), join(dir, 'dangle.txt'));
      const up2 = await send('POST', '/agent/workspace/upload', { sessionId: sid, files: [{ path: 'dangle.txt', content: 'x' }] });
      expect(up2.body.saved).toBe(0);
      expect(existsSync(join(outside, 'created-via-dangle.txt'))).toBe(false);
      const del = await send('POST', '/agent/workspace/delete', { sessionId: sid, path: 'link/victim.txt' });
      expect(del.body.ok).toBe(false);
      expect(existsSync(join(outside, 'victim.txt'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
