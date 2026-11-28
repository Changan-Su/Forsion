import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import type { EngineManager, EngineRunCtx } from '../engines/manager.js';
import type { AmadeusNotes } from '../seams/cloudBrain.js';
import { withAmadeusWorkspace } from '../contracts/sessionDefaults.js';
import { resolveApproval } from './approvals.js';
import { subscribe } from './eventBus.js';
import { createRun, listEventsFrom } from './runStore.js';
import { abortRun, enqueueRun, waitForRunSettlement } from './agentLoop.js';

const runId = 'amadeus-loop-test';
const account = '1'.repeat(64);
let home: string;
let config: string;
let local: string;
let closeDb: () => void;
let firstCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
let firstPayload: { messages: Array<{ content: unknown }>; tools: Array<{ function: { name: string } }> } | undefined;
function call(id: string, name: string, args: object) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } };
}
const library = vi.fn(async (): Promise<AmadeusNotes | null> => ({ list: async () => [], read, write: async () => ({ seq: 2 }) }));
const read = vi.fn(async () => ({ content: 'Online receipt', seq: 1, fileId: 'note-1' }));
const runExternal = vi.fn(async (_ctx: EngineRunCtx) => ({ content: 'External result' }));
const engines: EngineManager = {
  list: () => [{ id: 'fixture', name: 'Fixture engine', available: true, status: 'available' }],
  has: id => id === 'fixture', setDefaultModel: () => {}, dispose: async () => {},
  capabilities: async () => ({ models: [], commands: [] }), run: runExternal,
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-vault-loop-'));
  mkdirSync(join(home, 'userData'));
  config = join(home, 'userData', 'amadeus-config.json');
  local = join(home, 'notes');
  mkdirSync(local);
  writeFileSync(config, JSON.stringify({ lastVault: local, activeVault: {
    kind: 'online', account, libraryId: 'work', vaultId: 'work', prefix: 'Amadeus/', name: 'Work',
  } }));
  vi.stubEnv('TANGU_HOME', home);
  vi.stubEnv('FORSION_AMADEUS_CONFIG', config);
  vi.stubEnv('FORSION_AMADEUS_VAULT', undefined);
  firstPayload = undefined;
  firstCalls = [call('online-read', 'amadeus_read_note', { path: 'Entry.md' })];
  library.mockClear();
  runExternal.mockClear();
  read.mockClear();
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'fixture', userId: 'u1' });
  closeDb = () => db.close();
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({
    host, engines,
    profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['amadeus_read_note', 'amadeus_list_notes', 'write_file'] }),
    brain: {
      amadeus: {
        accountNamespace: () => account,
        library,
      },
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'fixture', baseUrl: 'fixture', apiModelId: 'm' }),
        buildProviderPayload: async ({ messages, tools }: any) => ({ messages, tools }),
        streamProviderCompletion: async ({ payload, onToken }: any) => {
          if (onToken && !firstPayload) {
            firstPayload = structuredClone(payload);
            writeFileSync(config, JSON.stringify({ lastVault: local })); // The desktop changes the selection while the model is working.
            return {
              content: '', toolCalls: firstCalls, usage: { prompt_tokens: 100, completion_tokens: 10 }, finishReason: 'tool_calls',
            };
          }
          onToken?.('Done.');
          return { content: 'Done.', toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 2 }, finishReason: 'stop' };
        },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'fixture' }) },
      memory: { getMemory: async () => ({ content: '' }) },
      models: { hasDirectModel: () => false },
    } as any,
    billing: {
      canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }),
      calculateCost: async () => 0, logApiUsage: async () => {},
    } as any,
  });
  await runMigration();
  await query("INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 'Notes', 'm', 'user')");
});

afterEach(async () => {
  abortRun(runId);
  await waitForRunSettlement(runId, 2000);
  closeDb?.();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it('uses the pinned library for the prompt and tool execution after a mid-turn switch', async () => {
  await startTurn();
  await waitForRunSettlement(runId, 8000);
  const events = await listEventsFrom(runId, 0);
  expect(events.find(e => e.type === 'error')).toBeUndefined();
  expect(events.some(e => e.type === 'done')).toBe(true);
  expect(firstPayload?.messages.some(m => String(m.content).includes('"Work" (online)'))).toBe(true);
  expect(firstPayload?.tools.some(t => t.function.name === 'amadeus_read_note')).toBe(true);
  expect(read).toHaveBeenCalledExactlyOnceWith('Entry.md');
  expect(events.find(e => e.type === 'tool_result' && e.payload.name === 'amadeus_read_note')?.payload.result).toBe('Online receipt');
}, 12_000);

async function startTurn(config: Record<string, unknown> = {}) {
  await createRun({ id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm', assistantMessageId: 'answer',
    input: { message: 'Run the task', userMessageId: 'question', attachments: [], agentConfig: {
      execMode: 'host', cwd: home, approvalMode: 'full-auto', compaction: { enabled: false }, ...config,
    } } });
  enqueueRun('S', runId);
}

it('review P1-6: a stored automatic root drops out of both the prompt and auto-edit grants after an online switch', async () => {
  const work = join(home, 'work');
  const manual = join(home, 'manual');
  const legacy = join(home, 'unmarked');
  for (const dir of [work, manual, legacy]) mkdirSync(dir);
  const staleFile = join(local, 'Entry.md');
  const manualFile = join(manual, 'Entry.md');
  const legacyFile = join(legacy, 'Entry.md');
  writeFileSync(staleFile, 'local vault text');
  const userConfig = { execMode: 'host' as const, extraRoots: [manual, legacy] };
  const stored = withAmadeusWorkspace(userConfig, local);
  expect(stored.amadeusExtraRoots).toEqual([local]);
  expect(withAmadeusWorkspace(userConfig, manual)).toBe(userConfig);
  await query("UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'", [JSON.stringify(stored)]);
  firstCalls = [
    call('auto-root', 'write_file', { path: staleFile, content: 'wrong vault' }),
    call('manual-root', 'write_file', { path: manualFile, content: 'permitted manual write' }),
    call('legacy-root', 'write_file', { path: legacyFile, content: 'permitted unmarked write' }),
  ];
  const approvals: string[] = [];
  const detach = subscribe(runId, (event) => {
    if (event.type !== 'approval_request') return;
    approvals.push(event.payload.approvalId);
    resolveApproval(event.payload.approvalId, { action: 'reject' });
  });
  try {
    // Restore persisted provenance and disregard a stale mark on a manual grant.
    await startTurn({ cwd: work, approvalMode: 'auto-edit', extraRoots: stored.extraRoots, amadeusExtraRoots: [manual] });
    await waitForRunSettlement(runId, 8000);
  } finally {
    detach();
  }
  const prompt = firstPayload?.messages.map(message => String(message.content)).join('\n');
  expect(readFileSync(staleFile, 'utf8')).toBe('local vault text');
  expect(approvals).toHaveLength(1);
  expect(prompt).not.toContain(local);
  expect(prompt).toContain(manual);
  expect(prompt).toContain(legacy);
  expect(readFileSync(manualFile, 'utf8')).toBe('permitted manual write');
  expect(readFileSync(legacyFile, 'utf8')).toBe('permitted unmarked write');
}, 12_000);

it('records explicit root provenance when an older session only saved the host path list', async () => {
  const work = join(home, 'work');
  mkdirSync(work);
  const appended = withAmadeusWorkspace({ execMode: 'host', extraRoots: [work] }, local);
  await query("UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'", [JSON.stringify({ extraRoots: appended.extraRoots })]);
  firstCalls = [];
  await startTurn({ cwd: work, ...appended });
  await waitForRunSettlement(runId, 8000);
  const [{ agent_config }] = await query<Array<{ agent_config: string }>>("SELECT agent_config FROM chat_sessions WHERE id = 'S'");
  expect(JSON.parse(agent_config)).toMatchObject({ extraRoots: [work, local], amadeusExtraRoots: [local] });
}, 12_000);

it('review P1-11: publishes running before verification settles and continues with local tools on failure', async () => {
  let release!: (value: null) => void;
  library.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const work = join(home, 'work');
  mkdirSync(work);
  firstCalls = [call('local-edit', 'write_file', { path: 'output.md', content: 'local result' })];
  let running = false;
  const detach = subscribe(runId, (event) => {
    if (event.type === 'status' && event.payload.state === 'running') running = true;
  });
  try {
    await startTurn({ cwd: work });
    await vi.waitFor(() => expect(running).toBe(true), { timeout: 1500 });
    expect(release).toBeTypeOf('function');
    expect(firstPayload).toBeUndefined();
  } finally {
    release?.(null);
    detach();
  }
  await waitForRunSettlement(runId, 8000);
  expect(firstPayload?.messages.some(message => String(message.content).includes('"Work" (online)'))).toBe(true);
  expect(firstPayload?.tools.some(tool => tool.function.name === 'amadeus_read_note')).toBe(false);
  expect(readFileSync(join(work, 'output.md'), 'utf8')).toBe('local result');
}, 12_000);

it('review P1-11 external: runs a plain external engine without a library request', async () => {
  await startTurn({ engineId: 'fixture' });
  await waitForRunSettlement(runId, 8000);
  const events = await listEventsFrom(runId, 0);
  expect(events.some(event => event.type === 'status' && event.payload.state === 'running')).toBe(true);
  expect(events.some(event => event.type === 'done')).toBe(true);
  expect(runExternal).toHaveBeenCalledOnce();
  expect(library).not.toHaveBeenCalled();
}, 12_000);
