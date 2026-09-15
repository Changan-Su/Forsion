/**
 * 子代理的 deferred 解锁通道(E2 收尾):子代理此前被显式剥掉 unlockedTools/unlockTools —— 没有
 * load_tools、也没有「Additional Tools」目录,browser 细粒度 / 日历 / view_video /
 * write_process_input / set_ui_setting 在委派出去的那一刻整片消失。本块钉三条:
 *   ① 子代理自己能 load_tools:首帧带 load_tools + 目录段,解锁后的 defs 多出那一个工具;
 *   ② 解锁项**追加在末尾**:immediate 前缀逐字节不动(前缀缓存只在解锁那一刻断一次);
 *   ③ 父子隔离:从父集合的**拷贝**起步 —— 父已解锁的子代理继承得到(反证「换成空集」),
 *      子代理解锁的绝不回灌父集合(反证「共享同一个 Set 引用」)。两条断言在任一错误实现下
 *      必有一条红 —— 这就是 ③ 的结构性负对照(源码级负对照另跑,见交付说明)。
 *   ④ 管理面例外(SUB_AGENT_UNLOCK_DENY):manage_* 族改的是 agent 定义/技能/自动化规则/日程/harness
 *      这类跨 run 存续的配置,子代理**不得**自助解锁 —— seed 时从父集合拷贝里剔掉、目录段不列、
 *      load_tools 拦下并如实报「本会话不可用」。能力面照旧可解锁(①②③ 就是它的正对照)。
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
import { runSubAgent, SUB_AGENT_UNLOCK_DENY } from './subAgent.js';
import { listDeferredTools } from '../tools/registry.js';
import type { ToolContext } from '../tools/registry.js';

const USER = 'u1';
let home: string;
let subPayloads: any[];
let script: Array<() => any>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-subunlock-'));
  process.env.TANGU_HOME = home;
  subPayloads = [];
  script = [];

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    // ⚠ tools 必须透传:本块量的就是「这一轮真发出去的工具面」。
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
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
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
const parentCtx = (unlockedTools?: Set<string>): ToolContext => ({
  userId: USER, sessionId: 'S', appId: 'tangu', runId: 'R1',
  profile: createTanguProfile({ sandboxMode: 'none' }),
  execMode: 'sandbox', thinkingLevel: 'medium',
  ...(unlockedTools ? { unlockedTools, unlockTools: (names: string[]) => names.forEach((n) => unlockedTools.add(n)) } : {}),
} as unknown as ToolContext);

/** registry 层面的 deferred 目录(**未**经子代理的 deny 名单过滤):管理面断言的「前提不成立就别断言」对照。 */
function rawSubCatalog(): { name: string; group?: string }[] {
  return listDeferredTools({ ...(parentCtx() as any), subAgentDepth: 1 } as ToolContext);
}

/** 子代理实际看得到的 deferred 目录(靠内省选被测工具,别猜名字:门禁随宿主环境/profile 变)。
 *  去掉管理面:①②③ 量的是**能力面**,被测工具不该随注册顺序挑到一个本就解锁不了的 manage_*。 */
function subCatalog(): { name: string; group?: string }[] {
  return rawSubCatalog().filter((d) => !SUB_AGENT_UNLOCK_DENY.has(d.name));
}

/** 本 harness 下 registry 真列得出来的管理面工具 —— 按**父级**(depth 0)的目录取:
 *  子代理硬闸(resolveTools 按 subAgentDepth≥1 整族剔除)之后,depth 1 的目录里本就一个都没有,
 *  拿 rawSubCatalog() 当「前提成立」的证据会永远为空、把下面两条测试变成空转。
 *  execMode='sandbox' 时 mode:'host' 的 manage_agent/manage_skill/manage_harness 本就不可见,
 *  拿它们当被测对象同样是空转。 */
function deniedInCatalog(): string[] {
  return listDeferredTools(parentCtx()).map((d) => d.name).filter((n) => SUB_AGENT_UNLOCK_DENY.has(n));
}

const names = (payload: any): string[] => ((payload?.tools ?? []) as any[]).map((t) => t?.function?.name);

/** 「先 load_tools 再收尾」两轮剧本。 */
function scriptLoading(toLoad: string): void {
  script = [
    () => ({
      content: '', reasoning: '',
      toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'load_tools', arguments: JSON.stringify({ names: [toLoad] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
    }),
    () => ({ content: '装好了,收工。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' }),
  ];
}

describe('子代理的 deferred 解锁通道', () => {
  it('首帧就带 load_tools 与「Additional Tools」目录段', async () => {
    const catalog = subCatalog();
    expect(catalog.length, '子代理 ctx 下一个 deferred 工具都没有 → 本块的前提不成立').toBeGreaterThan(0);
    script = [() => ({ content: '好了。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' })];
    await runSubAgent({ task: '随便', parentCtx: parentCtx(), modelId: 'm1' });

    expect(names(subPayloads[0])).toContain('load_tools');
    const sys = String((subPayloads[0].messages as any[]).find((m) => m.role === 'system')?.content || '');
    expect(sys).toContain('## Additional Tools (load on demand)');
    expect(sys).toContain(`- ${catalog[0].name}: `);
    // 目录里列的工具本体不在常驻面上(否则「按需装载」就白做了)。
    expect(names(subPayloads[0])).not.toContain(catalog[0].name);
  }, 20_000);

  it('load_tools 解锁的工具进入下一轮 defs,且追加在末尾(前缀字节不动)', async () => {
    // 不带 deferGroup:连坐解锁会一次追加整组,「恰好多出一个」的断言就说不清了。
    const target = subCatalog().find((d) => !d.group);
    expect(target, '没有一个无 deferGroup 的 deferred 工具可选').toBeTruthy();
    scriptLoading(target!.name);
    await runSubAgent({ task: `去用 ${target!.name}`, parentCtx: parentCtx(), modelId: 'm1' });

    expect(subPayloads.length).toBe(2);
    const before = names(subPayloads[0]);
    const after = names(subPayloads[1]);
    expect(before).not.toContain(target!.name);
    expect(after).toEqual([...before, target!.name]); // 恰好多出一个,且在末尾
    // 字节级:immediate 前缀原样不动 —— 解锁只在这一刻打一次 provider 前缀缓存。
    const beforeJson = JSON.stringify(subPayloads[0].tools);
    const afterJson = JSON.stringify(subPayloads[1].tools);
    expect(afterJson.startsWith(beforeJson.slice(0, -1) + ',')).toBe(true);
  }, 20_000);

  it('父子解锁集隔离:父的已解锁项继承得到,子代理解锁的不回灌父集合', async () => {
    const cat = subCatalog().filter((d) => !d.group);
    expect(cat.length, '需要两个互不同组的 deferred 工具').toBeGreaterThanOrEqual(2);
    const [inherited, target] = [cat[0].name, cat[1].name];
    const parentSet = new Set<string>([inherited]);
    scriptLoading(target);
    await runSubAgent({ task: `去用 ${target}`, parentCtx: parentCtx(parentSet), modelId: 'm1' });

    // ① 继承:首帧就带父已解锁的那个(换成 `new Set()` 空集起步 → 这条红)。
    expect(names(subPayloads[0])).toContain(inherited);
    // ② 隔离:子代理解锁的那个绝不出现在父集合里(共享同一个 Set 引用 → 这条红)。
    expect([...parentSet]).toEqual([inherited]);
    expect(parentSet.has(target)).toBe(false);
    // 子代理自己那边确实生效了(否则 ② 会因为「压根没解锁成功」而假绿)。
    expect(names(subPayloads[1])).toContain(target);
  }, 20_000);

  it('管理面 · seed 时剔除:父解锁过 manage_* 也不外溢给子代理', async () => {
    const denied = deniedInCatalog();
    expect(denied.length, '本 harness 下一个管理面 deferred 工具都不可见 → 本条空转,换 execMode 或换名单').toBeGreaterThan(0);
    const carry = subCatalog().find((d) => !d.group)?.name;
    expect(carry, '需要一个能力面 deferred 工具做正对照').toBeTruthy();
    // 父 run 把能力面与管理面都解锁过:子代理只该继承前者。
    const parentSet = new Set<string>([carry!, ...denied]);
    script = [() => ({ content: '好了。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' })];
    await runSubAgent({ task: '随便', parentCtx: parentCtx(parentSet), modelId: 'm1' });

    const first = names(subPayloads[0]);
    expect(first, '能力面照旧继承(否则本条测的不是 deny 而是继承坏了)').toContain(carry);
    const sys = String((subPayloads[0].messages as any[]).find((m) => m.role === 'system')?.content || '');
    for (const n of denied) {
      expect(first, `${n} 不该随父集合外溢进子代理 defs`).not.toContain(n);
      expect(sys, `${n} 不该出现在子代理的「Additional Tools」目录段`).not.toContain(`- ${n}: `);
    }
    // 父集合本身一字未改(剔除发生在**拷贝**上)。
    expect([...parentSet].sort()).toEqual([carry!, ...denied].sort());
  }, 20_000);

  it('管理面 · unlock 时拦下:load_tools 装不上,且如实报「本会话不可用」', async () => {
    const denied = deniedInCatalog();
    expect(denied.length, '本 harness 下一个管理面 deferred 工具都不可见 → 本条空转').toBeGreaterThan(0);
    const target = denied[0];
    const ok = subCatalog().find((d) => !d.group)?.name;
    expect(ok, '需要一个能力面 deferred 工具做正对照').toBeTruthy();
    script = [
      () => ({
        content: '', reasoning: '',
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'load_tools', arguments: JSON.stringify({ names: [ok, target] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
      }),
      () => ({ content: '收工。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' }),
    ];
    await runSubAgent({ task: `去用 ${target}`, parentCtx: parentCtx(), modelId: 'm1' });

    expect(subPayloads.length).toBe(2);
    const after = names(subPayloads[1]);
    expect(after, '能力面该装上(否则本条会因为「load_tools 整个没生效」而假绿)').toContain(ok);
    expect(after, `${target} 的定义绝不该进子代理的 defs`).not.toContain(target);
    // 回答如实:装上的报装上,拦下的报不可用 —— 谎报成功会让模型去调一个永远没有定义的工具。
    const toolMsg = String((subPayloads[1].messages as any[]).filter((m) => m.role === 'tool').pop()?.content || '');
    expect(toolMsg).toContain(`Loaded tool(s): ${ok}`);
    expect(toolMsg).toContain(`Unavailable in this session: ${target}`);
  }, 20_000);

  it('管理面 · 本次委派授予过的:load_tools 照常装上,不再报「本会话不可用」', async () => {
    // ⑤ 那道闸(unlockTools 回调)现在按 isSubAgentDenied 判而不是静态名单 —— 授予项必须在这里也放行,
    // 否则会出现「首轮 defs 里有、模型再 load_tools 一次却被告知不可用」的自相矛盾状态。
    // 名字写死 manage_schedule(不从名单里挑):名单被误删一项时本条必须红。
    expect(deniedInCatalog(), '本 harness 下 manage_schedule 在父级目录里不可见 → 本条空转')
      .toContain('manage_schedule');
    script = [
      () => ({
        content: '', reasoning: '',
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'load_tools', arguments: JSON.stringify({ names: ['manage_schedule'] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
      }),
      () => ({ content: '收工。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' }),
    ];
    await runSubAgent({ task: '看看日程', parentCtx: parentCtx(), modelId: 'm1', grantTools: ['manage_schedule'] });

    expect(subPayloads.length).toBe(2);
    // 预解锁:授予项首轮就在工具面上(不必先花一轮 load_tools)。
    expect(names(subPayloads[0]), '授予项应预解锁进首轮 defs').toContain('manage_schedule');
    // 已在 defs 里的工具不该再出现在「not loaded yet」目录段:列了模型会先白花一轮 load_tools(live 09-15 实测)。
    const sys0 = String(subPayloads[0].messages.find((m) => m.role === 'system')?.content || '');
    expect(sys0, '授予项已预解锁,不该再列进 Additional Tools 目录').not.toContain('- manage_schedule: ');
    const toolMsg = String((subPayloads[1].messages as any[]).filter((m) => m.role === 'tool').pop()?.content || '');
    expect(toolMsg).toContain('Loaded tool(s): manage_schedule');
    expect(toolMsg, '授予过的名字不该再被报成本会话不可用').not.toContain('Unavailable in this session');
    expect(names(subPayloads[1])).toContain('manage_schedule');
  }, 20_000);

  // 评审 09-15 #5 的原场景:子代理**一次把目录里剩下的全部** deferred 工具解锁掉。旧判据
  // (lockedCount===0 就撤 load_tools)会在下一轮把 load_tools 从 defs 中间删掉,解锁项又追加在
  // 末尾 —— 工具 JSON 从 load_tools 原来的位置起整体错位,前缀缓存从该点全 miss。
  // 上面「解锁一个」那条踩不到:环境里还剩别的未解锁项,lockedCount 从来没归零。
  it('一次解锁全部目录项:load_tools 不消失,且前一轮 tools 仍是后一轮的逐字节前缀', async () => {
    const all = subCatalog().map((d) => d.name);
    expect(all.length, '子代理目录为空 → 本条空转').toBeGreaterThan(1);
    script = [
      () => ({
        content: '', reasoning: '',
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'load_tools', arguments: JSON.stringify({ names: all }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
      }),
      () => ({ content: '全装好了,收工。', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' }),
    ];
    await runSubAgent({ task: '把目录里的都装上', parentCtx: parentCtx(), modelId: 'm1' });

    expect(subPayloads.length).toBe(2);
    expect(names(subPayloads[0])).toContain('load_tools');
    expect(names(subPayloads[1]), '解锁光了也不该把 load_tools 从工具面撤走').toContain('load_tools');
    const bytes = (p: any): string[] => ((p?.tools ?? []) as any[]).map((t) => JSON.stringify(t));
    const before = bytes(subPayloads[0]);
    expect(bytes(subPayloads[1]).slice(0, before.length), '第一轮那份必须仍是第二轮那份的逐字节前缀').toEqual(before);
    // 解锁确实生效了(否则「前缀成立」会因为两轮一模一样而假绿)。
    expect(bytes(subPayloads[1]).length).toBeGreaterThan(before.length);
    for (const n of all) expect(names(subPayloads[1]), `${n} 应已解锁进 defs`).toContain(n);
  }, 20_000);
});
