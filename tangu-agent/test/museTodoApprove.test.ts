/**
 * POST /agent/special/muse/todos/:id/approve(收件箱 TODO 卡「交给 Muse 执行」,2026-09-11):真 express(随机端口 fetch 直打)+ tmp TANGU_HOME。
 * 覆盖:pending → 200、状态 injected、Muse 日程多一条一次性此刻到期的条目(任务书 = 前缀 + 库里的标题 + 整份 detail,4000 字不截)、反馈行;
 * 再点 409(CAS);Muse 关着 409 且 TODO 仍 pending;PATCH dismissed 由引擎写反馈行 —— 桌面「忽略」TODO 卡不再自己记,
 * e2e:inboxamadeus 的「前端不另记反馈」断言靠这条才不是假绿。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { loadSchedule, entriesOf, upsertEntry, validateEntryInput } from '../src/services/agentSchedule.js';
import { museDueSchedules } from '../src/services/muse.js';

const USER = 'local';
let srv: Server;
let base: string;
let home: string;
const logs: string[] = [];

const call = async (method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const setMuse = (muse: Record<string, unknown>): void =>
  writeFileSync(join(home, 'config.json'), JSON.stringify({ specialAgents: { muse: { modelId: 'm1', ...muse } } }), 'utf8');
const seedTodo = (id: string, title: string, detail: string): Promise<unknown> =>
  query(`INSERT INTO muse_todos (id, user_id, title, detail, status, source_session_id) VALUES (?, ?, ?, ?, 'pending', 's1')`, [id, USER, title, detail]);
const statusOf = async (id: string): Promise<string> => (await query<any[]>(`SELECT status FROM muse_todos WHERE id = ?`, [id]))[0]?.status;
const entriesFor = async (id: string): Promise<any[]> => {
  const db = await loadSchedule('muse');
  return db ? entriesOf(db).filter((e) => e.description === `todo ${id}`) : [];
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-todoapprove-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const brain: any = { memory: { appendLogEntry: async (_u: string, text: string) => { logs.push(text); return { date: 'd', time: 't' }; } } };
  configureTangu({ host, brain, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express();
  app.use(express.json());
  app.use(specialRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});

afterAll(() => {
  srv?.close();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => { logs.length = 0; setMuse({ enabled: true }); });

describe('POST /agent/special/muse/todos/:id/approve', () => {
  it('pending → 200:TODO injected、Muse 日程多一条一次性此刻到期的条目(任务书来自库、整份不截)、反馈行', async () => {
    const detail = 'd'.repeat(3990) + '【验收在末尾】';
    await seedTodo('t1', '恢复网页动画', detail);
    const r = await call('POST', '/agent/special/muse/todos/t1/approve');
    expect(r.status).toBe(200);
    expect(await statusOf('t1')).toBe('injected');
    const [e] = await entriesFor('t1');
    expect(e).toMatchObject({ name: '恢复网页动画', repeat: '', auto: true });
    expect(e.prompt.startsWith('The user approved this todo')).toBe(true);
    expect(e.prompt.endsWith(`恢复网页动画\n\n${detail}`)).toBe(true);
    expect(e.prompt.length).toBeGreaterThan(4000); // 批准路由放宽到 4500;别的日程入口仍截 4000(见下面那条)
    expect(Math.abs(Date.parse(e.date) - Date.now())).toBeLessThan(120_000);
    expect(logs.some((l) => l.includes('todo "恢复网页动画" approved'))).toBe(true);
  });

  it('再点一次 → 409 todo_not_pending(CAS:两处同时点只成一次),不多建条目', async () => {
    const r = await call('POST', '/agent/special/muse/todos/t1/approve');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('todo_not_pending');
    expect(await entriesFor('t1')).toHaveLength(1);
  });

  it('Muse 关着 → 409 muse_disabled,TODO 仍 pending、不建条目', async () => {
    setMuse({ enabled: false });
    await seedTodo('t2', '关着的时候', 'x');
    const r = await call('POST', '/agent/special/muse/todos/t2/approve');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('muse_disabled');
    expect(await statusOf('t2')).toBe('pending');
    expect(await entriesFor('t2')).toHaveLength(0);
  });

  it('两条不同 TODO 同时批准:日程两条都在(同一 agent 的日程读改写串行化,后写不覆盖先写)', async () => {
    await seedTodo('t4', '并发一', 'a');
    await seedTodo('t5', '并发二', 'b');
    const [a, b] = await Promise.all([call('POST', '/agent/special/muse/todos/t4/approve'), call('POST', '/agent/special/muse/todos/t5/approve')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await entriesFor('t4')).toHaveLength(1);
    expect(await entriesFor('t5')).toHaveLength(1);
  });

  it('上次批准停在「条目已落、状态未改」:再点一次找回同一条、只改状态,不重复建', async () => {
    await seedTodo('t6', '断在半路的', 'c');
    const v = validateEntryInput({ name: '断在半路的', date: '2026-09-11T10:00', auto: true, prompt: 'p', description: 'todo t6' });
    if (!v.ok) throw new Error(v.error);
    await upsertEntry('muse', v.value);
    const r = await call('POST', '/agent/special/muse/todos/t6/approve');
    expect(r.status).toBe(200);
    expect(await statusOf('t6')).toBe('injected');
    expect(await entriesFor('t6')).toHaveLength(1);
  });

  it('别的日程入口仍按 4000 截(只有批准路由放宽)', () => {
    const v = validateEntryInput({ name: 'x', prompt: 'p'.repeat(5000) });
    expect(v.ok && v.value.prompt.length).toBe(4000);
  });

  it('GET 单条:有就回状态,没有 404 todo_not_found', async () => {
    const a = await call('GET', '/agent/special/muse/todos/t1');
    expect(a.status).toBe(200);
    expect(a.body.todo).toMatchObject({ id: 't1', status: 'injected' });
    const b = await call('GET', '/agent/special/muse/todos/nope');
    expect(b.status).toBe(404);
    expect(b.body.error).toBe('todo_not_found');
  });

  it('PATCH 带 from = CAS:当前不是 from 就 409、状态不动;不带 from 照旧无条件(MuseView)', async () => {
    await seedTodo('t8', 'CAS', 'x');
    expect((await call('PATCH', '/agent/special/muse/todos/t8', { status: 'injected', from: 'pending' })).status).toBe(200);
    const r = await call('PATCH', '/agent/special/muse/todos/t8', { status: 'dismissed', from: 'pending' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('todo_not_pending');
    expect(await statusOf('t8')).toBe('injected');
    expect((await call('PATCH', '/agent/special/muse/todos/t8', { status: 'done' })).status).toBe(200);
    expect(await statusOf('t8')).toBe('done');
  });

  it('到期消费:批准建的条目(todo <id>)要等那条 TODO 真是 injected 才放行;普通条目不受影响', async () => {
    await seedTodo('t9', '孤儿条目', 'x');
    for (const desc of ['todo t9', 'plain']) {
      const v = validateEntryInput({ name: desc, date: '2026-09-11T00:00', auto: true, prompt: 'p', description: desc });
      if (!v.ok) throw new Error(v.error);
      await upsertEntry('muse', v.value);
    }
    const due = async (): Promise<string[]> => (await museDueSchedules(new Date('2026-09-12T00:00'))).map((e) => e.description);
    expect(await due()).toContain('plain');
    expect(await due()).not.toContain('todo t9');
    await query(`UPDATE muse_todos SET status = 'injected' WHERE id = 't9'`);
    expect(await due()).toContain('todo t9');
  });

  it('卡片落点 PATCH(from=pending)顺手撤掉批准停在半路留下的孤儿条目', async () => {
    await seedTodo('t10', '孤儿再改点新会话', 'x');
    const v = validateEntryInput({ name: 'x', date: '2026-09-11T00:00', auto: true, prompt: 'p', description: 'todo t10' });
    if (!v.ok) throw new Error(v.error);
    await upsertEntry('muse', v.value);
    const r = await call('PATCH', '/agent/special/muse/todos/t10', { status: 'injected', from: 'pending' });
    expect(r.status).toBe(200);
    expect(await entriesFor('t10')).toHaveLength(0);
  });

  it('到期闸查库失败 = todo 条目一条不放(fail closed),普通条目照常', async () => {
    const at = new Date('2026-09-12T00:00');
    expect((await museDueSchedules(at)).map((e) => e.description)).toContain('todo t9'); // 上一条已把 t9 置 injected
    await query(`ALTER TABLE muse_todos RENAME TO muse_todos_off`);
    try {
      const due = (await museDueSchedules(at)).map((e) => e.description);
      expect(due).toContain('plain');
      expect(due.some((d) => d.startsWith('todo '))).toBe(false);
    } finally {
      await query(`ALTER TABLE muse_todos_off RENAME TO muse_todos`);
    }
  });

  it('PATCH dismissed:引擎自己写 [feedback] 行(桌面「忽略」TODO 卡不再另记)', async () => {
    await seedTodo('t3', '不想做的', 'x');
    const r = await call('PATCH', '/agent/special/muse/todos/t3', { status: 'dismissed' });
    expect(r.status).toBe(200);
    expect(await statusOf('t3')).toBe('dismissed');
    expect(logs).toContain('[feedback] todo "不想做的" marked dismissed by user');
  });
});
