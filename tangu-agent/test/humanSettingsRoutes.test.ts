/**
 * 随账号走的设置文件的本机读写接口:GET / PUT /agent/human/Settings/<name>.db。
 * 调用方(桌面渲染层)靠 GET 的四种回答决定能不能写:读到了 / 确认没有 / 文件坏了 / 不知道。
 * 报文和云端的同名接口(/api/agent/human/Settings/<name>.db)同形:渲染层用同一套解析对两边。
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { checkWritePath } from '../src/tools/fsPolicy.js';
import humanRouter from '../src/routes/human.js';

let home: string, base: string, server: Server, database: { close(): void };
const previousHome = process.env.TANGU_HOME;
const api = async (url: string, method = 'GET', body?: any, extraHeaders: Record<string, string> = {}) => {
  const r = await fetch(base + url, { method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json', ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* 不是 JSON:旧引擎的 404 页就是这样 */ }
  return { status: r.status, body: json, text };
};
const URL = '/agent/human/Settings/calendar.db';
const dir = () => join(home, 'human', 'Settings');
const file = (name = 'calendar.db') => join(dir(), name);
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const db = (items: Record<string, string>) => ({
  version: 2, name: 'calendar-settings',
  columns: [{ id: 'k', name: 'key', type: 'text' }, { id: 'v', name: 'value', type: 'text' }],
  rows: Object.entries(items).map(([k, v]) => ({ id: `s${createHash('sha1').update(k).digest('hex').slice(0, 16)}`, cells: { k, v } })),
});
const onDisk = (name = 'calendar.db') => readFileSync(file(name), 'utf8');

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-settings-routes-'))); process.env.TANGU_HOME = home;
  const { host, db: sqlite } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = sqlite;
  sqlite.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }) } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express(); app.use(express.json({ limit: '25mb' })); app.use(humanRouter); // 上限照 standalone/main.ts
  server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  database?.close(); rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});
beforeEach(() => { rmSync(dir(), { recursive: true, force: true }); rmSync(join(home, 'human', '.memory.lock'), { force: true }); });

describe('GET: four answers the caller can tell apart', () => {
  it('missing: the route exists and the file does not — a 200 saying so, never a 404', async () => {
    const r = await api(URL);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'missing', exists: false, version: null });
    expect(existsSync(file())).toBe(false); // 读不会顺手建文件
  });
  it('ok: the content and its version (sha256 of the bytes on disk)', async () => {
    mkdirSync(dir(), { recursive: true });
    const text = `${JSON.stringify(db({ 'sync|color|tasks.db': 'red' }), null, 2)}\n`;
    writeFileSync(file(), text);
    const r = await api(URL);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok', exists: true, data: db({ 'sync|color|tasks.db': 'red' }), version: sha(text) });
  });
  it('corrupt: unparseable or wrongly shaped files answer 422 without a version', async () => {
    mkdirSync(dir(), { recursive: true });
    const dup = db({ a: '1' }); dup.rows.push({ ...dup.rows[0] });
    for (const bad of ['{ not json', '[]', JSON.stringify({ version: 2, name: 'x', columns: [] }), JSON.stringify({ ...db({}), rows: [{ cells: {} }] }), JSON.stringify(dup), '']) {
      writeFileSync(file(), bad);
      const r = await api(URL);
      expect([bad, r.status, r.body?.error, r.body?.status]).toEqual([bad, 422, 'HUMAN_SETTINGS_CORRUPT', 'corrupt']);
      expect(r.body.version).toBeUndefined();
      expect(r.body.exists).toBeUndefined();
      expect(onDisk()).toBe(bad);
    }
  });
  it('unknown: remote callers, missing auth and unreadable paths are neither "missing" nor "ok"', async () => {
    expect((await api(URL, 'GET', undefined, { 'x-forsion-remote': 'lan' })).status).toBe(403);
    expect((await fetch(base + URL)).status).toBe(401);
    mkdirSync(file(), { recursive: true }); // 同名的是个文件夹
    const r = await api(URL);
    expect(r.status).toBe(500);
    expect(r.body.status).toBeUndefined();
  });
  it('an engine without this route answers 404, which a caller cannot mistake for the 200 "missing"', async () => {
    const old = express(); old.use(express.json());
    const s = old.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => s.once('listening', () => resolve()));
    try {
      const r = await fetch(`http://127.0.0.1:${(s.address() as any).port}${URL}`, { headers: { Authorization: 'Bearer fixture' } });
      expect(r.status).toBe(404);
    } finally { await new Promise<void>((resolve) => s.close(() => resolve())); }
  });
});

describe('names: the family is Settings/<name>.db', () => {
  it('serves any well-formed name and rejects the rest before touching the disk', async () => {
    expect((await api('/agent/human/Settings/appearance-2.db')).body).toEqual({ status: 'missing', exists: false, version: null });
    for (const bad of ['Calendar.db', 'calendar.json', 'calendar', '-x.db', 'a_b.db', `${'a'.repeat(65)}.db`, '..%2FCALENDAR.db', '.hidden.db', 'calendar%20(conflict%202026-11-10%200900).db']) {
      for (const method of ['GET', 'PUT']) {
        const r = await api(`/agent/human/Settings/${bad}`, method, method === 'PUT' ? { data: db({}), version: null } : undefined);
        expect([bad, method, r.status, r.body?.error]).toEqual([bad, method, 400, 'HUMAN_BAD_SETTINGS_NAME']);
      }
    }
    expect(existsSync(dir()) ? readdirSync(dir()) : []).toEqual([]);
    expect((await api('/agent/human/Settings/a/b.db')).status).toBe(404); // 更深的路径没有路由
    // 大小写敏感,和云端那条一样:别的写法不是这条路由
    for (const method of ['GET', 'PUT']) expect((await api('/agent/human/settings/calendar.db', method, method === 'PUT' ? { data: db({}), version: null } : undefined)).status).toBe(404);
    expect(existsSync(dir())).toBe(false);
  });
  it('refuses a symlinked settings file instead of following it', async () => {
    mkdirSync(dir(), { recursive: true });
    const outside = join(home, 'outside.db'); writeFileSync(outside, JSON.stringify(db({ secret: '1' })));
    symlinkSync(outside, file());
    expect((await api(URL)).status).toBe(500);
    expect((await api(URL, 'PUT', { data: db({ a: '1' }), version: null })).status).toBe(500);
    expect(JSON.parse(readFileSync(outside, 'utf8')).rows[0].cells.k).toBe('secret');
  });
});

describe('PUT: compare-and-swap on the version', () => {
  it('creates with version null, then writes only against the version last read', async () => {
    const created = await api(URL, 'PUT', { data: db({ a: '1' }), version: null });
    expect(created.status).toBe(200);
    expect(created.body).toEqual({ ok: true, version: sha(onDisk()) });
    expect(onDisk()).toBe(`${JSON.stringify(db({ a: '1' }), null, 2)}\n`); // 和同步合并出来的写法逐字节一样
    const read = await api(URL);
    expect(read.body.version).toBe(created.body.version);
    const next = await api(URL, 'PUT', { data: db({ a: '1', b: '2' }), version: read.body.version });
    expect(next.status).toBe(200);
    expect((await api(URL)).body).toMatchObject({ status: 'ok', version: next.body.version, data: db({ a: '1', b: '2' }) });
    expect(readdirSync(dir())).toEqual(['calendar.db']); // 原子写不留临时文件
  });
  it('a stale version gets 409 with the current content and version, and nothing is written', async () => {
    const first = await api(URL, 'PUT', { data: db({ a: '1' }), version: null });
    const second = await api(URL, 'PUT', { data: db({ a: '2' }), version: first.body.version });
    const before = onDisk();
    const stale = await api(URL, 'PUT', { data: db({ a: 'stale' }), version: first.body.version });
    expect(stale.status).toBe(409);
    // 平铺带回当时 GET 会给的那份回答
    expect(stale.body).toMatchObject({ error: 'HUMAN_CONFLICT', status: 'ok', exists: true, data: db({ a: '2' }), version: second.body.version });
    expect(onDisk()).toBe(before);
    // 拿 409 带回的票据再写就成了
    expect((await api(URL, 'PUT', { data: db({ a: 'merged' }), version: stale.body.version })).status).toBe(200);
  });
  it('creating a file someone else just created gets 409 too', async () => {
    await api(URL, 'PUT', { data: db({ a: 'theirs' }), version: null });
    const r = await api(URL, 'PUT', { data: db({ a: 'mine' }), version: null });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'HUMAN_CONFLICT', status: 'ok', exists: true, data: db({ a: 'theirs' }) });
    expect(JSON.parse(onDisk()).rows[0].cells.v).toBe('theirs');
  });
  it('a version for a file that is gone gets 409 with status missing', async () => {
    const first = await api(URL, 'PUT', { data: db({ a: '1' }), version: null });
    rmSync(file());
    const r = await api(URL, 'PUT', { data: db({ a: '2' }), version: first.body.version });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'HUMAN_CONFLICT', status: 'missing', exists: false, version: null });
    expect(existsSync(file())).toBe(false);
  });
  it('a corrupt file on disk is never overwritten, not even with its own hash as the version', async () => {
    mkdirSync(dir(), { recursive: true });
    const bad = '{ "rows": [ half written';
    writeFileSync(file(), bad);
    for (const version of [null, sha(bad), 'anything']) {
      const r = await api(URL, 'PUT', { data: db({ a: '1' }), version });
      expect([version, r.status, r.body.error, r.body.status]).toEqual([version, 409, 'HUMAN_CONFLICT', 'corrupt']);
      expect(r.body.version).toBeUndefined(); // 坏文件不发票据
    }
    expect(onDisk()).toBe(bad);
  });
  it('rejects bodies that are not a database file, and writes nothing', async () => {
    const dup = db({ a: '1' }); dup.rows.push({ ...dup.rows[0] });
    const bads: any[] = [
      undefined, null, [], 'text', { ...db({}), rows: 'x' }, { ...db({}), columns: undefined }, { ...db({}), version: '2' }, { ...db({}), name: 1 },
      { ...db({}), source: { folder: 'x' } }, { ...db({}), rows: [{ id: 1, cells: {} }] }, { ...db({}), rows: [{ id: 'a' }] }, { ...db({}), rows: [{ id: 'a', cells: [] }] },
      { ...db({}), columns: [{ name: 'no id' }] }, { ...db({}), views: {} }, dup,
    ];
    for (const data of bads) {
      const r = await api(URL, 'PUT', { data, version: null });
      expect([JSON.stringify(data), r.status, r.body.error]).toEqual([JSON.stringify(data), 400, 'HUMAN_BAD_SETTINGS']);
    }
    for (const version of [undefined, 1, {}]) expect((await api(URL, 'PUT', { data: db({}), version })).status).toBe(400);
    expect(existsSync(file())).toBe(false);
  });
  it('rejects more than 256 KB and accepts a file just under it', async () => {
    const big = await api(URL, 'PUT', { data: db({ big: 'x'.repeat(256 * 1024) }), version: null });
    expect([big.status, big.body.error, big.body.limit]).toEqual([413, 'HUMAN_SETTINGS_TOO_LARGE', 262144]);
    expect(existsSync(file())).toBe(false);
    const fits = await api(URL, 'PUT', { data: db({ big: 'x'.repeat(250 * 1024) }), version: null });
    expect(fits.status).toBe(200);
    expect(Buffer.byteLength(onDisk())).toBeLessThanOrEqual(256 * 1024);
  });
  it('remote callers cannot write', async () => {
    const r = await api(URL, 'PUT', { data: db({ a: '1' }), version: null }, { 'x-forsion-remote': 'lan' });
    expect(r.status).toBe(403);
    expect(existsSync(file())).toBe(false);
  });
  it('waits for the human folder lock the sync holds, and answers 503 without writing if it never frees', async () => {
    mkdirSync(join(home, 'human'), { recursive: true });
    const lock = join(home, 'human', '.memory.lock');
    writeFileSync(lock, 'sync');
    setTimeout(() => rmSync(lock, { force: true }), 150); // 同步落完盘放了锁
    expect((await api(URL, 'PUT', { data: db({ a: '1' }), version: null })).status).toBe(200);
    writeFileSync(lock, 'stuck');
    const before = onDisk();
    const r = await api(URL, 'PUT', { data: db({ a: '2' }), version: sha(before) });
    expect([r.status, r.body.error]).toEqual([503, 'HUMAN_BUSY']);
    expect(onDisk()).toBe(before);
  });
});

describe('file tools', () => {
  it('cannot write settings files: the human folder is hard-denied to them, like the default calendar', () => {
    const ctx = { userId: 'owner', sessionId: 's', appId: 'tangu', cwd: home, execMode: 'host' as const };
    for (const rel of ['human/Settings/calendar.db', 'human/Settings/new.db', 'human/CALENDAR.db']) expect([rel, checkWritePath(ctx, join(home, rel))]).toEqual([rel, expect.objectContaining({ ok: false, hardDeny: true })]);
  });
});
