/** P1 · K2 §3.6:远端批准 Muse TODO 的台账 —— 急停撤回还没跑的(删条目 + TODO 回 pending),已跑过 / 已不在的只出账不动。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { recordRemoteCreated, listRemoteCreated, revertRemoteMuseEntries, remoteCreatedFile } from './remoteCreated.js';
import { ensureEntry, validateEntryInput, loadSchedule, entriesOf, markEntryFired, removeEntry } from './agentSchedule.js';

let home: string;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-remote-created-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function entry(todoId: string): Promise<string> {
  await query(`INSERT INTO muse_todos (id, user_id, title, status) VALUES (?, 'u1', ?, 'injected')`, [todoId, todoId]);
  const v = validateEntryInput({ name: todoId, date: '2026-09-28T10:00', auto: true, todo: true, prompt: 'do it', description: `todo ${todoId}` });
  if (!v.ok) throw new Error(v.error);
  const r = await ensureEntry('muse', v.value, (e) => e.description === `todo ${todoId}`);
  if (!r.ok) throw new Error(r.error);
  await recordRemoteCreated({ kind: 'muse-todo', slug: 'muse', entryId: r.entry.id, todoId, via: 'tunnel' });
  return r.entry.id;
}
const statusOf = async (id: string): Promise<string> => (await query<any[]>(`SELECT status FROM muse_todos WHERE id = ?`, [id]))[0].status;
const ids = async (): Promise<string[]> => entriesOf((await loadSchedule('muse'))!).map((e) => e.id);

describe('remoteCreated', () => {
  it('还没跑的撤回、已跑过的不动、已不在的出账;账清空;台账落在引擎 home、0600', async () => {
    const fresh = await entry('T-fresh');
    const ran = await entry('T-ran');
    const gone = await entry('T-gone');
    await markEntryFired('muse', ran);
    await removeEntry('muse', gone);
    expect((await listRemoteCreated()).map((x) => x.todoId).sort()).toEqual(['T-fresh', 'T-gone', 'T-ran']);
    expect(remoteCreatedFile().startsWith(home)).toBe(true);
    expect(JSON.parse(readFileSync(remoteCreatedFile(), 'utf8')).v).toBe(1);

    expect(await revertRemoteMuseEntries()).toBe(1);
    expect(await ids()).not.toContain(fresh);
    expect(await ids()).toContain(ran);
    expect(await statusOf('T-fresh')).toBe('pending');
    expect(await statusOf('T-ran')).toBe('injected');
    expect(await listRemoteCreated()).toEqual([]);
    expect(await revertRemoteMuseEntries()).toBe(0); // 幂等
  });

  it('同一条目重复登记只留一行', async () => {
    await entry('T-dup');
    const [it] = (await listRemoteCreated()).filter((x) => x.todoId === 'T-dup');
    await recordRemoteCreated({ kind: 'muse-todo', slug: 'muse', entryId: it.entryId, todoId: 'T-dup' });
    expect((await listRemoteCreated()).filter((x) => x.todoId === 'T-dup')).toHaveLength(1);
  });
});
