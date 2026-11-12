/** Real loop + in-memory SQLite. Summary provider deliberately ignores abort to exercise the
 * commit fence, original-context continuation, one main request, checkpoint and SSE replay. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { createRun, appendStep, listEventsFrom } from './runStore.js';
import { subscribe, type AgentEvent } from './eventBus.js';
import { abortRun, enqueueRun, waitForRunSettlement } from './agentLoop.js';



let home: string;
let payloads: any[][];
let runId = '';
let useProgram = false;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-context-replay-'));
  process.env.TANGU_HOME = home;
  payloads = []; useProgram = false;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['read_file', 'read_only_code', 'load_tools'] }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: structuredClone(o.messages), tools: o.tools }),
        streamProviderCompletion: async (o: any) => {
          if (o.onToken) {
            payloads.push(o.payload.messages);
            if (useProgram && payloads.length === 1) return { content: '', toolCalls: [{ id: 'program-call', type: 'function', function: { name: 'read_only_code', arguments: JSON.stringify({ code: 'const a = tool("read_file", {path:"input.txt"}); print(a.split("\\n").filter(x => x.includes("FINDING")));' }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 }, finishReason: 'tool_calls' };
            o.onToken('Done.');
          }
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
  delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true });
});
async function turn(n: number, ephemeralHint = '') {
  runId = `replay-${n}`;
  await createRun({ id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `a${n}`,
    input: { message: `question-${n}`, userMessageId: `u${n}`, ephemeralHint, attachments: [], agentConfig: {
      execMode: useProgram ? 'host' : 'sandbox', cwd: home, approvalMode: 'readonly', compaction: { enabled: false },
      mentionedProjects: [{ name: `Project-${n}`, path: `/synthetic/project-${n}` }],
    } } });
  const done = new Promise<void>((resolve, reject) => {
    const off = subscribe(runId, event => {
      if (event.type === 'error') { off(); reject(new Error(JSON.stringify(event.payload))); }
      if (event.type === 'done') { off(); resolve(); }
    });
  });
  enqueueRun('S', runId);
  await done; await waitForRunSettlement(runId, 2000);
}
it('replays exact runtime snapshots across three rehydrations without persisting ephemeral data or altering user text', async () => {
  await turn(1, 'PRIVATE_EPHEMERAL_SENTINEL');
  await turn(2);
  await turn(3);
  const snapshot = payloads[0].find(m => String(m.content).includes('Project-1'));
  expect(snapshot).toBeTruthy();
  expect(payloads[1].filter(m => m.content === snapshot.content)).toHaveLength(1);
  expect(payloads[2].filter(m => m.content === snapshot.content)).toHaveLength(1);
  expect(payloads[1].findIndex(m => m.content === snapshot.content)).toBeLessThan(payloads[1].findIndex(m => m.role === 'assistant'));
  expect(JSON.stringify(payloads[0])).toContain('PRIVATE_EPHEMERAL_SENTINEL');
  expect(JSON.stringify(payloads[1])).not.toContain('PRIVATE_EPHEMERAL_SENTINEL');
  const rows = await query(`SELECT role, content FROM chat_messages WHERE session_id = 'S'`);
  expect(rows.filter((r: any) => r.role === 'user').map((r: any) => r.content)).toEqual(['question-1', 'question-2', 'question-3']);
  const steps = await query(`SELECT llm_response FROM agent_steps`);
  expect(JSON.stringify(steps)).toContain('Project-1');
  expect(JSON.stringify(steps)).not.toContain('PRIVATE_EPHEMERAL_SENTINEL');
}, 15_000);

it('runs nested reads through the actual loop but only replays the selected program output', async () => {
  useProgram = true;
  writeFileSync(join(home, 'input.txt'), 'DO_NOT_REPLAY_RAW\n'.repeat(1000) + 'FINDING exact-evidence\n');
  await turn(1);
  expect(payloads).toHaveLength(2);
  const result = payloads[1].find(m => m.role === 'tool' && m.tool_call_id === 'program-call');
  expect(result.content).toContain('FINDING exact-evidence');
  expect(JSON.stringify(payloads[1])).not.toContain('DO_NOT_REPLAY_RAW');
  const events = await listEventsFrom(runId, 0);
  expect(events.some(e => e.type === 'tool_call' && e.payload.parentCallId === 'program-call')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('DO_NOT_REPLAY_RAW');
  const rows = await query(`SELECT tool_results FROM chat_messages WHERE session_id = 'S'`);
  expect(JSON.stringify(rows)).not.toContain('DO_NOT_REPLAY_RAW');
}, 15_000);

it('restores context at the original user row after steering discarded its assistant owner', async () => {
  await createRun({ id: 'steered-run', sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'discarded-owner', input: {} });
  for (const [id, role, content, timestamp] of [['original-user', 'user', 'original question', 1000], ['steering-user', 'user', 'new direction', 2000], ['new-owner', 'model', 'steered answer', 3000]]) {
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, 'S', ?, ?, ?)`, [id, role, content, timestamp]);
  }
  await appendStep({ id: 'snapshot-step', runId: 'steered-run', stepNo: 1, llmResponse: { content: 'steered answer', turnContext: { version: 1, assistantMessageId: 'discarded-owner', sourceMessageId: 'original-user', text: 'ORIGINAL_RUNTIME_SNAPSHOT' } } });
  await turn(1);
  const contents = payloads[0].map(m => m.content);
  const at = contents.indexOf('original question');
  expect(contents.slice(at, at + 3)).toEqual(['original question', 'ORIGINAL_RUNTIME_SNAPSHOT', 'new direction']);
  expect(contents.filter(c => c === 'ORIGINAL_RUNTIME_SNAPSHOT')).toHaveLength(1);
}, 15_000);
