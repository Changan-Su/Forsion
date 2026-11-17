/**
 * 被模型的安全审核拦下的回答(借鉴 DeepSeek chat-demo ④,contracts/safetyStop.ts)。
 *   ① refusal:这一发流出的正文换成固定文案(落库的就是这句)、origin 记 refused、done 带 refused,不续写、不带 truncated。
 *   ② 拦下的原文不进 agent_steps,下一轮的上下文里也没有它(只有那句固定文案)。
 *   ③ content_filter 带着工具调用:工具一个不执行、只发一次。
 *   ④ 先说话调过工具、收尾那发被拦:此前的正文留着,后面接固定文案。
 *   ⑤ 文案跟界面语言(ui_settings.locale),没有快照时看用户那句话。
 * 真内存 SQLite + 真 agentLoop + 脚本化 fake llm(套路同 agentLoop.inflightPersist.test.ts)。
 * 负对照:删掉 agentLoop 里 `if (isSafetyStop(res.finishReason))` 那段 → ①–④ 都红。
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
  home = mkdtempSync(join(tmpdir(), 'tangu-safety-'));
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
  const runId = `SS${++runSeq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: '帮我写一段话', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'sandbox', cwd: home }, ...extra },
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

const REFUSED = '这是不该留下的半截正文';
const ZH = '这条回答被模型的安全审核拦下了。';
const EN = "This reply was blocked by the model's safety check.";
const lastCall = (): any => { const c = finalizeSpy.mock.calls; return c[c.length - 1]?.[0]; };
const getDt = { id: 'c1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } };

describe('replies blocked by the model safety check', () => {
  it('replaces the streamed text with the fixed notice, marks refused, never continues', async () => {
    script = [say(REFUSED, 'refusal')];
    const r = await runToEnd();
    expect(r.status).toBe('done');
    expect(streamCalls, '不续写、不重答').toBe(1);
    expect(r.done?.content).toBe(ZH);
    expect(r.done?.refused).toBe(true);
    expect(r.done?.truncated).toBeUndefined();
    expect(r.done?.lengthResumed).toBeUndefined();
    expect(lastCall().content).toBe(ZH);
    expect(lastCall().origin).toBe('refused');
    expect(r.statuses.some((s) => s.phase === 'safety_stop')).toBe(true);
    const steps = await query<any[]>('SELECT llm_response FROM agent_steps WHERE run_id = ?', [r.runId]);
    expect(steps.length).toBeGreaterThan(0);
    expect(JSON.stringify(steps), 'agent_steps 也是回放源,原文不能在里面').not.toContain(REFUSED);

    // 下一轮:上下文里没有原文,只有那句固定文案
    script = [say('好的。', 'stop')];
    const r2 = await runToEnd();
    expect(r2.status).toBe('done');
    const ctx = JSON.stringify(seenMessages[seenMessages.length - 1]);
    expect(ctx).not.toContain(REFUSED);
    expect(ctx).toContain(ZH);
    expect(lastCall().origin, '正常的下一轮不带 refused').toBeUndefined();
    expect(r2.done?.refused).toBeUndefined();
  });

  it('content_filter with tool calls: no tool runs, one request only', async () => {
    script = [async (o: any) => { o.onToken('半截'); return { content: '半截', reasoning: 'r', toolCalls: [getDt], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: 'content_filter' }; }];
    const r = await runToEnd();
    expect(r.status).toBe('done');
    expect(streamCalls).toBe(1);
    expect(lastCall().toolCalls).toEqual([]);
    expect(lastCall().reasoning).toBe('');
    expect(r.done?.content).toBe(ZH);
  });

  it('keeps text from earlier tool rounds and appends the notice', async () => {
    script = [
      async (o: any) => { o.onToken('先查一下时间。'); return { content: '先查一下时间。', reasoning: '', toolCalls: [getDt], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: 'tool_calls' }; },
      say(REFUSED, 'refusal'),
    ];
    const r = await runToEnd();
    expect(r.status).toBe('done');
    expect(streamCalls).toBe(2);
    expect(r.done?.content).toBe(`先查一下时间。\n\n${ZH}`);
    expect(lastCall().content).not.toContain(REFUSED);
    expect(lastCall().toolCalls.length, '此前那轮的工具调用照留').toBe(1);
  });

  it('notice follows the interface language', async () => {
    script = [say(REFUSED, 'refusal')];
    const r = await runToEnd({ uiSettings: { locale: { value: 'en' } } });
    expect(r.done?.content).toBe(EN);
  });
});
