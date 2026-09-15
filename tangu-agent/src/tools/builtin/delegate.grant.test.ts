/**
 * delegate.grantTools 的入参校验(委派**发起侧**的那一半)。执行侧(子代理真拿到工具、照走审批)
 * 在 src/services/subAgentGrantApproval.test.ts;本块只钉「什么授得出去、什么授不出去」。
 *
 * 不变量:**被授权的子代理永远不会比父代理更强**。它落地成两条校验:
 *   ① 名字必须是可授予的管理工具(旧别名先归一);写错 → 报错并**不 spawn**;
 *   ② 父代理此刻自己解析得出该工具(resolveTools 同一份口径)。父自己拿不到的,授不出去 ——
 *      云端/沙箱(manage_agent 是 host-only)、Muse 非 full-auto 档(manage_automation 的 isEnabledFor)
 *      各测一遍,并各配一条**正对照**:同形状 ctx 去掉那道门禁后授得出去,证明红的是该门禁而不是别的。
 * 两条校验都排在 engine 分支**之前**:名字写错是模型的错误认知,两条路都该当场纠正。
 * 第三条(engine × grantTools **互斥**)在 engine 分支里:外部 CLI 跑自己的工具面,授予到不了它那里,
 * 与其静默丢掉不如让这次委派失败 —— 见文件末尾那一块。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../../seams/runtime.js';
import { createTanguProfile } from '../../profiles/index.js';
import type { ToolContext } from '../toolTypes.js';

const spies = vi.hoisted(() => ({ runSubAgent: vi.fn(async () => 'sub report') }));
// delegate.ts 同时 import runSubAgent 与 SUB_MAX_ITERATIONS(后者进工具描述),两个都要给。
vi.mock('../../services/subAgent.js', () => ({ runSubAgent: spies.runSubAgent, SUB_MAX_ITERATIONS: 24 }));

// ⚠️ 必须经门面 registry.js 走一遭:内置 provider 是它在模块顶层逐个 registerToolProvider 注册的。
// 只 import delegate.js 的话全局 provider 表是空的 → resolveTools 返回空 Map → 本块「父代理拿得到」
// 的正对照会全红在一个与被测逻辑无关的原因上。
await import('../registry.js');
const { delegateProvider } = await import('./delegate.js');

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const profile = createTanguProfile({ sandboxMode: 'none' });
const execute = (delegateProvider.tools()[0] as any).execute as (args: any, ctx: ToolContext) => Promise<string>;

// TANGU_HOME 隔离到临时目录:resolveTools 会读**真实家目录**的 hostSandbox 配置
// (execMode='host' 时 resolveHostSandboxPolicy()),开发机上开着沙箱的话整族 manage_* 会被
// COVERED_TOOLS 默认拒挡掉 —— 本块就会全红在「父代理自己也拿不到」上,与被测逻辑无关。
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-grantval-'));
  process.env.TANGU_HOME = home;
  spies.runSubAgent.mockClear();
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 缺省父上下文 = 本地 host 主 loop(depth 0),管理面本就可达。 */
const ctxOf = (extra: Partial<ToolContext> = {}): ToolContext => ({
  userId: 'u1', sessionId: 'S', appId: 'tangu', runId: 'R1', profile,
  execMode: 'host', cwd: '/tmp', approvalMode: 'full-auto', modelId: 'm1',
  ...extra,
} as ToolContext);

/** 上一次 runSubAgent 收到的 grantTools(没调用过则 null)。 */
const lastGrants = (): string[] | undefined | null => {
  const call = spies.runSubAgent.mock.calls.at(-1) as any[] | undefined;
  return call ? (call[0] as any).grantTools : null;
};

describe('delegate.grantTools 校验', () => {
  it('缺省不授予:runSubAgent 不带 grantTools(老行为零变化)', async () => {
    const r = await execute({ task: 'do something' }, ctxOf());
    expect(r).toBe('sub report');
    expect(lastGrants()).toBeUndefined();
  });

  it('未知名字 → 报错并点出那个名字,且**不 spawn**', async () => {
    const r = await execute({ task: 't', grantTools: ['manage_everything'] }, ctxOf());
    expect(r).toMatch(/unknown grantTools entry/i);
    expect(r).toContain('manage_everything');
    expect(r).toContain('manage_agent'); // 可授予清单要写给模型看,别只说「不对」
    expect(spies.runSubAgent, '校验失败绝不能已经把子代理放出去了').not.toHaveBeenCalled();
  });

  it('类型不对(非数组 / 元素非字符串)→ 报错并不 spawn', async () => {
    expect(await execute({ task: 't', grantTools: 'manage_schedule' }, ctxOf())).toMatch(/must be an array/i);
    expect(await execute({ task: 't', grantTools: [1] }, ctxOf())).toMatch(/must be an array/i);
    expect(spies.runSubAgent).not.toHaveBeenCalled();
  });

  it('父代理自己拿不到就授不出去 · sandbox 形态 × manage_agent(host-only)', async () => {
    const r = await execute({ task: 't', grantTools: ['manage_agent'] }, ctxOf({ execMode: 'sandbox' }));
    expect(r).toMatch(/cannot grant "manage_agent"/i);
    expect(spies.runSubAgent).not.toHaveBeenCalled();
    // 正对照:同一句话在 host 形态下授得出去 —— 上面红的是 mode 域,不是「grantTools 一律拒」。
    expect(await execute({ task: 't', grantTools: ['manage_agent'] }, ctxOf())).toBe('sub report');
    expect(lastGrants()).toEqual(['manage_agent']);
  });

  it('父代理自己拿不到就授不出去 · Muse 非 full-auto 档 × manage_automation', async () => {
    const museCtx = ctxOf({ muse: true, approvalMode: 'auto-edit' });
    const r = await execute({ task: 't', grantTools: ['manage_automation'] }, museCtx);
    expect(r).toMatch(/cannot grant "manage_automation"/i);
    expect(spies.runSubAgent).not.toHaveBeenCalled();
    // 正对照:同一个 Muse ctx 拨到 full-auto(manage_automation 的 isEnabledFor 这时放行)就授得出去。
    expect(await execute({ task: 't', grantTools: ['manage_automation'] }, ctxOf({ muse: true, approvalMode: 'full-auto' }))).toBe('sub report');
    expect(lastGrants()).toEqual(['manage_automation']);
  });

  it('旧别名 muse_watch 归一成 manage_automation,并与正典名去重', async () => {
    await execute({ task: 't', grantTools: ['muse_watch'] }, ctxOf());
    expect(lastGrants(), '传下去的必须是正典名:子代理侧一切判定都按正典名比对').toEqual(['manage_automation']);
    await execute({ task: 't', grantTools: ['manage_automation', 'muse_watch', 'manage_schedule'] }, ctxOf());
    expect(lastGrants()).toEqual(['manage_automation', 'manage_schedule']);
  });

  it('校验排在 engine 分支之前:两处都不合法时先报 grantTools', async () => {
    // 本机没装外部引擎 → engine 名一定非法。若校验顺序反了,拿到的会是 engine 那句。
    const r = await execute({ task: 't', engine: 'no-such-engine', grantTools: ['nope'] }, ctxOf());
    expect(r).toMatch(/unknown grantTools entry/i);
    expect(spies.runSubAgent).not.toHaveBeenCalled();
  });
});

/**
 * engine × grantTools 互斥(2026-09-15 回归)。外部 CLI 跑它自己的工具面,授予根本到不了它那里 ——
 * 从前是「校验通过 → 静默丢掉」:模型不知道自己点名的管理工具是个空操作,而 start 事件还照发 grants,
 * 审计面上等于记下了一条从未授出去的管理权限。现在当场失败,让模型自己选一条路。
 */
describe('engine × grantTools 互斥', () => {
  const withEngine = (): void => {
    configureTangu({
      host: stub, brain: stub, billing: stub, profile,
      engines: { list: () => [{ id: 'codex', name: 'Codex', available: true }] } as any,
    });
  };

  it('两个都给 → 报错、不 spawn,且把那几个授不出去的名字点出来', async () => {
    withEngine();
    const r = await execute({ task: 't', engine: 'codex', grantTools: ['manage_schedule'] }, ctxOf());
    expect(r).toMatch(/grantTools does not apply to engine delegation/i);
    expect(r).toContain('manage_schedule');
    expect(r).toContain('codex');
    expect(spies.runSubAgent, '静默丢掉授予正是被修的那件事:宁可这次委派失败').not.toHaveBeenCalled();
  });

  it('负对照:同一个引擎、不带 grantTools → 照常委派(挡的是组合,不是 engine 本身)', async () => {
    withEngine();
    expect(await execute({ task: 't', engine: 'codex' }, ctxOf())).toBe('sub report');
    expect((spies.runSubAgent.mock.calls.at(-1) as any[])[0].engineId).toBe('codex');
    expect(lastGrants()).toBeUndefined();
  });

  it('负对照:同一份 grantTools、不带 engine → 照常授予(内置子代理这条路一字未变)', async () => {
    withEngine();
    expect(await execute({ task: 't', grantTools: ['manage_schedule'] }, ctxOf())).toBe('sub report');
    expect(lastGrants()).toEqual(['manage_schedule']);
  });
});
