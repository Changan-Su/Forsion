/**
 * 压缩死路(2026-10-26 生产反馈):1M 模型被缺省封顶到 272k,长编码会话越线 → 摘要请求的输出正好写满
 * 6144(DeepSeek V4 思考默认开、推理 token 也算在里面)→ 半截摘要被拒收 → 机械折叠压不动(最近 20 条受保护)→
 * 估算 ≥ 272k → run 以「Context remains over the model input budget after compaction」报废。
 * 台架把封顶缩到 40k(env TANGU_CONTEXT_WINDOW_TOKENS,模块加载时读,故 hoisted)、模型自报 1M,同一条路径按比例复现。
 * 真内存 SQLite + 真 loop(enqueueRun),fake llm:摘要调用按系统提示识别,其余按脚本回应。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => { process.env.TANGU_CONTEXT_WINDOW_TOKENS = '40000'; });

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
import { enqueueRun } from '../src/services/agentLoop.js';
import { estimateMessagesTokens } from '../src/services/contextBudget.js';
import { LlmError } from '../src/core/types.js';

const USER = 'u1';
const REAL_WINDOW = 1_000_000; // 模型自报;run 的预算被封顶到 40k(生产里是 272k)
const SOFT = 40_000;
const COMPACTION = { reserveTokens: 2_048, keepRecentTokens: 300 }; // 触发线 = 40000 − 2048 = 37952
let home: string;
let payloads: any[];
let script: Array<(payload: any) => any>;
/** 摘要调用怎么回:返回 'length' = 半截(撞输出上限),否则给一段正常摘要。入参是这次请求的 maxTokens。 */
let summarize: (maxTokens: number) => 'length' | string;
let summaryMaxTokens: number[];

const isSummaryCall = (p: any): boolean => String(p?.messages?.[0]?.content || '').includes('You are performing a context checkpoint compaction');
const call = (id: string) => ({ id, type: 'function', function: { name: 'todo_read', arguments: '{}' } });
const reply = (content: string, calls: any[] = [], promptTokens = 100) => () => ({
  content, reasoning: '', toolCalls: calls, usage: { prompt_tokens: promptTokens, completion_tokens: 10 }, finishReason: 'stop',
});
const mainCalls = () => payloads.filter((p) => !isSummaryCall(p));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-deadend-'));
  process.env.TANGU_HOME = home;
  payloads = []; script = []; summaryMaxTokens = [];
  summarize = () => 'length';
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', context_window: REAL_WINDOW }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), maxTokens: o.maxTokens }),
    streamProviderCompletion: async (o: any) => {
      payloads.push(o.payload);
      if (isSummaryCall(o.payload)) {
        summaryMaxTokens.push(o.payload.maxTokens);
        const r = summarize(o.payload.maxTokens);
        if (r === 'length') return { content: '## Goal\nhalf a summ', reasoning: '', toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: o.payload.maxTokens }, finishReason: 'length' };
        return { content: r, reasoning: '', toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: 20 }, finishReason: 'stop' };
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

async function settle(runId: string, ms = 15_000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > ms) throw new Error(`run 未在 ${ms}ms 内结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 20));
  }
}
async function launch(runId: string, message: string): Promise<any> {
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${runId}`,
    input: { message, userMessageId: `U-${runId}`, attachments: [], agentConfig: { compaction: COMPACTION } },
  });
  enqueueRun('S', runId);
  return settle(runId);
}
const statusEvents = async (runId: string, pred: (p: any) => boolean) => (await query<any[]>(`SELECT payload FROM agent_run_events WHERE run_id = ? AND type = 'status' ORDER BY seq`, [runId]))
  .map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload)).filter(pred);
/** 24 行长历史,每行 10k 字符(≈2.5k token),合计 ≈60k:全在 hydrate 窗口内,大多落在机械折叠保护的「最近 20 条」里。 */
async function seedLongHistory(chars = 10_000): Promise<void> {
  for (let i = 0; i < 24; i++) {
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, 'S', ?, ?, ?)`,
      [`H${i}`, i % 2 ? 'model' : 'user', `HIST-${i} ` + String.fromCharCode(97 + (i % 26)).repeat(chars), 1000 + i]);
  }
}
const checkpoints = () => query<any[]>(`SELECT through_message_id FROM session_summaries WHERE session_id = 'S'`);

describe('压缩死路:摘要被截断不该让 run 报废', () => {
  it('摘要每次都撞输出上限:不报「Context remains over」,兜底裁掉最旧的历史后跑完;最新的请求原样在', async () => {
    await seedLongHistory();
    script = [reply('FINAL-ANSWER')];
    const run = await launch('R1', 'CURRENT-ASK');
    expect(run.error ?? '').not.toContain('Context remains over');
    expect(run.status).toBe('done');
    const ctx = mainCalls()[0].messages;
    expect(estimateMessagesTokens(ctx)).toBeLessThan(SOFT);
    const text = JSON.stringify(ctx);
    expect(text).toContain('CURRENT-ASK');
    expect(text).not.toContain('HIST-0 '); // 最旧的被裁
    expect(text).toContain('earlier messages were dropped'); // 留了标记,模型知道前面有东西没了
    expect(await statusEvents('R1', (p) => p.phase === 'compacted' && p.trimmed > 0)).toHaveLength(1);
  });

  it('摘要只在 6144 上限内写不完:放宽上限重试一次就成功,走正常摘要而不是兜底裁剪', async () => {
    await seedLongHistory();
    summarize = (max) => (max <= 6_144 ? 'length' : '## Goal\nWIDE-SUMMARY: keep going');
    script = [reply('FINAL-ANSWER')];
    const run = await launch('R1', 'CURRENT-ASK');
    expect(run.status).toBe('done');
    expect(summaryMaxTokens).toHaveLength(2);
    expect(summaryMaxTokens[1]).toBeGreaterThan(summaryMaxTokens[0]);
    const text = JSON.stringify(mainCalls()[0].messages);
    expect(text).toContain('WIDE-SUMMARY');
    expect(text).not.toContain('earlier messages were dropped');
  });

  it('最新内容本身就超过封顶:在模型真实窗口内照常发请求(发警告),不在 Tangu 自己的封顶上报废', async () => {
    // 本 run 的请求 + 第 1 轮(助手长正文 + 工具结果)是裁不掉的最新内容,合计 ≈ 42k > 40k 封顶,远小于 1M。
    script = [reply('TURN1 ' + 'w'.repeat(92_000), [call('t1')], 20_000), reply('FINAL-ANSWER', [], 43_000)];
    const run = await launch('R1', 'BIG-ASK ' + 'q'.repeat(76_000));
    expect(run.error ?? '').not.toContain('Context remains over');
    expect(run.status).toBe('done');
    expect(mainCalls()).toHaveLength(2);
    expect(await statusEvents('R1', (p) => p.warning === 'context_over_budget')).not.toHaveLength(0);
  });

  it('裁剪过的 run 里后来的摘要成功了:不落持久检查点(否则下个 run 永远跳过被裁掉的行)', async () => {
    await seedLongHistory();
    let n = 0;
    summarize = () => (++n <= 2 ? 'length' : '## Goal\nLATER-SUMMARY');
    // 第 1 轮:兜底裁剪后回一大段正文 + 工具调用,实测涨回触发线之上 → 第 2 轮前再压一次,这次摘要成功
    script = [reply('TURN1 ' + 'w'.repeat(60_000), [call('t1')], 39_000), reply('FINAL-ANSWER')];
    const run = await launch('R1', 'CURRENT-ASK');
    expect(run.status).toBe('done');
    expect(n).toBe(3);
    expect(JSON.stringify(mainCalls()[1].messages)).toContain('LATER-SUMMARY');
    expect(await checkpoints()).toEqual([]);
  });

  it('上游拒收超长、估算却还在触发线下:摘要失败 + 折叠不动时照样裁剪,重试本轮成功', async () => {
    await seedLongHistory(5_000); // ≈30k:低于 37952 的触发线;每行 < 8000 字符,机械折叠一条也折不动
    let overflowed = 0;
    script = [() => { overflowed++; throw new LlmError(400, "This model's maximum context length is 32000 tokens. However, your messages resulted in 33000 tokens."); }, reply('RECOVERED')];
    const run = await launch('R1', 'CURRENT-ASK');
    expect(run.error ?? '').not.toContain('maximum context length');
    expect(run.status).toBe('done');
    expect(overflowed).toBe(1);
    const text = JSON.stringify(mainCalls()[1].messages);
    expect(text).toContain('earlier messages were dropped');
    expect(text).toContain('CURRENT-ASK');
  });
});

