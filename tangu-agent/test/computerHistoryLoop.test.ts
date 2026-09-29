/**
 * 电脑历史 × 真 loop(评审 09-27 两条 major 的落库 / 召回面,纯函数单测看不见):
 *   ① Muse 摘要只进本轮 wire,**不**进 agent_runs.input / chat_messages(此前 muse.ts 把它拼进 input.ephemeralHint,
 *      随 run 永久落 state.db,不受 7 天保留 / 清除 / 关闭约束);只认引擎内部的 input.background,请求体的 agentConfig.muse 不算。
 *   ② 跨会话召回(memoryRecall §3 历史片段)不把「调过 read_computer_history 的会话」注入过不了门禁的 run
 *      (功能关掉 / 远程设备页);过得了门禁的本机 run 照常召回(对照,证明召回链真的通)。
 * 真内存 SQLite + fake brain 抓 wire(同 ephemeralHintPersistence.test.ts)。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/computerHistoryLoop.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { computerHistoryDir, COMPUTER_HISTORY_PERSIST_PLACEHOLDER, CH_DESKTOP_CONFIG_ENV } from '../src/services/computerHistory.js';
import { normalizeHooksConfig, saveHooksConfig, syncUserTrust } from '../src/hooks/index.js';

const USER = 'u1';
const TERM = 'hummingbird';
const LEAK = 'CH-LEAK-MARK';
const PLAIN = 'PLAIN-RECALL-MARK';
const EVENT_MARK = 'ROADMAP-EVENT-MARK';

let home: string;
let llmPayloads: any[];
/** 按 payload 定制模型回复(缺省 null = 一律答「好。」);beforeEach 复位。 */
let llmScript: ((payload: any) => any) | null = null;
let prevVolatile: string | undefined;
/** 模型窗口(缺省不报 → 族表缺省窗口);压缩用例钉小,灌到触发线。beforeEach 复位。 */
let ctxWindow: number | undefined;
/** 压缩摘要调用的 payload(不进 llmPayloads);假摘要器把收到的转写原样回显进摘要,转写里有什么检查点里就有什么。 */
let summaryPayloads: any[];
const isSummaryCall = (p: any): boolean => String(p?.messages?.[0]?.content || '').includes('You are performing a context checkpoint compaction');

function chState(enabled: boolean): void {
  mkdirSync(computerHistoryDir(), { recursive: true });
  writeFileSync(join(computerHistoryDir(), 'state.json'), JSON.stringify({
    v: 1, enabled, pausedUntil: null, status: enabled ? 'recording' : 'off', since: Date.now() - 3_600_000, updatedAt: Date.now(), platform: 'darwin',
  }));
  // 第二道闸:桌面配置(桌面拉起引擎时经 FORSION_DESKTOP_CONFIG 传路径)与 state.json 同步开关
  writeFileSync(process.env[CH_DESKTOP_CONFIG_ENV]!, JSON.stringify({ computerHistoryEnabled: enabled }));
}
function chEvent(e: Record<string, unknown>): void {
  const d = new Date(e.t as number);
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
  mkdirSync(join(computerHistoryDir(), 'events'), { recursive: true });
  appendFileSync(join(computerHistoryDir(), 'events', name), JSON.stringify(e) + '\n');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-chloop-'));
  process.env.TANGU_HOME = home;
  process.env[CH_DESKTOP_CONFIG_ENV] = join(home, 'tangu-desktop-config.json');
  prevVolatile = process.env.TANGU_MEMORY_VOLATILE;
  delete process.env.TANGU_MEMORY_VOLATILE;
  llmPayloads = [];
  llmScript = null;
  ctxWindow = undefined;
  summaryPayloads = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({
        model: { provider: 'test', name: 'test', ...(ctxWindow ? { context_window: ctxWindow } : {}) }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm',
      }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        if (isSummaryCall(o.payload)) {
          summaryPayloads.push(o.payload);
          return { content: `## Goal\nECHO\n${o.payload.messages[1]?.content ?? ''}`, reasoning: '', toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: 20 }, finishReason: 'stop' };
        }
        llmPayloads.push(o.payload);
        if (llmScript) return llmScript(o.payload);
        return { content: '好。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' };
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0, logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
  // 过去的两个会话:P 里助手调过 read_computer_history 并复述了内容;Q 是普通会话(对照:藏匿只针对前者)
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('P', ?, 'tangu', 'what was I doing', 'm1', 'user')`, [USER]);
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('Q', ?, 'tangu', 'birds', 'm1', 'user')`, [USER]);
  const ts = Date.now() - 86_400_000;
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('P1', 'P', 'user', '我休息之前在做什么', ?)`, [ts]);
  await query(
    `INSERT INTO chat_messages (id, session_id, role, content, timestamp, tool_calls) VALUES ('P2', 'P', 'model', ?, ?, ?)`,
    [`You were editing the ${TERM} roadmap ${LEAK} and reviewing PR 4242.`, ts + 1,
      JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'read_computer_history', arguments: '{}' } }])],
  );
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('Q1', 'Q', 'user', ?, ?)`, [`${TERM} notes ${PLAIN}`, ts + 2]);
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  delete process.env[CH_DESKTOP_CONFIG_ENV];
  if (prevVolatile === undefined) delete process.env.TANGU_MEMORY_VOLATILE;
  else process.env.TANGU_MEMORY_VOLATILE = prevVolatile;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function runToSettled(id: string, msg: string, extraInput: Record<string, unknown> = {}): Promise<any> {
  await createRun({
    id, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${id}`,
    input: { message: msg, userMessageId: `U-${id}`, attachments: [], agentConfig: {}, ...extraInput },
  });
  enqueueRun('S', id);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(id);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 25));
  }
}
const inputOf = async (id: string): Promise<any> => { const i = (await getRun(id))!.input; return typeof i === 'string' ? JSON.parse(i) : i; };
const textOf = (m: any): string => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
const wireText = (payload: any): string => (payload.messages as any[]).map(textOf).join('\n');
const tailOf = (payload: any): string => textOf((payload.messages as any[])[payload.messages.length - 1]);

describe('跨会话召回不绕过电脑历史门禁', () => {
  it('对照:开着 + 本机 desktop 客户端 → 两个会话都召回得到(召回链是通的)', async () => {
    chState(true);
    expect((await runToSettled('R1', `${TERM} status?`, { client: 'desktop/1.0' })).status).toBe('done');
    const wire = wireText(llmPayloads[0]);
    expect(wire).toContain(PLAIN);
    expect(wire).toContain(LEAK);
  }, 30_000);

  it('关掉电脑历史后:调过 read_computer_history 的会话不再被召回,普通会话照常', async () => {
    chState(false);
    expect((await runToSettled('R1', `${TERM} status?`, { client: 'desktop/1.0' })).status).toBe('done');
    const wire = wireText(llmPayloads[0]);
    expect(wire, '普通会话照常召回(否则下一条是空真的)').toContain(PLAIN);
    expect(wire).not.toContain(LEAK);
  }, 30_000);

  it('开着但 run 来自远程设备页(input.remote):同样藏', async () => {
    chState(true);
    expect((await runToSettled('R1', `${TERM} status?`, { client: 'desktop/1.0', remote: { via: 'tunnel', marked: true } })).status).toBe('done');
    expect(wireText(llmPayloads[0])).toContain(PLAIN);
    expect(wireText(llmPayloads[0])).not.toContain(LEAK);
  }, 30_000);

  it('开着但无本机客户端(TUI / 通道 / 自动化不带 client):同样藏', async () => {
    chState(true);
    expect((await runToSettled('R1', `${TERM} again?`)).status).toBe('done');
    expect((await inputOf('R1')).client, '前提:这个 run 真的没有 client').toBeUndefined();
    expect(wireText(llmPayloads[0])).toContain(PLAIN);
    expect(wireText(llmPayloads[0])).not.toContain(LEAK);
  }, 30_000);
});

describe('Muse 电脑历史摘要:只进 wire,不落库', () => {
  beforeEach(() => {
    chState(true);
    chEvent({ t: Date.now() - 20 * 60_000, kind: 'app', app: { name: 'Code', bundleId: 'com.microsoft.VSCode' }, title: `${EVENT_MARK}.md` });
  });

  it('引擎内部 background=muse 的 run:wire 尾部有摘要,agent_runs.input 与 chat_messages 里都没有', async () => {
    const run = await runToSettled('M1', 'Start this round.', { background: 'muse', client: 'muse/1.0', ephemeralHint: 'HINT-ONLY' });
    expect(run.status).toBe('done');
    const tail = tailOf(llmPayloads[0]);
    expect(tail).toContain('HINT-ONLY');
    expect(tail).toContain('[computer-history:observed]');
    expect(tail).toContain(EVENT_MARK);
    const stored = JSON.stringify(await inputOf('M1'));
    expect(stored).toContain('HINT-ONLY'); // input 确实落库了(否则下一条是空真的)
    expect(stored).not.toContain('computer_history');
    expect(stored).not.toContain(EVENT_MARK);
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S'`);
    expect(rows.some((r) => String(r.content).includes(EVENT_MARK))).toBe(false);
  }, 30_000);

  it('棘轮:muse.ts 不再自己拼摘要(拼进 ephemeralHint = 随 agent_runs.input 永久落库;startCycle 没有集成测试,只能这样钉)', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/services/muse.ts'), 'utf8');
    expect(src).not.toMatch(/computerHistoryDigest\s*\(/);
  });

  it('负对照:请求体可控的 agentConfig.muse 不触发摘要注入', async () => {
    expect((await runToSettled('M2', 'Start this round.', { client: 'desktop/1.0', agentConfig: { muse: true } })).status).toBe('done');
    expect(wireText(llmPayloads[0])).not.toContain('[computer-history:observed]');
  }, 30_000);
});

describe('read_computer_history 结果:本轮模型拿全文,会话库只存占位(评审 09-27 #1)', () => {
  // 此前工具结果经通用流程落进 chat_messages.tool_results / agent_steps.tool_results / agent_run_events(tool_result 事件),
  // 三份副本都不受电脑历史的 7 天保留、清除、关闭约束。现在 executeOneToolCall 对声明了 persistPlaceholder 的工具只落占位。
  const MARK = 'CH-RESULT-MARK';
  const usage = { prompt_tokens: 10, completion_tokens: 5 };
  beforeEach(() => {
    chState(true);
    chEvent({ t: Date.now() - 20 * 60_000, kind: 'app', app: { name: 'Code', bundleId: 'com.microsoft.VSCode' }, title: `${MARK}.md` });
    // 第一轮调工具;看到 tool 结果后收尾(答复里不复述标记:要测的是工具结果本身的落库面)
    llmScript = (payload) => ((payload.messages as any[]).some((m) => m.role === 'tool')
      ? { content: 'You were editing a markdown file.', reasoning: '', toolCalls: [], usage, finishReason: 'stop' }
      : { content: '', reasoning: '', toolCalls: [{ id: 'ch1', type: 'function', function: { name: 'read_computer_history', arguments: '{}' } }], usage, finishReason: 'tool_calls' });
  });

  it('本轮第二次调用的 wire 里有全文;三处落库只有占位;下一轮回放只见占位', async () => {
    expect((await runToSettled('H1', '我休息之前在做什么?', { client: 'desktop/1.0' })).status).toBe('done');
    expect(llmPayloads.length, '前提:真走了「调工具 → 看结果 → 收尾」两轮').toBe(2);
    const toolWire = (llmPayloads[1].messages as any[]).filter((m) => m.role === 'tool').map(textOf).join('\n');
    expect(toolWire, '模型本轮拿到的是全文(否则是工具没解析到 / 被门禁挡了,下面的断言就是空真的)').toContain(MARK);
    expect(toolWire).toContain('[computer-history:observed]');

    const sinks: Array<[string, string[]]> = [
      ['chat_messages.tool_results', (await query<any[]>(`SELECT tool_results FROM chat_messages WHERE session_id = 'S' AND tool_results IS NOT NULL`)).map((r) => String(r.tool_results))],
      ['agent_steps.tool_results', (await query<any[]>(`SELECT tool_results FROM agent_steps WHERE run_id = 'H1'`)).map((r) => String(r.tool_results)).filter((x) => x !== 'null')],
      ['agent_run_events(tool_result)', (await query<any[]>(`SELECT payload FROM agent_run_events WHERE run_id = 'H1' AND type = 'tool_result'`)).map((r) => String(r.payload))],
    ];
    for (const [where, rows] of sinks) {
      expect(rows.length, `${where} 有行(否则不含标记是空真的)`).toBeGreaterThan(0);
      expect(rows.join('\n'), where).toContain(COMPUTER_HISTORY_PERSIST_PLACEHOLDER);
      expect(rows.join('\n'), where).not.toContain(MARK);
    }

    // 下一轮:历史回放把 tool 结果从 chat_messages 行重建 → 只见占位,且交错/配对不坏(run 照常 done)
    llmScript = null;
    llmPayloads = [];
    expect((await runToSettled('H2', 'And after that?', { client: 'desktop/1.0' })).status).toBe('done');
    const replay = (llmPayloads[0].messages as any[]);
    const replayedTool = replay.find((m) => m.role === 'tool' && m.tool_call_id === 'ch1');
    expect(replayedTool, '回放里 ch1 的 tool 消息还在(与 assistant 的 tool_calls 配对)').toBeTruthy();
    expect(textOf(replayedTool)).toBe(COMPUTER_HISTORY_PERSIST_PLACEHOLDER);
    expect(wireText(llmPayloads[0])).not.toContain(MARK);
  }, 30_000);
});

describe('read_computer_history 全文不借压缩检查点 / PostToolUse hook 落盘(评审 round2)', () => {
  const MARK = 'CH-COMPACT-MARK';
  const usage = (prompt: number) => ({ prompt_tokens: prompt, completion_tokens: 5 });
  beforeEach(() => {
    chState(true);
    chEvent({ t: Date.now() - 20 * 60_000, kind: 'app', app: { name: 'Code', bundleId: 'com.microsoft.VSCode' }, title: `${MARK}.md` });
  });

  it('run 内自动压缩:摘要输入里 CH 结果是占位,落库的检查点里没有全文', async () => {
    const WINDOW = 40_000; // 触发线 = 40000 − max(2048, 5%) = 37952
    ctxWindow = WINDOW;
    // ① 调 read_computer_history → ② 看到结果后再调一个工具、实测 prompt 顶到线下 500 → ③ 迭代前越线,压缩第 ① 轮 → 收尾
    const script = [
      () => ({ content: '', reasoning: '', toolCalls: [{ id: 'ch1', type: 'function', function: { name: 'read_computer_history', arguments: '{}' } }], usage: usage(100), finishReason: 'tool_calls' }),
      () => ({ content: 'Checking todos.', reasoning: '', toolCalls: [{ id: 't2', type: 'function', function: { name: 'todo_read', arguments: '{}' } }], usage: usage(WINDOW - 500), finishReason: 'tool_calls' }),
      () => ({ content: 'Done.', reasoning: '', toolCalls: [], usage: usage(200), finishReason: 'stop' }),
    ];
    llmScript = () => { const step = script.shift(); if (!step) throw new Error('script exhausted'); return step(); };
    const run = await runToSettled('C1', '我休息之前在做什么?', { client: 'desktop/1.0', agentConfig: { compaction: { reserveTokens: 2_048, keepRecentTokens: 300 } } });
    expect(run.status).toBe('done');
    const toolWire = (llmPayloads[1].messages as any[]).filter((m) => m.role === 'tool').map(textOf).join('\n');
    expect(toolWire, '前提:第 ② 轮模型拿到的是全文(否则下面「不含标记」是空真的)').toContain(MARK);
    expect(summaryPayloads.length, '前提:真的压缩了一次').toBe(1);

    const transcript = textOf(summaryPayloads[0].messages[1]);
    expect(transcript).toContain('[Tool result: read_computer_history]');
    expect(transcript).toContain(COMPUTER_HISTORY_PERSIST_PLACEHOLDER);
    expect(transcript).not.toContain(MARK);
    expect(transcript).not.toContain('[computer-history:observed]');

    const cps = await query<any[]>(`SELECT summary FROM session_summaries WHERE session_id = 'S'`);
    expect(cps.length, '前提:检查点落库了(回显式摘要器 → 转写里有什么这里就有什么)').toBe(1);
    expect(String(cps[0].summary)).toContain('ECHO');
    expect(String(cps[0].summary)).toContain(COMPUTER_HISTORY_PERSIST_PLACEHOLDER);
    expect(String(cps[0].summary)).not.toContain(MARK);
  }, 30_000);

  it('PostToolUse hook 的 tool_response 是占位,不是全文', async () => {
    const out = join(home, 'post-tool-use.json');
    saveHooksConfig(syncUserTrust(normalizeHooksConfig({
      events: { PostToolUse: [{ matcher: 'read_computer_history', hooks: [{ type: 'command', command: `cat > '${out}'` }] }] },
    })));
    llmScript = (payload) => ((payload.messages as any[]).some((m) => m.role === 'tool')
      ? { content: 'You were editing a markdown file.', reasoning: '', toolCalls: [], usage: usage(10), finishReason: 'stop' }
      : { content: '', reasoning: '', toolCalls: [{ id: 'ch1', type: 'function', function: { name: 'read_computer_history', arguments: '{}' } }], usage: usage(10), finishReason: 'tool_calls' });
    // hook 只在 execMode=host 跑;full-auto 免得读工具卡审批
    const run = await runToSettled('K1', '我休息之前在做什么?', { client: 'desktop/1.0', agentConfig: { execMode: 'host', cwd: home, approvalMode: 'full-auto' } });
    expect(run.status).toBe('done');
    const toolWire = (llmPayloads[1].messages as any[]).filter((m) => m.role === 'tool').map(textOf).join('\n');
    expect(toolWire, '前提:模型本轮拿到全文').toContain(MARK);
    expect(existsSync(out), '前提:hook 真的跑了(否则下面是空真的)').toBe(true);
    const got = JSON.parse(readFileSync(out, 'utf8'));
    expect(got.hook_event_name).toBe('PostToolUse');
    expect(got.tool_name).toBe('read_computer_history');
    expect(got.tool_response).toBe(COMPUTER_HISTORY_PERSIST_PLACEHOLDER);
    expect(JSON.stringify(got)).not.toContain(MARK);
  }, 30_000);
});
