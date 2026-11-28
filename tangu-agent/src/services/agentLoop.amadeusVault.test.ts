import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { createRun, listEventsFrom } from './runStore.js';
import { abortRun, enqueueRun, waitForRunSettlement } from './agentLoop.js';

const runId = 'amadeus-loop-test';
const account = '1'.repeat(64);
let home: string;
let config: string;
let local: string;
let closeDb: () => void;
let firstPayload: { messages: Array<{ content: unknown }>; tools: Array<{ function: { name: string } }> } | undefined;
const read = vi.fn(async () => ({ content: 'Online receipt', seq: 1, fileId: 'note-1' }));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-vault-loop-'));
  config = join(home, 'amadeus-config.json');
  local = join(home, 'notes');
  mkdirSync(local);
  writeFileSync(config, JSON.stringify({ lastVault: local, activeVault: {
    kind: 'online', account, libraryId: 'work', vaultId: 'work', prefix: 'Amadeus/', name: 'Work',
  } }));
  vi.stubEnv('TANGU_HOME', home);
  vi.stubEnv('FORSION_AMADEUS_CONFIG', config);
  vi.stubEnv('FORSION_AMADEUS_VAULT', undefined);
  firstPayload = undefined;
  read.mockClear();
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'fixture', userId: 'u1' });
  closeDb = () => db.close();
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({
    host,
    profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['amadeus_read_note', 'amadeus_list_notes'] }),
    brain: {
      amadeus: {
        accountNamespace: () => account,
        library: async () => ({ list: async () => [], read, write: async () => ({ seq: 2 }) }),
      },
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'fixture', baseUrl: 'fixture', apiModelId: 'm' }),
        buildProviderPayload: async ({ messages, tools }: any) => ({ messages, tools }),
        streamProviderCompletion: async ({ payload, onToken }: any) => {
          if (onToken && !firstPayload) {
            firstPayload = structuredClone(payload);
            writeFileSync(config, JSON.stringify({ lastVault: local })); // The desktop changes the selection while the model is working.
            return {
              content: '', toolCalls: [{ id: 'online-read', type: 'function', function: {
                name: 'amadeus_read_note', arguments: JSON.stringify({ path: 'Entry.md' }),
              } }], usage: { prompt_tokens: 100, completion_tokens: 10 }, finishReason: 'tool_calls',
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
  await createRun({ id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm', assistantMessageId: 'answer',
    input: { message: 'Read Entry.md', userMessageId: 'question', attachments: [], agentConfig: {
      execMode: 'host', cwd: home, approvalMode: 'full-auto', compaction: { enabled: false },
    } } });
  enqueueRun('S', runId);
  await waitForRunSettlement(runId, 8000);
  const events = await listEventsFrom(runId, 0);
  expect(events.find(e => e.type === 'error')).toBeUndefined();
  expect(events.some(e => e.type === 'done')).toBe(true);
  expect(firstPayload?.messages.some(m => String(m.content).includes('"Work" (online)'))).toBe(true);
  expect(firstPayload?.tools.some(t => t.function.name === 'amadeus_read_note')).toBe(true);
  expect(read).toHaveBeenCalledExactlyOnceWith('Entry.md');
  expect(events.find(e => e.type === 'tool_result' && e.payload.name === 'amadeus_read_note')?.payload.result).toBe('Online receipt');
}, 12_000);
