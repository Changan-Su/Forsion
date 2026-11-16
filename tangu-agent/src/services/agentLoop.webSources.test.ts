/** 搜索来源编号的引擎整链(真 loop + 内存 SQLite):web_search 的结构化来源随 tool_result 事件发出、落进
 * chat_messages.tool_results,而模型那份 tool 消息(本轮与下一轮回放)逐字是「引用锚点头 + runSearch 的 text」,
 * 来源里独有的标题一个字都进不去。 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

const SENTINEL = 'ONLY_IN_METADATA_TITLE';
const URL_A = 'https://www.hokkaido-ski.jp/niseko/beginner';
const TEXT = `Search results (Bocha):\n1. Niseko guide\n  ${URL_A}\n  gentle slope.`;
const HEAD = 'Cite for the user: [<a short phrase from the snippet>](<the result URL>) — the link text is the exact sentence the reader gets scrolled to.\n\n';

let home: string;
let payloads: any[][];
let runId = '';
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-web-sources-'));
  process.env.TANGU_HOME = home;
  payloads = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['web_search'] }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: structuredClone(o.messages), tools: o.tools }),
        streamProviderCompletion: async (o: any) => {
          if (!o.onToken) return { content: 'Done.', toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 2 }, finishReason: 'stop' };
          payloads.push(o.payload.messages);
          const last = o.payload.messages[o.payload.messages.length - 1];
          // 每轮的第一发去搜,拿到结果后收尾
          if (last?.role === 'user') return { content: '', toolCalls: [{ id: `call-${payloads.length}`, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'hokkaido' }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 }, finishReason: 'tool_calls' };
          o.onToken(`See [gentle slope](${URL_A}).`);
          return { content: `See [gentle slope](${URL_A}).`, toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 2 }, finishReason: 'stop' };
        },
      },
      search: { runSearch: async () => ({ provider: 'bocha', text: TEXT, results: [{ title: SENTINEL, url: URL_A, snippet: 'gentle slope.', date: '2026-10-28' }] }) },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
});
afterEach(async () => {
  abortRun(runId); await waitForRunSettlement(runId, 2000);
  delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true });
});

async function turn(n: number) {
  runId = `web-${n}`;
  await createRun({ id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `a${n}`,
    input: { message: `question-${n}`, userMessageId: `u${n}`, attachments: [], agentConfig: { execMode: 'sandbox', cwd: home, approvalMode: 'readonly', compaction: { enabled: false } } } });
  const done = new Promise<void>((resolve, reject) => {
    const off = subscribe(runId, (event) => {
      if (event.type === 'error') { off(); reject(new Error(JSON.stringify(event.payload))); }
      if (event.type === 'done') { off(); resolve(); }
    });
  });
  enqueueRun('S', runId);
  await done; await waitForRunSettlement(runId, 2000);
}

it('sources ride on the tool_result event and the stored row; the model only ever sees head + text', async () => {
  await turn(1);
  const expected = [{ url: URL_A, site: 'hokkaido-ski.jp', title: SENTINEL, date: '2026-10-28', snippet: 'gentle slope.' }];

  const events = await listEventsFrom('web-1', 0);
  const result = events.find((e: any) => e.type === 'tool_result');
  expect(result?.payload?.metadata).toEqual({ sources: expected });

  const rows = await query<any[]>(`SELECT tool_results FROM chat_messages WHERE id = 'a1'`);
  const stored = typeof rows[0].tool_results === 'string' ? JSON.parse(rows[0].tool_results) : rows[0].tool_results;
  expect(stored[0].metadata).toEqual({ sources: expected });
  expect(stored[0].content).toBe(HEAD + TEXT);

  // 本轮第二发:tool 消息逐字是 head + text
  const toolMsg = payloads[1].find((m: any) => m.role === 'tool');
  expect(toolMsg.content).toBe(HEAD + TEXT);
  expect(JSON.stringify(payloads[1])).not.toContain(SENTINEL);

  // 下一轮回放上一轮:同一串,来源还是进不去
  await turn(2);
  const replayed = payloads[2].filter((m: any) => m.role === 'tool');
  expect(replayed[0].content).toBe(HEAD + TEXT);
  expect(JSON.stringify(payloads[2])).not.toContain(SENTINEL);
});
