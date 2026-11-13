/** Real loop + SQLite: loading a skill must deliver its instructions, including
 * the middle, without requiring a second optional tool-output read. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun, listEventsFrom } from '../src/services/runStore.js';
import { subscribe } from '../src/services/eventBus.js';
import { abortRun, enqueueRun, waitForRunSettlement } from '../src/services/agentLoop.js';

const skill = {
  id: 'instruction-fixture', name: 'Long instruction fixture', description: 'Release instructions',
  content: 'Read the whole procedure.\n' + 'Ordinary instruction.\n'.repeat(1600)
    + 'MIDDLE_INSTRUCTION: Publish through the Store.\n' + 'More instructions.\n'.repeat(4000)
    + 'END_INSTRUCTION: Verify the published package.',
};
const expected = `# Skill: ${skill.name}\n\n${skill.content}`;
let home: string;
let payloads: any[][];
let runId = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-skill-output-'));
  process.env.TANGU_HOME = home;
  payloads = [];
});
afterEach(async () => {
  abortRun(runId); await waitForRunSettlement(runId, 2000);
  delete process.env.TANGU_HOME;
  rmSync(home, { recursive: true, force: true });
});

it.each([
  { window: 200_000, prompt: 100, fail: false, budgetError: false },
  { window: 200_000, prompt: 100, fail: true, budgetError: false },
  { window: 24_000, prompt: 100, fail: false, budgetError: true },
  { window: 80_000, prompt: 60_000, fail: false, budgetError: true },
  { window: 80_000, prompt: 30_000, fail: false, budgetError: false, calls: 2 },
])('loads complete instructions or returns a recoverable error: %j', async ({ window, prompt, fail, budgetError, calls = 1 }) => {
  let reads = 0;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['use_skill', 'read_tool_output'] }),
    brain: {
      assets: { getSkill: async (id: string) => {
        if (id !== skill.id) return null;
        if (++reads > 1 && fail) throw new Error(skill.content);
        return skill;
      } },
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: window }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: structuredClone(o.messages), tools: o.tools }),
        streamProviderCompletion: async (o: any) => {
          if (o.onToken) {
            payloads.push(o.payload.messages);
            if (payloads.length === 1) return { content: '', toolCalls: Array.from({ length: calls }, (_, i) => ({ id: `skill-call-${i}`, type: 'function', function: { name: 'use_skill', arguments: JSON.stringify({ skill_id: skill.id }) } })), usage: { prompt_tokens: prompt, completion_tokens: 10 }, finishReason: 'tool_calls' };
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
  runId = 'skill-output';
  await createRun({ id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
    input: { message: 'Follow the release skill.', userMessageId: 'U1', attachments: [], agentConfig: {
      execMode: 'host', cwd: home, approvalMode: 'readonly', compaction: { enabled: false }, enabledSkillIds: [skill.id],
    } } });
  const done = new Promise<void>((resolve, reject) => {
    const off = subscribe(runId, event => {
      if (event.type === 'error') { off(); reject(new Error(JSON.stringify(event.payload))); }
      if (event.type === 'done') { off(); resolve(); }
    });
  });
  enqueueRun('S', runId);
  await done; await waitForRunSettlement(runId, 2000);
  expect((await getRun(runId))?.status).toBe('done');
  expect(payloads).toHaveLength(2);
  const events = await listEventsFrom(runId, 0);
  const rows = await query<any[]>(`SELECT tool_results FROM chat_messages WHERE session_id = 'S' AND role = 'model'`);
  const stored = typeof rows[0].tool_results === 'string' ? JSON.parse(rows[0].tool_results) : rows[0].tool_results;
  for (let i = 0; i < calls; i++) {
    const id = `skill-call-${i}`;
    const result = payloads[1].find(m => m.role === 'tool' && m.tool_call_id === id);
    const event = events.find(e => e.type === 'tool_result' && e.payload.id === id)!;
    // In the two-call fixture the first skill fits; the second must include the
    // first one's already admitted tokens instead of independently passing.
    const exceedsBudget = budgetError || i > 0;
    expect(event.payload.isError).toBe(fail || exceedsBudget);
    if (exceedsBudget) {
      expect(result?.content).toContain('instructions were not loaded');
      expect(result?.content).toContain('larger-context model');
      expect(result?.content).not.toContain('MIDDLE_INSTRUCTION');
      expect(result?.content).not.toContain('read_tool_output');
      expect(existsSync(join(home, '.agent', 'tool-outputs'))).toBe(false);
      expect(existsSync(join(home, 'tool-spill'))).toBe(false);
    } else if (fail) {
      expect(result?.content).not.toContain('MIDDLE_INSTRUCTION');
      expect(result?.content).toContain('read_tool_output');
    } else {
      expect(result?.content).toContain('MIDDLE_INSTRUCTION: Publish through the Store.');
      expect(result?.content).toBe(expected);
      expect(existsSync(join(home, '.agent', 'tool-outputs'))).toBe(false);
      expect(existsSync(join(home, 'tool-spill'))).toBe(false);
    }
    expect(event.payload.result).toBe(result.content);
    expect(stored.find((r: any) => r.tool_call_id === id).content).toBe(result.content);
  }
}, 15_000);
