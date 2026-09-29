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
import { readHuman, writeHuman, renderHumanContext } from '../src/agents/humanStore.js';
import { manageHumanProvider } from '../src/tools/builtin/manageHuman.js';
import { getToolDefinitions, listDeferredTools } from '../src/tools/registry.js';
import { humanProjectScope } from '../src/services/humanContext.js';
import { checkWritePath } from '../src/tools/fsPolicy.js';
import humanRouter from '../src/routes/human.js';

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
    const r = await api('/agent/agents/first/human', 'PUT', { expectedVersion: before.version, content: '# New agreement', summary: 'New agreement' });
    expect(r.status).toBe(200);
    const undo = await api('/agent/agents/first/human/undo', 'POST', { expectedVersion: r.body.document.version, changeId: r.body.change.id });
    expect(undo.status).toBe(200); expect(undo.body.document.content).toBe(before.content);
    expect(undo.body.document.history[0].undoOf).toBe(r.body.change.id);
    expect((await api('/agent/agents/first/human/undo', 'POST', { expectedVersion: undo.body.document.version, changeId: r.body.change.id })).status).toBe(409);
  });
  it('uses project metadata and keeps project history outside the repository', async () => {
    const before = await api('/agent/project-context/human?sessionId=project');
    const r = await api('/agent/project-context/human', 'PUT', { sessionId: 'project', expectedVersion: before.body.version, content: '# Project\nDesktop first.', summary: 'Project sequence' });
    expect(r.status).toBe(200); expect(r.body.document.path).toBe(join(project, '.tangu', 'HUMAN.md'));
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
  it('keeps collaboration with the display Agent when memories are shared', async () => {
    const tool = manageHumanProvider.tools()[0];
    const ctx = { userId: 'owner', sessionId: 'rootless', appId: 'tangu', execMode: 'sandbox' as const, agentSlug: 'shared' };
    expect(tool.isEnabledFor!(deps().profile, ctx)).toBe(true);
    const result = await runWithAgentSlug('first', async () => {
      const before = JSON.parse(await tool.execute({ action: 'read', scope: 'agent' }, ctx));
      return JSON.parse(await tool.execute({ action: 'update', scope: 'agent', expectedVersion: before.version, content: '# Shared\nUse sketches.', summary: 'Sketches', evidence: 'Explicit request' }, ctx));
    }, 'shared');
    expect(result.kind).toBe('human_update'); expect(result.change.scope).toEqual({ kind: 'agent', slug: 'shared' });
    expect((await readHuman(scope)).content).not.toContain('Use sketches');
    expect((await readHuman({ kind: 'agent', slug: 'shared' })).content).toContain('Use sketches');
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
