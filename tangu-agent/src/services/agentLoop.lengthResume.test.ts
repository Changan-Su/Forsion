/**
 * 纯文字回答写到输出上限(finishReason='length'、没有工具调用):引擎自动接着写一次(借鉴 DeepSeek chat-demo 方案 ①,B)。
 *   ① 第一发停在半句 → 第二发带着 <length_resume> 接上,终稿是「断处直接相连」的一整段(不插空行),done 带 lengthResumed。
 *   ② 接了一次又撞上限 → 不再接(一共两发),done 带 truncated,界面据此画「继续生成」。
 *   ③ 正常收尾不受影响:一发、done 不带这两个标记。
 *   ④ 断在行尾(「…\n」)时换行原样补回,不粘成「。3.」(11-15 live 复跑抓到)。
 *   ⑤ 续写那一发没写出正文 → 照样 truncated;⑥ 续写那一发转去调(截断的)工具 → 之后的正文另起一段,不粘到断处;
 *   ⑦ 轮数紧(maxIterations 2)不自动接,直接 truncated(⑤–⑦ = Codex 评审 11-15 #2–#4)。
 *   ⑧ 一个字都没写出来就撞上限(推理吃光额度):不接、不标 truncated,照旧走空终稿兜底。
 * 真内存 SQLite + 真 agentLoop + 脚本化 fake llm(套路同 agentLoop.inflightPersist.test.ts)。
 * 负对照:删掉 agentLoop 里 `res.finishReason === 'length' && !res.toolCalls?.length` 那段自动续写 → ① ② 都红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu, deps } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { createRun, getRun } from './runStore.js';
import { subscribe } from './eventBus.js';
import { enqueueRun } from './agentLoop.js';

const USER = 'u1';
let home: string;
let script: Array<(o: any) => Promise<any>>;
let streamCalls: number;
let seenMessages: any[][];
let finalizeSpy: any;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-lenresume-'));
  process.env.TANGU_HOME = home;
  script = [];
  streamCalls = 0;
  seenMessages = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        streamCalls++;
        seenMessages.push((o.payload?.messages || o.messages || []).map((m: any) => ({ role: m.role, content: m.content })));
        const step = script.shift();
        if (!step) throw new Error(`脚本耗尽:第 ${streamCalls} 次流式调用没有出招`);
        return step(o);
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  finalizeSpy = vi.spyOn(deps().state, 'finalizeAssistantMessage');
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 一发流式回答:逐段 onToken,再按给定的 finishReason 收尾。 */
const say = (text: string, finishReason: string) => async (o: any) => {
  for (const piece of text.match(/.{1,6}/gsu) || []) o.onToken(piece);
  return { content: text, reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason };
};

let runSeq = 0;
async function runToEnd(extra: Record<string, unknown> = {}): Promise<{ runId: string; status: string; done: any; statuses: any[] }> {
  const runId = `LR${++runSeq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: '排一个 5 天行程', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'sandbox', cwd: home, ...extra } },
  });
  let done: any = null;
  const statuses: any[] = [];
  const off = subscribe(runId, (ev) => {
    if (ev.type === 'done') done = ev.payload;
    if (ev.type === 'status') statuses.push(ev.payload);
  });
  enqueueRun('S', runId);
  try {
    const t0 = Date.now();
    for (;;) {
      const r = await getRun(runId);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return { runId, status: String(r.status), done, statuses };
      if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 20));
    }
  } finally { off(); }
}

const lastPersisted = (): string => { const c = finalizeSpy.mock.calls; return String(c[c.length - 1]?.[0]?.content ?? ''); };
const lastUserText = (msgs: any[]): string => String([...msgs].reverse().find((m) => m.role === 'user')?.content ?? '');

describe('plain-text answers cut off by the output limit', () => {
  it('continues once automatically and glues the continuation onto the cut', async () => {
    script = [
      say('第 4 天:从二世谷坐巴士到留寿都，中午前到，下午', 'length'),
      say('上第二节课，晚上住留寿都。', 'stop'),
    ];
    const r = await runToEnd();
    expect(r.status).toBe('done');
    expect(streamCalls, '截断后自动接一次').toBe(2);
    expect(lastUserText(seenMessages[1])).toContain('<length_resume>');
    expect(seenMessages[1].some((m) => m.role === 'assistant' && String(m.content).includes('下午')), '断掉的那截要进上下文').toBe(true);
    const content = '第 4 天:从二世谷坐巴士到留寿都，中午前到，下午上第二节课，晚上住留寿都。';
    expect(r.done?.content, '终稿在断处直接相连,不插空行').toBe(content);
    expect(lastPersisted()).toBe(content);
    expect(r.done?.lengthResumed).toBe(true);
    expect(r.done?.truncated).toBeUndefined();
    expect(r.statuses.some((s) => s?.phase === 'length_resume')).toBe(true);
  });

  it('continues only once: a second cut ends the run with truncated', async () => {
    script = [
      say('第一段写到一半', 'length'),
      say('第二段也写到一半', 'length'),
    ];
    const r = await runToEnd();
    expect(r.status).toBe('done');
    expect(streamCalls, '只自动接一次').toBe(2);
    expect(r.done?.content).toBe('第一段写到一半第二段也写到一半');
    expect(r.done?.truncated).toBe(true);
    expect(r.done?.lengthResumed).toBe(true);
  });

  it('keeps the line break at a cut that fell right after a newline', async () => {
    script = [
      say('1. 麻雀:小巧。\n2. 燕子:轻快。\n', 'length'),
      say('3. 喜鹊:黑白相间。', 'stop'),
    ];
    const r = await runToEnd();
    expect(streamCalls).toBe(2);
    expect(r.done?.content).toBe('1. 麻雀:小巧。\n2. 燕子:轻快。\n3. 喜鹊:黑白相间。');
    expect(lastPersisted()).toBe('1. 麻雀:小巧。\n2. 燕子:轻快。\n3. 喜鹊:黑白相间。');
  });

  it('an empty continuation leaves the answer marked truncated', async () => {
    script = [say('首都是伦', 'length'), say('', 'stop')];
    const r = await runToEnd();
    expect(streamCalls).toBe(2);
    expect(r.done?.content).toBe('首都是伦');
    expect(r.done?.truncated, '断处还在半句,界面要给「继续生成」').toBe(true);
    expect(r.done?.lengthResumed).toBe(true);
  });

  it('text after a continuation that turned into a truncated tool call starts its own paragraph', async () => {
    script = [
      say('答案写到一半', 'length'),
      async () => ({ content: '', reasoning: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a' } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'length' }),
      say('新的总结。', 'stop'),
    ];
    const r = await runToEnd();
    expect(streamCalls).toBe(3);
    expect(r.done?.content).toBe('答案写到一半\n\n新的总结。');
  });

  it('does not auto-continue when the next turn would be the last one', async () => {
    script = [say('第一段写到一半', 'length')];
    const r = await runToEnd({ maxIterations: 2 });
    expect(streamCalls, '续写那一发会是收尾轮:不接').toBe(1);
    expect(r.done?.truncated).toBe(true);
    expect(r.done?.lengthResumed).toBeUndefined();
  });

  it('does not continue or flag an answer that hit the limit before writing anything', async () => {
    script = [say('', 'length')];
    const r = await runToEnd();
    expect(streamCalls, '没有半句可接').toBe(1);
    expect(r.done?.truncated).toBeUndefined();
    expect(r.done?.lengthResumed).toBeUndefined();
  });

  it('a normal finish carries neither flag', async () => {
    script = [say('写完了。', 'stop')];
    const r = await runToEnd();
    expect(streamCalls).toBe(1);
    expect(r.done?.content).toBe('写完了。');
    expect(r.done?.truncated).toBeUndefined();
    expect(r.done?.lengthResumed).toBeUndefined();
  });
});
