/**
 * 自动压缩持久化 + 溢出重试 + 窗口外老行惰性检查点(09-15 对标 pi / Codex;Codex 评审后补齐边角):
 * 真内存 SQLite + 真 runStore/eventBus + 真 loop(enqueueRun),fake llm 按脚本回应;
 * 压缩摘要调用按系统提示识别(可卡住 / 可失败一次)。窗口取自 fake 模型对象(context_window),旋钮走 agentConfig.compaction。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { enqueueRun, enqueueSteer, abortRun, TURN_INTERRUPTED_MARKER } from '../src/services/agentLoop.js';
import { LlmError } from '../src/core/types.js';

const USER = 'u1';
const WINDOW = 40_000; // 触发线 = 40000 − max(2048, 5%) = 37952
const COMPACTION = { reserveTokens: 2_048, keepRecentTokens: 300 };
let home: string;
let payloads: any[]; // 主循环 + 摘要调用的 payload(按顺序)
let script: Array<(payload: any) => any>; // 主循环调用的脚本(摘要调用不消耗)
let summaries: string[];
let resolveCalls: string[];
let summaryGate: Promise<void> | null; // 摘要调用卡在这里(惰性检查点竞态用)
let summaryFailOnce: boolean; // 下一次摘要调用抛错(兜底路径用)

const isSummaryCall = (p: any): boolean => String(p?.messages?.[0]?.content || '').includes('You are performing a context checkpoint compaction');
const call = (id: string) => ({ id, type: 'function', function: { name: 'todo_read', arguments: '{}' } });
const reply = (content: string, calls: any[] = [], promptTokens = 100) => () => ({
  content, reasoning: '', toolCalls: calls, usage: { prompt_tokens: promptTokens, completion_tokens: 10 }, finishReason: 'stop',
});
const overflow = (msg = "This model's maximum context length is 40000 tokens. However, your messages resulted in 41000 tokens.") => () => { throw new LlmError(400, msg); };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-compact-'));
  process.env.TANGU_HOME = home;
  payloads = []; script = []; summaries = []; resolveCalls = []; summaryGate = null; summaryFailOnce = false;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async (id: string) => {
      resolveCalls.push(id);
      return { model: { provider: 'test', name: 'test', context_window: WINDOW }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' };
    },
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), maxTokens: o.maxTokens }),
    streamProviderCompletion: async (o: any) => {
      payloads.push(o.payload);
      if (isSummaryCall(o.payload)) {
        if (summaryFailOnce) { summaryFailOnce = false; throw new LlmError(502, 'summarizer down'); }
        if (summaryGate) await summaryGate;
        const text = `## Goal\nSUMMARY-${summaries.length + 1}: keep going`;
        summaries.push(text);
        return { content: text, reasoning: '', toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: 20 }, finishReason: 'stop' };
      }
      const step = script.shift();
      if (!step) throw new Error('fake llm: script exhausted');
      return step(o.payload);
    },
  };
  configureTangu({
    host,
    brain: { llm: fakeLlm, users: { getUserById: async () => ({ id: USER, username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false } } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function settle(runId: string, ms = 10_000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > ms) throw new Error(`run 未在 ${ms}ms 内结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 20));
  }
}
async function start(runId: string, assistantId: string, userMessageId: string, message: string, compaction: any = COMPACTION): Promise<void> {
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: assistantId,
    input: { message, userMessageId, attachments: [], agentConfig: { compaction } },
  });
  enqueueRun('S', runId);
}
async function launch(runId: string, assistantId: string, userMessageId: string, message: string, compaction: any = COMPACTION): Promise<any> {
  await start(runId, assistantId, userMessageId, message, compaction);
  return settle(runId);
}
const checkpoints = () => query<any[]>(`SELECT summary, through_timestamp, through_message_id, through_tool_call_id FROM session_summaries WHERE session_id = 'S' ORDER BY through_timestamp ASC`);
const statusEvents = async (runId: string, phase: string) => (await query<any[]>(`SELECT payload FROM agent_run_events WHERE run_id = ? AND type = 'status' ORDER BY seq`, [runId]))
  .map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload)).filter((p) => p.phase === phase);
const lastCtx = (): any[] => payloads[payloads.length - 1].messages;
const tick = () => new Promise((r) => setTimeout(r, 5)); // 行时间戳按 ms:两个 run 之间留一拍,别撞同一毫秒
/** count 行历史(user/model 交替);第 bigToolAt 行(model)带一轮工具与 2000 字符结果 —— compactContext 的机械折叠
 *  只折「system 后前 3 条、最近 20 条」之外的中段,所以要放在窗口内靠前的位置。 */
async function seedHistory(count = 60, bigToolAt = -1): Promise<void> {
  for (let i = 0; i < count; i++) {
    const role = i % 2 ? 'model' : 'user';
    if (i === bigToolAt) {
      await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, tool_calls, tool_results) VALUES (?, 'S', 'model', ?, ?, ?, ?)`,
        [`H${i}`, `HIST-${i} row`, 1000 + i, JSON.stringify([call(`ht${i}`)]), JSON.stringify([{ tool_call_id: `ht${i}`, content: 'BIG-TOOL-RESULT ' + 'z'.repeat(2_000) }])]);
    } else {
      await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, 'S', ?, ?, ?)`, [`H${i}`, role, `HIST-${i} row`, 1000 + i]);
    }
  }
}

describe('run 内自动压缩 → 持久检查点(行内切点)→ 下个 run 从摘要接着跑', () => {
  it('第 2 轮满载:U1 + 第 1 轮被总结,第 2 轮原样保留;检查点等助手行落库后带 tool_call 切点落库;摘要消息跨 run 逐字相同', async () => {
    const TURN1 = 'TURN1-MARKER ' + 'a'.repeat(200);
    const TURN2 = 'TURN2-MARKER ' + 'b'.repeat(3_000);
    script = [reply(TURN1, [call('t1')], 100), reply(TURN2, [call('t2')], WINDOW - 500), reply('FINAL-ANSWER')];
    const run = await launch('R1', 'A1', 'U1', 'please do the long thing');
    expect(run.status).toBe('done');
    expect(summaries).toHaveLength(1);
    // 第 3 轮(收尾)的上下文 = [system, 摘要, 第 2 轮(assistant+tool)]:第 1 轮与 U1 已进摘要
    const finalCtx = lastCtx();
    expect(finalCtx[1].role).toBe('system');
    expect(String(finalCtx[1].content)).toContain('SUMMARY-1');
    expect(JSON.stringify(finalCtx)).not.toContain('TURN1-MARKER');
    expect(JSON.stringify(finalCtx)).toContain('TURN2-MARKER');
    expect(finalCtx.some((m) => m.role === 'user' && String(m.content).includes('please do the long thing'))).toBe(false);
    // 事件形状:compacting/compacted 带 reason;覆盖到尚未落库的段 → persisted:false(finalize 后才落)
    expect(await statusEvents('R1', 'compacting')).toMatchObject([{ forced: true, reason: 'threshold' }]);
    expect(await statusEvents('R1', 'compacted')).toMatchObject([{ forced: true, reason: 'threshold', persisted: false }]);
    // 检查点:through = A1 落库时间戳,行内切点 = t1(第 1 轮),不是 t2
    const rows = await checkpoints();
    expect(rows).toHaveLength(1);
    expect(rows[0].through_message_id).toBe('A1');
    expect(rows[0].through_tool_call_id).toBe('t1');
    const a1 = await query<any[]>(`SELECT timestamp FROM chat_messages WHERE id = 'A1'`);
    expect(Number(rows[0].through_timestamp)).toBe(Number(a1[0].timestamp));
    expect(String(rows[0].summary)).toContain('SUMMARY-1');

    // 下个 run:hydrate = [摘要, A1 行只回放 t1 之后的轮次, U2];U1 与第 1 轮不再原样回放;摘要消息字节与 run 内那条相同(前缀缓存)
    await tick();
    script = [reply('second run answer')];
    const run2 = await launch('R2', 'A2', 'U2', 'and now?');
    expect(run2.status).toBe('done');
    expect(summaries).toHaveLength(1); // 没有再总结一遍
    const ctx2 = lastCtx();
    expect(ctx2[1].role).toBe('system');
    expect(ctx2[1].content).toBe(finalCtx[1].content);
    expect(ctx2[0].content).toBe(finalCtx[0].content); // 系统前缀也逐字相同
    const text2 = JSON.stringify(ctx2);
    expect(text2).not.toContain('TURN1-MARKER');
    expect(text2).not.toContain('please do the long thing');
    expect(text2).toContain('TURN2-MARKER');
    expect(text2).toContain('FINAL-ANSWER');
    expect(text2).toContain('and now?');
    expect(ctx2.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['t2']);
    expect(ctx2[ctx2.length - 1]).toMatchObject({ role: 'user' });
  });

  it('安全兜底:切点 id 在行里对不上 → 该行整体原样回放(重复而非丢失)', async () => {
    script = [reply('TURN1-MARKER', [call('t1')]), reply('TURN2-MARKER ' + 'b'.repeat(3_000), [call('t2')], WINDOW - 500), reply('FINAL')];
    expect((await launch('R1', 'A1', 'U1', 'go')).status).toBe('done');
    await query(`UPDATE session_summaries SET through_tool_call_id = 'nonexistent' WHERE session_id = 'S'`);
    await tick();
    script = [reply('ok')];
    expect((await launch('R2', 'A2', 'U2', 'next')).status).toBe('done');
    const text = JSON.stringify(lastCtx());
    expect(text).toContain('SUMMARY-1');
    expect(text).toContain('TURN1-MARKER'); // 整行回放
    expect(text).toContain('TURN2-MARKER');
    expect(text).not.toContain('"content":"go"'); // U1 严格早于边界行,仍覆盖
  });

  it('同一毫秒的邻行:边界行按 id 认,时间戳相同但不是边界行的消息原样回放', async () => {
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('U0', 'S', 'user', 'EARLIER-ASK', 1000)`);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, tool_calls, tool_results) VALUES ('A0', 'S', 'model', 'EARLIER-ANSWER', 2000, ?, ?)`,
      [JSON.stringify([call('t0')]), JSON.stringify([{ tool_call_id: 't0', content: 'earlier todo' }])]);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('X', 'S', 'user', 'TIE-AFTER', 2000)`); // 与 A0 同一毫秒
    await query(`INSERT INTO session_summaries (id, session_id, summary, through_timestamp, through_message_id) VALUES ('cp', 'S', 'MANUAL-SUM', 2000, 'A0')`);
    script = [reply('ok')];
    expect((await launch('R1', 'A1', 'U1', 'now')).status).toBe('done');
    const text = JSON.stringify(lastCtx());
    expect(text).toContain('MANUAL-SUM');
    expect(text).not.toContain('EARLIER-ASK');
    expect(text).not.toContain('EARLIER-ANSWER');
    expect(text).toContain('TIE-AFTER');
  });

  it('压缩覆盖到未落库的第 1 轮后被 steer 拆段:检查点落在段 A(t1),steer 消息与段 B 原样回放', async () => {
    const TURN2 = 'TURN2-MARKER ' + 'b'.repeat(3_000);
    script = [
      reply('TURN1-MARKER', [call('t1')], 100),
      reply(TURN2, [call('t2')], WINDOW - 500), // 第 2 轮后满载 → 压缩(pending t1)
      () => { enqueueSteer('R1', { id: 'S1', content: 'STEER-MSG' }); return reply('SEG-A-END', [call('t3')])(); }, // 下一迭代顶注入 → 段 A finalize
      reply('SEG-B-END'),
    ];
    expect((await launch('R1', 'A1', 'U1', 'go')).status).toBe('done');
    const rows = await checkpoints();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ through_message_id: 'A1', through_tool_call_id: 't1' });
    const a1 = await query<any[]>(`SELECT timestamp, content FROM chat_messages WHERE id = 'A1'`);
    expect(Number(rows[0].through_timestamp)).toBe(Number(a1[0].timestamp));
    expect(String(a1[0].content)).toContain('SEG-A-END');
    await tick();
    script = [reply('ok')];
    expect((await launch('R2', 'A2', 'U2', 'next')).status).toBe('done');
    const ctx = lastCtx();
    const text = JSON.stringify(ctx);
    expect(text).not.toContain('TURN1-MARKER');
    expect(text).toContain('TURN2-MARKER');
    expect(text).toContain('SEG-A-END');
    expect(text).toContain('STEER-MSG');
    expect(text).toContain('SEG-B-END');
    expect(ctx.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['t2', 't3']);
  });

  it('压缩成功后 run 被中止:半截助手行落库时检查点一并补落,下个 run 回放未覆盖的轮次 + 打断标记', async () => {
    script = [
      reply('TURN1-MARKER', [call('t1')], 100),
      reply('TURN2-MARKER ' + 'b'.repeat(3_000), [call('t2')], WINDOW - 500),
      () => { abortRun('R1'); return new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 20)); },
    ];
    expect((await launch('R1', 'A1', 'U1', 'go')).status).toBe('aborted');
    const rows = await checkpoints();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ through_message_id: 'A1', through_tool_call_id: 't1' });
    await tick();
    script = [reply('ok')];
    expect((await launch('R2', 'A2', 'U2', 'resume')).status).toBe('done');
    const ctx = lastCtx();
    const text = JSON.stringify(ctx);
    expect(text).toContain('SUMMARY-1');
    expect(text).not.toContain('TURN1-MARKER');
    expect(text).toContain('TURN2-MARKER');
    expect(ctx.some((m) => m.role === 'user' && String(m.content) === TURN_INTERRUPTED_MARKER)).toBe(true);
  });

  it('run 级 compaction.model:摘要改用指定模型', async () => {
    script = [reply('TURN1', [call('t1')], 100), reply('TURN2 ' + 'b'.repeat(3_000), [call('t2')], WINDOW - 500), reply('FINAL')];
    expect((await launch('R1', 'A1', 'U1', 'go', { ...COMPACTION, model: 'cheap-summary' })).status).toBe('done');
    expect(summaries).toHaveLength(1);
    expect(resolveCalls).toContain('cheap-summary');
    expect(resolveCalls.filter((m) => m === 'cheap-summary')).toHaveLength(1);
  });
});

describe('触发线与兜底', () => {
  it('负对照:24k / 40k(越过旧的 50% 档、未到触发线)→ 不压缩、不折叠,历史原样', async () => {
    await seedHistory(30, 7); // < 50 行:不会触发收尾后的惰性检查点,摘要数才是干净的负对照
    script = [reply('TURN1', [call('t1')], 24_000), reply('FINAL')];
    expect((await launch('R1', 'A1', 'U1', 'go')).status).toBe('done');
    expect(summaries).toHaveLength(0);
    expect(await statusEvents('R1', 'compacting')).toEqual([]);
    expect(await statusEvents('R1', 'compacted')).toEqual([]);
    expect(JSON.stringify(lastCtx())).toContain('BIG-TOOL-RESULT ' + 'z'.repeat(2_000)); // 没被机械折叠
    expect(await checkpoints()).toEqual([]);
  });

  it('摘要调用失败 → 只机械折叠一次(如实标 fallback),不落检查点,不重复尝试', async () => {
    await seedHistory(30, 7);
    summaryFailOnce = true;
    script = [reply('TURN1', [call('t1')], WINDOW - 500), reply('FINAL')];
    expect((await launch('R1', 'A1', 'U1', 'go')).status).toBe('done');
    expect(summaries).toHaveLength(0);
    expect(await statusEvents('R1', 'compacting')).toHaveLength(1);
    expect(await statusEvents('R1', 'compacted')).toMatchObject([{ forced: true, fallback: true, reason: 'threshold' }]);
    expect(await checkpoints()).toEqual([]);
    const text = JSON.stringify(lastCtx());
    expect(text).toContain('tool output folded');
    expect(text).not.toContain('z'.repeat(2_000));
  });

  it('enabled:false:越线只走机械兜底、不发摘要;上游溢出也只折叠后重试', async () => {
    await seedHistory(30, 7);
    script = [reply('TURN1', [call('t1')], WINDOW - 500), reply('FINAL')];
    expect((await launch('R1', 'A1', 'U1', 'go', { ...COMPACTION, enabled: false })).status).toBe('done');
    expect(summaries).toHaveLength(0);
    expect(await statusEvents('R1', 'compacted')).toMatchObject([{ fallback: true }]);
    expect(await checkpoints()).toEqual([]);
    await tick();
    // 机械折叠只改 run 内存,DB 行原样:R2 重新 hydrate 出完整的大结果,溢出时又有得折
    script = [overflow(), reply('RECOVERED')];
    const r2 = await launch('R2', 'A2', 'U2', 'again', { ...COMPACTION, enabled: false });
    expect(r2.status).toBe('done');
    expect(summaries).toHaveLength(0);
    expect(await statusEvents('R2', 'compacted')).toMatchObject([{ fallback: true, reason: 'overflow' }]);
  });
});

describe('上游拒收超长输入 → 强制压缩一次后重进本轮', () => {
  it('400 context_length_exceeded:压缩(已落库行立刻落检查点,带行 id)→ 重试同一轮 → done;每 run 恰好一次重试', async () => {
    // 已有历史:U0 / A0(带一轮工具)→ 本 run U1
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('U0', 'S', 'user', 'EARLIER-ASK', 1000)`);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, tool_calls, tool_results) VALUES ('A0', 'S', 'model', 'EARLIER-ANSWER', 2000, ?, ?)`,
      [JSON.stringify([call('t0')]), JSON.stringify([{ tool_call_id: 't0', content: 'earlier todo' }])]);
    let overflowed = 0;
    script = [() => { overflowed++; return overflow()(); }, reply('RECOVERED')];
    const run = await launch('R1', 'A1', 'U1', 'CURRENT-ASK');
    expect(run.status).toBe('done');
    expect(overflowed).toBe(1);
    expect(summaries).toHaveLength(1);
    const ctx = lastCtx();
    expect(String(ctx[1].content)).toContain('SUMMARY-1');
    expect(JSON.stringify(ctx)).not.toContain('EARLIER-ANSWER');
    expect(JSON.stringify(ctx)).toContain('CURRENT-ASK');
    expect(await statusEvents('R1', 'compacted')).toMatchObject([{ forced: true, reason: 'overflow', persisted: true }]);
    // 已落库行(U0/A0)被覆盖 → 检查点立刻落库,through = A0 的时间戳 + 行 id,无切点
    const rows = await checkpoints();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].through_timestamp)).toBe(2000);
    expect(rows[0].through_message_id).toBe('A0');
    expect(rows[0].through_tool_call_id).toBeNull();
    const msgs = await query<any[]>(`SELECT content FROM chat_messages WHERE id = 'A1'`);
    expect(String(msgs[0].content)).toContain('RECOVERED');

    // 连续溢出:R2 仍允许一次「压缩 + 重试」,第二次溢出后不再重试,按第二次的错误失败
    await tick();
    const mainCallsBefore = payloads.filter((p) => !isSummaryCall(p)).length;
    const summariesBefore = summaries.length;
    script = [overflow('FIRST-OVERFLOW: context_length_exceeded'), overflow('SECOND-OVERFLOW: context_length_exceeded')];
    const run2 = await launch('R2', 'A2', 'U2', 'again ' + 'q'.repeat(400));
    expect(run2.status).toBe('failed');
    expect(String(run2.error)).toContain('SECOND-OVERFLOW');
    expect(summaries.length - summariesBefore).toBe(1);
    expect(payloads.filter((p) => !isSummaryCall(p)).length - mainCallsBefore).toBe(2);
  });
});

describe('run 收尾后:hydrate 窗口外的老行做持久检查点(惰性,不占本 run;下个 run 等它落库)', () => {
  it('62 行会话:收尾后窗口(块对齐)之外的前 20 行被总结成检查点(带边界行 id),下个 run 只回放窗口内的行 + 摘要', async () => {
    await seedHistory();
    script = [reply('answer 61')];
    expect((await launch('R1', 'A1', 'U1', 'question 61')).status).toBe('done');
    // fire-and-forget:轮询等检查点落库
    let rows: any[] = [];
    for (let i = 0; i < 200 && !rows.length; i++) { await new Promise((r) => setTimeout(r, 20)); rows = await checkpoints(); }
    expect(rows).toHaveLength(1);
    // 62 行 + 下个 run 的 user = 63 → 起点 ceil((63-50)/10)*10 = 20 → 覆盖 H0..H19(与 hydrate 的块对齐口径一致)
    expect(Number(rows[0].through_timestamp)).toBe(1000 + 19);
    expect(rows[0].through_message_id).toBe('H19');
    expect(rows[0].through_tool_call_id).toBeNull();
    expect(summaries).toHaveLength(1);
    const summaryInput = payloads.find(isSummaryCall)!.messages[1].content as string;
    expect(summaryInput).toContain('HIST-0 row');
    expect(summaryInput).toContain('HIST-19 row');
    expect(summaryInput).not.toContain('HIST-20 row');

    await tick();
    script = [reply('answer 62')];
    expect((await launch('R2', 'A2', 'U2', 'question 62')).status).toBe('done');
    const ctx = lastCtx();
    expect(String(ctx[1].content)).toContain('SUMMARY-1');
    const text = JSON.stringify(ctx);
    expect(text).not.toContain('HIST-19 row');
    expect(text).toContain('HIST-20 row');
    expect(text).toContain('question 61');
    expect(text).toContain('question 62');
  });

  it('检查点没覆盖到窗口起点(惰性摘要失败 / 没跑到):hydrate 窗口往前扩到覆盖处,老行原样回放而不是静默丢', async () => {
    await seedHistory(62);
    await query(`INSERT INTO session_summaries (id, session_id, summary, through_timestamp, through_message_id) VALUES ('cp', 'S', 'OLD-SUM', 1005, 'H5')`);
    script = [reply('ok')];
    expect((await launch('R1', 'A1', 'U1', 'go')).status).toBe('done');
    // 63 行 → 块对齐起点 20;H19 未被覆盖 → 扩到 10 → H9 未覆盖 → 扩到 0;H0..H5 按检查点丢,H6 起全部回放
    // (run 收尾后惰性检查点会再发一次摘要请求,所以只看主循环那条 payload)
    const text = JSON.stringify(payloads.filter((p) => !isSummaryCall(p)).at(-1).messages);
    expect(text).toContain('OLD-SUM');
    expect(text).not.toContain('HIST-5 row');
    expect(text).not.toContain('HIST-0 row');
    expect(text).toContain('HIST-6 row');
    expect(text).toContain('HIST-19 row');
    expect(text).toContain('HIST-61 row');
  });

  it('竞态:摘要还在跑时 run 已 done;紧接着的下个 run 等它落库后再 hydrate,老行不会既没摘要也没回放', async () => {
    await seedHistory();
    let release!: () => void;
    summaryGate = new Promise<void>((r) => { release = r; });
    script = [reply('answer 61')];
    expect((await launch('R1', 'A1', 'U1', 'question 61')).status).toBe('done'); // 摘要被卡住,run 照样先 done
    expect(await checkpoints()).toEqual([]);
    await tick();
    script = [reply('answer 62')];
    await start('R2', 'A2', 'U2', 'question 62');
    await new Promise((r) => setTimeout(r, 150)); // R2 此刻应在等在飞的检查点,还没发主请求
    expect(payloads.filter((p) => !isSummaryCall(p)).length).toBe(1);
    release();
    expect((await settle('R2')).status).toBe('done');
    expect(await checkpoints()).toHaveLength(1);
    const text = JSON.stringify(lastCtx());
    expect(text).toContain('SUMMARY-1');
    expect(text).not.toContain('HIST-19 row');
    expect(text).toContain('HIST-20 row');
  });
});
