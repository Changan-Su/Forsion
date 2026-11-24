/**
 * GET / POST /agent/sessions/:id/card-marks(任务卡 / 作品卡「处理过了」跟会话走,services/cardMarks.ts):
 * 按键只加不减;两个客户端同时记不同的卡都留下;「忽略」盖不掉已执行、已执行能换掉「忽略」;先开出的子会话 id 不被后来者冲掉;
 * 任务卡记录 8 天过期、作品卡记录一直留;会话不存在 404 带 session_not_found;存值读不出来 500 且不往回写。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

// 内存 better-sqlite3 是同步的:两个并发写在「读存值 → 落库」之间根本插不进去,不加串行也恒绿(假绿)。
// 每次 query 前让出一拍,制造真实的异步间隙(同 sessionConfigPatch.test)。
vi.mock('../src/core/db.js', async (orig) => {
  const m = await orig<typeof import('../src/core/db.js')>();
  return { ...m, query: async (sql: string, params?: unknown[]) => { await new Promise((r) => setImmediate(r)); return m.query(sql, params as any); } };
});

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import sessionsRouter from '../src/routes/sessions.js';
import { CARD_MARK_TTL_MS, CARD_MARKS_MAX, CardMarksFullError, capCardMarks, mergeCardMarks } from '../src/services/cardMarks.js';

let srv: Server;
let base: string;
const call = async (method: 'GET' | 'POST', id: string, body?: unknown): Promise<any> => {
  const r = await fetch(`${base}/agent/sessions/${id}/card-marks`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const rawOf = async (id: string): Promise<any> => (await query<any[]>(`SELECT card_marks, agent_config, updated_at FROM chat_sessions WHERE id = ?`, [id]))[0];
const marksOf = async (id: string): Promise<any> => { const v = (await rawOf(id)).card_marks; return typeof v === 'string' ? JSON.parse(v) : v; };
const addSession = (id: string, user = 'u1') => query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config, updated_at) VALUES (?, ?, 'tangu', 't', 'm1', 'user', 1, ?, '2026-01-01 00:00:00')`, [id, user, JSON.stringify({ approvalMode: 'readonly' })]);

beforeAll(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express(); app.use(express.json()); app.use(sessionsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => { await new Promise((r) => srv.close(r)); });

describe('card-marks 路由', () => {
  it('没记过 = 空表;记一条后 GET 读得回来;不动 agent_config 和 updated_at', async () => {
    await addSession('C1');
    expect(await call('GET', 'C1')).toEqual({ status: 200, body: { marks: {} } });
    const t = Date.now() - 1000;
    const r = await call('POST', 'C1', { marks: { 'id:a': { l: 'child', t, c: 'child-1' } } });
    expect(r.status).toBe(200);
    expect(r.body.marks).toEqual({ 'id:a': { l: 'child', t, c: 'child-1' } });
    expect((await call('GET', 'C1')).body.marks).toEqual({ 'id:a': { l: 'child', t, c: 'child-1' } });
    const row = await rawOf('C1');
    expect(JSON.parse(row.agent_config)).toEqual({ approvalMode: 'readonly' });
    expect(row.updated_at).toBe('2026-01-01 00:00:00');
  });

  it('两个客户端同时记不同的卡 → 两条都留下(按会话串行,不拿旧表互相盖)', async () => {
    await addSession('C2');
    const [a, b] = await Promise.all([
      call('POST', 'C2', { marks: { 'id:a': { l: 'here', t: Date.now() } } }),
      call('POST', 'C2', { marks: { 'creation:x': { l: 'ignore', t: Date.now() } } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Object.keys(await marksOf('C2')).sort()).toEqual(['creation:x', 'id:a']);
  });

  it('同一张卡:先开出的子会话留着;「忽略」盖不掉已执行;已执行换掉「忽略」', async () => {
    await addSession('C3');
    const t = Date.now() - 5000;
    await call('POST', 'C3', { marks: { 'id:a': { l: 'child', t, c: 'kid-a' }, 'id:b': { l: 'ignore', t } } });
    const r = await call('POST', 'C3', { marks: { 'id:a': { l: 'here', t: t + 1 }, 'id:b': { l: 'new', t: t + 1 } } });
    expect(r.body.marks['id:a']).toEqual({ l: 'child', t, c: 'kid-a' });
    expect(r.body.marks['id:b']).toEqual({ l: 'new', t: t + 1 });
    const again = await call('POST', 'C3', { marks: { 'id:b': { l: 'ignore', t: t + 2 } } });
    expect(again.body.marks['id:b'].l).toBe('new');
  });

  it('坏条目跳过、整批照收;体形状不对 400 且不写', async () => {
    await addSession('C4');
    const r = await call('POST', 'C4', { marks: { 'id:ok': { l: 'muse' }, 'id:bad': { l: 'delete-all' }, 'id:c': { l: 'child', c: '../etc/passwd' }, ['x'.repeat(300)]: { l: 'here' } } });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.marks)).toEqual(['id:ok', 'id:c']);
    expect(r.body.marks['id:c'].c).toBeUndefined();
    expect(typeof r.body.marks['id:ok'].t).toBe('number');
    for (const body of [{}, { marks: [] }, { marks: 'x' }, [1]]) expect((await call('POST', 'C4', body)).status, JSON.stringify(body)).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`id:${i}`, { l: 'here' }]));
    expect((await call('POST', 'C4', { marks: many })).status).toBe(400);
    expect(Object.keys(await marksOf('C4'))).toEqual(['id:ok', 'id:c']);
  });

  it('客户端钟快了:t 压到现在,不会永不过期', async () => {
    await addSession('C5');
    const r = await call('POST', 'C5', { marks: { 'id:a': { l: 'here', t: Date.now() + 365 * 24 * 3600_000 } } });
    expect(r.body.marks['id:a'].t).toBeLessThanOrEqual(Date.now());
  });

  it('任务卡记录过了 8 天不回、下次写时清掉;作品卡记录一直留', async () => {
    await addSession('C6');
    const old = Date.now() - CARD_MARK_TTL_MS - 60_000;
    await query(`UPDATE chat_sessions SET card_marks = ? WHERE id = ?`, [JSON.stringify({ 'id:old': { l: 'here', t: old }, 'creation:old': { l: 'ignore', t: old } }), 'C6']);
    expect((await call('GET', 'C6')).body.marks).toEqual({ 'creation:old': { l: 'ignore', t: old } });
    await call('POST', 'C6', { marks: { 'id:new': { l: 'here', t: Date.now() } } });
    expect(Object.keys(await marksOf('C6')).sort()).toEqual(['creation:old', 'id:new']);
  });

  it('同键的过期记录挡不住重新写出的卡;过期的来记录也换不掉还有效的「忽略」', async () => {
    await addSession('C9');
    const old = Date.now() - CARD_MARK_TTL_MS - 60_000;
    await query(`UPDATE chat_sessions SET card_marks = ? WHERE id = ?`, [JSON.stringify({ 'h1': { l: 'child', t: old, c: 'old-kid' }, 'h2': { l: 'ignore', t: Date.now() } }), 'C9']);
    const r = await call('POST', 'C9', { marks: { 'h1': { l: 'here', t: Date.now() }, 'h2': { l: 'here', t: old } } });
    expect(r.body.marks['h1'].l).toBe('here');
    expect(r.body.marks['h1'].c).toBeUndefined();
    expect(r.body.marks['h2'].l).toBe('ignore');
  });

  it('读不懂的存值条目(以后的版本写的)原样留着,写别的卡时照样写回去', async () => {
    await addSession('C10');
    const future = { l: 'cloud', t: Date.now(), extra: { a: 1 } };
    await query(`UPDATE chat_sessions SET card_marks = ? WHERE id = ?`, [JSON.stringify({ 'id:f': future, 'id:g': 'opaque' }), 'C10']);
    expect((await call('GET', 'C10')).body.marks).toMatchObject({ 'id:f': future, 'id:g': 'opaque' });
    const r = await call('POST', 'C10', { marks: { 'id:f': { l: 'here' }, 'id:n': { l: 'here' } } });
    expect(r.status).toBe(200);
    expect(await marksOf('C10')).toMatchObject({ 'id:f': future, 'id:g': 'opaque', 'id:n': { l: 'here' } });
  });

  it('作品卡记录满了:整次写 413,一条都不挤掉', async () => {
    await addSession('C11');
    const full = Object.fromEntries(Array.from({ length: CARD_MARKS_MAX }, (_, i) => [`creation:${i}`, { l: 'here', t: i + 1 }]));
    await query(`UPDATE chat_sessions SET card_marks = ? WHERE id = ?`, [JSON.stringify(full), 'C11']);
    const r = await call('POST', 'C11', { marks: { 'creation:new': { l: 'ignore' } } });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('card_marks_full');
    expect(Object.keys(await marksOf('C11')).length).toBe(CARD_MARKS_MAX);
  });

  it('会话不存在 / 不是本人的 → 404 session_not_found,不建行', async () => {
    await addSession('C7', 'someone-else');
    for (const id of ['C7', 'nope']) {
      for (const [m, body] of [['GET', undefined], ['POST', { marks: { 'id:a': { l: 'here' } } }]] as const) {
        const r = await call(m, id, body);
        expect(r.status, `${m} ${id}`).toBe(404);
        expect(r.body.error).toBe('session_not_found');
      }
    }
    expect(await marksOf('C7')).toBeNull();
  });

  it('存值读不出来 → GET / POST 都 500,存值原样不动(读失败 ≠ 空表)', async () => {
    await addSession('C8');
    await query(`UPDATE chat_sessions SET card_marks = ? WHERE id = ?`, ['{not json', 'C8']);
    expect((await call('GET', 'C8')).status).toBe(500);
    expect((await call('POST', 'C8', { marks: { 'id:a': { l: 'here' } } })).status).toBe(500);
    expect((await rawOf('C8')).card_marks).toBe('{not json');
    await query(`UPDATE chat_sessions SET card_marks = ? WHERE id = ?`, ['[1,2]', 'C8']);
    expect((await call('GET', 'C8')).status).toBe(500);
  });
});

describe('cardMarks 纯函数', () => {
  it('封顶:只挤最旧的任务卡记录;作品卡记录挤不动就抛', () => {
    const now = Date.now();
    const m: Record<string, any> = { 'creation:keep': { l: 'here', t: 1 } };
    for (let i = 0; i < CARD_MARKS_MAX; i++) m[`id:${i}`] = { l: 'here', t: now - (CARD_MARKS_MAX - i) };
    const out = capCardMarks(m);
    expect(Object.keys(out).length).toBe(CARD_MARKS_MAX);
    expect(out['creation:keep']).toBeDefined();
    expect(out['id:0']).toBeUndefined(); // 最旧的那条任务卡记录被挤掉
    expect(out[`id:${CARD_MARKS_MAX - 1}`]).toBeDefined();
    const creations = Object.fromEntries(Array.from({ length: CARD_MARKS_MAX + 1 }, (_, i) => [`creation:${i}`, { l: 'here', t: i }]));
    expect(() => capCardMarks(creations)).toThrow(CardMarksFullError);
  });

  it('merge 不改入参', () => {
    const stored = { 'id:a': { l: 'ignore' as const, t: 1 } };
    const out = mergeCardMarks(stored, { 'id:a': { l: 'here', t: 2 } }, Date.now());
    expect(stored['id:a'].l).toBe('ignore');
    expect(out).toEqual({});
    const now = Date.now();
    expect(mergeCardMarks({ 'id:a': { l: 'ignore', t: now } }, { 'id:a': { l: 'here', t: now } }, now)).toEqual({ 'id:a': { l: 'here', t: now } });
  });
});
