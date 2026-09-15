/**
 * delegate 的**授予**通道(grantTools)在 runSubAgent 这一层的端到端行为。上一层
 * (test/subAgentManageDeny.test.ts)钉的是 ctx.subAgentGrants 这个开关本身;本块钉的是
 * 「父代理点了名之后,子代理一整轮下来真的拿得到、且拿得**不多不少**」:
 *
 *   ① 首轮工具面:授予了 → manage_automation 直接在 defs 里(**预解锁**,不必先花一轮 load_tools);
 *      没授予 → 不在。
 *   ② 审批照走:被授予的调用**必须**经过 gateToolCall —— 授予抬的是子代理硬闸那一道,不是审批。
 *      这条最容易在实现里写反(在硬闸处顺手 return 掉审批),而且写反了功能测试全绿。
 *   ③ 没授予时仍然拒:gateToolCall 压根不被调用(不拿注定被拒的调用去打扰用户),
 *      模型收到的是 "unavailable to sub-agents" 那句。
 *   ④ 旧别名:模型写 muse_watch、父代理授的是 manage_automation —— 判定先归一,两边都不该漏。
 *      脚本一律用别名发起,正是为了让归一路径成为被测路径而不是旁路。
 *   ⑤ 事件契约:`subagent` phase:'start' 的 payload 带 `grants` 数组(审计面/live 台架唯一的观测点;
 *      台架的正/负判据全落在这个字段上,这里先在单测里钉死它的存在与取值)。
 *   ⑥ 父 run 不被污染:授予是**本次委派**的事,父 ctx 的 unlockedTools 一字未动。
 *   ⑦ 送审时带上**执行身份**(具名子代理的 slug):延后审批的行只存得下 run 的 agentSlug,
 *      ALS 作用域的工具(manage_harness 等)据此拒绝排队,否则事后重放会写到父代理头上。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { runSubAgent } from './subAgent.js';
import type { ToolContext } from '../tools/registry.js';

// 两个探针都**透传**真实实现:本块量的是「有没有被调到 / 发了什么 payload」,不是替换行为。
// (execMode='sandbox' 下真 gateToolCall 对非 mcp 工具即时放行,不需要审批订阅者。)
const spies = vi.hoisted(() => ({ gate: vi.fn(), publish: vi.fn(), exec: vi.fn(), hooks: vi.fn() }));
// executeTool 透传探针:「审批 reject / hook block 时工具实现没执行」只能用它证(看 tool 消息证不了)。
vi.mock('../tools/registry.js', async (orig) => {
  const actual = await orig<typeof import('../tools/registry.js')>();
  return {
    ...actual,
    executeTool: (...args: Parameters<typeof actual.executeTool>) => {
      spies.exec(...args);
      return actual.executeTool(...args);
    },
  };
});
// lifecycle hook:缺省空判定(与 host-only 闸的结果同形);单个用例可 mockImplementationOnce 返回 block。
vi.mock('../hooks/index.js', async (orig) => {
  const actual = await orig<typeof import('../hooks/index.js')>();
  return {
    ...actual,
    runHooks: async (...args: any[]) => {
      const forced = await spies.hooks(...args);
      return forced !== undefined ? forced : { additionalContext: [], systemMessages: [], runs: [] };
    },
  };
});
vi.mock('./approvals.js', async (orig) => {
  const actual = await orig<typeof import('./approvals.js')>();
  return {
    ...actual,
    gateToolCall: (...args: Parameters<typeof actual.gateToolCall>) => {
      // 缺省透传;单个用例可 mockImplementationOnce 返回一个决定(比如 reject)来验「决定真被执行」。
      const forced = spies.gate(...args);
      return forced !== undefined ? forced : actual.gateToolCall(...args);
    },
  };
});
vi.mock('./eventBus.js', async (orig) => {
  const actual = await orig<typeof import('./eventBus.js')>();
  return {
    ...actual,
    publish: (...args: Parameters<typeof actual.publish>) => {
      spies.publish(...args);
      return actual.publish(...args);
    },
  };
});

const USER = 'u1';
let home: string;
let subPayloads: any[];
let script: Array<() => any>;
/** beforeEach 装好的那份 deps:引擎路那块要在它之上再加一个 engines 管理器。 */
let baseDeps: any;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-subgrant-'));
  process.env.TANGU_HOME = home;
  subPayloads = [];
  script = [];
  spies.gate.mockClear(); // mockClear 而非 mockReset:后者会连带清掉上面工厂里装的透传实现
  spies.publish.mockClear();
  spies.exec.mockClear();
  spies.hooks.mockClear();

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
    streamProviderCompletion: async (o: any) => {
      subPayloads.push(o.payload);
      const step = script.shift();
      if (!step) throw new Error(`脚本耗尽:第 ${subPayloads.length} 次 LLM 调用没有出招`);
      return step();
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
  baseDeps = { host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) };
  configureTangu(baseDeps);
  await runMigration();
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`,
    [USER],
  );
  await createRun({
    id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
    input: { message: '干活', userMessageId: 'U1', attachments: [], agentConfig: {} },
  });
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

// execMode='sandbox':gateToolCall 对非 mcp 工具直接放行,测试不依赖审批订阅者。
const parentCtx = (unlockedTools: Set<string>): ToolContext => ({
  userId: USER, sessionId: 'S', appId: 'tangu', runId: 'R1',
  profile: createTanguProfile({ sandboxMode: 'none' }),
  execMode: 'sandbox', thinkingLevel: 'medium',
  unlockedTools, unlockTools: (names: string[]) => names.forEach((n) => unlockedTools.add(n)),
} as unknown as ToolContext);

/** 首轮直接调**旧别名** muse_watch(空参:manage_automation 走它自己的「未知 action」路径,无副作用),次轮收尾。 */
function scriptAliasCall(): void {
  script = [
    () => ({
      content: '', reasoning: '',
      toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'muse_watch', arguments: '{}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
    }),
    () => ({ content: '报告完毕。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' }),
  ];
}

const names = (payload: any): string[] => ((payload?.tools ?? []) as any[]).map((t) => t?.function?.name);
/** 模型这一轮真正收到的工具结果(最后一条 role='tool')。 */
const lastToolMessage = (payload: any): string =>
  String((payload?.messages as any[]).filter((m) => m.role === 'tool').pop()?.content || '');
/** `subagent` phase:'start' 事件的 payload(本块唯一能看到 grants 的地方)。 */
const startPayload = (): any =>
  spies.publish.mock.calls.find((c) => c[1] === 'subagent' && c[2]?.phase === 'start')?.[2];
/** 本次被 gateToolCall 送审的工具名(透传实现,所以这里量的是「有没有进审批」)。 */
const gatedNames = (): string[] => spies.gate.mock.calls.map((c: any[]) => c[1]?.function?.name);
/** 真进到 executeTool 的工具名(证「执行了 / 没执行」的唯一可靠观测点)。 */
const executedNames = (): string[] => spies.exec.mock.calls.map((c: any[]) => c[0]?.function?.name);
/** 本次跑里派发过的 hook 事件名 + tool_name。 */
const hookEvents = (): Array<[string, string]> => spies.hooks.mock.calls.map((c: any[]) => [c[0], c[1]?.tool_name]);

describe('delegate 授予的管理工具:进得了首轮 defs,且照走审批', () => {
  it('审批返回 reject → 拒绝原因进 tool 消息、管理工具本身没执行(证「照走审批」不只是「调过 gate」;Codex 09-15 #6)', async () => {
    scriptAliasCall();
    spies.gate.mockImplementationOnce(async () => ({ action: 'reject', rejectReason: 'NOPE-BY-GATE' }));
    await runSubAgent({ task: '去改自动化规则', parentCtx: parentCtx(new Set()), modelId: 'm1', grantTools: ['manage_automation'] });
    expect(subPayloads.length).toBe(2);
    const toolMsg = lastToolMessage(subPayloads[1]);
    expect(toolMsg).toContain('NOPE-BY-GATE');
    // 工具真没跑:跑了的话空参会落到它自己的「action」参数校验文案上。
    expect(toolMsg).not.toMatch(/action/i);
    expect(toolMsg).not.toMatch(/unavailable to sub-agents/i);
    // 直接证据:executeTool 一次都没被叫到(不是「跑了再把结果丢掉」;Codex 09-15 复审 #5)。
    expect(executedNames()).toEqual([]);
  }, 20_000);

  it('PreToolUse hook 返回 block → 子代理循环真拦(此前子代理完全不跑 lifecycle hook;Codex 09-15 复审 #2)', async () => {
    scriptAliasCall();
    spies.hooks.mockImplementationOnce(async (ev: string) => (ev === 'PreToolUse'
      ? { block: true, blockReason: 'HOOK-SAYS-NO', additionalContext: [], systemMessages: [], runs: [] }
      : undefined));
    await runSubAgent({ task: '去改自动化规则', parentCtx: parentCtx(new Set()), modelId: 'm1', grantTools: ['manage_automation'] });
    expect(subPayloads.length).toBe(2);
    expect(hookEvents(), 'PreToolUse 必须以模型原始工具名派发').toContainEqual(['PreToolUse', 'muse_watch']);
    const toolMsg = lastToolMessage(subPayloads[1]);
    expect(toolMsg).toContain('HOOK-SAYS-NO');
    expect(gatedNames(), '被 hook 拦下的调用不该再去打扰审批').toEqual([]);
    expect(executedNames(), '被 hook 拦下的调用不该执行').toEqual([]);
  }, 20_000);

  it('负对照:hook 空判定时照常 PreToolUse → 审批 → 执行 → PostToolUse', async () => {
    scriptAliasCall();
    await runSubAgent({ task: '去改自动化规则', parentCtx: parentCtx(new Set()), modelId: 'm1', grantTools: ['manage_automation'] });
    expect(executedNames()).toEqual(['muse_watch']);
    const evs = hookEvents().map(([e]) => e);
    expect(evs).toEqual(['PreToolUse', 'PostToolUse']);
  }, 20_000);

  it('授予 manage_automation:首轮 defs 就有、别名调用进审批、结果不是子代理拒绝语', async () => {
    const parentSet = new Set<string>();
    scriptAliasCall();
    await runSubAgent({ task: '去改自动化规则', parentCtx: parentCtx(parentSet), modelId: 'm1', grantTools: ['manage_automation'] });

    expect(subPayloads.length).toBe(2);
    // ① 预解锁:不用先花一轮 load_tools —— 父代理点名授予本身就等于说「这个子任务需要它」。
    expect(names(subPayloads[0]), '授予项应直接出现在子代理首轮工具面').toContain('manage_automation');
    // ② 审批照走:授予抬的是子代理硬闸,不是审批闸门。
    expect(gatedNames(), '被授予的调用必须经过 gateToolCall(授予 ≠ 免审批)').toContain('muse_watch');
    // ③ 模型真拿到了工具本身的回答,而不是那句拒绝。
    const toolMsg = lastToolMessage(subPayloads[1]);
    expect(toolMsg).not.toMatch(/unavailable to sub-agents/i);
    expect(toolMsg, '空参应落到 manage_automation 自己的参数校验上,证明它真被执行了').toMatch(/action/i);
    expect(executedNames(), '直接证据:executeTool 收到了这次调用').toEqual(['muse_watch']);
    // ④ 事件契约:start 事件带 grants(live 台架的正判据就落在这个字段)。
    expect(startPayload()?.grants).toEqual(['manage_automation']);
    // ⑤ 父 run 的解锁面一字未动(授予是本次委派的事,不回灌父 ctx)。
    expect([...parentSet]).toEqual([]);
  }, 20_000);

  it('负对照 · 同一份脚本不授予:首轮 defs 没有、不进审批、结果就是子代理拒绝语', async () => {
    const parentSet = new Set<string>();
    scriptAliasCall();
    await runSubAgent({ task: '去改自动化规则', parentCtx: parentCtx(parentSet), modelId: 'm1' });

    expect(subPayloads.length).toBe(2);
    expect(names(subPayloads[0]), '没授予就不该出现在工具面').not.toContain('manage_automation');
    expect(gatedNames(), '注定被拒的调用不该去打扰用户').not.toContain('muse_watch');
    expect(spies.gate, '本轮只有这一个工具调用,审批探针应当零调用').not.toHaveBeenCalled();
    expect(lastToolMessage(subPayloads[1])).toMatch(/unavailable to sub-agents/i);
    // grants 字段恒在(只是空数组)—— 台架的负判据靠「没有任何 start 事件授予过它」,字段缺席会让判据形同虚设。
    expect(startPayload()?.grants).toEqual([]);
    expect([...parentSet]).toEqual([]);
  }, 20_000);
});

/** 具名子代理:落一个最小 config.toml 到 TANGU_HOME/agents/<slug>,getAgent 即认。 */
function writeAgent(slug: string, name: string): void {
  const dir = join(home, 'agents', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.toml'), `name = "${name}"\ndeveloper_instructions = "Do the subtask."\ncreated_by = "test"\n`);
}
/** 上一次送审时 gateToolCall 收到的 ctx(第三个参数)。 */
const lastGateCtx = (): any => (spies.gate.mock.calls.at(-1) as any[] | undefined)?.[2];

describe('送审时带上执行身份(execAgentSlug)', () => {
  // 脚本:随便一个无副作用的工具(get_datetime)调一次即可 —— 本块量的是送审 ctx,不是工具本身。
  const scriptDatetime = (): void => {
    script = [
      () => ({
        content: '', reasoning: '',
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
      }),
      () => ({ content: '好了。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' }),
    ];
  };

  it('具名子代理:ctx.execAgentSlug = 该 agent 的 slug(它正是 executeTool 时的展示身份)', async () => {
    writeAgent('subby', 'Subby');
    scriptDatetime();
    await runSubAgent({ task: '干点活', parentCtx: parentCtx(new Set()), modelId: 'm1', agentSlug: 'subby' });
    expect(spies.gate).toHaveBeenCalled();
    expect(lastGateCtx()?.execAgentSlug, 'pendingApprovals 的 ALS 闸全靠这个字段认出「执行的不是本 run 的 agent」').toBe('subby');
  }, 20_000);

  it('负对照:内联临时子代理(无 agentSlug)不带 execAgentSlug —— 它就在父代理的作用域里跑,没有漂移', async () => {
    scriptDatetime();
    await runSubAgent({ task: '干点活', parentCtx: parentCtx(new Set()), modelId: 'm1', instructions: '你是临时工' });
    expect(spies.gate).toHaveBeenCalled();
    expect(lastGateCtx()).not.toHaveProperty('execAgentSlug');
  }, 20_000);
});

/**
 * 引擎路的 start 事件必须**诚实**:外部 CLI 跑自己的工具面,Tangu 的授予到不了它那里。
 * 从前这里照发 `grants: [...grantTools]`,事件流(= 审计面)于是记下了一条从未真正授出去的管理权限,
 * 而「其实没生效」只写在源码注释里 —— 事件消费者读不到。现在恒发空数组 + engine 标记。
 * (delegate 那层已当场拒绝这个组合;本块钉的是绕过 delegate 直调 runSubAgent 时的第二道诚实性保证。)
 */
describe('引擎子代理的 start 事件不谎报 grants', () => {
  const withEngine = (ran: any[]) => configureTangu({
    ...baseDeps,
    engines: {
      list: () => [{ id: 'codex', name: 'Codex', available: true }],
      run: async (o: any) => { ran.push(o); return { content: '引擎干完了' }; },
    } as any,
  });

  it('直调带 grantTools 的引擎委派:入口就抛错、引擎不启动(不再静默丢掉;Codex 09-15 #4)', async () => {
    const ran: any[] = [];
    withEngine(ran);
    await expect(runSubAgent({
      task: '交给引擎', parentCtx: parentCtx(new Set()), modelId: 'm1',
      engineId: 'codex', grantTools: ['manage_automation'],
    })).rejects.toThrow(/grantTools does not apply to engine delegation/);
    expect(ran, '引擎不该被调起来').toHaveLength(0);
    expect(startPayload(), '没起子代理就不该有 start 事件').toBeUndefined();
  }, 20_000);

  it('不带 grantTools 的引擎委派:照常跑,start 事件 grants 恒空并带 engine 标记把两条路分开', async () => {
    const ran: any[] = [];
    withEngine(ran);
    const out = await runSubAgent({ task: '交给引擎', parentCtx: parentCtx(new Set()), modelId: 'm1', engineId: 'codex' });
    expect(out).toBe('引擎干完了');
    expect(ran, '引擎真被调起来了(否则下面的断言是空转)').toHaveLength(1);
    const start = startPayload();
    expect(start?.grants, '外部 CLI 从没拿到过任何管理工具,事件里就不能写它拿到了').toEqual([]);
    expect(start?.engine, '消费者得能不看源码注释就分清两条路').toBe('codex');
  }, 20_000);
});
