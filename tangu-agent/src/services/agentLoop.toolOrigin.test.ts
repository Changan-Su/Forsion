/** 遥测 v3 契约 §19:真 loop 里插件工具的 tool_call / tool_result 带 pluginId + pluginOfficial,内置工具只有 source(不多出键)。
 *  live 台架多半只调内置工具,证不了插件那一支,这条用注册的插件 provider 直接断言事件 payload。 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { subscribe } from './eventBus.js';
import { abortRun, enqueueRun, waitForRunSettlement } from './agentLoop.js';
import { registerToolProvider, unregisterToolProvider } from '../tools/toolRegistry.js';

const PROVIDER = 'test:telemetry-owner';
let home: string;
let calls = 0;
const runId = 'origin-1';

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-tool-origin-'));
  process.env.TANGU_HOME = home;
  calls = 0;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  registerToolProvider({
    id: PROVIDER, origin: 'plugin', official: true, ownerPlugin: 'acme-tools',
    tools: () => [{ name: 'acme_echo', mode: 'both', capabilities: { sideEffect: 'none', parallel: true },
      definition: { type: 'function', function: { name: 'acme_echo', description: 'echo', parameters: { type: 'object', properties: {} } } },
      execute: async () => 'acme says hi' } as any],
  });
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['read_file', 'acme_echo', 'load_tools'] }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: structuredClone(o.messages), tools: o.tools }),
        streamProviderCompletion: async (o: any) => {
          if (o.onToken && ++calls === 1) {
            return { content: '', toolCalls: [
              { id: 'c-plugin', type: 'function', function: { name: 'acme_echo', arguments: '{}' } },
              { id: 'c-builtin', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'input.txt' }) } },
            ], usage: { prompt_tokens: 100, completion_tokens: 10 }, finishReason: 'tool_calls' };
          }
          o.onToken?.('Done.');
          return { content: 'Done.', toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 2 }, finishReason: 'stop' };
        },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
});
afterEach(async () => {
  abortRun(runId); await waitForRunSettlement(runId, 2000);
  unregisterToolProvider(PROVIDER);
  delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true });
});

it('plugin tool events carry pluginId + pluginOfficial; builtin ones carry only source', async () => {
  writeFileSync(join(home, 'input.txt'), 'hello\n');
  await createRun({ id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'a1',
    input: { message: 'go', userMessageId: 'u1', attachments: [], agentConfig: { execMode: 'host', cwd: home, approvalMode: 'full-auto', compaction: { enabled: false } } } });
  const done = new Promise<void>((resolve, reject) => {
    const off = subscribe(runId, (event) => {
      if (event.type === 'error') { off(); reject(new Error(JSON.stringify(event.payload))); }
      if (event.type === 'done') { off(); resolve(); }
    });
  });
  enqueueRun('S', runId);
  await done; await waitForRunSettlement(runId, 2000);
  const events = await listEventsFrom(runId, 0);
  const of = (type: string, id: string) => events.find((e: any) => e.type === type && e.payload.id === id)?.payload as Record<string, unknown> | undefined;
  for (const type of ['tool_call', 'tool_result']) {
    const plugin = of(type, 'c-plugin')
    expect(plugin, type).toMatchObject({ name: 'acme_echo', source: 'plugin', pluginId: 'acme-tools', pluginOfficial: true });
    const builtin = of(type, 'c-builtin')
    expect(builtin, type).toMatchObject({ name: 'read_file', source: 'builtin' });
    expect(Object.keys(builtin!).filter((k) => k.startsWith('plugin')), type).toEqual([]);
  }
}, 15_000);
