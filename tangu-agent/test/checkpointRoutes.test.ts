/** 真实 HTTP + SQLite + 文件系统:消息墙钟与检查点身份是两种互斥的恢复边界。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { query } from '../src/core/db.js';
import { runMigration } from '../src/db/migrate.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { snapshotBeforeWrite, recordPostWrite } from '../src/services/checkpoints.js';
import { claimDelegate, releaseDelegate } from '../src/services/delegateTranscript.js';
import sessionsRouter from '../src/routes/sessions.js';

let home: string, project: string, base: string, server: Server, database: { close(): void };
const previousHome = process.env.TANGU_HOME;
const file = (name: string) => join(project, name);
const read = (name: string) => readFileSync(file(name), 'utf8');
const write = (name: string, body: string) => writeFileSync(file(name), body);
const api = async (url: string, body?: unknown) => {
  const r = await fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const restore = (body: unknown, sessionId = 'mine') => api(`/agent/sessions/${sessionId}/checkpoints/restore`, body);

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-checkpoint-routes-')));
  process.env.TANGU_HOME = home;
  project = join(home, 'project'); mkdirSync(project);
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  for (const [id, user] of [['mine', 'owner'], ['another', 'owner'], ['theirs', 'other']]) {
    await query('INSERT INTO chat_sessions (id, user_id, app_id, kind, project_path, projectless) VALUES (?, ?, ?, ?, ?, ?)', [id, user, 'tangu', 'user', project, 0]);
  }
  const app = express(); app.use(express.json()); app.use(sessionsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks(); releaseDelegate('mine');
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  database?.close(); rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('POST /agent/sessions/:id/checkpoints/restore', () => {
  it('同毫秒回退的撤销按 GET 返回的 runId 精确恢复,不重复选入原检查点', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2000);
    write('a.txt', 'v1');
    await snapshotBeforeWrite('mine', 'original', [file('a.txt')]); write('a.txt', 'v2');
    expect((await restore({ at: 2000 })).status).toBe(200);
    expect(read('a.txt')).toBe('v1');
    const listed = await api('/agent/sessions/mine/checkpoints');
    expect(listed.status).toBe(200);
    const checkpoints = listed.body.checkpoints;
    expect(checkpoints.map((c: any) => c.at)).toEqual([2000, 2000]);
    const checkpointId = checkpoints.find((c: any) => c.runId !== 'original').runId;
    const undone = await restore({ checkpointId });
    expect(undone.status).toBe(200);
    expect(undone.body.restored).toEqual([file('a.txt')]);
    expect(read('a.txt')).toBe('v2');
  });

  it('时钟回退后 changes 的消息窗口与旧 at 请求仍按墙钟,不恢复 prompt 之前的写入', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2000);
    write('unrelated.txt', 'other-before\n');
    await snapshotBeforeWrite('mine', 'prior-clock', [file('unrelated.txt')]); write('unrelated.txt', 'other-after\n');
    clock.mockReturnValue(1000);
    write('a.txt', 'before-prompt\n');
    await snapshotBeforeWrite('mine', 'before-prompt', [file('a.txt')]); write('a.txt', 'at-prompt\n');
    clock.mockReturnValue(1200);
    await snapshotBeforeWrite('mine', 'after-prompt', [file('a.txt')]); write('a.txt', 'after-prompt\n');
    const changes = await api('/agent/sessions/mine/changes?bounds=1000,1100,1300');
    expect(changes.status).toBe(200);
    expect(changes.body.windows.map((w: any) => w.files.map((f: any) => [f.path, f.runs]))).toEqual([
      [[file('a.txt'), 1]], [[file('a.txt'), 1]], [[file('unrelated.txt'), 1]],
    ]);
    const diff = await api(`/agent/sessions/mine/changes/diff?since=1100&until=1300&path=${encodeURIComponent(file('a.txt'))}`);
    expect(diff.body.files[0].patch).toContain('-at-prompt');
    expect(diff.body.files[0].patch).toContain('+after-prompt');
    const r = await restore({ at: '1100', paths: [file('a.txt')] });
    expect(r.status).toBe(200);
    expect(read('a.txt')).toBe('at-prompt\n');
    expect(read('unrelated.txt')).toBe('other-after\n');
  });

  it('互斥选择与畸形值一律 400,不触碰文件或新增恢复记录', async () => {
    write('a.txt', 'v1'); await snapshotBeforeWrite('mine', 'original', [file('a.txt')]); write('a.txt', 'v2');
    const invalid = [
      {}, { at: 1, checkpointId: 'original' }, { at: null }, { at: 0 }, { at: -1 }, { at: 'no' }, { at: true }, { at: [] }, { at: {} },
      { checkpointId: null }, { checkpointId: 1 }, { checkpointId: [] }, { checkpointId: {} }, { checkpointId: '' }, { checkpointId: ' ' }, { checkpointId: ' original' }, { checkpointId: 'x'.repeat(129) },
      { checkpointId: 'original', paths: null }, { checkpointId: 'original', paths: [] }, { checkpointId: 'original', paths: [''] }, { checkpointId: 'original', paths: [1] }, { checkpointId: 'original', paths: Array(501).fill('a') },
      { checkpointId: 'original', keepEdited: null }, { checkpointId: 'original', keepEdited: 'true' },
    ];
    for (const body of invalid) expect((await restore(body)).status, JSON.stringify(body)).toBe(400);
    expect(read('a.txt')).toBe('v2');
    expect((await api('/agent/sessions/mine/checkpoints')).body.checkpoints).toHaveLength(1);
  });

  it('只在目标会话解析身份;未知/他人检查点 404,不回落到全部恢复', async () => {
    write('a.txt', 'v1'); await snapshotBeforeWrite('mine', 'original', [file('a.txt')]); write('a.txt', 'v2');
    await snapshotBeforeWrite('theirs', 'other-id', [file('a.txt')]);
    expect((await restore({ checkpointId: 'original' }, 'another')).status).toBe(404);
    expect((await restore({ checkpointId: 'other-id' }, 'theirs')).status).toBe(404);
    expect((await restore({ checkpointId: 'other-id' })).status).toBe(404);
    const missing = await restore({ checkpointId: 'no-such-checkpoint' });
    expect(missing).toEqual({ status: 404, body: { detail: 'Checkpoint not found' } });
    expect((await fetch(`${base}/agent/sessions/mine/checkpoints/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkpointId: 'original' }) })).status).toBe(401);
    expect(read('a.txt')).toBe('v2');
    expect((await api('/agent/sessions/mine/checkpoints')).body.checkpoints).toHaveLength(1);
  });

  it('数据库中的在飞 run 与 delegate 均阻止身份回退', async () => {
    write('a.txt', 'v1'); await snapshotBeforeWrite('mine', 'original', [file('a.txt')]); write('a.txt', 'v2');
    await query("INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('active', 'mine', 'owner', 'running', '{}')");
    expect((await restore({ checkpointId: 'original' })).status).toBe(409);
    await query("UPDATE agent_runs SET status = 'queued' WHERE id = 'active'");
    expect((await restore({ checkpointId: 'original' })).status).toBe(409);
    await query("UPDATE agent_runs SET status = 'done' WHERE id = 'active'");
    expect(claimDelegate('mine')).toBe(true);
    expect((await restore({ checkpointId: 'original' })).status).toBe(409);
    releaseDelegate('mine');
    expect(read('a.txt')).toBe('v2');
    expect((await restore({ checkpointId: 'original' })).status).toBe(200);
    expect(read('a.txt')).toBe('v1');
  });

  it('身份恢复继续遵守 paths 与 keepEdited,只覆盖明确选择且没有人工改写的文件', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) write(name, 'before');
    const paths = ['a.txt', 'b.txt', 'c.txt'].map(file);
    await snapshotBeforeWrite('mine', 'original', paths);
    for (const name of ['a.txt', 'b.txt', 'c.txt']) write(name, 'agent');
    await recordPostWrite('mine', 'original', paths); write('a.txt', 'user');
    const r = await restore({ checkpointId: 'original', paths: [file('a.txt'), file('b.txt')], keepEdited: true });
    expect(r.status).toBe(200);
    expect(r.body.conflicts).toEqual([file('a.txt')]);
    expect(r.body.restored).toEqual([file('b.txt')]);
    expect(['a.txt', 'b.txt', 'c.txt'].map(read)).toEqual(['user', 'before', 'agent']);
  });
});
