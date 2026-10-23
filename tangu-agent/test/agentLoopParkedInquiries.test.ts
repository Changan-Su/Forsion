/**
 * 挂起询问(10-23 方案「待确认卡片」B,借 Codex):托盘客户端的 run 里,ask_user 不再卡住整个 loop ——
 * 问题照发(inquiry_request),模型先拿到「还没答、别重问、不依赖答案的接着做」的占位结果;用户答了在迭代边界
 * 把答案放回原工具消息,并以 <inquiry_update> user 行交回模型(落库)。没别的可干就收尾,收尾闸门等答案再唤醒。钉四件:
 *   ① 挂起后接着干别的、收尾时等答案;答了 → 答案回到原工具消息 + 回灌一行,续跑收尾;落库的也是答案
 *   ② 模型还在干活时用户就答了 → 下一个迭代边界兑现
 *   ③ 在等答案时停止 → run aborted、询问撤掉(事后再答回 false)
 *   ④ 没握手的 run(TUI / 通道 / 老客户端)照旧阻塞:答之前模型拿不到下一轮
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
import { subscribe } from '../src/services/eventBus.js';
import { resolveInquiry } from '../src/services/inquiries.js';
import { enqueueRun, abortRun, INQUIRY_UPDATE_OPEN } from '../src/services/agentLoop.js';

const USER = 'u1';
let home: string;
let ws: string;
let outside: string;
let payloads: any[];
let script: Array<(o: any) => any>;
let runSeq = 0;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-parked-ask-'));
  process.env.TANGU_HOME = home;
  ws = join(home, 'ws');
  outside = join(home, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  payloads = [];
  script = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      // 只有主循环带 onToken;Historian 起标题等后台调用不吃剧本
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        payloads.push(o.payload);
        const step = script.shift();
        if (!step) throw new Error(`剧本耗尽:第 ${payloads.length} 次 LLM 调用没有出招`);
        return step(o);
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const usage = { prompt_tokens: 10, completion_tokens: 10 };
/** 工作区外写(auto-edit 下必须问)。 */
const _outsideWrite = (id: string, file: string, content = 'approved-write') => () => ({
  content: '', reasoning: '', finishReason: 'stop', usage,
  toolCalls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: join(outside, file), content }) } }],
});
/** 工作区内写(auto-edit 免批):「先干别的」。 */
const sideWrite = (id: string, file: string) => () => ({
  content: '', reasoning: '', finishReason: 'stop', usage,
  toolCalls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: join(ws, file), content: 'side' }) } }],
});
const finalStep = (content: string) => () => ({ content, reasoning: '', toolCalls: [], usage, finishReason: 'stop' });

const toolMsgs = (p: any): string[] => (p.messages as any[]).filter((m) => m.role === 'tool').map((m) => String(m.content));
const userMsgs = (p: any): string[] => (p.messages as any[]).filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

/** 起一个 run,返回收审批请求的句柄与「等终态」。tray=true 即 POST /agent/runs 带 approval_tray 的形状。 */
async function start(tray: boolean): Promise<{ runId: string; asked: any[]; nextInquiry: () => Promise<any>; settled: () => Promise<any> }> {
  const runId = `R${++runSeq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A${runSeq}`,
    input: {
      message: '干活', userMessageId: `U${runSeq}`, attachments: [], origin: 'client', client: 'desktop/2.12.0',
      agentConfig: { execMode: 'host', cwd: ws, approvalMode: 'auto-edit' },
      ...(tray ? { approvalTray: true } : {}),
    },
  });
  const asked: any[] = [];
  const waiters: Array<(p: any) => void> = [];
  const off = subscribe(runId, (ev) => {
    if (ev.type !== 'inquiry_request') return;
    asked.push(ev.payload);
    waiters.shift()?.(ev.payload);
  });
  let seen = 0;
  const nextInquiry = (): Promise<any> => {
    const i = seen++;
    return asked[i] ? Promise.resolve(asked[i]) : new Promise((r) => waiters.push(r));
  };
  enqueueRun('S', runId);
  const settled = async (): Promise<any> => {
    const t0 = Date.now();
    try {
      for (;;) {
        const r = await getRun(runId);
        if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
        if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
        await new Promise((res) => setTimeout(res, 20));
      }
    } finally { off(); }
  };
  return { runId, asked, nextInquiry, settled };
}
/** 某个工具调用在 chat_messages 里落库的结果(重载 / 后续 run 回放读的就是它)。 */
const persistedResult = async (callId: string): Promise<any> => {
  const rows = await query<any[]>(`SELECT tool_results FROM chat_messages WHERE session_id = 'S' AND tool_results IS NOT NULL`);
  for (const row of rows) {
    const list = typeof row.tool_results === 'string' ? JSON.parse(row.tool_results) : row.tool_results;
    const hit = (list || []).find((t: any) => t?.tool_call_id === callId);
    if (hit) return hit;
  }
  return null;
};
const until = async (cond: () => boolean, what: string): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 10_000) throw new Error(`等不到:${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const askUser = (id: string, question: string) => () => ({
  content: '', reasoning: '', finishReason: 'stop', usage,
  toolCalls: [{ id, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question, options: ['.conflicts/', 'next to the file'] }) } }],
});

describe('挂起询问(托盘 run)', () => {
  it('① 挂起后先干别的、收尾时等答案;答了 → 答案回到原工具消息、回灌一行、续跑收尾', async () => {
    script = [
      askUser('c-ask', 'Where should conflict copies go?'),
      sideWrite('c-side', 'side.txt'),
      finalStep('Side work done; waiting for your answer on conflict copies.'),
      finalStep('All done.'),
    ];
    const r = await start(true);
    const req = await r.nextInquiry();
    expect(req.question).toBe('Where should conflict copies go?')
    await until(() => payloads.length >= 3, '第 3 轮 LLM(收尾)');
    expect(toolMsgs(payloads[1]).some((t) => t.includes("Waiting for the user's answer"))).toBe(true);
    expect(existsSync(join(ws, 'side.txt'))).toBe(true);
    await new Promise((res) => setTimeout(res, 150));
    expect(payloads.length, '模型收尾后 run 不该结束,也不该再叫模型').toBe(3);
    expect((await getRun(r.runId))?.status).toBe('running');

    expect(resolveInquiry(req.inquiryId, '.conflicts/', r.runId)).toBe(true);
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(payloads.length).toBe(4);
    const update = userMsgs(payloads[3]).find((t) => t.startsWith(INQUIRY_UPDATE_OPEN));
    expect(update).toContain('[answered] ask_user (call c-ask) — Where should conflict copies go?');
    expect(update).toContain('User answered: .conflicts/');
    const askMsg = (payloads[3].messages as any[]).find((m) => m.role === 'tool' && m.tool_call_id === 'c-ask');
    expect(String(askMsg?.content)).toBe('User answered: .conflicts/');
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'user'`);
    expect(rows.filter((x) => String(x.content).startsWith(INQUIRY_UPDATE_OPEN))).toHaveLength(1);
    const saved = await persistedResult('c-ask');
    expect(saved?.parked).toBeFalsy();
    expect(saved?.content).toBe('User answered: .conflicts/');
  }, 20_000);

  it('② 模型还在干活时就答了 → 下一个迭代边界兑现(不必等到收尾)', async () => {
    let gate!: () => void;
    const held = new Promise<void>((res) => { gate = res; });
    script = [
      askUser('c-ask', 'Pick one?'),
      async () => { await held; return sideWrite('c-side', 'side.txt')(); },
      finalStep('Done with the answer.'),
    ];
    const r = await start(true);
    const req = await r.nextInquiry();
    await until(() => payloads.length >= 2, '第 2 轮 LLM');
    expect(resolveInquiry(req.inquiryId, 'next to the file', r.runId)).toBe(true);
    gate();
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(payloads.length).toBe(3);
    expect(userMsgs(payloads[2]).some((t) => t.startsWith(INQUIRY_UPDATE_OPEN) && t.includes('User answered: next to the file'))).toBe(true);
  }, 20_000);

  it('③ 等答案时停止 → aborted,询问撤掉(事后再答回 false)', async () => {
    script = [askUser('c-ask', 'Q?'), finalStep('Waiting for your answer.')];
    const r = await start(true);
    const req = await r.nextInquiry();
    await until(() => payloads.length >= 2, '第 2 轮 LLM');
    await new Promise((res) => setTimeout(res, 100));
    await abortRun(r.runId);
    const run = await r.settled();
    expect(run.status).toBe('aborted');
    expect(resolveInquiry(req.inquiryId, 'late', r.runId)).toBe(false);
  }, 20_000);

  it('⑤ 答了、还没到迭代边界就被停 → 落库的是答案,不是「还在等」(Codex 10-23 P1)', async () => {
    let gate!: () => void;
    const held = new Promise<void>((res) => { gate = res; });
    script = [
      askUser('c-ask', 'Pick one?'),
      async (o: any) => { await held; if (o.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return finalStep('x')(); },
    ];
    const r = await start(true);
    const req = await r.nextInquiry();
    await until(() => payloads.length >= 2, '第 2 轮 LLM(挂住)');
    expect(resolveInquiry(req.inquiryId, 'beta', r.runId)).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    await abortRun(r.runId);
    gate();
    const run = await r.settled();
    expect(run.status).toBe('aborted');
    expect((await persistedResult('c-ask'))?.content).toBe('User answered: beta');
  }, 20_000);

  it('⑥ 没答就停 → 落库写「没等到回答」,不留「还在等」的占位', async () => {
    script = [askUser('c-ask', 'Q?'), finalStep('Waiting for your answer.')];
    const r = await start(true);
    await r.nextInquiry();
    await until(() => payloads.length >= 2, '第 2 轮 LLM');
    await new Promise((res) => setTimeout(res, 100));
    await abortRun(r.runId);
    await r.settled();
    await new Promise((res) => setTimeout(res, 100));
    const saved = String((await persistedResult('c-ask'))?.content || '');
    expect(saved).toMatch(/^\[No answer\] The run was stopped/);
  }, 20_000);

  it('④ 没握手的 run 照旧阻塞:答之前模型拿不到下一轮', async () => {
    script = [askUser('c-ask', 'Q?'), finalStep('Got it.')];
    const r = await start(false);
    const req = await r.nextInquiry();
    await new Promise((res) => setTimeout(res, 200));
    expect(payloads.length).toBe(1);
    expect(resolveInquiry(req.inquiryId, 'yes', r.runId)).toBe(true);
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(toolMsgs(payloads[1])).toContain('User answered: yes');
    expect(userMsgs(payloads[1]).some((t) => t.startsWith(INQUIRY_UPDATE_OPEN))).toBe(false);
  }, 20_000);
});
