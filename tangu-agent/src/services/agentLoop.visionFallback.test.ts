import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { query } from '../core/db.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { LlmError, type ChatMessage } from '../core/types.js';
import { runMigration } from '../db/migrate.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { createTanguProfile } from '../profiles/index.js';
import { configureTangu } from '../seams/runtime.js';
import { abortRun, enqueueRun, waitForRunSettlement } from './agentLoop.js';
import { resolveDeskShot } from './deskCapture.js';
import { subscribe } from './eventBus.js';
import { createRun, getRun } from './runStore.js';
import { __resetVisionSlotCacheForTests } from './visionService.js';

const SHOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const USAGE = { prompt_tokens: 100, completion_tokens: 10 };
const OUTPUT_LIMIT = 'Upstream output limit reached before any reply was produced.';
let home: string;
let runId: string;
let closeDb: () => void;
let visionRequests: Array<{ messages: ChatMessage[]; maxTokens: number }>;
let mainInputs: ChatMessage[][];
let mainSupportsVision: boolean | undefined;
let visionFails: boolean;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-desk-vision-'));
  process.env.TANGU_HOME = home;
  runId = `desk-${basename(home)}`;
  visionRequests = [];
  mainInputs = [];
  mainSupportsVision = false;
  visionFails = true;
  __resetVisionSlotCacheForTests();
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'fixture', userId: 'u1' });
  closeDb = () => db.close();
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({
    host,
    profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['desk_screenshot'] }),
    brain: {
      llm: {
        resolveModelAndKey: async (id: string) => ({ model: { id, provider: 'fixture', name: id }, apiKey: 'fixture', baseUrl: 'fixture', apiModelId: id }),
        buildProviderPayload: async (opts: any) => ({ id: opts.model.id, messages: structuredClone(opts.messages), maxTokens: opts.maxTokens }),
        streamProviderCompletion: async (opts: any) => {
          if (opts.payload.id === 'vision-fixture') {
            visionRequests.push(opts.payload);
            if (visionFails) throw new LlmError(422, OUTPUT_LIMIT);
            return { content: 'A blue circle', reasoning: '', toolCalls: [], usage: USAGE, finishReason: 'stop' };
          }
          mainInputs.push(opts.payload.messages);
          if (mainInputs.length === 1) {
            return { content: '', reasoning: '', toolCalls: [
              { id: 'shot', type: 'function', function: { name: 'desk_screenshot', arguments: '{}' } },
            ], usage: USAGE, finishReason: 'tool_calls' };
          }
          if (mainSupportsVision !== true && JSON.stringify(opts.payload.messages).includes(SHOT)) {
            throw new LlmError(400, 'The selected model cannot process all input types in this request.');
          }
          opts.onToken?.('The turn continued.');
          return { content: 'The turn continued.', reasoning: '', toolCalls: [], usage: USAGE, finishReason: 'stop' };
        },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'fixture' }) },
      memory: { getMemory: async () => ({ content: '' }) },
      models: {
        hasDirectModel: () => false,
        listModelsForProject: async () => ({ models: [{ id: 'main-fixture', supportsVision: mainSupportsVision }], visionModelId: 'vision-fixture' }),
      },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'main-fixture', 'user')`);
});

afterEach(async () => {
  abortRun(runId);
  await waitForRunSettlement(runId, 2_000);
  closeDb();
  delete process.env.TANGU_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function screenshotRun(visionMode: 'auto' | 'always') {
  await createRun({
    id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'main-fixture', assistantMessageId: 'a1',
    input: { message: 'Check the Agent Desk screenshot.', userMessageId: 'u1', attachments: [],
      agentConfig: { execMode: 'host', cwd: home, approvalMode: 'full-auto', visionMode, compaction: { enabled: false } } },
  });
  const statuses: any[] = [];
  const finished = new Promise<void>((resolve) => {
    const off = subscribe(runId, (ev) => {
      if (ev.type === 'desk_capture_request') resolveDeskShot(runId, ev.payload.shotId, { dataUrl: SHOT, mode: 'open' });
      if (ev.type === 'status' && ev.payload.phase === 'describing_images') statuses.push(ev.payload);
      if (ev.type === 'done' || ev.type === 'error') { off(); resolve(); }
    });
  });
  enqueueRun('S', runId);
  await finished;
  await waitForRunSettlement(runId, 2_000);
  const run = await getRun(runId);
  return { statuses, status: run?.status, error: run?.error, nextInput: JSON.stringify(mainInputs[1]) };
}

it.each(['auto', 'always'] as const)('Agent Desk (%s) continues when auxiliary vision fails and the main model is text-only', async (mode) => {
  const result = await screenshotRun(mode);
  expect(visionRequests).toHaveLength(1);
  expect(visionRequests[0].maxTokens).toBe(4096);
  expect(JSON.stringify(visionRequests[0].messages)).toContain(SHOT);
  expect(result.statuses).toMatchObject([{ stage: 'start' }, { stage: 'done', ok: false }]);
  expect(result.status, result.error || undefined).toBe('done');
  expect(result.nextInput).not.toContain(SHOT);
  expect(result.nextInput).toContain('the vision assistant model could not describe them');
}, 15_000);

it('Agent Desk does not send an image on failed forced transcription when main model vision is unknown', async () => {
  mainSupportsVision = undefined;
  const result = await screenshotRun('always');
  expect(visionRequests).toHaveLength(1);
  expect(result.status).toBe('done');
  expect(result.nextInput).toContain('the vision assistant model could not describe them');
  expect(result.nextInput).not.toContain(SHOT);
}, 15_000);

it('Agent Desk sends the original to an image-capable model in automatic mode', async () => {
  mainSupportsVision = true;
  const result = await screenshotRun('auto');
  expect(visionRequests).toHaveLength(0);
  expect(result.status).toBe('done');
  expect(result.nextInput).toContain(SHOT);
}, 15_000);

it('Agent Desk passes a successful description to a text-only model', async () => {
  visionFails = false;
  const result = await screenshotRun('auto');
  expect(result.statuses).toMatchObject([{ stage: 'start' }, { stage: 'done', ok: true }]);
  expect(result.status).toBe('done');
  expect(result.nextInput).toContain('A blue circle');
  expect(result.nextInput).not.toContain(SHOT);
}, 15_000);
