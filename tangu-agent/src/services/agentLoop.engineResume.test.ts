/** 普通引擎对话的续接规则:真对话循环 + 内存 SQLite,引擎换成一个只记「这一轮让它续接哪个会话」的假管理器。
 *  规则只有一条:这场对话里最新的那条回答,必须就是那个引擎会话里最新的一条 —— 对不上就新开,不让引擎记着界面上已经没有的东西。 */
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
import { createRun } from './runStore.js';
import { subscribe } from './eventBus.js';
import { abortRun, enqueueRun, waitForRunSettlement } from './agentLoop.js';
import type { EngineManager, EngineRunCtx } from '../engines/manager.js';

type Behavior = { hang?: boolean; gone?: boolean };
let home: string;
let calls: Array<{ engineId: string; resume?: string; message: string }>;
let next: Behavior[];
let seq: number;
let started: () => void;
let runs: string[];
let via: 'load' | 'resume';

const engines: EngineManager = {
  list: () => [], has: (id) => id === 'dsh' || id === 'codex',
  capabilities: async () => ({ models: [], commands: [] }), setDefaultModel: () => {}, dispose: async () => {},
  run: async (ctx: EngineRunCtx) => {
    const b = next.shift() || {};
    calls.push({ engineId: ctx.engineId, resume: ctx.resumeSessionId, message: ctx.message });
    if (b.gone) throw Object.assign(new Error('Fake Harness no longer has the earlier session of this conversation (not resumable).'), { externalSessionGone: true });
    const id = ctx.resumeSessionId || `ext-${++seq}`;
    await ctx.onSession?.({ id, resumable: true, resumed: !!ctx.resumeSessionId, via });
    started();
    if (b.hang) await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    return { content: `answer to ${ctx.message}`, externalSessionId: id };
  },
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-engine-resume-'));
  process.env.TANGU_HOME = home;
  calls = []; next = []; seq = 0; runs = []; started = () => {}; via = 'resume';
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, engines, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['read_file'] }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: structuredClone(o.messages), tools: o.tools }),
        streamProviderCompletion: async (o: any) => { o.onToken?.('Tangu says hi.'); return { content: 'Tangu says hi.', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 2 }, finishReason: 'stop' }; },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
});
afterEach(async () => {
  for (const id of runs) { abortRun(id); await waitForRunSettlement(id, 2000); }
  delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true });
});

/** 发一句,等这一轮结束。stopWhenStarted = 引擎会话建立后按停止键。回 { done, error }。 */
async function turn(n: number, cfg: Record<string, unknown> = {}, opts: { stopWhenStarted?: boolean; session?: string } = {}) {
  const runId = `r${n}`; runs.push(runId);
  const sid = opts.session || 'S';
  await createRun({ id: runId, sessionId: sid, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `a${n}`,
    input: { message: `q${n}`, userMessageId: `u${n}`, attachments: [], agentConfig: { engineId: 'dsh', execMode: 'host', cwd: home, approvalMode: 'readonly', compaction: { enabled: false }, ...cfg } } });
  const out = { done: false, error: '' };
  const ended = new Promise<void>((resolve) => {
    const off = subscribe(runId, (event) => {
      if (event.type === 'done') { out.done = true; off(); resolve(); }
      if (event.type === 'error') { out.error = String((event.payload as any)?.error || 'error'); off(); resolve(); }
    });
  });
  if (opts.stopWhenStarted) started = () => { started = () => {}; setTimeout(() => abortRun(runId), 0); };
  enqueueRun(sid, runId);
  await ended; await waitForRunSettlement(runId, 2000);
  return out;
}
const resumes = () => calls.map((c) => c.resume ?? null);
const resultOf = async (n: number) => { const [r] = await query<any[]>(`SELECT status, result FROM agent_runs WHERE id = ?`, [`r${n}`]); return { status: r.status, result: typeof r.result === 'string' ? JSON.parse(r.result || '{}') : r.result || {} }; };

describe('普通引擎对话的续接', () => {
  it('第二句、第三句续接第一句开的那个引擎会话;指针记在每一轮的 run 上', async () => {
    expect((await turn(1)).done).toBe(true);
    expect((await turn(2)).done).toBe(true);
    expect((await turn(3)).done).toBe(true);
    expect(resumes()).toEqual([null, 'ext-1', 'ext-1']);
    expect((await resultOf(1)).result.externalSession).toEqual({ id: 'ext-1', engineId: 'dsh', cwd: home, after: null });
    expect((await resultOf(2)).result.externalSession).toEqual({ id: 'ext-1', engineId: 'dsh', cwd: home, after: 'a1' });
    // 会话配置里不留指针(那一份客户端能整份改写、分支会照抄)
    const [{ agent_config }] = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = 'S'`);
    expect(JSON.stringify(agent_config ?? '')).not.toContain('ext-1');
  }, 20_000);

  it('重新生成 / 编辑重发(最后那条回答被删了)→ 不续接,新开一个', async () => {
    await turn(1); await turn(2);
    await query(`DELETE FROM chat_messages WHERE id = 'a2'`);
    await turn(3);
    expect(resumes()).toEqual([null, 'ext-1', null]); // ext-1 里还记着被删掉的第二轮,不能接着用
    await turn(4);
    expect(resumes()[3]).toBe('ext-2');
  }, 20_000);

  it('第二轮中途被停(没留下回答)→ 第三轮照样续接', async () => {
    await turn(1);
    next = [{ hang: true }];
    const stopped = await turn(2, {}, { stopWhenStarted: true });
    expect(stopped.done).toBe(false);
    expect((await resultOf(2)).status).toBe('aborted');
    expect((await turn(3)).done).toBe(true);
    expect(resumes()).toEqual([null, 'ext-1', 'ext-1']);
  }, 20_000);

  it('第一轮就被停 → 第二轮接的是同一个引擎会话(指针在 prompt 之前就记下了)', async () => {
    next = [{ hang: true }];
    await turn(1, {}, { stopWhenStarted: true });
    expect((await resultOf(1)).result.externalSession).toMatchObject({ id: 'ext-1', after: null });
    await turn(2);
    expect(resumes()).toEqual([null, 'ext-1']);
  }, 20_000);

  it('中间换 Tangu 答过一轮 → 回到引擎时不续接(引擎会话里没有那一轮)', async () => {
    await turn(1);
    expect((await turn(2, { engineId: undefined, execMode: 'sandbox' })).done).toBe(true);
    await turn(3);
    expect(calls.map((c) => c.message)).toEqual(['q1', 'q3']); // 第二轮没进引擎
    expect(resumes()).toEqual([null, null]);
  }, 20_000);

  it('换了引擎或工作目录 → 不续接', async () => {
    await turn(1);
    await turn(2, { engineId: 'codex' });
    await turn(3);
    await turn(4, { cwd: join(home, '..') });
    expect(resumes()).toEqual([null, null, null, null]);
    expect(calls.map((c) => c.engineId)).toEqual(['dsh', 'codex', 'dsh', 'dsh']);
  }, 20_000);

  it('引擎说那个会话没有了 → 这一句照实失败并说明怎么办,下一句新开,不再去找它', async () => {
    await turn(1);
    next = [{ gone: true }];
    const failed = await turn(2);
    expect(failed.done).toBe(false);
    expect(failed.error).toMatch(/no longer has the earlier session.*Send your message again to continue in a new session/);
    expect(await resultOf(2)).toMatchObject({ status: 'failed', result: { externalSessionReset: true } });
    expect((await turn(3)).done).toBe(true);
    expect((await turn(4)).done).toBe(true);
    expect(resumes()).toEqual([null, 'ext-1', null, 'ext-2']);
  }, 20_000);

  it('分支出来的新会话(回答换了新 id、没有自己的 run)不和原对话共用引擎会话', async () => {
    await turn(1);
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('B', 'u1', 'tangu', 'branch', 'm1', 'user')`);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('b-a1', 'B', 'model', 'answer to q1', ?)`, [Date.now()]);
    await turn(2, {}, { session: 'B' });
    await turn(3);
    expect(resumes()).toEqual([null, null, 'ext-1']);
  }, 20_000);
});

describe('走 session/load 的引擎(Claude Code / Codex)', () => {
  it('普通对话里先不续接:没用真引擎测过,不动它们今天的行为', async () => {
    via = 'load';
    await turn(1); await turn(2);
    expect(resumes()).toEqual([null, null]);
    expect((await resultOf(1)).result.externalSession).toBeUndefined();
  }, 20_000);
});

describe('插件任务照旧按插件点名的会话续接', () => {
  it('用会话配置里的 externalSession,不看 run 上的指针', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES ('T', 'u1', 'tangu', 'task', 'm1', 'task', ?)`,
      [JSON.stringify({ pluginOwner: 'p', execMode: 'host', cwd: home, preset: null, externalSession: { id: 'plug-7', engineId: 'dsh', cwd: home } })]);
    expect((await turn(1, {}, { session: 'T' })).done).toBe(true);
    expect(resumes()).toEqual(['plug-7']);
    expect((await resultOf(1)).result.externalSession).toBeUndefined();
    const [{ agent_config }] = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = 'T'`);
    expect((typeof agent_config === 'string' ? JSON.parse(agent_config) : agent_config).externalSession).toEqual({ id: 'plug-7', engineId: 'dsh', cwd: home });
  }, 20_000);
});
