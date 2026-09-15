/**
 * 主 loop 的三个「实验载体」仪器(L3 round-1 补写):三处都曾经装好了消费端却没人生产,
 * 静默退化成改造前行为 —— 单测钉的正是「有没有被真的传下去」,不是它们生效后的效果。
 *   ① B4①:buildProviderPayload 收到 runId(Responses 客户端据此按 run 存 Codex 粘性路由态)
 *   ② B4②:buildProviderPayload 收到 agentId(= activeAgentSlug,与 cache_probe 的 head hash
 *      map 同一身份;TANGU_CACHE_KEY_SCOPE='agent' 时 resolveCacheKey 据此换桶)
 *   ③ D1:续跑轮的 assistant 消息挂 reasoning_content(上 wire 与否由各客户端门控)
 * 结构照抄 agentLoopFinishGates.test.ts:真内存 SQLite + 真 loop,fake llm 按脚本逐轮出招。
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
import { enqueueRun } from '../src/services/agentLoop.js';
import { DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';

const USER = 'u1';
let home: string;
let buildOpts: any[];
let llmPayloads: any[];
let script: Array<(o: any) => any>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-carriers-'));
  process.env.TANGU_HOME = home;
  buildOpts = [];
  llmPayloads = [];
  script = [];

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => {
      buildOpts.push(o);
      return { messages: o.messages.map((m: any) => ({ ...m })) };
    },
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

async function runToSettled(msg = '干活', extraInput: Record<string, unknown> = {}, id = 'R1'): Promise<any> {
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

const finalStep = (content: string) => () =>
  ({ content, reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' });
const systemOf = (payload: any): string =>
  String((payload.messages as any[]).find((m) => m.role === 'system')?.content || '');
const toolNamesOf = (opts: any): string[] => (opts.tools || []).map((t: any) => t.function.name);

describe('主 loop 的实验载体', () => {
  it('每轮 buildProviderPayload 都带上 agentId(=活跃 agent slug)与 runId', async () => {
    script = [
      () => ({
        content: '', reasoning: '',
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '一件事', status: 'completed' }] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
      }),
      () => ({ content: '干完了。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' }),
    ];
    const run = await runToSettled();
    expect(run.status).toBe('done');
    expect(buildOpts.length).toBe(2);
    for (const o of buildOpts) {
      expect(o.agentId).toBe(DEFAULT_AGENT_SLUG);
      expect(o.runId).toBe('R1');
      // cacheKey 仍是会话键:换桶只在 TANGU_CACHE_KEY_SCOPE='agent' 时由直连面做,loop 不预先换。
      expect(o.cacheKey).toBe('S');
    }
  }, 20_000);

  it('续跑轮的 assistant 消息挂 reasoning_content;模型没吐思考就不挂', async () => {
    script = [
      () => ({
        content: '先看看待办。', reasoning: 'COT-第一轮',
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '一件事', status: 'completed' }] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
      }),
      () => ({ content: '干完了。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' }),
    ];
    const run = await runToSettled();
    expect(run.status).toBe('done');
    const assistants = (llmPayloads[1].messages as any[]).filter((m) => m.role === 'assistant');
    expect(assistants.length).toBe(1);
    expect(assistants[0].reasoning_content).toBe('COT-第一轮');
    // 第一轮的上下文里没有本 run 的 assistant 轮,自然也没有回灌字段。
    expect((llmPayloads[0].messages as any[]).some((m) => m.reasoning_content)).toBe(false);
    // 只进上下文,绝不落库。
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S'`);
    expect(rows.some((r) => String(r.content).includes('COT-第一轮'))).toBe(false);
  }, 20_000);
});

/**
 * 延迟工具目录必须与真实工具面用**同一套门禁字段**装配(Codex 评审三轮·tools #1)。
 * 此前 listDeferredTools 的调用点没传 client/uiCommands,而 set_ui_setting 的门禁正是这两个 ——
 * 真实 GUI run 的「Additional Tools」里根本没有它,它的完整定义又因 deferred 被藏起来,
 * 用户开口要求换主题时模型无从解锁。既有单测用的是人工补齐字段的 guiCtx,盖不到真实装配路径。
 */
describe('首轮 system 目录 × 真实工具面', () => {
  it('GUI run(client + uiCommands):set_ui_setting 在目录里、不在常驻 defs 里', async () => {
    script = [finalStep('好的。')];
    const run = await runToSettled('把界面换成深色', { client: 'desktop/1.0.0', uiCommands: [] });
    expect(run.status).toBe('done');
    const sys = systemOf(llmPayloads[0]);
    expect(sys).toContain('## Additional Tools (load on demand)');
    expect(sys).toContain('- set_ui_setting:');
    const names = toolNamesOf(buildOpts[0]);
    expect(names).not.toContain('set_ui_setting'); // deferred → 不进常驻面
    expect(names).toContain('list_ui_commands'); // 界面面确实开着(不是整族被门禁关掉)
  }, 20_000);

  it('负对照:同一个 run 不带 client/uiCommands → 界面工具整族不在场,目录里也没有', async () => {
    script = [finalStep('好的。')];
    const run = await runToSettled('把界面换成深色');
    expect(run.status).toBe('done');
    const sys = systemOf(llmPayloads[0]);
    expect(sys).not.toContain('- set_ui_setting:');
    expect(toolNamesOf(buildOpts[0])).not.toContain('list_ui_commands');
  }, 20_000);
});

/**
 * 尾部 user 通道的落点(Codex 评审三轮 #9):只认「本轮那条 user 消息且它就在对话末尾」。
 * 倒扫「历史里最后一条 user」会在空消息 run(Muse/自动化/续跑,历史以 assistant 收尾)
 * 把 ephemeralHint 插到后面那些消息**之前** —— 既改写了历史,又不再是「尾部」。
 */
describe('尾部 user 通道的落点', () => {
  it('空消息 run(历史以 assistant 收尾):hint 另起一条尾部 user 消息,历史里的旧 user 一字不动', async () => {
    script = [finalStep('答一。')];
    expect((await runToSettled('第一问')).status).toBe('done');

    buildOpts = [];
    llmPayloads = [];
    script = [finalStep('答二。')];
    const run2 = await runToSettled('', { ephemeralHint: 'EPHEMERAL-MARK' }, 'R2');
    expect(run2.status).toBe('done');

    const msgs = (llmPayloads[0].messages as any[]);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('EPHEMERAL-MARK');
    // 历史里那条旧 user 没被改写(此前它才是 hint 的落点)。
    const oldUser = msgs.find((m) => m.role === 'user' && String(m.content).includes('第一问'));
    expect(oldUser).toBeTruthy();
    expect(String(oldUser.content)).toBe('第一问');
    // 上一轮的 assistant 回复仍排在新尾部 user 之前 —— 注入没有插进历史中间。
    const lastAssistant = msgs.map((m) => m.role).lastIndexOf('assistant');
    expect(lastAssistant).toBeGreaterThan(-1);
    expect(lastAssistant).toBeLessThan(msgs.length - 1);
  }, 30_000);

  it('正常 run:hint 仍拼进本轮那条 user 消息,不新起一条(前缀字节不多一条消息)', async () => {
    script = [finalStep('好。')];
    const run = await runToSettled('今天怎么样', { ephemeralHint: 'EPHEMERAL-MARK' });
    expect(run.status).toBe('done');
    const msgs = (llmPayloads[0].messages as any[]);
    const users = msgs.filter((m) => m.role === 'user');
    expect(users.length).toBe(1);
    expect(String(users[0].content)).toContain('今天怎么样');
    expect(String(users[0].content)).toContain('EPHEMERAL-MARK');
  }, 20_000);

  it('边界:历史以一条非本轮 user 收尾(上一 run 在 assistant 落库前中断)+ 空消息 run —— 就地追加,不造出两条连续 user', async () => {
    script = [finalStep('答一。')];
    expect((await runToSettled('第一问')).status).toBe('done');
    // 上一个 run 在 assistant 落库前被中断 → 历史以一条 user 收尾(它不是本轮那条)。
    // 时间戳显式加大:ORDER BY timestamp ASC 对同毫秒的并列不保证次序。
    await query(
      `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id) VALUES ('U-ORPHAN', 'S', 'user', '半路中断的一问', ?, 'm1')`,
      [Date.now() + 10_000],
    );

    buildOpts = [];
    llmPayloads = [];
    script = [finalStep('答二。')];
    const run2 = await runToSettled('', { ephemeralHint: 'EPHEMERAL-MARK' }, 'R2');
    expect(run2.status).toBe('done');

    const msgs = (llmPayloads[0].messages as any[]);
    // 请求里不允许出现两条相邻同为 user:openaiToAnthropicBody 只合并相邻 tool,同角色 user 逐条 push。
    const adjacentUserPairs = msgs.filter((m, i) => i > 0 && m.role === 'user' && msgs[i - 1].role === 'user');
    expect(adjacentUserPairs).toEqual([]);
    // hint 就地追加进末尾那条 user,仍是「尾部 user 通道」。
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('半路中断的一问');
    expect(String(last.content)).toContain('EPHEMERAL-MARK');
    // 更早的那条 user(历史中段)一字不动。
    const older = msgs.find((m) => m.role === 'user' && String(m.content).includes('第一问'));
    expect(String(older.content)).toBe('第一问');
    // 尾部通道恒不落库:追加进历史消息也一样。
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S'`);
    expect(rows.some((r) => String(r.content).includes('EPHEMERAL-MARK'))).toBe(false);
  }, 30_000);
});

/**
 * A2/A4 仪器的两条「必须对得上真实请求」(Codex 评审三轮 #4/#5):
 *   #4 toolsBytes 与探针的 tools 段按**本轮真实发出去的**工具头算 —— 末轮不发 tools 就是 0,
 *      照组装好的那份出账会把「前缀真的变了」掩盖成「没变」。
 *   #5 headHashSameAsAgentModel 恒定是**跨 run** 比较:基准在 run 开始时取一次并固定。
 *      此前每帧现取,而 probeSeq=0 已把 map 写成本 run 的值 → 第 2 帧起悄悄变成「与本 run 首帧比」。
 */
describe('缓存探针与固定头计量', () => {
  const probeCfg = { agentConfig: { cacheProbe: true, maxIterations: 2 } };
  const eventsOf = async (runId: string): Promise<Array<{ type: string; p: any }>> => {
    const rows = await query<any[]>(`SELECT type, payload FROM agent_run_events WHERE run_id = ? ORDER BY seq ASC`, [runId]);
    return rows.map((r) => ({ type: r.type, p: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }));
  };
  const toolTurn = () => ({
    content: '看下待办。', reasoning: '',
    toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '一件事', status: 'completed' }] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
  });

  it('末轮不发 tools → toolsBytes 与探针 tools 段都是 0;跨 run 比较基准在 run 开始时固定', async () => {
    process.env.TANGU_CACHE_PROBE = '1';
    try {
      script = [toolTurn, finalStep('干完了。')];
      expect((await runToSettled('干活', probeCfg, 'RP1')).status).toBe('done');

      const ev1 = await eventsOf('RP1');
      const usages1 = ev1.filter((e) => e.type === 'usage').map((e) => e.p);
      const probes1 = ev1.filter((e) => e.type === 'cache_probe').map((e) => e.p);
      expect(usages1.length).toBe(2);
      expect(probes1.length).toBe(2);

      // #4:第 0 轮带 tools(真实上 wire),末轮(iteration 1)不带 → 0 字节、探针 tools 段也是 0。
      expect(buildOpts[0].tools?.length).toBeGreaterThan(0);
      expect(buildOpts[1].tools).toBeUndefined();
      expect(usages1[0].toolsBytes).toBeGreaterThan(0);
      expect(usages1[1].toolsBytes).toBe(0);
      const toolsSeg = (p: any) => p.segments.find((s: any) => s.name === 'tools');
      expect(toolsSeg(probes1[0]).bytes).toBeGreaterThan(0);
      expect(toolsSeg(probes1[1]).bytes).toBe(0);
      // 工具头真的变了,探针就该说变了 —— 这正是此前被掩盖的那条。
      expect(probes1[1].changedSegments).toContain('tools');

      // #5:本 run 之前同一 (agent, model) 没有任何 head hash → 每一帧都是 null,
      //     绝不因为 probeSeq=0 写过 map 就在第 2 帧改成「与本 run 首帧比」。
      expect(probes1.map((p) => p.headHashSameAsAgentModel)).toEqual([null, null]);

      // 第二个 run:基准是上一 run 的首帧 hash,于是首帧给出真正的跨 run 判断。
      buildOpts = [];
      llmPayloads = [];
      script = [toolTurn, finalStep('又干完了。')];
      expect((await runToSettled('再干一次', probeCfg, 'RP2')).status).toBe('done');
      const probes2 = (await eventsOf('RP2')).filter((e) => e.type === 'cache_probe').map((e) => e.p);
      expect(probes2.length).toBe(2);
      expect(typeof probes2[0].headHashSameAsAgentModel).toBe('boolean'); // 有得比了
      expect(probes2[0].headHashSameAsAgentModel).toBe(probes2[0].headHash === probes1[0].headHash);
      // 末轮剥掉 tools → 头指纹必然不同于上一 run 的首帧,如实报 false。
      expect(probes2[1].headHashSameAsAgentModel).toBe(false);
    } finally {
      delete process.env.TANGU_CACHE_PROBE;
    }
  }, 40_000);
});
