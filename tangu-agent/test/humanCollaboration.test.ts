import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { agentsDir } from '../src/core/tanguHome.js';
import { query } from '../src/core/db.js';
import { runMigration } from '../src/db/migrate.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { readHuman, writeHuman, renderHumanContext, removedLines, HUMAN_RULES } from '../src/agents/humanStore.js';
import { manageHumanProvider } from '../src/tools/builtin/manageHuman.js';
import { memoryLogProvider } from '../src/tools/builtin/memoryLog.js';
import { getToolDefinitions, listDeferredTools } from '../src/tools/registry.js';
import { humanProjectScope } from '../src/services/humanContext.js';
import { checkWritePath } from '../src/tools/fsPolicy.js';
import humanRouter from '../src/routes/human.js';
import { scheduleAgentFilesSync } from '../src/services/agentFileSync.js';

let home: string, project: string, base: string, server: Server, database: { close(): void };
const previousHome = process.env.TANGU_HOME;
const scope = { kind: 'agent' as const, slug: 'first' };
const api = async (url: string, method = 'GET', body?: any, extraHeaders = {}) => {
  const r = await fetch(base + url, { method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json', ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-human-'))); process.env.TANGU_HOME = home;
  project = join(home, 'project'); mkdirSync(project);
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }) } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await saveAgent({ slug: 'first', name: 'First', systemPrompt: 'fixture' });
  await saveAgent({ slug: 'shared', name: 'Shared', systemPrompt: 'fixture', shareDefaultMemory: true });
  await query('INSERT INTO chat_sessions (id, user_id, app_id, kind, project_path, projectless) VALUES (?, ?, ?, ?, ?, ?)', ['project', 'owner', 'tangu', 'user', project, 0]);
  await query('INSERT INTO chat_sessions (id, user_id, app_id, kind, project_path, projectless) VALUES (?, ?, ?, ?, ?, ?)', ['private', 'other', 'tangu', 'user', project, 0]);
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

describe('HUMAN.md collaboration lifecycle', () => {
  it('authenticates access and binds project scope to the owned session', async () => {
    expect((await fetch(base + '/agent/agents/first/human')).status).toBe(401);
    expect((await api('/agent/agents/not-created/human')).status).toBe(404);
    expect((await api('/agent/project-context/human?sessionId=private')).status).toBe(404);
    expect((await api('/agent/project-context/human?sessionId=rootless')).status).toBe(400);
    expect((await api('/agent/project-context/human?cwd=' + encodeURIComponent(project))).status).toBe(400);
  });
  it('requires a version and source evidence, writes Markdown immediately, records undo history', async () => {
    const before = await readHuman(scope);
    expect(before.exists).toBe(false);
    expect((await api('/agent/agents/first/human', 'PUT', { content: 'lost update', summary: 'edit' })).status).toBe(428);
    await expect(writeHuman(scope, { content: 'no evidence', summary: 'edit', expectedVersion: before.version }, 'agent')).rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_REQUIRED' });
    const r = await writeHuman(scope, { content: '# Together\n\nShow options before implementation.', summary: 'Show options first', evidence: 'The user asked to compare options.', expectedVersion: before.version }, 'agent');
    expect(readFileSync(r.document.path, 'utf8')).toBe(r.document.content);
    expect(r.document.history[0]).toMatchObject({ id: r.change!.id, canUndo: true, actor: 'agent' });
    expect((await api('/agent/agents/first/human')).body.content).toBe(r.document.content);
  });
  it('preserves hand edits and rejects stale saves and stale undo', async () => {
    const before = await readHuman(scope);
    writeFileSync(before.path, '# Manual edit\nPlease preserve this.');
    expect((await api('/agent/agents/first/human', 'PUT', { expectedVersion: before.version, content: 'overwrite', summary: 'edit' })).status).toBe(409);
    expect((await api('/agent/agents/first/human/undo', 'POST', { expectedVersion: before.version, changeId: before.history[0].id })).status).toBe(409);
    expect((await readHuman(scope)).content).toContain('preserve this');
  });
  it('serializes concurrent writers and only one stale-version update succeeds', async () => {
    const before = await readHuman(scope);
    const results = await Promise.allSettled(['A', 'B'].map(content => writeHuman(scope, { content, summary: content, expectedVersion: before.version }, 'user')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('undo restores the previous content, persists its status and cannot undo twice', async () => {
    const before = await readHuman(scope);
    const sync = vi.mocked(scheduleAgentFilesSync); sync.mockClear();
    const r = await api('/agent/agents/first/human', 'PUT', { expectedVersion: before.version, content: '# New agreement', summary: 'New agreement' });
    expect(r.status).toBe(200);
    expect(sync.mock.calls).toEqual([['owner', 'first']]); // 不带 slug 的调用是空操作:同步按 agent 排队
    sync.mockClear();
    const undo = await api('/agent/agents/first/human/undo', 'POST', { expectedVersion: r.body.document.version, changeId: r.body.change.id });
    expect(undo.status).toBe(200); expect(undo.body.document.content).toBe(before.content);
    expect(sync.mock.calls).toEqual([['owner', 'first']]);
    expect(undo.body.document.history[0].undoOf).toBe(r.body.change.id);
    expect((await api('/agent/agents/first/human/undo', 'POST', { expectedVersion: undo.body.document.version, changeId: r.body.change.id })).status).toBe(409);
  });
  it('uses project metadata and keeps project history outside the repository', async () => {
    const before = await api('/agent/project-context/human?sessionId=project');
    vi.mocked(scheduleAgentFilesSync).mockClear();
    const r = await api('/agent/project-context/human', 'PUT', { sessionId: 'project', expectedVersion: before.body.version, content: '# Project\nDesktop first.', summary: 'Project sequence' });
    expect(r.status).toBe(200); expect(r.body.document.path).toBe(join(project, '.tangu', 'HUMAN.md'));
    expect(scheduleAgentFilesSync).not.toHaveBeenCalled(); // 项目级手册不在任何 agent 的文件夹里,不排 agent 同步
    expect((await readHuman(scope)).content).not.toContain('Desktop first');
    expect(await humanProjectScope('owner', 'project')).toEqual({ kind: 'project', cwd: project });
  });
  it('keeps an empty post-undo scope explicit so old chat receipts do not reactivate it', async () => {
    const cwd = mkdtempSync(join(home, 'undo-empty-'));
    const target = { kind: 'project' as const, cwd };
    const before = await readHuman(target);
    expect(renderHumanContext(before)).toBe('');
    const saved = await writeHuman(target, { expectedVersion: before.version, content: 'Removed agreement', summary: 'Add agreement' }, 'user');
    const undone = await writeHuman(target, { expectedVersion: saved.document.version, undoId: saved.change!.id }, 'user');
    const block = renderHumanContext(undone.document);
    expect(block).toContain('No saved collaboration agreements are currently active');
    expect(block).toContain('supersedes earlier saved versions');
    expect(block).not.toContain('Removed agreement');
  });
  it('respects existing root and legacy HUMAN.md files', async () => {
    for (const rel of ['HUMAN.md', '.forsion/HUMAN.md']) {
      const cwd = mkdtempSync(join(home, 'legacy-'));
      mkdirSync(join(cwd, '.forsion')); writeFileSync(join(cwd, rel), '# Existing');
      const r = await readHuman({ kind: 'project', cwd }); expect(r.path).toBe(join(cwd, rel)); expect(r.content).toBe('# Existing');
    }
  });
  it('rejects symlinked project metadata and Agent files without touching the target', async () => {
    const cwd = mkdtempSync(join(home, 'unsafe-')), outside = mkdtempSync(join(home, 'outside-'));
    writeFileSync(join(outside, 'HUMAN.md'), 'private'); symlinkSync(outside, join(cwd, '.tangu'));
    await expect(readHuman({ kind: 'project', cwd })).rejects.toThrow(/symbolic link/);
    symlinkSync(join(outside, 'HUMAN.md'), join(agentsDir(), 'shared', 'HUMAN.md'));
    await expect(readHuman({ kind: 'agent', slug: 'shared' })).rejects.toThrow(/symlink/);
    rmSync(join(agentsDir(), 'shared', 'HUMAN.md'));
    expect(readFileSync(join(outside, 'HUMAN.md'), 'utf8')).toBe('private');
  });
  it('takes the Agent directory lock that cloud sync commits under; project handbooks do not', async () => {
    // Agent 级 HUMAN.md 参与云同步,同步落盘拿的是 agent 目录的 .memory.lock:另一个进程持锁时,这里必须让路而不是插进去写。
    const lock = join(agentsDir(), 'first', '.memory.lock'), projectLock = join(project, '.memory.lock');
    const before = await readHuman(scope);
    for (const file of [lock, projectLock]) writeFileSync(file, JSON.stringify({ pid: 0, createdAt: Date.now() }));
    try {
      await expect(writeHuman(scope, { expectedVersion: before.version, content: '# Raced', summary: 'Raced' }, 'user')).rejects.toMatchObject({ code: 'MEMORY_BUSY' });
      expect((await readHuman(scope)).version).toBe(before.version);
      const projectDoc = await readHuman({ kind: 'project', cwd: project });
      expect((await writeHuman({ kind: 'project', cwd: project }, { expectedVersion: projectDoc.version, content: `${projectDoc.content}\nStill writable.`, summary: 'Project edit' }, 'user')).change).not.toBeNull();
    } finally { rmSync(lock); rmSync(projectLock); } // 项目目录里那把不是我们的锁:项目级手册不看它,也不在项目根留锁文件
    expect((await writeHuman(scope, { expectedVersion: before.version, content: `${before.content}\nAfter the lock.`, summary: 'After lock' }, 'user')).change).not.toBeNull();
  });
  it('keeps collaboration with the display Agent when memories are shared', async () => {
    const tool = manageHumanProvider.tools()[0];
    const ctx = { userId: 'owner', sessionId: 'rootless', appId: 'tangu', execMode: 'sandbox' as const, agentSlug: 'shared' };
    expect(tool.isEnabledFor!(deps().profile, ctx)).toBe(true);
    const sync = vi.mocked(scheduleAgentFilesSync); sync.mockClear();
    const result = await runWithAgentSlug('first', async () => {
      const before = JSON.parse(await tool.execute({ action: 'read', scope: 'agent' }, ctx));
      expect(before.howToWrite).toContain('The human is the reader'); // 写法跟着读取结果回来:模型动笔前刚读到的地方
      expect(before.version).toHaveLength(12); // 交给模型抄回来的是短版本号
      const saved = JSON.parse(await tool.execute({ action: 'update', scope: 'agent', expectedVersion: before.version, content: '# Shared\nUse sketches.', summary: 'Sketches', evidence: 'Explicit request' }, ctx));
      // 旧版本号(文档已经变了)照样被挡下,不因为只比前 12 位而放过去
      expect(await tool.execute({ action: 'update', scope: 'agent', expectedVersion: before.version, content: '# Stale', summary: 'Stale', evidence: 'Stale' }, ctx)).toContain('changed elsewhere');
      // 只认恰好 12 位的短版本号:后面多带了东西、或完整版本号抄错了尾巴,都不放行
      const now = JSON.parse(await tool.execute({ action: 'read', scope: 'agent' }, ctx)).version;
      for (const bad of [`${now}-garbage`, `${now}${'0'.repeat(52)}`]) expect(await tool.execute({ action: 'update', scope: 'agent', expectedVersion: bad, content: '# Bad', summary: 'Bad', evidence: 'Bad' }, ctx)).toContain('changed elsewhere');
      expect(saved.moved).toBeUndefined(); // 从空文档写起:没有拿掉任何一行,不用交代
      // 只加不删:照常存。拿掉了行的:先不存,把这些行按原文档里的行号交回;逐行交代全了才存,归 memory 的那句由工具直接记进记忆
      const added = JSON.parse(await tool.execute({ action: 'update', scope: 'agent', expectedVersion: now, content: '# Shared\nUse sketches.\nI will run the script first.\nTell me who reads it.', summary: 'More', evidence: 'More' }, ctx));
      expect(added.kind).toBe('human_update');
      const tidy = { action: 'update', scope: 'agent', expectedVersion: added.version, content: '# Working with me\nTell me who will read it.', summary: 'Tidy', evidence: 'Asked to tidy' };
      const pending = JSON.parse(await tool.execute(tidy, ctx));
      expect(pending).toMatchObject({ kind: 'human_pending', saved: false, removed: [{ line: 1, text: 'Use sketches.', under: 'Shared' }, { line: 2, text: 'I will run the script first.', under: 'Shared' }, { line: 3, text: 'Tell me who reads it.', under: 'Shared' }] });
      expect(pending.problems).toBeUndefined(); // 第一次只是没交代,不算出错
      expect((await readHuman({ kind: 'agent', slug: 'shared' })).content).toContain('I will run the script first.'); // 什么都没存
      // 三种写法各自整句匹配:dropped 不写理由、memory 不带句子、「reworded into memory: …」这种混写都不认(混写原先被当成 reworded,那一句就没记);
      // 同一行说了两次的作废重来;不在名单里的行号(9)多说了不算错
      const partial = JSON.parse(await tool.execute({ ...tidy, removed: ['1 dropped', '2 reworded into memory: Run it.', '3 reworded', '3 dropped: twice', '9 reworded', 'nonsense'] }, ctx));
      expect(partial.kind).toBe('human_pending');
      expect(partial.problems).toEqual([expect.stringContaining('Not understood: "1 dropped"'), expect.stringContaining('Not understood: "2 reworded into memory: Run it."'), 'Line 3: given more than once; say where it went once.', expect.stringContaining('Not understood: "nonsense"'), 'Line 1: not accounted for.', 'Line 2: not accounted for.']);
      expect((await deps().brain.memory.getMemorySnapshot!('owner')).entries.map((e) => e.content)).not.toContain('Run it.');
      const tooLong = JSON.parse(await tool.execute({ ...tidy, removed: ['1 dropped: unused', `2 memory: ${'x'.repeat(301)}`, '3 reworded'] }, ctx));
      expect(tooLong.problems).toEqual(['Line 2: the sentence is 301 characters; at most 300.']);
      // 两句要记、第二句没记上:文档不动,照实说第一句已经在记忆里
      const real = memoryLogProvider.tools().find((x) => x.name === 'remember')!; let calls = 0;
      const spy = vi.spyOn(memoryLogProvider, 'tools').mockReturnValue([{ ...real, execute: async (a, c) => { if (++calls === 1) return real.execute(a, c); throw new Error('MEMORY_BUSY'); } }]); // 第二句是抛出来的(别处占着锁),不是一句 Error 回执
      const half = JSON.parse(await tool.execute({ ...tidy, removed: ['1 memory: The human likes sketches.', '2 memory: Run the script before saying it is done.', '3 reworded'] }, ctx));
      spy.mockRestore();
      expect(half).toMatchObject({ kind: 'human_pending', saved: false, alreadySaved: ['The human likes sketches.'], problems: [expect.stringContaining('Line 2: could not be saved to memory')] });
      expect((await readHuman({ kind: 'agent', slug: 'shared' })).content).toContain('I will run the script first.');
      const done = JSON.parse(await tool.execute({ ...tidy, removed: ['1 dropped: The human stopped using sketches.', '2 memory: Run the script before saying it is done.', '3 reworded'] }, ctx));
      expect(done).toMatchObject({ kind: 'human_update', moved: [{ line: 'I will run the script first.', fact: 'Run the script before saying it is done.', memory: { scope: 'agent', entryId: expect.any(String), content: 'Run the script before saying it is done.' } }], dropped: [{ line: 'Use sketches.', reason: 'The human stopped using sketches.' }] });
      expect(done.change.summary).toBe('Tidy');
      expect((await deps().brain.memory.getMemorySnapshot!('owner')).entries.map((e) => e.content)).toContain('Run the script before saying it is done.');
      // 会让落盘失败的(缺依据、摘要太长、版本不是现在这一版)都在记记忆之前挡下
      const gone = { action: 'update', scope: 'agent', content: '# Empty', removed: ['1 memory: Should not be saved.'] };
      expect(await tool.execute({ ...gone, expectedVersion: done.version, summary: 'x' }, ctx)).toMatch(/^Error: Say what happened/);
      expect(await tool.execute({ ...gone, expectedVersion: done.version, summary: 'x'.repeat(241), evidence: 'e' }, ctx)).toMatch(/^Error: A short change summary/);
      expect(await tool.execute({ ...gone, expectedVersion: added.version, summary: 'x', evidence: 'e' }, ctx)).toContain('changed elsewhere');
      expect((await deps().brain.memory.getMemorySnapshot!('owner')).entries.map((e) => e.content)).not.toContain('Should not be saved.');
      // 比的是落盘后的样子:密钥那一行落盘时会被抹掉,所以它算被拿掉的行(原先按抹之前的内容比,它悄悄没了)
      // 比的是落盘后的样子:新内容里带密钥的那一行落盘时会被抹成 [REDACTED],和磁盘上原有的那一行是同一行,不算拿掉
      // (原先按抹之前的内容比,会把它当成被拿掉的行交回去)
      const key = `sk-${'a1'.repeat(12)}`;
      const kept = JSON.parse(await tool.execute({ action: 'update', scope: 'agent', expectedVersion: done.version, content: `# Working with me\nTell me who will read it.\nThe demo key is ${key}.`, summary: 'Key', evidence: 'Asked' }, ctx));
      expect(kept.kind).toBe('human_update');
      const again = JSON.parse(await tool.execute({ action: 'update', scope: 'agent', expectedVersion: kept.version, content: `# Working with me\nTell me who will read it.\nThe demo key is ${key}.\nSay when it is due.`, summary: 'Due', evidence: 'Asked' }, ctx));
      expect(again.kind).toBe('human_update');
      return saved;
    }, 'shared');
    expect(result.kind).toBe('human_update'); expect(result.change.scope).toEqual({ kind: 'agent', slug: 'shared' });
    expect(sync.mock.calls).toEqual(Array(5).fill(['owner', 'shared'])); // 存上的五次各排一次;归属(显示)agent,不是记忆桶 'first';只读、被挡下的、等交代的都不排同步
    expect((await readHuman(scope)).content).not.toContain('Use sketches');
    expect((await readHuman({ kind: 'agent', slug: 'shared' })).content).toBe('# Working with me\nTell me who will read it.\nThe demo key is [REDACTED].\nSay when it is due.');
    // agent 的写入盖上写法版本的章;用户自己改的不盖(界面靠这个认「旧版本写的」)
    const after = await writeHuman({ kind: 'agent', slug: 'shared' }, { expectedVersion: (await readHuman({ kind: 'agent', slug: 'shared' })).version, content: '# Mine', summary: 'Hand edit' }, 'user');
    expect(after.document.history.map((h) => [h.actor, h.rules])).toEqual([['user', undefined], ...Array(5).fill(['agent', HUMAN_RULES])]);
  });
  it('lists the lines an update took out: whole lines, numbered by the old note, headings and blanks ignored, reworded lines included', () => {
    const before = '# 协作约定\n\n- 先说给谁看。\n- 先说给谁看。\n\n## 我这边会做\n\n改完实际运行,并把结果贴出来。\n---\n';
    // under = 原来所在的小节:没有主语的那一句是谁的事,看它在哪个标题下面
    expect(removedLines(before, '# 怎么配合\n\n- 先说给谁看。\n')).toEqual([{ line: 2, text: '改完实际运行,并把结果贴出来。', under: '我这边会做' }]);
    expect(removedLines(before, '- 你先说给谁看。')).toEqual([{ line: 1, text: '- 先说给谁看。', under: '协作约定' }, { line: 2, text: '改完实际运行,并把结果贴出来。', under: '我这边会做' }]);
    expect(removedLines('没有标题的一行', '')).toEqual([{ line: 1, text: '没有标题的一行' }]);
    expect(removedLines('', '- x')).toEqual([]);
    expect(removedLines(before, before)).toEqual([]);
  });
  it('keeps collaboration available on a fresh chat or work turn without loading it again', () => {
    for (const preset of ['chat', 'work'] as const) {
      const ctx = { userId: 'owner', sessionId: 'rootless', appId: 'tangu', execMode: 'sandbox' as const, preset, profile: deps().profile };
      const visible = (extra = {}) => getToolDefinitions({ ...ctx, ...extra }).map(t => t.function.name);
      expect(visible()).toContain('manage_human');
      expect(listDeferredTools(ctx).map(t => t.name)).not.toContain('manage_human');
      for (const extra of [{ planMode: true }, { ephemeral: true }, { subAgentDepth: 1 }, { remote: { marked: true } }, { toolsMode: 'deny' as const, toolsList: ['manage_human'] }]) {
        expect(visible(extra)).not.toContain('manage_human');
      }
    }
  });
  it('does not bypass plan, remote, ephemeral, or delegated execution boundaries', async () => {
    const tool = manageHumanProvider.tools()[0];
    const ctx = { userId: 'owner', sessionId: 'rootless', appId: 'tangu', execMode: 'host' as const };
    for (const extra of [{ planMode: true }, { ephemeral: true }, { subAgentDepth: 1 }, { remote: { marked: true } }]) {
      expect(tool.isEnabledFor!(deps().profile, { ...ctx, ...extra })).toBe(false);
      expect(await tool.execute({ action: 'update', scope: 'agent' }, { ...ctx, ...extra })).toMatch(/^Error:/);
    }
    expect((await api('/agent/agents/first/human', 'GET', undefined, { 'x-forsion-remote': 'lan' })).status).toBe(403);
  });
  it('generic write tools cannot silently change HUMAN.md without a receipt', () => {
    expect(checkWritePath({ userId: 'owner', sessionId: 'project', appId: 'tangu', cwd: project, execMode: 'host' }, join(project, '.tangu/HUMAN.md'))).toMatchObject({ ok: false, hardDeny: true });
  });
});
