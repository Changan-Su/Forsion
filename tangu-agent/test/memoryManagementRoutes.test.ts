/** Synthetic HTTP/tool integration: no real account, network or personal memory. */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
vi.mock('../src/services/memorySyncService.js', () => ({ syncNow: vi.fn(), getSyncStatus: vi.fn() }));
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { memoryLogProvider } from '../src/tools/builtin/memoryLog.js';
import agentsRouter from '../src/routes/agents.js';
import memoryRouter from '../src/routes/memory.js';
let home: string;
let server: Server;
let base: string;
let database: { close(): void };
const previousHome = process.env.TANGU_HOME;
const api = async (path: string, method = 'GET', body?: any) => {
  const r = await fetch(base + path, { method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-memory-http-')); process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'fixture', userId: 'fixture-user' }); database = db;
  configureTangu({ host, brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }) } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await saveAgent({ slug: 'first', name: 'First', systemPrompt: 'fixture' });
  await saveAgent({ slug: 'second', name: 'Second', systemPrompt: 'fixture' });
  await saveAgent({ slug: 'shared', name: 'Shared', systemPrompt: 'fixture', shareDefaultMemory: true });
  const app = express(); app.use(express.json()); app.use(agentsRouter); app.use(memoryRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  database?.close();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('versioned Agent memory management', () => {
  it('requires authentication and refuses an unknown or traversing scope', async () => {
    expect((await fetch(base + '/agent/agents/first/memory')).status).toBe(401);
    expect((await api('/agent/memory', 'POST', { slug: '../outside', text: 'fixture' })).status).toBe(400);
    expect((await api('/agent/memory', 'POST', { slug: 'not-created', text: 'fixture' })).status).toBe(404);
  });

  it('requires a version for full replacement and prevents stale UI overwrite', async () => {
    const before = await api('/agent/agents/first/memory');
    expect((await api('/agent/agents/first/memory', 'PUT', { content: 'no version' })).status).toBe(428);
    const saved = await api('/agent/agents/first/memory', 'PUT', { content: 'first durable fact', expectedVersion: before.body.version });
    expect(saved.status).toBe(200);
    const stale = await api('/agent/agents/first/memory', 'PUT', { content: 'stale overwrite', expectedVersion: before.body.version });
    expect(stale.status).toBe(409);
    expect((await api('/agent/agents/first/memory')).body.content).toBe('first durable fact');
    expect((await api('/agent/agents/second/memory')).body.content).toBe('');
  });

  it('only permits the existing explicit shared-default exception', async () => {
    expect((await api('/agent/memory', 'POST', { slug: 'shared', text: 'explicit shared fact' })).status).toBe(200);
    expect((await api('/agent/memory')).body.content).toBe('explicit shared fact');
    expect((await api('/agent/agents/second/memory')).body.content).toBe('');
  });

  it('returns retained revisions and refuses restore to silently undo forgetting', async () => {
    const before = (await api('/agent/agents/first/memory')).body;
    const forgotten = await api('/agent/agents/first/memory/entries', 'POST', { action: 'forget', id: before.entries[0].id, expectedVersion: before.version });
    expect(forgotten.status).toBe(200);
    const history = await api('/agent/agents/first/memory/revisions');
    expect(history.body.revisions.some((r: any) => r.version === before.version)).toBe(true);
    const restored = await api('/agent/agents/first/memory/restore', 'POST', { version: before.version, expectedVersion: forgotten.body.version });
    expect(restored.status).toBe(200);
    expect(restored.body.content).toBe('');
  });

  it('validates LOG dates and rejects stale log replacement', async () => {
    const route = '/agent/agents/first/log?date=2026-09-08';
    const before = await api(route);
    expect((await api(route, 'PUT', { content: 'manual log' })).status).toBe(428);
    expect((await api(route, 'PUT', { content: 'manual log', expectedVersion: before.body.version })).status).toBe(200);
    expect((await api(route, 'PUT', { content: 'stale', expectedVersion: before.body.version })).status).toBe(409);
    expect((await api('/agent/agents/first/log?date=2026-02-30', 'PUT', { content: 'invalid', expectedVersion: 'x' })).status).toBe(400);
  });

  it('remember uses only the current Agent, retains source, and requires listed version for forgetting', async () => {
    const tool = memoryLogProvider.tools().find(t => t.name === 'remember')!;
    expect((tool.definition as any).function.parameters.properties.agentSlug).toBeUndefined();
    const ctx = { userId: 'fixture-user', sessionId: 'source-session', runId: 'source-run', appId: 'tangu' };
    const added = JSON.parse(await runWithAgentSlug('second', () => tool.execute({ fact: 'second private fact', agentSlug: 'first' }, ctx)) as string);
    // 回执只回受影响的条目(不再整份 entries 回灌上下文);来源仍落库,从读取面核。
    expect(added).toMatchObject({ ok: true, action: 'add', count: 1, limit: 20_000, entry: { content: 'second private fact' } });
    expect(added.entries).toBeUndefined();
    expect((await api('/agent/agents/second/memory')).body.entries[0]).toMatchObject({ id: added.entry.id, source: { sessionId: 'source-session', runId: 'source-run' } });
    expect((await api('/agent/agents/first/memory')).body.content).toBe('');
    const again = JSON.parse(await runWithAgentSlug('second', () => tool.execute({ fact: 'second private fact' }, ctx)) as string);
    expect(again).toMatchObject({ ok: true, duplicate: true, version: added.version, count: 1 });
    const missingVersion = await runWithAgentSlug('second', () => tool.execute({ action: 'forget', id: added.entry.id }, ctx));
    expect(missingVersion).toContain('expectedVersion is required');
    const forgotten = JSON.parse(await runWithAgentSlug('second', () => tool.execute({ action: 'forget', id: added.entry.id, expectedVersion: added.version }, ctx)) as string);
    expect(forgotten).toMatchObject({ ok: true, action: 'forget', id: added.entry.id, count: 0 });
  });

  it('remember rejects paragraph-sized facts, updates in place, and shows current entries when memory is full', async () => {
    const tool = memoryLogProvider.tools().find(t => t.name === 'remember')!;
    const ctx = { userId: 'fixture-user', sessionId: 'shape-session', runId: 'shape-run', appId: 'tangu' };
    const run = (args: any) => runWithAgentSlug('second', () => tool.execute(args, ctx)) as Promise<string>;
    // 09-22 终端用户导出里的典型条目:带日期的部署总结,1,477 字 —— 形状闸把它挡在门外并指向 log_event。
    const long = await run({ fact: '【2026-09-19 Forsion CAD 0.3.0 已部署】'.padEnd(301, '细') });
    expect(long).toMatch(/^Error: fact is 301 characters/); expect(long).toContain('log_event');
    expect((await api('/agent/agents/second/memory')).body.entries).toEqual([]);
    const ok = JSON.parse(await run({ fact: '用户机器是 Windows'.padEnd(300, '。') }));
    expect(ok.ok).toBe(true); expect(ok.entry.content).toHaveLength(300);
    // 新事实取代旧条目:update 原地替换,id 不变、条数不涨(从前的描述让模型改成再加一条「更正」)。
    const updated = JSON.parse(await run({ action: 'update', id: ok.entry.id, expectedVersion: ok.version, fact: '用户机器是 Windows 11' }));
    expect(updated).toMatchObject({ ok: true, action: 'update', entry: { id: ok.entry.id, content: '用户机器是 Windows 11' }, count: 1 });
    // 满了:回显现有条目与版本,让模型一次删旧加新,而不是只丢一句「超预算」。
    const stored = (await api('/agent/agents/second/memory')).body;
    expect((await api('/agent/agents/second/memory', 'PUT', { content: 'x'.repeat(19_990), expectedVersion: stored.version })).status).toBe(200);
    const full = await run({ fact: 'one more durable fact that no longer fits' });
    expect(full).toMatch(/^Error: long-term memory is full \(19990\/20000 characters\)/);
    expect(full).toContain('Current entries:'); expect(full).toContain('expectedVersion');
  });

  it('propagates log cancellation while reporting a confirmed remote write truthfully', async () => {
    const tools = memoryLogProvider.tools();
    const logTool = tools.find(t => t.name === 'log_event')!;
    const readTool = tools.find(t => t.name === 'read_log')!;
    const ctx = { userId: 'fixture-user', sessionId: 'fixture-session', appId: 'tangu' };
    const pre = new AbortController(); pre.abort(new Error('pre cancelled'));
    await expect(logTool.execute({ text: 'never written' }, { ...ctx, signal: pre.signal })).rejects.toThrow('pre cancelled');
    await expect(readTool.execute({}, { ...ctx, signal: pre.signal })).rejects.toThrow('pre cancelled');
    const writeAbort = new AbortController();
    const write = vi.spyOn(deps().brain.memory, 'appendLogEntry').mockImplementation(async (_user, _text, opts) => {
      expect(opts?.signal).toBe(writeAbort.signal);
      writeAbort.abort(new Error('cancelled after remote commit'));
      return { date: '2026-09-08', time: '10:00' };
    });
    try {
      expect(await logTool.execute({ text: 'already committed remotely' }, { ...ctx, signal: writeAbort.signal })).toContain('本条不会回滚');
    } finally { write.mockRestore(); }
    const readAbort = new AbortController();
    const read = vi.spyOn(deps().brain.memory, 'getLog').mockImplementation(async (_user, _date, opts) => {
      expect(opts?.signal).toBe(readAbort.signal); readAbort.abort(new Error('read cancelled'));
      return { date: '2026-09-08', content: 'stale response must not be returned', updatedAt: 0 };
    });
    try { await expect(readTool.execute({}, { ...ctx, signal: readAbort.signal })).rejects.toThrow('read cancelled'); }
    finally { read.mockRestore(); }
  });
});
