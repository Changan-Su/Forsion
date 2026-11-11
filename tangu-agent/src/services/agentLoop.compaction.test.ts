/** Real loop + in-memory SQLite. Summary provider deliberately ignores abort to exercise the
 * commit fence, original-context continuation, one main request, checkpoint and SSE replay. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { subscribe, type AgentEvent } from './eventBus.js';
import { abortRun, enqueueRun, waitForRunSettlement } from './agentLoop.js';
import { skipRunCompaction } from './runCompaction.js';

const defer = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
let home: string; let id: string; let index = 0;
let summary: ReturnType<typeof defer<any>>; let started: ReturnType<typeof defer<void>>;
let calls: any[]; let timeline: string[];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-compaction-')); process.env.TANGU_HOME = home;
  id = `compaction-${++index}`; summary = defer(); started = defer(); calls = []; timeline = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: [] }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
        streamProviderCompletion: async (o: any) => {
          if (String(o.payload.messages[0]?.content).includes('context checkpoint compaction')) {
            timeline.push('summary-call'); started.resolve(); return summary.promise;
          }
          if (!o.onToken) return { content: 'background', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
          timeline.push('main-call'); calls.push(o.payload.messages); o.onToken('The earlier decision was to retain the original evidence.');
          return { content: 'The earlier decision was to retain the original evidence.', reasoning: '', toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 20 }, finishReason: 'stop' };
        },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
  for (let n = 0; n < 12; n++) await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, 'S', ?, ?, ?)`,
    [`old-${n}`, n % 2 ? 'model' : 'user', `ORIGINAL_EVIDENCE_${n} ` + 'retained history '.repeat(50), Date.now() - 7_200_000 + n]);
});
afterEach(async () => {
  abortRun(id); summary.resolve({ content: '## Goal\nLate summary', toolCalls: [] }); await waitForRunSettlement(id, 2000);
  delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true });
});
async function start() {
  await createRun({ id, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `${id}-a`,
    input: { message: 'What was our earlier decision?', userMessageId: `${id}-u`, attachments: [], agentConfig: { execMode: 'sandbox', cwd: home, compaction: { keepRecentTokens: 50, idleMinutes: 60 } } } });
  const events: AgentEvent[] = [];
  const ended = defer<void>();
  const off = subscribe(id, event => { events.push(event); if (event.type === 'status' && event.payload.phase) timeline.push(event.payload.phase); if (event.type === 'done' || event.type === 'error') ended.resolve(); });
  enqueueRun('S', id);
  await Promise.race([started.promise, ended.promise.then(() => { throw new Error(JSON.stringify(events.filter(e => e.type === 'error'))); })]);
  return { events, off, ended: ended.promise, operationId: String(events.find(e => e.payload.phase === 'compacting')!.payload.operationId) };
}
describe('idle summary in the real run loop', () => {
  it('shows start before provider; skip resumes exactly once and late summary writes no checkpoint', async () => {
    const run = await start();
    try {
      expect(timeline.indexOf('compacting')).toBeLessThan(timeline.indexOf('summary-call'));
      const replay = await listEventsFrom(id, 0);
      expect(replay.some(e => e.type === 'status' && e.payload.phase === 'compacting')).toBe(true);
      expect(skipRunCompaction(id, run.operationId).ok).toBe(true);
      await run.ended; await waitForRunSettlement(id, 2000);
      expect(calls).toHaveLength(1); expect(JSON.stringify(calls[0])).toContain('ORIGINAL_EVIDENCE_0');
      summary.resolve({ content: '## Goal\nA late summary must never be used.', toolCalls: [], finishReason: 'stop' });
      await new Promise(r => setTimeout(r, 10));
      expect(calls).toHaveLength(1);
      expect(await query(`SELECT * FROM session_summaries WHERE session_id = 'S'`)).toEqual([]);
      expect(run.events.filter(e => e.payload.operationId === run.operationId).map(e => e.payload.phase)).toEqual(['compacting', 'compaction_skipped']);
    } finally { run.off(); }
  }, 15_000);
  it('normal completion commits one summary and sends one main request with it', async () => {
    const run = await start();
    try {
      summary.resolve({ content: '## Goal\nRetain the evidence and continue answering the question.', toolCalls: [], finishReason: 'stop' });
      await run.ended; await waitForRunSettlement(id, 2000);
      expect(calls).toHaveLength(1); expect(JSON.stringify(calls[0])).toContain('Compacted Summary');
      expect(await query(`SELECT * FROM session_summaries WHERE session_id = 'S'`)).toHaveLength(1);
      expect(run.events.filter(e => e.payload.operationId === run.operationId).map(e => e.payload.phase)).toEqual(['compacting', 'compacted']);
    } finally { run.off(); }
  }, 15_000);
});
