/**
 * 受保护审批只在本机批准 + 「谁答的」(P1 · K3 §3.2 / §3.3,方案 §6.3、§6.1「收起」)。
 * 真 express + 真路由(approvals / special)+ 真审批闸(gateToolCall 写 TANGU_HOME/config.json → reason.kind='protected')+ 内存 SQLite;
 * 只把事件总线的 publish 与 PermissionRequest hook 换成桩。
 *   S1 远端(x-forsion-remote)批准 / 总允许受保护项 → 403 APPROVAL_LOCAL_ONLY 且仍在等;远端拒绝 → 200;本机批准 → 200;
 *      special 排队的受保护项远端批准 → 403、行仍 pending(不执行);远端拒绝 → 200。
 *   S3 先答先得不变:A 端答后 B 端 410;approval_result.by = A 的来源(local / tunnel + 已验证调用方)。
 *   S4 远端「总允许」仍降单次、改参仍 400(既有测试之外再钉一次与 403 的先后)。
 * 负对照(实跑见红,记在 K3 交付报告):去掉 routes/approvals.ts 的 approvalLocalOnly 判断 → S1 远端批准 200;去掉 special.ts 的判断 → 行被执行。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ publish: vi.fn(async (..._a: any[]) => 1) }));
vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: state.publish }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));
vi.mock('../src/core/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/config.js')>()),
  getRawSection: () => undefined,
}));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import approvalsRouter from '../src/routes/approvals.js';
import specialRouter from '../src/routes/special.js';
import { approvalLocalOnly, gateToolCall } from '../src/services/approvals.js';
import { requestInquiry } from '../src/services/inquiries.js';
import type { ToolCall } from '../src/core/types.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const MARK = 'k3-local-only-mark-secret';
const UNIT = '6c1d7a4e-2b3f-4a5c-8d9e-0f1a2b3c4d5e';
const REMOTE = { 'x-forsion-remote': 'tunnel' };
const callerHdr = Buffer.from(JSON.stringify({ u: UNIT, k: 'phone', n: 'Pixel 9', p: 'android', r: null }), 'utf8').toString('base64url');
const VERIFIED = { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-mark': MARK, 'x-forsion-remote-caller': callerHdr };

let srv: Server;
let base: string;
let home: string;
let ws: string;
let seq = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;
const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const payloadsOf = (runId: string, type: string): any[] => state.publish.mock.calls.filter((c: any[]) => c[0] === runId && c[1] === type).map((c: any[]) => c[2]);
const settled = async (p: Promise<unknown>): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 80))]);

/** 起一条真审批:runId 落库(路由的 getRunForUser 要它),protected=true → 写 TANGU_HOME/config.json(受保护),否则 run_bash。 */
async function ask(protectedWrite: boolean): Promise<{ runId: string; approvalId: string; decided: Promise<any>; request: any }> {
  const runId = `R-lo-${++seq}`;
  await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES (?, ?, 'u1', 'running', '{}')`, [runId, `S-lo-${seq}`]);
  const c = protectedWrite ? call('write_file', { path: join(home, 'config.json'), content: '{}' }) : call('run_bash', { command: 'npm test && npm run build' });
  const decided = gateToolCall(runId, c, { sessionId: `S-lo-${seq}`, execMode: 'host', cwd: ws, approvalMode: 'auto-edit', profile } as any);
  await vi.waitFor(() => expect(payloadsOf(runId, 'approval_request')).toHaveLength(1));
  const request = payloadsOf(runId, 'approval_request')[0];
  return { runId, approvalId: request.approvalId, decided, request };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-k3-lo-'));
  ws = mkdtempSync(join(tmpdir(), 'tangu-k3-lo-ws-'));
  process.env.TANGU_HOME = home;
  process.env.TANGU_REMOTE_MARK_SECRET = MARK;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile });
  await runMigration();
  const app = express();
  app.use(express.json());
  app.use(approvalsRouter);
  app.use(specialRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  delete process.env.TANGU_REMOTE_MARK_SECRET;
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});
beforeEach(() => { state.publish.mockClear(); });

describe('S1 受保护审批只在本机批准', () => {
  it('approval_request 带 localOnly:true(且 reason.kind=protected);普通审批不带', async () => {
    const p = await ask(true);
    expect(p.request).toMatchObject({ localOnly: true, reason: { kind: 'protected' } });
    const n = await ask(false);
    expect(n.request.localOnly).toBeUndefined();
    await post(`/agent/runs/${p.runId}/approvals/${p.approvalId}`, { action: 'reject' });
    await post(`/agent/runs/${n.runId}/approvals/${n.approvalId}`, { action: 'reject' });
    await Promise.all([p.decided, n.decided]);
  });

  it('远端批准 / 总允许 → 403 APPROVAL_LOCAL_ONLY,仍在等;本机批准 → 200 且 by=local', async () => {
    const a = await ask(true);
    for (const action of ['approve', 'approve_always'] as const) {
      const r = await post(`/agent/runs/${a.runId}/approvals/${a.approvalId}`, { action }, VERIFIED);
      expect(r.status, action).toBe(403);
      expect(r.body).toMatchObject({ code: 'APPROVAL_LOCAL_ONLY' });
      expect(r.body.detail).toMatch(/only be approved on the computer running it/);
    }
    expect(await settled(a.decided)).toBe(false);
    expect(approvalLocalOnly(a.approvalId, a.runId)).toBe(true);
    expect(payloadsOf(a.runId, 'approval_result')).toEqual([]);
    const ok = await post(`/agent/runs/${a.runId}/approvals/${a.approvalId}`, { action: 'approve' });
    expect(ok.status).toBe(200);
    await expect(a.decided).resolves.toMatchObject({ action: 'approve' });
    expect(payloadsOf(a.runId, 'approval_result')).toEqual([{ approvalId: a.approvalId, action: 'approve', by: { via: 'local' } }]);
    expect(approvalLocalOnly(a.approvalId, a.runId)).toBeNull();
  });

  it('远端拒绝受保护项 → 200(拒绝永远可以)', async () => {
    const a = await ask(true);
    const r = await post(`/agent/runs/${a.runId}/approvals/${a.approvalId}`, { action: 'reject' }, REMOTE);
    expect(r.status).toBe(200);
    await expect(a.decided).resolves.toMatchObject({ action: 'reject' });
    expect(payloadsOf(a.runId, 'approval_result')[0].by).toEqual({ via: 'tunnel' });
  });

  it('不属于 URL 里这条 run → 410(与「不在等」同口径,不因 403 泄露存在性);远端改参仍 400(先于 403)', async () => {
    const a = await ask(true);
    expect((await post(`/agent/runs/R-other/approvals/${a.approvalId}`, { action: 'approve' }, REMOTE)).status).toBe(404); // run 不存在
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('R-lo-other', 'S-x', 'u1', 'running', '{}')`);
    expect((await post(`/agent/runs/R-lo-other/approvals/${a.approvalId}`, { action: 'approve' }, REMOTE)).status).toBe(410);
    const edit = await post(`/agent/runs/${a.runId}/approvals/${a.approvalId}`, { action: 'approve', argsOverride: { path: '/tmp/x' } }, REMOTE);
    expect(edit.status).toBe(400);
    await post(`/agent/runs/${a.runId}/approvals/${a.approvalId}`, { action: 'reject' });
    await a.decided;
  });

  it('special 排队的受保护项:远端批准 → 403 且行仍 pending(没执行);远端拒绝 → 200', async () => {
    const ins = (id: string, reason: string | null) => query(
      `INSERT INTO pending_approvals (id, user_id, session_id, run_id, agent_slug, tool, args, preview, reason, cwd, status)
       VALUES (?, 'u1', 'S-q', NULL, 'muse', 'write_file', ?, 'write config', ?, ?, 'pending')`,
      [id, JSON.stringify({ path: join(home, 'config.json'), content: '{"pwned":true}' }), reason, ws],
    );
    await ins('pa-prot', JSON.stringify({ kind: 'protected', mode: 'auto-edit' }));
    const r = await post('/agent/special/approvals/pa-prot/approve', {}, REMOTE);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'APPROVAL_LOCAL_ONLY' });
    const row = await query<any[]>(`SELECT status FROM pending_approvals WHERE id = 'pa-prot'`);
    expect(row[0].status).toBe('pending');
    const rej = await post('/agent/special/approvals/pa-prot/reject', {}, REMOTE);
    expect(rej.status).toBe(200);
    expect((await query<any[]>(`SELECT status FROM pending_approvals WHERE id = 'pa-prot'`))[0].status).toBe('rejected');
  });
});

describe('S3 先答先得 + 谁答的', () => {
  it('远端(已验证调用方)先批 → B 端 410;approval_result.by 带 via / callerUnit / callerName', async () => {
    const a = await ask(false);
    const r = await post(`/agent/runs/${a.runId}/approvals/${a.approvalId}`, { action: 'approve_always' }, VERIFIED);
    expect(r.status).toBe(200);
    await expect(a.decided).resolves.toMatchObject({ action: 'approve' });
    expect((await post(`/agent/runs/${a.runId}/approvals/${a.approvalId}`, { action: 'reject' })).status).toBe(410);
    // S4:远端「总允许」按单次批准兑现(action 广播为 approve)
    expect(payloadsOf(a.runId, 'approval_result')).toEqual([{ approvalId: a.approvalId, action: 'approve', by: { via: 'tunnel', callerUnit: UNIT, callerName: 'Pixel 9' } }]);
  });

  it('未盖章的隧道头(本机进程自己加的)→ by 只有 via,不带调用方', async () => {
    const a = await ask(false);
    await post(`/agent/runs/${a.runId}/approvals/${a.approvalId}`, { action: 'approve' }, { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-caller': callerHdr });
    await a.decided;
    expect(payloadsOf(a.runId, 'approval_result')[0].by).toEqual({ via: 'tunnel' });
  });

  it('询问:inquiry_result.by 同口径(本机 = local;来路不在契约内 = remote)', async () => {
    const runId = `R-lo-${++seq}`;
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES (?, 'S-i', 'u1', 'running', '{}')`, [runId]);
    const q1 = requestInquiry(runId, { question: '?', options: [], allowFreeText: true });
    const q2 = requestInquiry(runId, { question: '?', options: [], allowFreeText: true });
    const [i1, i2] = payloadsOf(runId, 'inquiry_request').map((p) => p.inquiryId);
    expect((await post(`/agent/runs/${runId}/inquiries/${i1}`, { answer: 'A' })).status).toBe(200);
    expect((await post(`/agent/runs/${runId}/inquiries/${i2}`, { answer: 'B' }, { 'x-forsion-remote': 'weird' })).status).toBe(200);
    await Promise.all([q1, q2]);
    expect(payloadsOf(runId, 'inquiry_result').map((p) => p.by)).toEqual([{ via: 'local' }, { via: 'remote' }]);
  });
});
