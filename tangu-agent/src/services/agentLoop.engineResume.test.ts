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
import { bumpHistoryRevision, historyEpoch } from './historyRevision.js';
import type { EngineManager, EngineRunCtx } from '../engines/manager.js';

type Behavior = { hang?: boolean; gone?: boolean; busy?: boolean };
let home: string;
let calls: Array<{ engineId: string; resume?: string; from?: string | null; message: string }>;
let next: Behavior[];
let seq: number;
let started: () => void;
let runs: string[];
let via: 'load' | 'resume';
let verified: boolean; // 引擎层按握手里的适配器名给的:普通对话里这个引擎会话下一轮能不能接着用
let agent: string | undefined; // 握手里报的适配器名

const engines: EngineManager = {
  list: () => [], has: (id) => id === 'dsh' || id === 'codex',
  capabilities: async () => ({ models: [], commands: [] }), setDefaultModel: () => {}, dispose: async () => {},
  run: async (ctx: EngineRunCtx) => {
    const b = next.shift() || {};
    calls.push({ engineId: ctx.engineId, resume: ctx.resumeSessionId, from: ctx.resumeFromAgent, message: ctx.message });
    if (b.busy) throw new Error('Fake Harness has this conversation open in another window or process, so it cannot be continued here.');
    if (b.gone) throw Object.assign(new Error('Fake Harness no longer has the earlier session of this conversation (not resumable).'), { externalSessionGone: true });
    const id = ctx.resumeSessionId || `ext-${++seq}`;
    await ctx.onSession?.({ id, resumable: true, resumed: !!ctx.resumeSessionId, via, verifiedForChat: verified, ...(agent ? { agent } : {}) });
    started();
    if (b.hang) await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    return { content: `answer to ${ctx.message}`, externalSessionId: id };
  },
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-engine-resume-'));
  process.env.TANGU_HOME = home;
  calls = []; next = []; seq = 0; runs = []; started = () => {}; via = 'resume'; verified = true; agent = 'fake-harness';
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
async function turn(n: number, cfg: Record<string, unknown> = {}, opts: { stopWhenStarted?: boolean; session?: string; message?: string } = {}) {
  const runId = `r${n}`; runs.push(runId);
  const sid = opts.session || 'S';
  await createRun({ id: runId, sessionId: sid, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `a${n}`,
    input: { message: opts.message ?? `q${n}`, userMessageId: `u${n}`, attachments: [], agentConfig: { engineId: 'dsh', execMode: 'host', cwd: home, approvalMode: 'readonly', compaction: { enabled: false }, ...cfg } } });
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
    expect((await resultOf(1)).result.externalSession).toEqual({ id: 'ext-1', engineId: 'dsh', cwd: home, after: null, rev: 0, epoch: historyEpoch, agent: 'fake-harness' });
    expect((await resultOf(2)).result.externalSession).toEqual({ id: 'ext-1', engineId: 'dsh', cwd: home, after: 'a1', rev: 0, epoch: historyEpoch, agent: 'fake-harness' });
    // 续接时把「是哪家适配器记下的」一起交给引擎层核对;第一轮没有可续接的,不传
    expect(calls.map((c) => c.from)).toEqual([undefined, 'fake-harness', 'fake-harness']);
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

  // 被停的那一轮在库里什么都不留(引擎对话的用户消息引擎这边不落库,回答还没有):改没改过只能靠历史版本号认。
  // 客户端的截断重发(重试 / 改了再发 / 重新生成)和回退都走删消息那个入口,入口会让版本号加一 —— 这里直接加。
  it('第二轮被停后,那一句被改了重发 → 不续接:引擎会话里还记着被弃掉的那一句', async () => {
    await turn(1);
    next = [{ hang: true }];
    await turn(2, {}, { stopWhenStarted: true });
    bumpHistoryRevision('S');
    await turn(3);
    expect(resumes()).toEqual([null, 'ext-1', null]);
    await turn(4); // 新开的那个往后照常续接
    expect(resumes()[3]).toBe('ext-2');
    expect((await resultOf(3)).result.externalSession).toMatchObject({ id: 'ext-2', rev: 1 });
  }, 20_000);

  // 客户端的「重试」也走截断重发(版本号加一),但发的是原话:没有被弃掉的东西,照旧续接 —— 新开等于不声不响丢上文。
  it('第二轮被停 / 中途出错后原样重试 → 照样续接', async () => {
    await turn(1);
    next = [{ hang: true }];
    await turn(2, {}, { stopWhenStarted: true });
    bumpHistoryRevision('S');
    expect((await turn(3, {}, { message: 'q2' })).done).toBe(true);
    expect(resumes()).toEqual([null, 'ext-1', 'ext-1']);
  }, 20_000);

  it('一轮没建成引擎会话就失败了(被占着),那边放开后点重试 → 照样续接上一轮的会话', async () => {
    await turn(1);
    next = [{ busy: true }];
    expect((await turn(2)).error).toMatch(/open in another window/);
    bumpHistoryRevision('S'); // 重试:截断重发把失败的那一句删了再发
    expect((await turn(3, {}, { message: 'q2' })).done).toBe(true);
    bumpHistoryRevision('S'); // 改成别的话再发也一样:那一句引擎从没见过,没有什么要弃掉
    next = [{ busy: true }]; await turn(4);
    bumpHistoryRevision('S');
    expect((await turn(5, {}, { message: 'something else' })).done).toBe(true);
    expect(resumes()).toEqual([null, 'ext-1', 'ext-1', 'ext-1', 'ext-1']);
  }, 20_000);

  it('指针不是本进程记的(引擎重启过,版本号从头数)→ 不知道改没改过,不拿两个数字硬比', async () => {
    next = [{ hang: true }];
    await turn(1, {}, { stopWhenStarted: true });
    const [row] = await query<any[]>(`SELECT result FROM agent_runs WHERE id = 'r1'`);
    const result = JSON.parse(row.result);
    result.externalSession.epoch = 'another-process'; result.externalSession.rev = 7;
    await query(`UPDATE agent_runs SET result = ? WHERE id = 'r1'`, [JSON.stringify(result)]);
    await turn(2);
    expect(resumes()).toEqual([null, 'ext-1']);
  }, 20_000);

  it('中间夹着十几次没建成引擎会话的失败(一直被占着)→ 指针不被挤出去,那边放开后照样续接', async () => {
    await turn(1);
    for (let i = 2; i <= 15; i++) { next = [{ busy: true }]; expect((await turn(i)).error).toMatch(/open in another window/); }
    expect((await turn(16)).done).toBe(true);
    expect(resumes().slice(1)).toEqual(Array(15).fill('ext-1'));
  }, 40_000);

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

// 走 session/load 的引擎续接时会把历史重放一遍。哪几家的适配器用真引擎核过,由引擎层判(acpEngine 的 chatResumeVerified,
// 按握手里的适配器名);这里只看对话循环照不照它办。
describe('走 session/load 的引擎', () => {
  it('用真引擎核过的适配器(Codex)→ 第二句、第三句续接,指针记在 run 上', async () => {
    via = 'load'; verified = true;
    await turn(1, { engineId: 'codex' }); await turn(2, { engineId: 'codex' }); await turn(3, { engineId: 'codex' });
    expect(resumes()).toEqual([null, 'ext-1', 'ext-1']);
    expect((await resultOf(1)).result.externalSession).toMatchObject({ id: 'ext-1', engineId: 'codex', after: null });
    expect((await resultOf(2)).result.externalSession).toMatchObject({ id: 'ext-1', engineId: 'codex', after: 'a1' });
  }, 20_000);

  it('还没核过的适配器(Claude Code)→ 照旧每轮新开、不记指针:不动它今天的行为', async () => {
    via = 'load'; verified = false;
    await turn(1); await turn(2);
    expect(resumes()).toEqual([null, null]);
    expect((await resultOf(1)).result.externalSession).toBeUndefined();
    expect((await resultOf(2)).result.externalSession).toBeUndefined();
  }, 20_000);

  it('老指针没记是哪家适配器 → 照样续接,交给引擎层的是 null(只看核没核过)', async () => {
    agent = undefined;
    await turn(1); await turn(2);
    expect(resumes()).toEqual([null, 'ext-1']);
    expect((await resultOf(1)).result.externalSession.agent).toBeUndefined();
    expect(calls.map((c) => c.from)).toEqual([undefined, null]);
  }, 20_000);

  it('引擎层没说核过(老的引擎管理器不带这一项)→ 当成没核过', async () => {
    via = 'resume'; verified = undefined as unknown as boolean;
    await turn(1); await turn(2);
    expect(resumes()).toEqual([null, null]);
  }, 20_000);
});

describe('插件任务照旧按插件点名的会话续接', () => {
  it('用会话配置里的 externalSession,不看 run 上的指针,也不让引擎层核适配器', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES ('T', 'u1', 'tangu', 'task', 'm1', 'task', ?)`,
      [JSON.stringify({ pluginOwner: 'p', execMode: 'host', cwd: home, preset: null, externalSession: { id: 'plug-7', engineId: 'dsh', cwd: home } })]);
    expect((await turn(1, {}, { session: 'T' })).done).toBe(true);
    expect(resumes()).toEqual(['plug-7']);
    expect(calls[0].from).toBeUndefined();
    expect((await resultOf(1)).result.externalSession).toBeUndefined();
    const [{ agent_config }] = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = 'T'`);
    expect((typeof agent_config === 'string' ? JSON.parse(agent_config) : agent_config).externalSession).toEqual({ id: 'plug-7', engineId: 'dsh', cwd: home });
  }, 20_000);
});
