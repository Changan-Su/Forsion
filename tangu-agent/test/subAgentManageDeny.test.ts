/**
 * 子代理(subAgentDepth ≥ 1)× 管理面(manage_agent / manage_skill / manage_automation /
 * manage_schedule / manage_harness):**共享策略层**的闸,而不是「只藏不拦」。
 *
 * 此前只有三道「藏」的闸(目录段不列 / seed 拷贝剔除 / unlockTools 回调拒),全都在 subAgent.ts 里,
 * 而 executeTool 按名字从完整 registry 解析、根本不查 unlockedTools —— 子代理直接吐一个
 * `manage_schedule` 调用就执行了(sandbox/full-auto 下无人拦);更直接的是 Muse / 自动化父 run 的
 * 标志会被子代理继承,deferBypass 把整族管理工具**直接放进子代理首轮 defs**。
 *
 * ── 策略:**缺省拒 + 委派时由父代理逐次授予**(ctx.subAgentGrants,经 delegate 的 grantTools)。──
 * 本块钉四条不变量,三种父上下文(普通 / muse / automationOrigin)各测一遍:
 *   ① 缺省可见性:**无授予**时,depth≥1 五个名字既不在 defs、也不在「Additional Tools」目录里
 *      (deferBypass 也不例外);
 *   ② 缺省执行:直接 executeTool 这五个名字(外加旧别名 muse_watch)一律被拒,措辞是
 *      "unavailable to sub-agents",且拒绝**早于任何审批闸门**;
 *   ③ 授予后放行**且只放行被点名的那一个**:grants={manage_schedule} 时它可达、直调不再撞那句拒绝,
 *      另外四个照旧被拒 —— 授予不是「把整族打开」。旧别名同理:授 manage_automation,muse_watch 也通;
 *   ④ 授予**只抬这一道闸**:execMode='sandbox' 下授 manage_agent(mode:'host')依然不可达 ——
 *      拿到的是「工具不存在于本会话」那句,而不是子代理拒绝语。被授权的子代理不会比父代理更强。
 * 非空转前提:同形状 ctx 在 depth 0 下这五个都真的可达(否则断言的是别的门禁,不是本闸)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { getToolDefinitions, listDeferredTools, executeTool } from '../src/tools/registry.js';
import { canonicalToolName } from '../src/tools/toolRegistry.js';
import { SUB_AGENT_DENY_TOOLS, SUB_AGENT_GRANTABLE_TOOLS } from '../src/tools/toolRegistry.js';
import type { ToolContext } from '../src/tools/registry.js';

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const profile = createTanguProfile({ sandboxMode: 'none' });

/** 五个管理面工具。写死名字(不从 SUB_AGENT_DENY_TOOLS 读):名单被误删一项时本块必须红。 */
const MANAGE_TOOLS = ['manage_agent', 'manage_skill', 'manage_automation', 'manage_schedule', 'manage_harness'];

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-subdeny-'));
  process.env.TANGU_HOME = home; // depth 0 的执行对照会摸家目录(getAgent 等),隔离到临时目录
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

// execMode='host' + hostExec profile:manage_agent/manage_skill/manage_harness 是 mode:'host',
// 换成 sandbox 它们本就不可见,depth 1 的「不可见」会变成空真的。
const base = {
  userId: 'u1', sessionId: 's1', appId: 'tangu', profile,
  execMode: 'host' as const, cwd: '/tmp', approvalMode: 'full-auto' as const,
  unlockTools: () => {},
};

/** 三种父上下文。muse 档必须 full-auto:manage_automation 自己的 isEnabledFor 会把
 *  ask/agent 档的 Muse 挡掉,那样测的就不是本硬闸了。 */
const PARENTS: Array<[string, Partial<ToolContext>]> = [
  ['普通 run', {}],
  ['muse run', { muse: true, approvalMode: 'full-auto' }],
  ['automation run', { automationOrigin: 'rule-1' }],
];

/** 本 ctx 下模型**能知道**这个工具存在的两条路:常驻 defs ∪ 「Additional Tools」目录。 */
function reachable(ctx: ToolContext): Set<string> {
  return new Set<string>([
    ...getToolDefinitions(ctx).map((t: any) => t.function?.name),
    ...listDeferredTools(ctx).map((d) => d.name),
  ]);
}

const callOf = (name: string) => ({ id: 'c1', type: 'function', function: { name, arguments: '{}' } }) as any;

describe('子代理硬闸:管理面既不可见也不可执行', () => {
  for (const [label, extra] of PARENTS) {
    it(`${label}:depth 0 五个都可达,depth 1 全部消失(defs + 目录)`, () => {
      const parent = { ...base, ...extra } as ToolContext;
      const sub = { ...parent, subAgentDepth: 1 } as ToolContext;
      const at0 = reachable(parent);
      const at1 = reachable(sub);
      for (const n of MANAGE_TOOLS) {
        expect(at0.has(n), `${n} 在 depth 0 就不可达 → 本条空转(是别的门禁滤掉的,不是子代理硬闸)`).toBe(true);
        expect(at1.has(n), `${n} 不该对子代理可达(defs 或目录任一处出现都算漏)`).toBe(false);
      }
      // 正对照:能力面照旧(硬闸只砍管理族,不是把子代理的 deferred 面整片端了)。
      expect(listDeferredTools(sub).length, '子代理的按需目录不该被清空').toBeGreaterThan(0);
    });

    it(`${label}:depth 1 直接调五个管理工具 → 一律 "unavailable to sub-agents"`, async () => {
      const sub = { ...base, ...extra, subAgentDepth: 1 } as ToolContext;
      for (const n of MANAGE_TOOLS) {
        const r = await executeTool(callOf(n), sub);
        expect(r.isError, `${n} 必须以错误收场`).toBe(true);
        expect(r.result, `${n} 的拒绝措辞要说清是子代理的问题,不是「工具不存在」`).toMatch(/unavailable to sub-agents/i);
      }
      // 旧别名 muse_watch:executeTool 归一成 manage_automation 之后仍命中硬闸。
      const alias = await executeTool(callOf('muse_watch'), sub);
      expect(alias.isError).toBe(true);
      expect(alias.result).toMatch(/unavailable to sub-agents/i);
    });

    it(`${label}:父代理授予 manage_schedule → 它可达且可执行,另外四个照旧被拒`, async () => {
      const granted = { ...base, ...extra, subAgentDepth: 1, subAgentGrants: new Set(['manage_schedule']) } as ToolContext;
      // ① 可见:授予项进得了子代理的工具面(defs 或目录任一处 —— 真实委派里它走预解锁那条进 defs)。
      expect(reachable(granted).has('manage_schedule'), '被授予的工具必须对子代理可达,否则「授予」只是句空话').toBe(true);
      // ② 可执行:空参 → 走 manage_schedule 自己的「未知 action」路径,而**不是**子代理拒绝语。
      const ok = await executeTool(callOf('manage_schedule'), granted);
      expect(ok.result, '授予过的工具不该再撞子代理硬闸').not.toMatch(/unavailable to sub-agents/i);
      // ③ 授予是**逐个**的,不是把整族打开 —— 没点名的四个一字未松。
      for (const n of MANAGE_TOOLS.filter((x) => x !== 'manage_schedule')) {
        expect(reachable(granted).has(n), `${n} 没被授予,不该跟着一起开`).toBe(false);
        const r = await executeTool(callOf(n), granted);
        expect(r.isError).toBe(true);
        expect(r.result, `${n} 没被授予,必须照旧拒绝`).toMatch(/unavailable to sub-agents/i);
      }
    });

    it(`${label}:授予 manage_automation 后,旧别名 muse_watch 也一并放行(判定先归一)`, async () => {
      const granted = { ...base, ...extra, subAgentDepth: 1, subAgentGrants: new Set(['manage_automation']) } as ToolContext;
      const alias = await executeTool(callOf('muse_watch'), granted);
      expect(alias.result, '授的是正典名,模型写旧别名不该被判成未授予').not.toMatch(/unavailable to sub-agents/i);
      // 正典名本身自然也通(否则上面那条可能是因为别名路径整个坏掉而假绿)。
      const canonical = await executeTool(callOf('manage_automation'), granted);
      expect(canonical.result).not.toMatch(/unavailable to sub-agents/i);
    });
  }

  it('授予只抬**这一道**闸:sandbox 形态下授 manage_agent(host-only)依然不可达', async () => {
    // 不变量「被授权的子代理永远不会比父代理更强」的最小反证:manage_agent 是 mode:'host',
    // execMode='sandbox' 时 resolveTools 本就不给 —— 授予不该把它变出来。
    const sub = { ...base, execMode: 'sandbox' as const, subAgentDepth: 1, subAgentGrants: new Set(['manage_agent']) } as ToolContext;
    expect(reachable(sub).has('manage_agent'), '授予不得绕过 mode 域过滤').toBe(false);
    const r = await executeTool(callOf('manage_agent'), sub);
    expect(r.isError).toBe(true);
    // 拿到的是「本会话没有这个工具」,而不是子代理拒绝语 —— 说明它死在另一道闸上,不是本闸放行后又被本闸拦。
    expect(r.result).toMatch(/is not available in this session/i);
    expect(r.result).not.toMatch(/unavailable to sub-agents/i);
  });

  it('两份名单不许漂移:可授予清单 ≡ 五个管理工具,且每一项都在 deny 名单里', () => {
    // 新加第六个 manage_* 时最容易只改一处:只进 DENY → 父代理永远授不出去(delegate 的 enum 里没有);
    // 只进 GRANTABLE → 它压根不是被拦的工具,「授予」是句空话。两份名单必须同进同出。
    expect([...SUB_AGENT_GRANTABLE_TOOLS].sort()).toEqual([...MANAGE_TOOLS].sort());
    for (const n of SUB_AGENT_GRANTABLE_TOOLS) {
      expect(SUB_AGENT_DENY_TOOLS.has(n), `${n} 可授予却不在 deny 名单里 —— 授予它没有任何意义`).toBe(true);
    }
    // 别名不进可授予清单:它是 delegate 的 enum 真源,给模型两种拼写只会制造歧义(归一在校验层做)。
    expect(SUB_AGENT_GRANTABLE_TOOLS).not.toContain('muse_watch');
  });

  it('负对照 · depth 0:同样的直调不会撞上这句拒绝(硬闸只对子代理生效)', async () => {
    const parent = { ...base } as ToolContext;
    for (const n of MANAGE_TOOLS) {
      const r = await executeTool(callOf(n), parent); // 空参:各工具走自己的 "Error: 未知 action" 路径,无副作用
      expect(r.result, `${n} 在主 loop 里不该被当成子代理拒掉`).not.toMatch(/unavailable to sub-agents/i);
    }
  });
});

/** 别名表是普通对象:模型硬调一个叫 constructor / toString / __proto__ 的工具名,`ALIASES[name]` 会沿原型链
 *  取到函数或对象,下游 `name.startsWith` 直接 TypeError 掀翻整轮(Codex 09-15 #5)。归一必须 Object.hasOwn。 */
describe('别名表不吃原型链上的键', () => {
  it('canonicalToolName 对 constructor / toString / __proto__ / hasOwnProperty 原样返回字符串', () => {
    for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(canonicalToolName(n)).toBe(n);
    expect(canonicalToolName('muse_watch'), '正对照:真别名照常归一').toBe('manage_automation');
  });

  it('模型硬调名为 constructor / __proto__ 的工具:executeTool 以「未知工具」错误收场,不抛 TypeError', async () => {
    const sub = { ...base, subAgentDepth: 1 } as ToolContext;
    for (const n of ['constructor', '__proto__']) {
      const r = await executeTool(callOf(n), sub);
      expect(r.isError, n).toBe(true);
      expect(r.result, n).not.toMatch(/unavailable to sub-agents/i);
    }
  });
});
