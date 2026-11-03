/**
 * delegate 续用:回报带 id → resume 接着同一个子会话干。走真 delegate.execute + 真 hydrateHistory + 内存 SQLite,
 * 假的只有模型。钉的是这几件事:
 *   ① 第二轮真带着上一轮的工具调用与结果上模型,且不新开子会话;
 *   ② 只有本会话自己派出的 delegate 子会话续得上,别的一律清楚地拒掉、绝不跑模型;
 *   ③ 授予沿用原值并按当前口径重验,续用不是加权限的入口;
 *   ④ 同一 id 不能同时跑两轮;
 *   ⑤ 上下文超窗口时先压,压不下来报错。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { claimDelegate, isDelegateActive, releaseDelegate } from './delegateTranscript.js';
import type { ToolContext } from '../tools/registry.js';

await import('../tools/registry.js'); // 内置 provider 在门面模块顶层注册,validateGrants 的 resolveTools 靠它
const { delegateProvider } = await import('../tools/builtin/delegate.js');
const execute = (delegateProvider.tools()[0] as any).execute as (args: any, ctx: ToolContext) => Promise<string>;

const USER = 'u1';
const CHILD = 'c1d2e3f4-0000-4000-8000-000000000001';
const OTHER_PARENT = 'a0000000-0000-4000-8000-000000000002';
const OTHER_USER = 'a0000000-0000-4000-8000-000000000003';
const HISTORIAN = 'a0000000-0000-4000-8000-000000000004';
const ENGINE = 'a0000000-0000-4000-8000-000000000005';
const BROKEN = 'a0000000-0000-4000-8000-000000000006';
const GRANTED = 'a0000000-0000-4000-8000-000000000007';
const profile = createTanguProfile({ sandboxMode: 'none' });
let home: string;
let requests: any[];
let script: Array<() => any>;
let model: Record<string, unknown>;
let events: Array<{ type: string; payload: any }>;
let unsubscribe: () => void;
let db: { close(): void };

const reply = (content: string) => ({ content, reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' });
const callDatetime = (id: string) => ({ content: '', reasoning: '', toolCalls: [{ id, type: 'function', function: { name: 'get_datetime', arguments: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'tool_calls' });
const idOf = (report: string) => /\[subagent id: ([0-9a-f]{8}) /.exec(report)?.[1] ?? '';
// execMode='sandbox':闸门对非 mcp 工具直接放行,不依赖审批订阅者。
const ctxOf = (extra: Partial<ToolContext> = {}): ToolContext => ({
  userId: USER, sessionId: 'S', appId: 'tangu', runId: 'R1', modelId: 'm1', profile, execMode: 'sandbox', thinkingLevel: 'medium', ...extra,
} as ToolContext);
const insertDelegate = (id: string, config: Record<string, unknown>, extra: { kind?: string; parent?: string; user?: string } = {}) => query(
  `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, agent_config) VALUES (?, ?, 'tangu', 'Worker', 'm1', ?, ?, ?)`,
  [id, extra.user ?? USER, extra.kind ?? 'delegate', extra.parent ?? 'S', JSON.stringify(config)],
);
const rowsOf = (id: string) => query<any[]>('SELECT id, role, content FROM chat_messages WHERE session_id = ? ORDER BY timestamp, role DESC', [id]);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-subresume-'));
  process.env.TANGU_HOME = home;
  requests = []; script = []; events = []; model = { provider: 'test', name: 'test' };
  const sqlite = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db = sqlite.db;
  sqlite.db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const llm: any = {
    resolveModelAndKey: async () => ({ model, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), cacheKey: o.cacheKey }),
    streamProviderCompletion: async (o: any) => {
      requests.push(o.payload);
      const step = script.shift();
      if (!step) throw new Error(`no scripted reply for call ${requests.length}`);
      return step();
    },
  };
  configureTangu({
    host: sqlite.host, profile,
    brain: { llm, users: { getUserById: async () => ({ id: USER }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false } } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
  await createRun({ id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1', input: { message: 'go', userMessageId: 'U1', attachments: [], agentConfig: {} } });
  unsubscribe = subscribe('R1', (ev) => events.push({ type: ev.type, payload: ev.payload }));
});

afterEach(() => {
  unsubscribe?.();
  db.close();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('delegate resume', () => {
  it('接着原上下文跑:第二轮带着上一轮的工具结果,不新开子会话,两轮各落各的行', async () => {
    script = [() => callDatetime('tc1'), () => reply('The time is known.')];
    const first = await execute({ task: 'What time is it?', instructions: 'You are the clock keeper.', name: 'Clock' }, ctxOf());
    const id = idOf(first);
    expect(first).toContain('The time is known.');
    expect(id).not.toBe('');

    script = [() => reply('Follow-up answered.')];
    const second = await execute({ task: 'And the date?', context: 'Same clock.', resume: id }, ctxOf());
    expect(second).toContain('Follow-up answered.');
    expect(idOf(second), '续用后 id 不变,还能接着续').toBe(id);

    const wire = requests.at(-1).messages as any[];
    expect(wire[0].content, '人设跟着回来').toContain('You are the clock keeper.');
    expect(wire.some((m) => m.tool_calls?.some((c: any) => c.id === 'tc1'))).toBe(true);
    expect(wire.find((m) => m.role === 'tool' && m.tool_call_id === 'tc1')?.content).toBeTruthy();
    expect(wire.at(-1)).toMatchObject({ role: 'user', content: 'And the date?\n\n## Context\nSame clock.' });
    expect(requests.at(-1).cacheKey).toBe(requests[0].cacheKey);

    const sessions = await query<any[]>(`SELECT id FROM chat_sessions WHERE kind = 'delegate'`);
    expect(sessions).toHaveLength(1);
    const full = sessions[0].id as string;
    expect(full.startsWith(id)).toBe(true);
    const rows = await rowsOf(full);
    expect(rows.map((r) => r.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(rows[1].content).toBe('The time is known.');
    expect(rows[3].content, '第二轮写新行,不覆盖上一轮').toBe('Follow-up answered.');

    const starts = events.filter((e) => e.type === 'subagent' && e.payload.phase === 'start').map((e) => e.payload);
    expect(starts[0].messageId).toBe(`delegate:${full}`);
    expect(starts[0].userMessageId).toBeUndefined();
    expect(starts[1].messageId).toBe(rows[3].id);
    expect(starts[1].userMessageId).toBe(rows[2].id);
    expect(starts[1].grants).toEqual([]);
    expect(isDelegateActive(full)).toBe(false);
  }, 20_000);

  it('全长 id 也认;大小写不敏感;短 id 撞上两条就不猜;回报里的短 id 不带通配符空间', async () => {
    await insertDelegate(CHILD, {});
    await insertDelegate('c1d2e3f4-ffff-4000-8000-000000000009', {});
    expect(await execute({ task: 'x', resume: 'c1d2e3f4' }, ctxOf()), '前缀撞车').toMatch(/^Error: no subagent/);
    expect(await execute({ task: 'x', resume: '%' }, ctxOf()), '通配符').toMatch(/^Error: no subagent/);
    expect(await execute({ task: 'x', resume: 'c1d2' }, ctxOf()), '太短').toMatch(/^Error: no subagent/);
    expect(requests).toEqual([]);
    script = [() => reply('full id ok')];
    expect(await execute({ task: 'x', resume: CHILD.toUpperCase() }, ctxOf())).toContain('full id ok');
  }, 20_000);

  it('重启之后也续得上:上下文只来自落库,不靠内存(用户在子会话里聊过的也算)', async () => {
    await insertDelegate(CHILD, { subAgentGrants: [] });
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('u', ?, 'user', 'old task', 1), ('a', ?, 'model', 'old finding: 42', 2)`, [CHILD, CHILD]);
    script = [() => reply('ok')];
    await execute({ task: 'next', resume: CHILD }, ctxOf());
    expect((requests[0].messages as any[]).map((m) => m.content)).toEqual(expect.arrayContaining(['old task', 'old finding: 42', 'next']));
  }, 20_000);

  it('查无此人 / 别的会话 / 别的用户 / 不是 delegate 的后台会话:一律拒,模型一次都不调', async () => {
    await insertDelegate(OTHER_PARENT, {}, { parent: 'S2' });
    await insertDelegate(OTHER_USER, {}, { user: 'u2' });
    await insertDelegate(HISTORIAN, {}, { kind: 'historian' });
    for (const id of ['nope', 'deadbeef', OTHER_PARENT, OTHER_USER, HISTORIAN]) {
      const r = await execute({ task: 'x', resume: id }, ctxOf());
      expect(r, id).toMatch(/^Error: no subagent with id/);
      expect(r, '要告诉模型下一步怎么走').toContain('Delegate a new subagent');
    }
    expect(await execute({ task: 'x', resume: OTHER_PARENT }, ctxOf({ sessionId: undefined as any }))).toMatch(/^Error: no subagent/);
    expect(requests).toEqual([]);
  }, 20_000);

  it('外部引擎跑的子代理续不了;engine 参数与 resume 也不能同用', async () => {
    await insertDelegate(ENGINE, { engineId: 'codex' });
    expect(await execute({ task: 'x', resume: ENGINE }, ctxOf())).toMatch(/external engine 'codex'.*cannot be resumed/);
    expect(await execute({ task: 'x', resume: ENGINE, engine: 'codex' }, ctxOf())).toMatch(/^Error: engine cannot be combined with resume/);
    expect(requests).toEqual([]);
  }, 20_000);

  it('定下来的东西改不了:grantTools / agentSlug / instructions / name 与 resume 同传都拒', async () => {
    await insertDelegate(CHILD, {});
    for (const [k, v] of [['grantTools', ['manage_schedule']], ['agentSlug', 'x'], ['instructions', 'y'], ['name', 'z']] as const) {
      expect(await execute({ task: 'x', resume: CHILD, [k]: v }, ctxOf()), k).toMatch(new RegExp(`^Error: ${k} cannot be combined with resume`));
    }
    expect(requests).toEqual([]);
  }, 20_000);

  it('授予按当前口径重验:父代理已失去的工具续不了,还在的原样沿用', async () => {
    await insertDelegate(GRANTED, { subAgentGrants: ['manage_agent'] });
    const denied = await execute({ task: 'x', resume: GRANTED }, ctxOf()); // sandbox 形态下 manage_agent 不可达
    expect(denied).toMatch(/cannot grant "manage_agent"/);
    expect(denied).toContain('cannot be resumed with its original permissions');
    expect(requests).toEqual([]);
    expect(isDelegateActive(GRANTED), '被拒时不能留下占位').toBe(false);

    script = [() => reply('ok')];
    await execute({ task: 'x', resume: GRANTED }, ctxOf({ execMode: 'host', cwd: home, approvalMode: 'full-auto' })); // 正对照:host 形态下可达
    expect(events.find((e) => e.type === 'subagent' && e.payload.phase === 'start')?.payload.grants).toEqual(['manage_agent']);
  }, 20_000);

  it('配置读不出来时不当「没有授予」往下跑', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, agent_config) VALUES (?, ?, 'tangu', 't', 'm1', 'delegate', 'S', '{oops')`, [BROKEN, USER]);
    await expect(execute({ task: 'x', resume: BROKEN }, ctxOf())).rejects.toThrow();
    expect(requests).toEqual([]);
  }, 20_000);

  it('同一 id 不能同时跑两轮:并行续用只有一个进得去,结束后放开', async () => {
    await insertDelegate(CHILD, {});
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    script = [() => gate.then(() => reply('done'))];
    const running = execute({ task: 'a', resume: CHILD }, ctxOf());
    await new Promise((r) => setTimeout(r, 50));
    expect(isDelegateActive(CHILD)).toBe(true);
    expect(await execute({ task: 'b', resume: CHILD }, ctxOf())).toMatch(/still running/);
    release();
    expect(await running).toContain('done');
    expect(isDelegateActive(CHILD)).toBe(false);
  }, 20_000);

  it('用户正在子会话里跑一轮时不抢;失败收尾也放开占位', async () => {
    await insertDelegate(CHILD, {});
    await createRun({ id: 'R2', sessionId: CHILD, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A2', input: { message: 'hi', userMessageId: 'U2', attachments: [], agentConfig: {} } });
    expect(await execute({ task: 'x', resume: CHILD }, ctxOf())).toMatch(/still running/);
    await query(`UPDATE agent_runs SET status = 'done' WHERE id = 'R2'`);
    script = []; // 模型调用失败(脚本耗尽);重试耗尽后走 delegate 的报错
    expect(await execute({ task: 'x', resume: CHILD }, ctxOf())).toMatch(/^Error: subagent failed/);
    expect(isDelegateActive(CHILD)).toBe(false);
  }, 20_000);

  it('别的进程占着(claim 直接占)时报 still running', async () => {
    await insertDelegate(CHILD, {});
    expect(claimDelegate(CHILD)).toBe(true);
    expect(await execute({ task: 'x', resume: CHILD }, ctxOf())).toMatch(/still running/);
    releaseDelegate(CHILD);
  }, 20_000);

  it('上下文过线:先压再跑,摘要进请求、追问还在', async () => {
    await insertDelegate(CHILD, {});
    model = { provider: 'test', name: 'test', context_window: 40_000 };
    const bulk = 'word '.repeat(19_000); // 单行不超历史硬帽,否则回放时已被截断、到不了压缩线
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('u', ?, 'user', 'old task', 1), ('a', ?, 'model', ?, 2), ('u2', ?, 'user', 'second task', 3), ('a2', ?, 'model', ?, 4), ('u3', ?, 'user', 'third task', 5), ('a3', ?, 'model', 'third answer', 6)`, [CHILD, CHILD, bulk, CHILD, CHILD, bulk, CHILD, CHILD]);
    script = [() => reply('SUMMARY-OF-OLD-WORK with enough text'), () => reply('ok')];
    expect(await execute({ task: 'next', resume: CHILD }, ctxOf())).toContain('ok');
    expect(requests).toHaveLength(2);
    const wire = requests[1].messages as any[];
    expect(wire.some((m) => JSON.stringify(m.content).includes('SUMMARY-OF-OLD-WORK'))).toBe(true);
    expect(wire.filter((m) => JSON.stringify(m.content).includes(bulk)), '老的那份进了摘要,最近的留原文').toHaveLength(1);
    expect(wire.at(-1)).toMatchObject({ role: 'user', content: 'next' });
  }, 20_000);

  it('行数超出回放窗口:老行先进持久摘要,不静默丢(Codex 10-30)', async () => {
    await insertDelegate(CHILD, {});
    for (let i = 0; i < 30; i++) {
      await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?), (?, ?, 'model', ?, ?)`,
        [`u${i}`, CHILD, `question ${i}`, i * 2 + 1, `a${i}`, CHILD, i === 0 ? 'THE-OLDEST-FINDING' : `answer ${i}`, i * 2 + 2]);
    }
    script = [() => reply('SUMMARY keeps THE-OLDEST-FINDING for later'), () => reply('ok')];
    expect(await execute({ task: 'next', resume: CHILD }, ctxOf())).toContain('ok');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0].messages), '摘要的输入里有最老那行').toContain('THE-OLDEST-FINDING');
    expect(JSON.stringify(requests[1].messages), '续用的请求里有摘要').toContain('SUMMARY keeps THE-OLDEST-FINDING');
  }, 20_000);

  it('工具轮带上落库的推理:DeepSeek / GLM 要它,别的端点由兼容层剥掉(Codex 10-30)', async () => {
    await insertDelegate(CHILD, {});
    const calls = JSON.stringify([{ id: 'tc1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } }]);
    const results = JSON.stringify([{ tool_call_id: 'tc1', name: 'get_datetime', content: 'noon', isError: false }]);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('u', ?, 'user', 'q', 1)`, [CHILD]);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, reasoning, tool_calls, tool_results) VALUES ('a', ?, 'model', 'done', 2, 'THOUGHT', ?, ?)`, [CHILD, calls, results]);
    script = [() => reply('ok')];
    await execute({ task: 'next', resume: CHILD }, ctxOf());
    expect((requests[0].messages as any[]).find((m) => m.tool_calls)?.reasoning_content).toBe('THOUGHT');
  }, 20_000);

  it('压不下来就报错,不带着注定被拒的上下文去请求', async () => {
    await insertDelegate(CHILD, {});
    model = { provider: 'test', name: 'test', context_window: 4_000 };
    const long = 'word '.repeat(9_000);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('u', ?, 'user', ?, 1), ('a', ?, 'model', ?, 2)`, [CHILD, long, CHILD, long]);
    script = []; // 摘要调用失败,机械折叠又不动受保护的最近几条
    expect(await execute({ task: long, resume: CHILD }, ctxOf())).toMatch(/^Error: subagent failed: its context no longer fits/);
    expect(isDelegateActive(CHILD)).toBe(false);
    expect((await rowsOf(CHILD)).length, '没开新一轮').toBe(2);
  }, 20_000);
});
