/**
 * Muse 面板「叫醒」与「最近几轮」两条路由(2026-11-08,Muse Space 右栏方案 B 里不等主区模板就能先上的两件)。
 * 真 express + 真 special 路由 + 真 SQLite(内存)+ 临时 TANGU_HOME。
 *   GET  /agent/special/muse/rounds:只列 Muse 后台周期(input.background === 'muse'),新 → 旧;怎么醒的读 input.museTrigger
 *        (升级前的轮次没有 → null);待办数按这一轮(同会话、开始到收尾后 60 秒内落的);手聊再多也挤不掉后台轮次;在跑的没有 endedAt;不串别的用户;远程来源 403。
 *   POST /agent/special/muse/wake:Muse 关着 409;开着 → status.wakePending = true(supervisor 没起时 202,请求留着);远程来源 403。
 * 巡检怎么处理这笔请求(清休眠、不看运行时段、额度照守)在 src/services/muse.manualWake.test.ts;模型那半走 live `--only musewakenow`。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/museWakeRounds.test.ts
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import specialRouter from '../src/routes/special.js';
import { saveSpecialAgentsConfig } from '../src/services/specialAgentsConfig.js';

let server: Server;
let base: string;
let home: string;
let db: ReturnType<typeof createSqliteHost>['db'];
const prevHome = process.env.TANGU_HOME;
const prevUser = process.env.TANGU_USER_ID;
const REMOTE = { 'x-forsion-remote': 'tunnel' };
const call = async (method: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${p}`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? '{}' : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const cycleInput = (trigger?: string): string => JSON.stringify({ message: 'm', background: 'muse', ...(trigger ? { museTrigger: trigger } : {}) });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-muse-wake-'));
  process.env.TANGU_HOME = home;
  process.env.TANGU_USER_ID = 'u1';
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db = local.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host: local.host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: {} as any, brain: {} as any });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, kind, created_at) VALUES
    ('m1', 'u1', 'tangu', 'Muse', 'muse', '2026-11-08 08:00:00'),
    ('m2', 'u1', 'tangu', 'Muse', 'muse', '2026-11-08 09:00:00'),
    ('m3', 'u1', 'tangu', 'Muse', 'muse', '2026-11-08 10:00:00'),
    ('m4', 'u1', 'tangu', 'Muse', 'muse', '2026-11-08 11:00:00'),
    ('mx', 'u2', 'tangu', 'Muse', 'muse', '2026-11-08 11:30:00')`);
  // m1:升级前的周期(input 里没有 museTrigger);m2:规则叫醒、失败;m3 里有一条手聊进来的 run(不是后台周期,不算);m4:用户叫醒、还在跑;r1 的 input 里有 background 但没 museTrigger
  await query(`INSERT INTO agent_runs (id, session_id, user_id, status, error, input, created_at, updated_at) VALUES
    ('r1', 'm1', 'u1', 'done', NULL, ?, '2026-11-08 08:00:00', '2026-11-08 08:01:30'),
    ('r2', 'm2', 'u1', 'failed', 'upstream 529', ?, '2026-11-08 09:00:00', '2026-11-08 09:00:20'),
    ('r3', 'm3', 'u1', 'done', NULL, ?, '2026-11-08 10:00:00', '2026-11-08 10:02:00'),
    ('r3chat', 'm3', 'u1', 'done', NULL, ?, '2026-11-08 10:30:00', '2026-11-08 10:31:00'),
    ('r4', 'm4', 'u1', 'running', NULL, ?, '2026-11-08 11:00:00', '2026-11-08 11:00:05'),
    ('rx', 'mx', 'u2', 'done', NULL, ?, '2026-11-08 11:30:00', '2026-11-08 11:31:00')`,
  [cycleInput(), cycleInput('rule:t1'), cycleInput('heartbeat'), JSON.stringify({ message: 'hi' }), cycleInput('manual'), cycleInput('manual')]);
  // m4 里叫醒那轮之后又手聊了 45 次(比后台轮次新,一页 40 装不下),外加一条 input 读不出的坏行:都不能把后台轮次挤掉
  const chats = Array.from({ length: 45 }, (_, i) => i);
  await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input, created_at, updated_at) VALUES ${chats.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    chats.flatMap((i) => [`c${i}`, 'm4', 'u1', 'done', JSON.stringify({ message: `hi ${i}` }), `2026-11-08 12:${String(i).padStart(2, '0')}:00`, `2026-11-08 12:${String(i).padStart(2, '0')}:30`]));
  await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input, created_at, updated_at) VALUES ('cbad', 'm4', 'u1', 'done', '{oops', '2026-11-08 13:00:00', '2026-11-08 13:00:10')`);
  // 待办按「这一轮」算:d4 是 r3 收尾很久之后手聊里提的,不算给 r3
  await query(`INSERT INTO muse_todos (id, user_id, title, status, source_session_id, created_at) VALUES
    ('d1', 'u1', 'a', 'pending', 'm3', '2026-11-08 10:01:00'), ('d2', 'u1', 'b', 'done', 'm3', '2026-11-08 10:01:30'),
    ('d4', 'u1', 'd', 'pending', 'm3', '2026-11-08 10:30:30'),
    ('d3', 'u1', 'c', 'pending', 'm1', '2026-11-08 08:01:00'), ('dx', 'u2', 'x', 'pending', 'm3', '2026-11-08 10:01:00')`);
  const app = express(); app.use(express.json()); app.use(specialRouter);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  if (prevUser === undefined) delete process.env.TANGU_USER_ID; else process.env.TANGU_USER_ID = prevUser;
  rmSync(home, { recursive: true, force: true });
});

describe('GET /agent/special/muse/rounds', () => {
  it('只列后台周期,新 → 旧;怎么醒的、用时、待办数、失败原因;在跑的没有结束时刻;不串别的用户', async () => {
    const { status, body } = await call('GET', '/agent/special/muse/rounds?limit=4');
    expect(status).toBe(200);
    const rounds = body.rounds as any[];
    expect(rounds.map((r) => r.runId)).toEqual(['r4', 'r3', 'r2', 'r1']); // r3chat / c* 手聊、cbad 坏 input、rx 别的用户都不在
    const [r4, r3, r2, r1] = rounds;
    expect(r4).toMatchObject({ trigger: 'manual', status: 'running', endedAt: null });
    expect(r3).toMatchObject({ trigger: 'heartbeat', todos: 2, files: 0 });
    expect(r3.endedAt - r3.startedAt).toBe(120_000);
    expect(r3.startedAt).toBe(Date.parse('2026-11-08T10:00:00Z'));
    expect(r2).toMatchObject({ trigger: 'rule:t1', status: 'failed', error: 'upstream 529', todos: 0 });
    expect(r1).toMatchObject({ trigger: null, todos: 1 });
  });

  it('缺省 3 条;远程来源 403(带运行错误原文,只给本机面板)', async () => {
    expect((await call('GET', '/agent/special/muse/rounds')).body.rounds).toHaveLength(3);
    expect((await call('GET', '/agent/special/muse/rounds', REMOTE)).status).toBe(403);
  });
});

describe('POST /agent/special/muse/wake', () => {
  it('Muse 关着 → 409,不记请求', async () => {
    saveSpecialAgentsConfig({ muse: { enabled: false } } as any);
    expect((await call('POST', '/agent/special/muse/wake')).status).toBe(409);
    expect((await call('GET', '/agent/special/muse/status')).body.status.wakePending).toBe(false);
  });

  it('开着 → 记下请求(supervisor 没起:202,起来后的第一次巡检照办),状态里 wakePending = true;远程来源 403', async () => {
    saveSpecialAgentsConfig({ muse: { enabled: true } } as any);
    expect((await call('POST', '/agent/special/muse/wake', REMOTE)).status).toBe(403);
    const r = await call('POST', '/agent/special/muse/wake');
    expect(r.status).toBe(202);
    expect(r.body.status).toMatchObject({ wakePending: true, wakeBlocked: null });
    // 远程投影不加这两个字段(远端不出「叫醒」)
    const remote = await call('GET', '/agent/special/muse/status', REMOTE);
    expect(remote.body.status).not.toHaveProperty('wakePending');
  });
});
