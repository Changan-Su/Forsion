/**
 * 主 loop「收尾闸门 + 中流恢复」仪器(harness 工程 2026-07-27 轮):
 *   ① 中流断线恢复:吐过帧后断线不再整 run 报废——段切分落库 + <stream_resume> 续写
 *   ② 完成度审计:收尾时 todo 有未完项 → <completion_audit> 回灌一次,逼继续/明说
 *   ③ 验证回路(/verify):收尾前跑命令,红→<verify_failed> 回灌逼修;两轮仍红→终稿如实标注
 * 公约同时被钉死:三种脚手架消息只进上下文,**绝不落库**。
 * 结构照抄 agentLoopTruncation.test.ts:真内存 SQLite + 真 loop,fake llm 按脚本逐轮出招。
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
import { enqueueRun, abortRun } from '../src/services/agentLoop.js';

const USER = 'u1';
let home: string;
let llmPayloads: any[];
/** 每轮一个出招函数;耗尽即抛(脚本写短了会立刻暴露)。 */
let script: Array<(o: any) => any>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-gates-'));
  process.env.TANGU_HOME = home;
  llmPayloads = [];
  script = [];

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
    streamProviderCompletion: async (o: any) => {
      llmPayloads.push(o.payload);
      const step = script.shift();
      if (!step) throw new Error(`脚本耗尽:第 ${llmPayloads.length} 次 LLM 调用没有出招`);
      return step(o);
    },
  };
  const fakeBrain: any = {
    llm: fakeLlm,
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`,
    [USER],
  );
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const finalStep = (content: string) => () => ({
  content, reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop',
});
const todoWriteStep = (todos: Array<{ content: string; status: string }>) => () => ({
  content: '', reasoning: '',
  toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
});
/** 上下文里的 user 文本全集(断言脚手架是否被喂给模型)。 */
const userTexts = (payload: any): string => (payload.messages as any[])
  .filter((m) => m.role === 'user')
  .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
  .join('\n---\n');

async function runToSettled(agentConfig: Record<string, any> = {}, msg = '干活'): Promise<any> {
  await createRun({
    id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
    input: { message: msg, userMessageId: 'U1', attachments: [], agentConfig },
  });
  enqueueRun('S', 'R1');
  const t0 = Date.now();
  for (;;) {
    const r = await getRun('R1');
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe('中流断线恢复', () => {
  it('吐过帧后断线:段切分落库 + <stream_resume> 续写,run 照常 done;脚手架不落库', async () => {
    script = [
      (o) => { o.onToken?.('前半段,'); throw new TypeError('fetch failed'); }, // 中流断线(可重试类)
      finalStep('后半段收尾。'),
    ];
    const run = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(2);

    // 续写轮的上下文:半截正文以 assistant 轮在场 + <stream_resume> 指令在场
    const msgs2 = llmPayloads[1].messages as any[];
    expect(msgs2.some((m) => m.role === 'assistant' && String(m.content).includes('前半段'))).toBe(true);
    expect(userTexts(llmPayloads[1])).toContain('<stream_resume>');

    // 落库:两段助手消息(半截段 + 续写段),半截内容没丢
    const rows = await query<any[]>(`SELECT role, content FROM chat_messages WHERE session_id = 'S' ORDER BY timestamp ASC`);
    const modelRows = rows.filter((r) => r.role === 'model');
    expect(modelRows.length).toBe(2);
    expect(String(modelRows[0].content)).toContain('前半段');
    expect(String(modelRows[1].content)).toContain('后半段收尾');
    // 公约:脚手架绝不落库
    expect(rows.some((r) => String(r.content).includes('<stream_resume>'))).toBe(false);
  }, 20_000);
});

describe('中流断线恢复 · 边界(Codex 评审 #5)', () => {
  it('maxIterations=1 的末轮断线:续写不消耗迭代额度,同迭代重进,不以半截假 done', async () => {
    script = [
      (o) => { o.onToken?.('半截'); throw new TypeError('fetch failed'); },
      finalStep('完整收尾。'),
    ];
    const run = await runToSettled({ maxIterations: 1 });
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(2); // 修复前:循环耗尽,第二次调用根本不会发生
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'model' ORDER BY timestamp ASC`);
    expect(String(rows.pop()!.content)).toContain('完整收尾');
  }, 20_000);
});

describe('完成度审计', () => {
  it('收尾时 todo 有未完项 → 回灌 <completion_audit>(含清单)续跑;只审一次;不落库', async () => {
    script = [
      todoWriteStep([{ content: '任务A', status: 'completed' }, { content: '任务B', status: 'pending' }]),
      finalStep('先收个尾。'), // 收尾企图:todo 还有任务B → 应被审计拦下
      finalStep('把任务B也处理完了。'), // 第二次收尾:auditNudged 放行(todo 仍未完也不再拦 = 只审一次)
    ];
    const run = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(3);
    const audit = userTexts(llmPayloads[2]);
    expect(audit).toContain('<completion_audit>');
    expect(audit).toContain('任务B'); // 清单全文回灌
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S'`);
    expect(rows.some((r) => String(r.content).includes('<completion_audit>'))).toBe(false);
  }, 20_000);

  it('纯 reasoning 收尾企图被审计拦下续跑:providerItems(replay 态)不丢(Codex 终审 #2)', async () => {
    script = [
      todoWriteStep([{ content: '任务A', status: 'pending' }]),
      // 收尾企图:正文为空、只有 reasoning items(Responses 纯思考轮)→ 审计续跑时必须保住 replay 态
      () => ({
        content: '', reasoning: '', toolCalls: [],
        usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop',
        outputItems: [{ type: 'reasoning', id: 'rs_x', encrypted_content: 'ENC' }],
      }),
      finalStep('处理完了。'),
    ];
    const r = await runToSettled();
    expect(r.status).toBe('done');
    expect(llmPayloads.length).toBe(3);
    expect(userTexts(llmPayloads[2])).toContain('<completion_audit>'); // 确认走的是审计续跑路径
    const replayed = (llmPayloads[2].messages as any[]).find(
      (m) => m.role === 'assistant' && Array.isArray(m.providerItems) && m.providerItems.length,
    );
    expect(replayed, '续跑轮必须带回 reasoning replay 态').toBeTruthy();
    expect(replayed.providerItems[0].encrypted_content).toBe('ENC');
  });

  it('todo 全完成 → 不审计,直接收尾', async () => {
    script = [
      todoWriteStep([{ content: '任务A', status: 'completed' }]),
      finalStep('全部完成。'),
    ];
    const run = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(2);
  }, 20_000);
});

describe('验证回路(/verify)', () => {
  it('验证命令红 → <verify_failed> 带输出尾巴回灌;两轮仍红 → 终稿如实标注;脚手架不落库', async () => {
    script = [
      todoWriteStep([{ content: 'x', status: 'completed' }]), // usedTools=true 且 todo 全完成(隔离审计)
      finalStep('做完了。'), // 收尾企图 1:verify 第 1 轮红 → 回灌逼修
      finalStep('修好了。'), // 收尾企图 2:verify 第 2 轮仍红 → 到顶,如实标注收尾
    ];
    const run = await runToSettled({ execMode: 'host', cwd: home, verifyCommand: 'echo BOOM >&2; exit 3' });
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(3);
    const vf = userTexts(llmPayloads[2]);
    expect(vf).toContain('<verify_failed>');
    expect(vf).toContain('BOOM'); // 输出尾巴回灌
    expect(vf).toContain('exit 3');
    const rows = await query<any[]>(`SELECT role, content FROM chat_messages WHERE session_id = 'S'`);
    const finalRow = rows.filter((r) => r.role === 'model').pop();
    expect(String(finalRow!.content)).toContain('验证命令未通过'); // 最后仍红必须如实告知,不许装绿
    expect(rows.some((r) => String(r.content).includes('<verify_failed>'))).toBe(false);
  }, 20_000);

  it('验证命令执行期间 abort:命令被杀、run 走 aborted 而非带着验证结果假 done(Codex 评审 #6)', async () => {
    script = [
      todoWriteStep([{ content: 'x', status: 'completed' }]),
      finalStep('做完了。'),
    ];
    await createRun({
      id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
      input: { message: '干活', userMessageId: 'U1', attachments: [], agentConfig: { execMode: 'host', cwd: home, verifyCommand: 'sleep 30' } },
    });
    enqueueRun('S', 'R1');
    // 等 loop 走到 verifying(两次 LLM 调用都发生后进入 sleep 30),再打断
    const t0 = Date.now();
    while (llmPayloads.length < 2) {
      if (Date.now() - t0 > 10_000) throw new Error('未进入验证阶段');
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 300)); // 给 spawn 一点起身时间
    abortRun('R1');
    const settled = Date.now();
    for (;;) {
      const r = await getRun('R1');
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) {
        expect(String(r.status)).toBe('aborted');
        expect(Date.now() - settled).toBeLessThan(5_000); // sleep 30 被杀,不是干等 30s
        break;
      }
      if (Date.now() - settled > 8_000) throw new Error('abort 后 run 未及时终结(验证命令没被杀?)');
      await new Promise((r2) => setTimeout(r2, 25));
    }
  }, 25_000);

  it('验证命令绿 → 一次通过,不多跑轮次', async () => {
    script = [
      todoWriteStep([{ content: 'x', status: 'completed' }]),
      finalStep('做完了。'),
    ];
    const run = await runToSettled({ execMode: 'host', cwd: home, verifyCommand: 'true' });
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(2);
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'model'`);
    expect(String(rows.pop()!.content)).not.toContain('验证命令未通过');
  }, 20_000);
});

describe('计划提交兜底(2026-08-18 真机:模型把计划当普通文本回完就收尾)', () => {
  it('planMode 下收尾未调 exit_plan_mode → 回灌 <plan_submit_check> 续跑;只催一次;不落库', async () => {
    script = [
      finalStep('小计划:1. 读 a.txt 2. 追加一行。'), // 纯文本计划 = 用户没有批准入口
      finalStep('那我就不提交了。'), // 第二次收尾:planNudged 已用掉 → 放行(plan 模式也用于问答)
    ];
    const run = await runToSettled({ execMode: 'host', cwd: home, planMode: true });
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(2); // 催了一次(否则只会有 1 次调用)

    expect(userTexts(llmPayloads[1])).toContain('<plan_submit_check>');
    // 上一轮的纯文本计划要以 assistant 轮在场,否则模型看不懂在催什么
    expect((llmPayloads[1].messages as any[]).some((m) => m.role === 'assistant' && String(m.content).includes('小计划'))).toBe(true);

    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S'`);
    expect(rows.some((r) => String(r.content).includes('plan_submit_check'))).toBe(false); // 脚手架不落库
  }, 20_000);

  it('负对照:非 planMode 收尾不催(否则普通会话每轮都被拦)', async () => {
    script = [finalStep('做完了。')];
    const run = await runToSettled({ execMode: 'host', cwd: home });
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(1);
  }, 20_000);
});
