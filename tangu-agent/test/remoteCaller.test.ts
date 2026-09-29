/**
 * 设备能力 MCP 方案 P1 · K1(引擎半边)· 调用方设备:x-forsion-remote-caller → input.remote.callerUnit/callerKind/callerName。
 *   S9  只在 marked && via==='tunnel' 时认调用方:无章 / 错章 / via=lan|p2p 带合法编码的调用方头 → 缺席;合法 → 三字段齐。
 *   S10 请求体 / 会话存值里的同名字段不作数:只认头;remoteOf 丢多余键、按同一规则重建。
 *   路由:POST /agent/runs 带三头 → 落库 input.remote.callerUnit;POST /agent/sessions 的 remoteOrigin 标记带调用方;
 *        steer 染色先到先得(本机 run 被手机 steer 后,callerUnit = 第一个远端染色者)。
 * 负对照:改前 parseRemoteOrigin 不读该头 → S9 合法腿红(实跑记录见 K1 交付报告)。
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
import {
  parseRemoteOrigin, remoteOf, remoteOriginMarker, remoteCallerUnit, remoteApprovalPayload, taintRunRemote, clearRunRemoteTaint, effectiveRemote,
} from '../src/services/remoteOrigin.js';

const MARK = 'boot-mark-secret';
const UNIT = '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f';
const OTHER = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const enc = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const CALLER = enc({ u: UNIT, k: 'phone', n: '小米 14', p: 'android', r: '2026-09-28T01:02:03.000Z' });
const TUNNEL = { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-mark': MARK, 'x-forsion-remote-caller': CALLER };
const WANT = { via: 'tunnel', marked: true, callerUnit: UNIT, callerKind: 'phone', callerName: '小米 14' };

let srv: Server;
let base: string;
let home: string;
const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const json = (v: any): any => (typeof v === 'string' ? JSON.parse(v) : v);
const runInput = async (runId: string): Promise<any> => json((await query<any[]>(`SELECT input FROM agent_runs WHERE id = ?`, [runId]))[0].input);

beforeAll(async () => {
  process.env.TANGU_REMOTE_MARK_SECRET = MARK;
  home = mkdtempSync(join(tmpdir(), 'tangu-remote-caller-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express(); app.use(express.json()); app.use(runsRouter); app.use(sessionsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  delete process.env.TANGU_REMOTE_MARK_SECRET;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('S9 头解析:只在盖了章的隧道来路认调用方', () => {
  it('合法:三字段齐(名字是中文也不丢);unit 统一小写', () => {
    expect(parseRemoteOrigin(TUNNEL)).toEqual(WANT);
    expect(parseRemoteOrigin({ ...TUNNEL, 'x-forsion-remote-caller': enc({ u: UNIT.toUpperCase(), k: 'desktop', n: 'Mac' }) }))
      .toEqual({ via: 'tunnel', marked: true, callerUnit: UNIT, callerKind: 'desktop', callerName: 'Mac' });
  });

  it('无章 / 错章 / via=lan|p2p / 值不在契约内 → 调用方缺席(本机进程自己加头,永远拿不到 callerUnit)', () => {
    expect(parseRemoteOrigin({ 'x-forsion-remote': 'tunnel', 'x-forsion-remote-caller': CALLER })).toEqual({ via: 'tunnel', marked: false });
    expect(parseRemoteOrigin({ ...TUNNEL, 'x-forsion-remote-mark': 'wrong' })).toEqual({ via: 'tunnel', marked: false });
    expect(parseRemoteOrigin({ ...TUNNEL, 'x-forsion-remote': 'lan' })).toEqual({ via: 'lan', marked: true });
    expect(parseRemoteOrigin({ ...TUNNEL, 'x-forsion-remote': 'p2p' })).toEqual({ via: 'p2p', marked: true });
    expect(parseRemoteOrigin({ ...TUNNEL, 'x-forsion-remote': 'bogus' })).toEqual({ marked: true });
  });

  it('畸形调用方头只丢调用方、不报错:非 uuid / 未知 kind / 非 JSON / 非 b64url / 数组 → 远程照旧、callerUnit 缺席;名字剥控制符截 120', () => {
    const base = { via: 'tunnel', marked: true };
    for (const bad of [enc({ u: 'nope', k: 'phone', n: 'x' }), enc({ u: UNIT, k: 'server', n: 'x' }), enc({ u: UNIT }), enc([UNIT]), 'not json!', enc('str'), Buffer.from('{').toString('base64url'), 'x'.repeat(5000)]) {
      expect(parseRemoteOrigin({ ...TUNNEL, 'x-forsion-remote-caller': bad })).toEqual(base);
    }
    const r = parseRemoteOrigin({ ...TUNNEL, 'x-forsion-remote-caller': enc({ u: UNIT, k: 'phone', n: `Pix\u0000el‮​ ${'y'.repeat(300)}` }) })!;
    expect(r.callerName!.startsWith('Pixel ')).toBe(true);
    expect(r.callerName!.length).toBe(120);
    expect(parseRemoteOrigin({ ...TUNNEL, 'x-forsion-remote-caller': enc({ u: UNIT, k: 'phone', n: 42 }) })).toEqual({ via: 'tunnel', marked: true, callerUnit: UNIT, callerKind: 'phone' });
  });
});

describe('S10 持久化重建 / 标记 / 取用', () => {
  it('remoteOf 按同一规则重建:多余键丢;非隧道 / 无章时调用方丢;unit 或 kind 不合法则三者都丢', () => {
    expect(remoteOf({ remote: { ...WANT, evil: 1, marked: true } })).toEqual(WANT);
    expect(remoteOf({ remote: { ...WANT, via: 'lan' } })).toEqual({ via: 'lan', marked: true });
    expect(remoteOf({ remote: { ...WANT, marked: false } })).toEqual({ via: 'tunnel', marked: false });
    expect(remoteOf({ remote: { ...WANT, callerUnit: 'nope' } })).toEqual({ via: 'tunnel', marked: true });
    expect(remoteOf({ remote: { ...WANT, callerKind: undefined } })).toEqual({ via: 'tunnel', marked: true });
    expect(remoteOf({ remote: { via: 'tunnel', marked: true } })).toEqual({ via: 'tunnel', marked: true });
  });

  it('remoteOriginMarker 带调用方;remoteCallerUnit 取有效污点(起跑的或 steer 染上的);审批载荷不带 marked', () => {
    expect(remoteOriginMarker(WANT as any)).toEqual({ ...WANT, at: expect.any(String) });
    expect(remoteOriginMarker({ via: 'lan', marked: false })).toEqual({ via: 'lan', marked: false, at: expect.any(String) });
    expect(remoteCallerUnit({ remote: WANT as any })).toBe(UNIT);
    expect(remoteCallerUnit({ remote: { via: 'tunnel', marked: true } })).toBeUndefined();
    expect(remoteCallerUnit(undefined)).toBeUndefined();
    expect(remoteApprovalPayload(WANT as any)).toEqual({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: '小米 14' });
    expect(remoteApprovalPayload({ marked: false })).toEqual({});
  });

  it('steer 染色先到先得:第一个远端染色者是 callerUnit,之后别的设备 steer 不改', () => {
    taintRunRemote('R-first', WANT as any);
    taintRunRemote('R-first', { via: 'tunnel', marked: true, callerUnit: OTHER, callerKind: 'phone', callerName: 'Other' });
    expect(remoteCallerUnit({ runId: 'R-first' })).toBe(UNIT);
    expect(effectiveRemote({ runId: 'R-first' })?.callerName).toBe('小米 14');
    clearRunRemoteTaint('R-first');
    expect(remoteCallerUnit({ runId: 'R-first' })).toBeUndefined();
  });
});

describe('路由', () => {
  it('POST /agent/runs 带三头 → 落库 input.remote 带调用方;请求体 / agent_config 里自称的调用方不作数(负对照:无调用方头的隧道 run 没有 callerUnit)', async () => {
    const r = await send('POST', '/agent/runs', { session_id: 'RC1', model_id: 'm1', message: 'hi', agent_config: {} }, TUNNEL);
    expect(r.status).toBe(200);
    expect((await runInput(r.body.runId)).remote).toEqual(WANT);
    const spoof = { callerUnit: OTHER, callerKind: 'phone', callerName: 'Spoofed' };
    const s = await send('POST', '/agent/runs', { session_id: 'RC2', model_id: 'm1', message: 'hi', remote: { via: 'tunnel', marked: true, ...spoof }, agent_config: { remote: spoof, remoteOrigin: spoof } }, { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-mark': MARK });
    const input = await runInput(s.body.runId);
    expect(input.remote).toEqual({ via: 'tunnel', marked: true });
    expect(input.agentConfig.remoteOrigin).toBeUndefined();
    const local = await send('POST', '/agent/runs', { session_id: 'RC3', model_id: 'm1', message: 'hi', remote: { via: 'tunnel', marked: true, ...spoof } });
    expect((await runInput(local.body.runId)).remote).toBeUndefined();
  });

  it('POST /agent/sessions:远程建的会话 remoteOrigin 带调用方;会话存值里的调用方不会变成 run 的调用方', async () => {
    const r = await send('POST', '/agent/sessions', { title: 'x', agent_config: {} }, TUNNEL);
    expect(r.body.session.agent_config.remoteOrigin).toEqual({ ...WANT, at: expect.any(String) });
    const id = r.body.session.id;
    // 本机接着在这个会话里起 run:会话存值带着调用方,但 run 没有污点(只认头)
    const l = await send('POST', '/agent/runs', { session_id: id, model_id: 'm1', message: 'hi', agent_config: r.body.session.agent_config });
    expect((await runInput(l.body.runId)).remote).toBeUndefined();
  });

  it('远端 steer 本机在飞 run:染色带调用方,之后别的设备再 steer 不改', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES ('RCS', 'u1', 'tangu', 't', 'm1', 'user', 1, '{}')`);
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('rc-steer', 'RCS', 'u1', 'running', '{}')`);
    expect((await send('POST', '/agent/runs/rc-steer/steer', { message: 'from phone' }, TUNNEL)).status).toBe(200);
    expect((await send('POST', '/agent/runs/rc-steer/steer', { message: 'from another' }, { ...TUNNEL, 'x-forsion-remote-caller': enc({ u: OTHER, k: 'desktop', n: 'Other' }) })).status).toBe(200);
    expect(remoteCallerUnit({ runId: 'rc-steer' })).toBe(UNIT);
    clearRunRemoteTaint('rc-steer');
  });
});
