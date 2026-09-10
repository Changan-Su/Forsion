/** 真 loop + 内存 SQLite：重试链预算、中流续写取消、外部引擎沙箱边界。无网络/用户进程。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const policy = vi.hoisted(() => ({ restricted: false }));
vi.mock('../src/sandbox/hostSandboxPolicy.js', () => ({
  resolveHostSandboxPolicy: () => ({ mode: policy.restricted ? 'workspace-write' : 'off', network: 'deny' }),
  isHostSandboxRestricted: () => policy.restricted,
  isHostSandboxToolAllowed: () => true,
}));
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun, abortRun, abortAllRuns } from '../src/services/agentLoop.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { agentSyncScope, setAgentSyncPermission } from '../src/services/cloudSyncAccount.js';
import { runAgentFilesSync } from '../src/services/agentFileSync.js';
import type { AgentFilesBrain } from '../src/seams/cloudBrain.js';
import { DockerCleanupError } from '../src/sandbox/dockerLifecycle.js';

const realNow = Date.now.bind(Date);
let home: string;
let previousHome: string | undefined;
let stream: ReturnType<typeof vi.fn>;
let engineRun: ReturnType<typeof vi.fn>;
let agentFiles: AgentFilesBrain;

beforeEach(async () => {
  policy.restricted = false;
  previousHome = process.env.TANGU_HOME;
  home = mkdtempSync(join(tmpdir(), 'tangu-runtime-safety-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  stream = vi.fn(async () => ({ content: 'finished', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  engineRun = vi.fn();
  agentFiles = { getManifest: vi.fn(async () => []), getFile: vi.fn(async () => null), putFile: vi.fn(async (_u, _s, _p, body) => ({ mtimeMs: body.mtimeMs })), deleteFile: vi.fn(async () => {}) };
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none' }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test' }, apiKey: '', baseUrl: '', apiModelId: 'test' }),
        buildProviderPayload: async (opts: any) => ({ messages: structuredClone(opts.messages) }),
        streamProviderCompletion: stream,
      },
      users: { getUserById: async () => ({ id: 'u', username: 'test' }) },
      agentFiles, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }),
      calculateCost: async () => 0, logApiUsage: async () => {} } as any,
    engines: { has: () => true, run: engineRun } as any,
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('runtime-s', 'u', 'tangu', 't', 'm', 'user')`);
});

afterEach(() => {
  abortAllRuns();
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

async function launch(agentConfig: any = {}): Promise<void> {
  await createRun({ id: 'runtime-r', sessionId: 'runtime-s', userId: 'u', appId: 'tangu', modelId: 'm', assistantMessageId: 'runtime-a',
    input: { message: 'inspect the parser', userMessageId: 'runtime-u', agentConfig } });
  enqueueRun('runtime-s', 'runtime-r');
}
async function settled(runId = 'runtime-r'): Promise<any> {
  const started = realNow();
  while (realNow() - started < 6000) {
    const run = await getRun(runId);
    if (run && ['done', 'failed', 'aborted'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not settle');
}

describe('main loop runtime safety', () => {
  it('reports cleanup failure rather than a successful stop when cancellation and cleanup failure coincide', async () => {
    stream.mockImplementation(async () => {
      abortRun('runtime-r');
      throw new DockerCleanupError('still-running', 'daemon unavailable');
    });
    await launch();
    const run = await settled();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('not confirmed');
    expect(run.error).toContain('quarantined');
    expect(stream).toHaveBeenCalledOnce();
  });

  it('stops pre-frame retries once their combined wall time exceeds the budget', async () => {
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    stream.mockImplementation(async () => { offset += 30_001; throw new TypeError('temporary network failure'); });
    await launch();
    expect((await settled()).status).toBe('failed');
    expect(stream).toHaveBeenCalledTimes(2); // 旧主 loop 每次只判 30s,会重发四次。
  });

  it('cancels midstream continuation backoff promptly while preserving already emitted text', async () => {
    stream.mockImplementation(async (opts: any) => {
      opts.onToken('already emitted');
      setTimeout(() => abortRun('runtime-r'), 20);
      throw new TypeError('connection reset midstream');
    });
    const started = realNow();
    await launch();
    expect((await settled()).status).toBe('aborted');
    expect(realNow() - started).toBeLessThan(1000); // 不等待原 1.5s 退避。
    expect(stream).toHaveBeenCalledOnce();
    const messages = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'runtime-s' AND role = 'model'`);
    expect(messages.map((m) => m.content).join('\n')).toContain('already emitted');
  });

  it('rejects external engines under trusted sandbox policy even if the request claims sandbox off', async () => {
    policy.restricted = true;
    await launch({ engineId: 'test-engine', hostSandbox: { mode: 'off' } });
    const run = await settled();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('External engines are unavailable');
    expect(engineRun).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
});


describe('first Agent hydration lifecycle', () => {
  it('publishes failure, stores a terminal state and advances the queue after first hydrate fails', async () => {
    await launch({ agentSlug: 'missing-agent' });
    await createRun({ id: 'runtime-next', sessionId: 'runtime-s', userId: 'u', appId: 'tangu', modelId: 'm', assistantMessageId: 'runtime-next-a', input: { message: 'next', agentConfig: { agentSlug: 'also-missing' } } });
    enqueueRun('runtime-s', 'runtime-next');
    expect((await settled()).status).toBe('failed');
    expect((await settled('runtime-next')).status).toBe('failed');
    const events = await query<any[]>(`SELECT type, payload FROM agent_run_events WHERE run_id = 'runtime-r' AND type = 'error'`);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload).aborted).toBe(false);
    expect(stream).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'agents', 'xyra', '.memory-state.json'))).toBe(false);
  });

  it('honors the stored session Agent when an older client omits agentSlug', async () => {
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'runtime-s'`, [JSON.stringify({ agentSlug: 'stored-missing' })]);
    await launch();
    expect((await settled()).status).toBe('failed');
    expect(agentFiles.getManifest).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'agents', 'xyra', '.memory-state.json'))).toBe(false);
  });

  it('aborting a pending first hydrate aborts transport, publishes aborted and releases the session', async () => {
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    let transportSignal: AbortSignal | undefined;
    vi.mocked(agentFiles.getManifest).mockImplementationOnce(async (_uid, opts) => {
      transportSignal = opts!.signal;
      requested();
      return new Promise((_, reject) => transportSignal!.addEventListener('abort', () => reject(transportSignal!.reason), { once: true }));
    });
    await launch({ agentSlug: 'fresh-agent' });
    await started;
    await createRun({ id: 'runtime-after-stop', sessionId: 'runtime-s', userId: 'u', appId: 'tangu', modelId: 'm', assistantMessageId: 'runtime-stop-a', input: { message: 'next', agentConfig: { agentSlug: 'second-missing' } } });
    enqueueRun('runtime-s', 'runtime-after-stop');
    abortRun('runtime-r');
    expect((await settled()).status).toBe('aborted');
    expect(transportSignal!.aborted).toBe(true);
    expect((await settled('runtime-after-stop')).status).toBe('failed');
    const events = await query<any[]>(`SELECT payload FROM agent_run_events WHERE run_id = 'runtime-r' AND type = 'error'`);
    expect(events).toHaveLength(1); expect(JSON.parse(events[0].payload).aborted).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'agents', 'fresh-agent'))).toBe(false);
  });
});


it('external engine post-sync uses the session display Agent, including explicit shared memory', async () => {
  await saveAgent({ slug: 'shared-display', name: 'Shared display', systemPrompt: 'synthetic persona', cloudSync: true, shareDefaultMemory: true });
  setAgentSyncPermission('shared-display', agentSyncScope(agentFiles, 'u')!, true, true);
  await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'runtime-s'`, [JSON.stringify({ agentSlug: 'shared-display' })]);
  engineRun.mockResolvedValue({ content: 'external finished' });
  await launch({ engineId: 'test-engine' });
  expect((await settled()).status).toBe('done');
  const started = realNow();
  while (!vi.mocked(agentFiles.putFile).mock.calls.some((args) => args[1] === 'shared-display' && args[2] === 'SOUL.md')) {
    if (realNow() - started > 2000) throw new Error('external run did not sync its display Agent');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Drain the account queue before deleting the temporary fixture.
  await runAgentFilesSync(agentFiles, 'u', { onlySlug: 'shared-display' });
  expect(stream).not.toHaveBeenCalled();
});

it('a malformed stored session identity cannot silently activate default memory', async () => {
  await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'runtime-s'`, [JSON.stringify('invalid configuration')]);
  await launch(); expect((await settled()).status).toBe('failed'); expect(stream).not.toHaveBeenCalled();
  expect(existsSync(join(home, 'agents', 'xyra', '.memory-state.json'))).toBe(false);
});
