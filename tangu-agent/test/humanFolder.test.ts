// human/ 文件夹第 1 步(10-20):USER.md → MEMORY.md 迁移与双写、human 范围的版本与撤销、路由、About the Human、manage_human 第三维、文件工具硬拒。
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, existsSync, utimesSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { ensureHumanFolder, humanDir, readUserMd, userMdFile } from '../src/core/tanguHome.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { readHuman, writeHuman, renderHumanContext } from '../src/agents/humanStore.js';
import { renderAboutHuman, syncUserMdIntoHumanMemory } from '../src/agents/humanFolder.js';
import { manageHumanProvider } from '../src/tools/builtin/manageHuman.js';
import { checkWritePath } from '../src/tools/fsPolicy.js';
import humanRouter from '../src/routes/human.js';

let home: string, base: string, server: Server, database: { close(): void };
const previousHome = process.env.TANGU_HOME;
const api = async (url: string, method = 'GET', body?: any, extraHeaders = {}) => {
  const r = await fetch(base + url, { method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json', ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const memory = () => join(humanDir(), 'MEMORY.md');
beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-humanfolder-'))); process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }) } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await saveAgent({ slug: 'first', name: 'First', systemPrompt: 'fixture' });
  await query('INSERT INTO chat_sessions (id, user_id, app_id, kind, projectless) VALUES (?, ?, ?, ?, ?)', ['rootless', 'owner', 'tangu', 'user', 1]);
  const app = express(); app.use(express.json()); app.use(humanRouter);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  database?.close(); rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('human/ folder, step 1', () => {
  it('copies USER.md into MEMORY.md once and never clobbers it afterwards', () => {
    rmSync(humanDir(), { recursive: true, force: true });
    writeFileSync(userMdFile(), 'I am Lin.');
    ensureHumanFolder();
    expect(readFileSync(memory(), 'utf8')).toBe('I am Lin.');
    writeFileSync(memory(), 'Edited in the new place.');
    writeFileSync(userMdFile(), 'Old place changed later.');
    ensureHumanFolder();
    expect(readFileSync(memory(), 'utf8')).toBe('Edited in the new place.');
    expect(readUserMd()).toBe('Edited in the new place.'); // 读者认新位置
    rmSync(memory());
    expect(readUserMd()).toBe('Old place changed later.'); // 没迁过来时退回 USER.md
  });

  it('keeps versions and undo for every file in the folder, and refuses unknown files', async () => {
    const soul = { kind: 'human' as const, file: 'SOUL.md' as const };
    const before = await readHuman(soul);
    expect(before.exists).toBe(false);
    await expect(writeHuman(soul, { content: 'Calls them Lin.', summary: 'Name', expectedVersion: before.version }, 'agent')).rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_REQUIRED' });
    const r = await writeHuman(soul, { content: 'Calls them Lin.', summary: 'Name', evidence: 'They said so.', expectedVersion: before.version }, 'agent');
    expect(readFileSync(join(humanDir(), 'SOUL.md'), 'utf8')).toBe('Calls them Lin.');
    const undone = await writeHuman(soul, { expectedVersion: r.document.version, undoId: r.change!.id }, 'user');
    expect(undone.document.content).toBe('');
    await expect(readHuman({ kind: 'human', file: 'CALENDAR.db' as any })).rejects.toMatchObject({ code: 'HUMAN_NOT_FOUND' });
  });

  it('serves the folder over HTTP, writes MEMORY.md through to USER.md, and stays host-only', async () => {
    const got = await api('/agent/human/MEMORY.md');
    expect(got.status).toBe(200);
    const put = await api('/agent/human/MEMORY.md', 'PUT', { content: 'Runs on weekends.', summary: 'Edit', expectedVersion: got.body.version });
    expect(put.status).toBe(200);
    expect(readFileSync(userMdFile(), 'utf8')).toBe('Runs on weekends.'); // 第 2 步之前同步只认 USER.md
    const undo = await api('/agent/human/MEMORY.md/undo', 'POST', { changeId: put.body.change.id, expectedVersion: put.body.document.version });
    expect(undo.status).toBe(200);
    expect(readFileSync(userMdFile(), 'utf8')).toBe(undo.body.document.content);
    expect((await api('/agent/human/CALENDAR.db')).status).toBe(404);
    expect((await api('/agent/human/..%2FUSER.md')).status).toBe(404);
    expect((await api('/agent/human/AGENT.md', 'GET', undefined, { 'x-forsion-remote': 'lan' })).status).toBe(403);
  });

  it('folds a newer USER.md pulled from another device into MEMORY.md with an undoable record, but not an older one', async () => {
    const doc = await readHuman({ kind: 'human', file: 'MEMORY.md' });
    await writeHuman({ kind: 'human', file: 'MEMORY.md' }, { content: 'Local text.', summary: 'Edit', expectedVersion: doc.version }, 'user');
    writeFileSync(userMdFile(), 'Older text from the cloud.');
    utimesSync(userMdFile(), new Date(0), new Date(0));
    expect(await syncUserMdIntoHumanMemory()).toBe(false);
    expect(readFileSync(memory(), 'utf8')).toBe('Local text.');
    writeFileSync(userMdFile(), 'Newer text from the phone.');
    const future = new Date(Date.now() + 60_000); utimesSync(userMdFile(), future, future);
    expect(await syncUserMdIntoHumanMemory()).toBe(true);
    const after = await readHuman({ kind: 'human', file: 'MEMORY.md' });
    expect(after.content).toBe('Newer text from the phone.');
    expect(after.history[0]).toMatchObject({ actor: 'user', canUndo: true });
    expect(await syncUserMdIntoHumanMemory()).toBe(false); // 同样内容不再记第二条
    writeFileSync(userMdFile(), ''); // 旧设备在设置里清空了
    const later = new Date(Date.now() + 120_000); utimesSync(userMdFile(), later, later);
    expect(await syncUserMdIntoHumanMemory()).toBe(true);
    expect(readFileSync(memory(), 'utf8')).toBe('');
  });

  it('keeps an old profile longer than the handbook limit editable, and does not migrate through a symlinked folder', async () => {
    const long = 'x'.repeat(15000);
    writeFileSync(memory(), long);
    const doc = await readHuman({ kind: 'human', file: 'MEMORY.md' });
    expect(doc.content).toBe(long);
    await writeHuman({ kind: 'human', file: 'MEMORY.md' }, { content: 'Short now.', summary: 'Edit', expectedVersion: doc.version }, 'user');
    await expect(readHuman({ kind: 'human', file: 'HUMAN.md' }).then(d => writeHuman({ kind: 'human', file: 'HUMAN.md' }, { content: long, summary: 'Edit', expectedVersion: d.version }, 'user'))).rejects.toMatchObject({ code: 'HUMAN_INVALID_CONTENT' });
    const elsewhere = mkdtempSync(join(tmpdir(), 'tangu-humanfolder-elsewhere-'));
    renameSync(humanDir(), `${humanDir()}.real`); symlinkSync(elsewhere, humanDir());
    writeFileSync(userMdFile(), 'Private.');
    ensureHumanFolder();
    expect(existsSync(join(elsewhere, 'MEMORY.md'))).toBe(false);
    rmSync(humanDir()); renameSync(`${humanDir()}.real`, humanDir()); rmSync(elsewhere, { recursive: true, force: true });
  });

  it('renders About the Human from AGENT.md, MEMORY.md and SOUL.md, and nothing when all are empty', async () => {
    for (const f of ['AGENT.md', 'MEMORY.md', 'SOUL.md']) rmSync(join(humanDir(), f), { force: true });
    rmSync(userMdFile(), { force: true });
    expect(renderAboutHuman()).toBe('');
    writeFileSync(join(humanDir(), 'AGENT.md'), 'Lead with the answer.');
    writeFileSync(join(humanDir(), 'SOUL.md'), 'x'.repeat(5000));
    const block = renderAboutHuman();
    expect(block).toContain('## About the Human');
    expect(block).toContain('Lead with the answer.');
    expect(block).toContain('…(truncated)'); // 画像 ≤2000
    expect(block).not.toContain('What they wrote about themselves');
  });

  it('manage_human writes the shared note as a third dimension and shows the other notes on read', async () => {
    const tool = manageHumanProvider.tools()[0];
    const ctx = { userId: 'owner', sessionId: 'rootless', appId: 'tangu', execMode: 'sandbox' as const, agentSlug: 'first' };
    await runWithAgentSlug('first', async () => {
      const agentRead = JSON.parse(await tool.execute({ action: 'read', scope: 'agent' }, ctx));
      await tool.execute({ action: 'update', scope: 'agent', expectedVersion: agentRead.version, content: 'Tell me which project first.', summary: 'Project first', evidence: 'Asked twice' }, ctx);
      const shared = JSON.parse(await tool.execute({ action: 'read', scope: 'shared' }, ctx));
      expect(shared.others).toMatchObject({ agent: 'Tell me which project first.' });
      const saved = JSON.parse(await tool.execute({ action: 'update', scope: 'shared', expectedVersion: shared.version, content: 'Look at the plan before saying go.', summary: 'Plan first', evidence: 'Every agent needed it' }, ctx));
      expect(saved.change.scope).toEqual({ kind: 'human', file: 'HUMAN.md' });
    });
    const doc = await readHuman({ kind: 'human', file: 'HUMAN.md' });
    expect(readFileSync(join(humanDir(), 'HUMAN.md'), 'utf8')).toBe('Look at the plan before saying go.');
    expect(renderHumanContext(doc)).toContain('shared collaboration handbook for this person');
    expect(await tool.execute({ action: 'read', scope: 'project' }, ctx)).toMatch(/^Error: This session has no project/);
  });

  it('generic file tools cannot write into the human folder', () => {
    for (const f of ['HUMAN.md', 'SOUL.md', 'MEMORY.md', 'AGENT.md', 'notes.txt']) {
      expect(checkWritePath({ userId: 'owner', sessionId: 'rootless', appId: 'tangu', cwd: home, execMode: 'host' }, join(humanDir(), f))).toMatchObject({ ok: false, hardDeny: true });
    }
    expect(existsSync(join(humanDir(), 'notes.txt'))).toBe(false);
  });
});
