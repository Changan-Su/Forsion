/** 真 loop + 内存 SQLite：重试链预算、中流续写取消、外部引擎沙箱边界。无网络/用户进程。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import runsRouter from '../src/routes/runs.js';

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
import { enqueueRun, abortRun, abortAllRuns, waitForRunSettlement } from '../src/services/agentLoop.js';
import * as loop from '../src/services/agentLoop.js';
import { registerToolProvider } from '../src/tools/toolRegistry.js';
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
let contextWindow: number;

beforeEach(async () => {
  policy.restricted = false;
  contextWindow = 128_000;
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
        resolveModelAndKey: async () => ({ model: { provider: 'test', context_window: contextWindow }, apiKey: '', baseUrl: '', apiModelId: 'test' }),
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

async function screenshotHistory(): Promise<void> {
  for (let i = 0; i < 24; i++) {
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, attachments) VALUES (?, 'runtime-s', 'user', ?, ?, ?)`,
      [`history-${i}`, `prior work ${i}`, i + 1, i === 23 ? JSON.stringify([{ mimeType: 'image/png', data: 'A'.repeat(2_406_140) }]) : null]);
  }
}

async function queueNext(): Promise<void> {
  await createRun({ id: 'runtime-resume', sessionId: 'runtime-s', userId: 'u', appId: 'tangu', modelId: 'm', assistantMessageId: 'runtime-resume-a',
    input: { message: 'continue from completed work', userMessageId: 'runtime-resume-u', agentConfig: {} } });
  enqueueRun('runtime-s', 'runtime-resume');
}

describe('steering preserves the running task', () => {
  it('does not discard accepted input at the last iteration boundary', async () => {
    stream.mockImplementationOnce(async () => {
      loop.enqueueSteer('runtime-r', { id: 'last-question', content: 'One more clarification' });
      return { content: 'Previous answer', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
    await launch({ maxIterations: 1 });
    expect((await settled()).status).toBe('done');
    expect(stream).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(stream.mock.calls[1][0].payload.messages)).toContain('One more clarification');
  });
  it('waits for an executing tool, preserves its result and handles the question in the same run', async () => {
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    let toolSignal: AbortSignal | undefined;
    const execute = vi.fn(async (_args, ctx) => {
      toolSignal = ctx.signal; began();
      await new Promise<void>((resolve) => { finish = resolve; });
      return 'original operation completed';
    });
    registerToolProvider({ id: 'test:steering-boundary', tools: () => [{ name: 'steering_boundary', definition: { type: 'function', function: { name: 'steering_boundary', description: 'test only', parameters: { type: 'object' } } }, execute }] });
    stream.mockResolvedValueOnce({ content: 'Working', toolCalls: [{ id: 'operation', type: 'function', function: { name: 'steering_boundary', arguments: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    await launch(); await started;
    loop.enqueueSteer('runtime-r', { id: 'question', content: 'What is happening?' });
    expect(loop.expediteSteer('runtime-r')).toBe(true);
    expect(toolSignal?.aborted).not.toBe(true);
    expect(stream).toHaveBeenCalledOnce();
    finish();
    expect((await settled()).status).toBe('done');
    expect(execute).toHaveBeenCalledOnce();
    const context = stream.mock.calls[1][0].payload.messages;
    expect(JSON.stringify(context)).toContain('original operation completed');
    expect(JSON.stringify(context)).toContain('What is happening?');
  });

  it('discards a late sampled tool call after steering and does not run its side effect', async () => {
    let finish!: (v: any) => void;
    let began!: () => void;
    let oldCallbacks: any;
    const started = new Promise<void>((resolve) => { began = resolve; });
    stream.mockImplementationOnce(async (opts: any) => { oldCallbacks = opts; began(); return new Promise((resolve) => { finish = resolve; }); });
    await launch(); await started;
    loop.enqueueSteer('runtime-r', { id: 'question', content: 'Change the approach' });
    loop.expediteSteer('runtime-r');
    oldCallbacks.onToken('LATE AND INVALID');
    finish({ content: 'LATE AND INVALID', toolCalls: [{ id: 'late', type: 'function', function: { name: 'write_file', arguments: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect((await settled()).status).toBe('done');
    expect(stream).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(stream.mock.calls[1][0].payload.messages)).not.toContain('LATE AND INVALID');
    const calls = await query<any[]>(`SELECT * FROM agent_run_events WHERE run_id = 'runtime-r' AND type = 'tool_call'`);
    expect(calls).toHaveLength(0);
  });

  it('rejects steering after a real stop', async () => {
    stream.mockImplementationOnce(async () => { abortRun('runtime-r'); return { content: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }; });
    await launch(); expect((await settled()).status).toBe('aborted');
    expect(loop.enqueueSteer('runtime-r', { id: 'late', content: 'too late' })).toBe(false);
    expect(loop.expediteSteer('runtime-r')).toBe(false);
  });
  it('interrupts sampling, not the run, retains partial text and injects attachments once', async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    stream.mockImplementationOnce(async (opts: any) => {
      opts.onToken('Already inspected the window.');
      began();
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    });
    await launch(); await started;
    expect(loop.enqueueSteer('runtime-r', { id: 'question', content: 'Why is it slow?', attachments: [{ mimeType: 'image/png', data: 'AAAA' }] })).toBe(true);
    const app = express(); app.use(express.json()); app.use(runsRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const url = `http://127.0.0.1:${(server.address() as any).port}/agent/runs`;
    try {
      const body = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: JSON.stringify({ flush: true }) };
      expect((await fetch(`${url}/runtime-r/steer`, { ...body, headers: { 'Content-Type': 'application/json' } })).status).toBe(401);
      expect((await fetch(`${url}/unknown/steer`, body)).status).toBe(404);
      await createRun({ id: 'foreign-run', sessionId: 'runtime-s', userId: 'someone-else', appId: 'tangu', modelId: 'm', assistantMessageId: 'foreign-a', input: {} });
      expect((await fetch(`${url}/foreign-run/steer`, body)).status).toBe(404);
      expect((await fetch(`${url}/runtime-r/steer`, body)).status).toBe(200);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    expect((await settled()).status).toBe('done');
    expect(stream).toHaveBeenCalledTimes(2);
    const context = stream.mock.calls[1][0].payload.messages;
    expect(JSON.stringify(context)).toContain('Already inspected the window.');
    expect(JSON.stringify(context)).toContain('inspect the parser');
    expect(JSON.stringify(context)).toContain('data:image/png;base64,AAAA');
    const rows = await query<any[]>(`SELECT role, content FROM chat_messages WHERE session_id = 'runtime-s'`);
    expect(rows.filter((r) => r.content === 'Why is it slow?')).toHaveLength(1);
    expect(rows.some((r) => r.content.includes('<turn_interrupted>'))).toBe(false);
  });

  it('restores completed tool calls and results through the real database adapter', async () => {
    const calls = [{ id: 'past-tool', type: 'function', function: { name: 'use_skill', arguments: '{"skill_id":"local:computer-use"}' } }];
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, tool_calls, tool_results) VALUES ('past', 'runtime-s', 'model', '', 1, ?, ?)`,
      [JSON.stringify(calls), JSON.stringify([{ tool_call_id: 'past-tool', content: 'Skill loaded successfully' }])]);
    await launch(); expect((await settled()).status).toBe('done');
    const context = stream.mock.calls[0][0].payload.messages;
    expect(context).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'past-tool', content: 'Skill loaded successfully' }));
  });
});

describe('screenshot stall and stop/restart regression', () => {
  it('does not spend another summary call on the same context after usage recalibration', async () => {
    await screenshotHistory();
    let summaries = 0;
    let turns = 0;
    stream.mockImplementation(async (opts: any) => {
      if (String(opts.payload.messages[0].content).includes('You are performing a context checkpoint')) {
        summaries++;
        return { content: 'Keep the completed work. Continue the existing task.', toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 10 } };
      }
      turns++;
      return { content: 'finished', toolCalls: turns <= 4
        ? [{ id: `todo-${turns}`, type: 'function', function: { name: 'todo_read', arguments: '{}' } }] : [],
      usage: { prompt_tokens: 125_000, completion_tokens: 10 } };
    });
    await launch();
    expect((await settled()).status).toBe('done');
    expect(await waitForRunSettlement('runtime-r')).toBe(true);
    expect(turns).toBeGreaterThanOrEqual(5);
    expect(summaries).toBe(1);
  });

  it('fails explicitly when the protected context still cannot fit, without deleting the attachment', async () => {
    await screenshotHistory();
    contextWindow = 4000;
    await launch();
    const result = await settled();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Context remains over');
    expect(await waitForRunSettlement('runtime-r')).toBe(true);
    expect(stream).toHaveBeenCalledOnce(); // one summary, no repeated compaction/provider retry loop
    const rows = await query<any[]>(`SELECT attachments FROM chat_messages WHERE id = 'history-23'`);
    expect(JSON.parse(rows[0].attachments)[0].data).toHaveLength(2_406_140);
  });

  it('keeps the historical screenshot without compacting on every run or tool iteration', async () => {
    await screenshotHistory();
    let toolsReturned = false;
    stream.mockImplementation(async (opts: any) => {
      const msgs = opts.payload.messages;
      expect(String(msgs[0].content)).not.toContain('You are performing a context checkpoint');
      expect(msgs.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))).toBe(true);
      const toolCalls = !toolsReturned ? [{ id: 'todo', type: 'function', function: { name: 'todo_read', arguments: '{}' } }] : [];
      toolsReturned = true;
      return { content: 'finished', reasoning: '', toolCalls, usage: { prompt_tokens: 23_103, completion_tokens: 20 } };
    });
    await launch();
    expect((await settled()).status).toBe('done');
    expect(await waitForRunSettlement('runtime-r')).toBe(true);
    await queueNext();
    expect((await settled('runtime-resume')).status).toBe('done');
    expect(await waitForRunSettlement('runtime-resume')).toBe(true);
    expect(stream.mock.calls.length).toBeGreaterThanOrEqual(3);
    const events = await query<any[]>(`SELECT payload FROM agent_run_events WHERE type = 'status'`);
    expect(events.map((e) => JSON.parse(e.payload)).filter((e) => e.phase === 'compacting')).toEqual([]);
  });

  it.each(['summary', 'first-frame'])('cancels during %s and starts the queued next run', async (phase) => {
    if (phase === 'summary') { await screenshotHistory(); contextWindow = 4000; }
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let transportSignal: AbortSignal | undefined;
    stream.mockImplementationOnce(async (opts: any) => {
      if (phase === 'summary') expect(String(opts.payload.messages[0].content)).toContain('context checkpoint');
      transportSignal = opts.signal;
      started();
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    });
    await launch();
    await entered;
    contextWindow = 128_000;
    await queueNext();
    abortRun('runtime-r');
    expect(await waitForRunSettlement('runtime-r')).toBe(true);
    expect(transportSignal?.aborted).toBe(true);
    expect((await settled()).status).toBe('aborted');
    expect((await settled('runtime-resume')).status).toBe('done');
    expect(await waitForRunSettlement('runtime-resume')).toBe(true);
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('does not claim settlement for a provider still running, or accept its late success after cancellation', async () => {
    let release!: () => void;
    stream.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ content: 'late success', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }); }));
    await launch();
    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());
    abortRun('runtime-r');
    expect(await waitForRunSettlement('runtime-r', 10)).toBe(false);
    release();
    expect(await waitForRunSettlement('runtime-r')).toBe(true);
    expect((await settled()).status).toBe('aborted');
  });
});
