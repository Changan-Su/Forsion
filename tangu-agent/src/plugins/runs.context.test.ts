import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';

const m = vi.hoisted(() => ({
  alive: true, local: true, remote: false, runId: undefined as string | undefined,
  db: null as any, queries: [] as string[], gate: undefined as Promise<void> | undefined,
}));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({
    profile: { capabilities: { hostExec: m.local } },
    host: {
      query: async (sql: string, params: unknown[]) => {
        m.queries.push(sql);
        const rows = m.db.prepare(sql).all(...params);
        await m.gate;
        return rows;
      },
      getDbType: () => 'sqlite',
    },
  }),
}));
vi.mock('../seams/runContext.js', async (original) => ({
  ...await original<typeof import('../seams/runContext.js')>(), currentRunId: () => m.runId,
}));
vi.mock('../services/remoteOrigin.js', async (original) => ({
  ...await original<typeof import('../services/remoteOrigin.js')>(), effectiveRemote: () => m.remote,
}));
import { createPluginRuns } from './runs.js';

const cwd = path.resolve('context-project');
const sdk = () => createPluginRuns('test-panel', () => m.alive);
const insert = (id: string, user: string, project: string | null, model: string | null, config: string | null) =>
  m.db.prepare('INSERT INTO chat_sessions VALUES (?, ?, ?, ?, ?, ?)').run(id, user, project, model, config, 'private chat title');

beforeEach(() => {
  Object.assign(m, { alive: true, local: true, remote: false, runId: undefined, gate: undefined, queries: [] });
  m.db = new Database(':memory:');
  m.db.exec('CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, user_id TEXT, project_path TEXT, model_id TEXT, agent_config TEXT, title TEXT)');
  // No messages table: reading chat bodies would fail this fixture.
  insert('native-session', 'alice', cwd, 'codex/test', JSON.stringify({ thinkingLevel: 'high', approvalMode: 'auto-edit', secret: 'must stay private' }));
});
afterEach(() => { m.db.close(); vi.restoreAllMocks(); });

it('reads only the authenticated user session metadata, without requiring task/plugin ownership', async () => {
  expect(await sdk().context('native-session', 'alice')).toEqual({
    sessionId: 'native-session', cwd, modelId: 'codex/test', thinkingLevel: 'high', approvalMode: 'auto-edit',
  });
  expect(m.queries).toEqual(['SELECT id, project_path, model_id, agent_config FROM chat_sessions WHERE id = ? AND user_id = ?']);
});

it('gives the same error for foreign and missing sessions', async () => {
  await expect(sdk().context('native-session', 'mallory')).rejects.toThrow('Session not found');
  await expect(sdk().context('missing', 'alice')).rejects.toThrow('Session not found');
});

it('rejects empty session and user IDs before accessing the database', async () => {
  await expect(sdk().context('', 'alice')).rejects.toThrow('Session and authenticated user are required');
  await expect(sdk().context('native-session', '  ')).rejects.toThrow('Session and authenticated user are required');
  await expect(sdk().context(undefined as any, 'alice')).rejects.toThrow('Session and authenticated user are required');
  expect(m.queries).toEqual([]);
});

it('does not infer a directory, model, effort or approval for a projectless session', async () => {
  insert('projectless', 'alice', null, null, JSON.stringify({ cwd, title: 'private config' }));
  expect(await sdk().context('projectless', 'alice')).toEqual({
    sessionId: 'projectless', cwd: null, modelId: null, thinkingLevel: null, approvalMode: null,
  });
  insert('relative', 'alice', 'relative/path', '', null);
  expect((await sdk().context('relative', 'alice')).cwd).toBeNull();
});

it('fails on unreadable configuration and restricts unknown nonempty approval modes', async () => {
  insert('broken', 'alice', cwd, null, '{');
  await expect(sdk().context('broken', 'alice')).rejects.toThrow();
  insert('unknown-mode', 'alice', cwd, null, JSON.stringify({ approvalMode: 'new-unknown-mode' }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect((await sdk().context('unknown-mode', 'alice')).approvalMode).toBe('readonly');
});

it('rejects disabled plugins, non-local engines and remote runs before reading metadata', async () => {
  m.alive = false;
  await expect(sdk().context('native-session', 'alice')).rejects.toThrow('Plugin is disabled');
  m.alive = true; m.local = false;
  await expect(sdk().context('native-session', 'alice')).rejects.toThrow('Task runs require a local engine');
  m.local = true; m.runId = 'remote-run'; m.remote = true;
  await expect(sdk().context('native-session', 'alice')).rejects.toThrow('Task dispatch requires local authorization');
  expect(m.queries).toEqual([]);
});

it('does not return metadata after the plugin is disabled during the query', async () => {
  let release!: () => void;
  m.gate = new Promise<void>(resolve => { release = resolve; });
  const result = sdk().context('native-session', 'alice');
  expect(m.queries).toHaveLength(1);
  m.alive = false;
  release();
  await expect(result).rejects.toThrow('Plugin is disabled');
});
