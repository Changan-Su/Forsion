import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { completeHistorianTask, transcriptDelta, HISTORIAN_CONTEXT_CHARS, type HistorianTask } from '../src/services/historianSession.js';

let db: ReturnType<typeof createSqliteHost>['db'];
let calls: any[];
let inFlight: number;
let maxInFlight: number;
beforeEach(async () => {
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
  db = local.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  calls = []; inFlight = 0; maxInFlight = 0;
  configureTangu({ host: local.host, profile: createTanguProfile({ sandboxMode: 'none' }), brain: { llm: {
    resolveModelAndKey: async () => ({ model: {}, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (p: any) => { calls.push(p); return p; },
    streamProviderCompletion: async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { content: 'Remember the project constraints and pending work.', usage: {} };
    },
  } } as any, billing: { calculateCost: async () => 0 } as any });
  await runMigration();
  await query("INSERT INTO chat_sessions (id, user_id, app_id, title) VALUES ('p', 'u', 'tangu', 'Parent'), ('other', 'u', 'tangu', 'Other')");
});
afterEach(() => db.close());
const task = (over: Partial<HistorianTask> = {}): HistorianTask => ({ sessionId: 'p', userId: 'u', modelId: 'm', task: 'judge', instructions: 'Summarize.', transcript: 'First fact', maxTokens: 100, ...over });

describe('persistent Historian', () => {
  it('shares one session across judge/team tasks, serializes concurrent calls, and isolates parents', async () => {
    const [a, b] = await Promise.all([completeHistorianTask(task()), completeHistorianTask(task({ task: 'team-summary', transcript: 'Team result' }))]);
    expect(a.historianSessionId).toBe(b.historianSessionId);
    expect(maxInFlight).toBe(1);
    expect(calls[1].messages.some((m: any) => m.role === 'assistant')).toBe(true);
    const c = await completeHistorianTask(task({ sessionId: 'other' }));
    expect(c.historianSessionId).not.toBe(a.historianSessionId);
    expect(calls[2].messages.some((m: any) => m.role === 'assistant')).toBe(false);
    const rows = await query<any[]>("SELECT id FROM chat_sessions WHERE parent_session_id = 'p' AND kind = 'historian'");
    expect(rows).toHaveLength(1);
    await expect(completeHistorianTask(task({ userId: 'someone-else' }))).rejects.toThrow('parent session');
  });

  it('sends only new transcript lines and persists a checkpoint at the smaller context limit', async () => {
    const a = await completeHistorianTask(task());
    await completeHistorianTask(task({ transcript: 'First fact\nSecond fact' }));
    expect(calls.at(-1).messages.at(-1).content).toContain('Second fact');
    expect(calls.at(-1).messages.at(-1).content).not.toContain('First fact');
    await query("INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('big', ?, 'user', ?, ?), ('reply', ?, 'model', 'ack', ?)",
      [a.historianSessionId, 'x'.repeat(HISTORIAN_CONTEXT_CHARS), Date.now() + 10, a.historianSessionId, Date.now() + 11]);
    await completeHistorianTask(task({ transcript: 'Third fact' }));
    const checkpoints = await query<any[]>('SELECT summary FROM session_summaries WHERE session_id = ?', [a.historianSessionId]);
    expect(checkpoints).toHaveLength(1);
    expect(calls.at(-1).messages.some((m: any) => m.content.includes('[Historian checkpoint]'))).toBe(true);
    expect(calls.at(-1).messages.reduce((n: number, m: any) => n + m.content.length, 0)).toBeLessThan(HISTORIAN_CONTEXT_CHARS);
  });

  it('handles sliding windows and repeated snapshots without losing new lines', () => {
    expect(transcriptDelta('a\nb\nc', 'b\nc\nd')).toBe('d');
    expect(transcriptDelta('a', 'a')).toBe('[No new conversation text.]');
    expect(transcriptDelta('abc', 'bc-new')).toBe('bc-new');
  });
});
