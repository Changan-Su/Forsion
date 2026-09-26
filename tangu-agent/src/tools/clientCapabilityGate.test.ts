/**
 * 客户端能力工具(ToolDef.clientCapability)中央闸的矩阵测试(toolRegistry.clientCapabilityAllowed + add())。
 *
 * 为什么是矩阵:这道闸出错全是软故障 —— 放松了,桌面 / Muse / 子代理 run 里模型就能调一个注定没人执行的
 * phone_*(然后说「已经帮你打开了」);收紧了,手机上能力静默消失。每一格都钉住。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { configureTangu } from '../seams/runtime.js';
import { createAiStudioProfile } from '../profiles/index.js';
import { getToolDefinitions, listDeferredTools, executeTool, type ToolContext } from './registry.js';
import { clientCapabilityAllowed, listLoadoutTools, registerToolProvider, resolveTools } from './toolRegistry.js';
import { makeClientActionRequester, resolveClientAction } from '../services/clientAck.js';
import type { AppProfile } from '../seams/appProfile.js';

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const cloud = createAiStudioProfile();
const PHONE = ['phone_open', 'phone_navigate', 'phone_compose', 'phone_system', 'phone_control'];

const fakeTool = (name: string, clientCapability?: string, deferred = false): any => ({
  name, mode: 'both', ...(clientCapability !== undefined ? { clientCapability } : {}), ...(deferred ? { deferred: true } : {}),
  definition: { type: 'function', function: { name, description: `test ${name}`, parameters: { type: 'object', properties: {} } } },
  execute: async () => 'ok',
});

beforeAll(() => {
  configureTangu({ host: stub, brain: stub, billing: stub, profile: cloud });
  // 插件来源的能力工具(与内置对等性)+ 前缀规则的反例 + 另一个 ns 的正例;另有一个无能力的插件工具作 chat 面对照。
  registerToolProvider({
    id: 'test:client-cap-plugin', origin: 'plugin',
    tools: () => [
      // deferred:让「带能力时常驻 defs 不变」那条只比内置面(夹具不进常驻 defs)。
      fakeTool('phone_plugin_extra', 'phone.intents', true),
      fakeTool('write_file_evil', 'phone.intents', true), // 名字不带 phone_ 前缀 → 永不可见
      fakeTool('camera_snap', 'camera.basic', true),
      fakeTool('phone_wrong_ns', 'camera.basic', true), // 能力 ns 与名字前缀不一致 → 永不可见
      fakeTool('plugin_plain_tool'),
    ],
  });
});

const base: ToolContext = { userId: 'u1', sessionId: 's1', appId: cloud.appId, profile: cloud, execMode: 'sandbox', unlockTools: () => {} };
const mobile: ToolContext = { ...base, client: 'mobile/2.12.0', clientCapabilities: ['phone.intents'] };
const visible = (ctx: ToolContext, profile: AppProfile = cloud): string[] => [...resolveTools(profile, ctx).keys()];
const catalog = (ctx: ToolContext): string[] => listDeferredTools(ctx).map((d) => d.name);

describe('clientCapabilityAllowed(纯判定)', () => {
  const t = { name: 'phone_open', clientCapability: 'phone.intents' };
  it('没声明能力的工具不受影响', () => {
    expect(clientCapabilityAllowed({ name: 'web_search' }, {})).toBe(true);
  });
  it('只有 mobile/* 放行', () => {
    for (const client of ['desktop/2.12.0', 'web/2.12.0', 'cli/1', 'tui/1', 'muse/1', 'automation/1', '', undefined]) {
      expect(clientCapabilityAllowed(t, { client, clientCapabilities: ['phone.intents'] }), String(client)).toBe(false);
    }
    expect(clientCapabilityAllowed(t, { client: 'mobile/1', clientCapabilities: ['phone.intents'] })).toBe(true);
  });
  it('能力未声明 / 别的能力 / 空数组 → 拒', () => {
    for (const caps of [undefined, [], ['phone.ui'], ['phone.intents2']]) {
      expect(clientCapabilityAllowed(t, { client: 'mobile/1', clientCapabilities: caps })).toBe(false);
    }
  });
  it('子代理 / 计划模式 / 通道会话 / 讨论成员 → 拒', () => {
    const ok = { client: 'mobile/1', clientCapabilities: ['phone.intents'] };
    expect(clientCapabilityAllowed(t, { ...ok, subAgentDepth: 1 })).toBe(false);
    expect(clientCapabilityAllowed(t, { ...ok, planMode: true })).toBe(false);
    expect(clientCapabilityAllowed(t, { ...ok, channelSession: true })).toBe(false);
    expect(clientCapabilityAllowed(t, { ...ok, inDiscussion: true })).toBe(false);
    expect(clientCapabilityAllowed(t, { ...ok, subAgentDepth: 0 })).toBe(true);
  });
  it('前缀规则:工具名必须以 <ns>_ 开头;空能力 / 非字符串能力 fail closed', () => {
    const ok = { client: 'mobile/1', clientCapabilities: ['phone.intents', 'camera.basic'] };
    expect(clientCapabilityAllowed({ name: 'write_file', clientCapability: 'phone.intents' }, ok)).toBe(false);
    expect(clientCapabilityAllowed({ name: 'phoneopen', clientCapability: 'phone.intents' }, ok)).toBe(false);
    expect(clientCapabilityAllowed({ name: 'phone_x', clientCapability: 'camera.basic' }, ok)).toBe(false);
    expect(clientCapabilityAllowed({ name: 'camera_x', clientCapability: 'camera.basic' }, ok)).toBe(true);
    expect(clientCapabilityAllowed({ name: 'phone_x', clientCapability: '' }, ok)).toBe(false);
    expect(clientCapabilityAllowed({ name: 'phone_x', clientCapability: null as any }, ok)).toBe(false);
  });
});

describe('resolveTools × 预设 × 来源', () => {
  it('手机端 + 能力:五个内置 phone_* 在目录里(deferred),常驻 defs 与不带能力时逐字节相同', () => {
    for (const preset of [undefined, 'chat', 'coding'] as const) {
      const ctx = { ...mobile, preset };
      const cat = catalog(ctx);
      for (const n of PHONE) expect(cat, `${preset}:${n}`).toContain(n);
      // defs 不变:能力只多出目录行(前缀缓存对老客户端 / 没开开关的手机零影响)
      expect(JSON.stringify(getToolDefinitions(ctx)), String(preset)).toBe(JSON.stringify(getToolDefinitions({ ...base, client: 'mobile/2.12.0', preset })));
    }
  });

  it('每个工具目录一行、带自己的短 hint', () => {
    const lines = listDeferredTools(mobile).filter((d) => PHONE.includes(d.name));
    expect(lines.map((d) => d.name).sort()).toEqual([...PHONE].sort());
    for (const d of lines) {
      expect(d.hint.length, d.name).toBeLessThanOrEqual(100);
      expect(d.group).toBe('phone');
    }
    expect(new Set(lines.map((d) => d.hint)).size).toBe(PHONE.length);
  });

  it('负对照:无能力 / 桌面端带能力 / web 端带能力 / Muse → 一个 phone_* 都没有', () => {
    for (const ctx of [
      { ...base, client: 'mobile/2.12.0' },
      { ...base, client: 'desktop/2.12.0', clientCapabilities: ['phone.intents'] },
      { ...base, client: 'web/2.12.0', clientCapabilities: ['phone.intents'] },
      { ...base, client: 'muse/1', clientCapabilities: ['phone.intents'], muse: true },
      { ...mobile, subAgentDepth: 1 },
      { ...mobile, planMode: true },
      { ...mobile, channelSession: true },
      { ...mobile, inDiscussion: true },
    ] as ToolContext[]) {
      const v = visible(ctx);
      expect(v.filter((n) => n.startsWith('phone_')), JSON.stringify({ c: ctx.client, s: ctx.subAgentDepth, p: ctx.planMode, ch: ctx.channelSession, d: ctx.inDiscussion })).toEqual([]);
    }
  });

  it('插件来源的能力工具与内置等价:chat 面照样放行;无能力的插件工具在 chat 面仍被拒(例外只按能力)', () => {
    const chat = { ...mobile, preset: 'chat' as const };
    const v = visible(chat);
    expect(v).toContain('phone_plugin_extra');
    expect(v).not.toContain('plugin_plain_tool');
    expect(visible({ ...base, preset: 'chat' })).not.toContain('phone_plugin_extra');
    // work 面同样可见(对照:例外不是 chat 专属的后门)
    expect(visible(mobile)).toContain('phone_plugin_extra');
  });

  it('前缀规则在 add() 里生效:挂了能力但名字不带前缀 / ns 不一致的工具永不可见', () => {
    const ctx = { ...mobile, clientCapabilities: ['camera.basic', 'phone.intents'] };
    const v = visible(ctx);
    expect(v).not.toContain('write_file_evil');
    expect(v).not.toContain('phone_wrong_ns');
    expect(v).toContain('camera_snap');
    expect(visible(mobile)).not.toContain('camera_snap'); // 没声明 camera.basic
  });

  it('部署级内置白名单不是 all:phone_* 必须逐个列进去(列了才有,load_tools 自动补上)', () => {
    const listed = { ...cloud, toolLoadout: { ...cloud.toolLoadout, builtins: ['get_datetime', ...PHONE] } } as AppProfile;
    const unlisted = { ...cloud, toolLoadout: { ...cloud.toolLoadout, builtins: ['get_datetime'] } } as AppProfile;
    const withProfile = (p: AppProfile): ToolContext => ({ ...mobile, profile: p });
    expect(visible(withProfile(unlisted), unlisted).filter((n) => PHONE.includes(n))).toEqual([]);
    const v = visible(withProfile(listed), listed);
    for (const n of PHONE) expect(v).toContain(n);
    expect(v).toContain('load_tools');
  });

  it('门禁工具口径:tools_mode allow 名单不列 phone_* 也不砍它们;agent 编辑器的勾选目录里没有 phone_*', () => {
    const v = visible({ ...mobile, toolsMode: 'allow', toolsList: ['web_search'] });
    for (const n of PHONE) expect(v).toContain(n);
    expect(listLoadoutTools().map((t) => t.name).filter((n) => n.startsWith('phone_'))).toEqual([]);
  });

  it('执行侧同源:闸拒时按名硬调也是 not available,且不会发出任何东西', async () => {
    const r = await executeTool({ id: 'c', type: 'function', function: { name: 'phone_open', arguments: '{"app":"Maps"}' } } as any,
      { ...base, client: 'desktop/2.12.0', clientCapabilities: ['phone.intents'] });
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/not available in this session/);
  });
});

/**
 * requestClientAction 按工具收窄(Codex P2):agentLoop 按 run 装配一份,只判「本 run 声明过哪些能力」。
 * 不收窄的话,同 run 里没声明 clientCapability 的插件工具直调它就绕过了中央闸。
 * ⚠️ run 同时声明 phone.intents 与 camera.basic:只声明一个的话,run 级闭包自己就会把别的 ns 判 undeclared,
 *    收窄删掉了本组照样绿(负对照失效)。
 */
describe('requestClientAction 按工具收窄(registry.executeTool)', () => {
  const RUN_CAPS = ['phone.intents', 'camera.basic'];
  const events: Array<{ runId: string; type: string; payload: any }> = [];
  const seenInExecute: Array<{ tool: string; has: boolean }> = [];
  const seenInEnabledFor: boolean[] = [];
  const ac = new AbortController();
  const runRequester = makeClientActionRequester({ runId: 'rp', sessionId: 's1', caps: RUN_CAPS, runSignal: ac.signal });
  const runCtx: ToolContext = {
    ...base, client: 'mobile/2.12.0', clientCapabilities: RUN_CAPS, runId: 'rp', signal: ac.signal, requestClientAction: runRequester,
  };
  const probe = (name: string, clientCapability?: string): any => ({
    ...fakeTool(name, clientCapability, true),
    isEnabledFor: (_p: AppProfile, ctx: ToolContext) => { seenInEnabledFor.push(!!ctx.requestClientAction); return true; },
    execute: async (args: Record<string, any>, ctx: ToolContext) => {
      seenInExecute.push({ tool: name, has: !!ctx.requestClientAction });
      if (!ctx.requestClientAction) return 'no-requester';
      return JSON.stringify(await ctx.requestClientAction({ ns: String(args.ns), op: 'torch', args: { on: true } }));
    },
  });
  const call = async (name: string, ns: string) =>
    (await executeTool({ id: 'c', type: 'function', function: { name, arguments: JSON.stringify({ ns }) } } as any, runCtx)).result;
  const clientCmds = () => events.filter((e) => e.type === 'client_cmd');

  beforeAll(() => {
    registerToolProvider({ id: 'test:client-cap-probe', origin: 'plugin', tools: () => [probe('probe_plain'), probe('phone_probe', 'phone.intents')] });
    // 假手机:收到 client_cmd 就 claim + 回 ok(只有真发出去的动作才会走到这里)。
    const fakeState = new Proxy({
      appendEvent: async (runId: string, type: string, payload: any) => {
        events.push({ runId, type, payload });
        if (type === 'client_cmd') {
          setTimeout(() => {
            const c = resolveClientAction(runId, payload.ackId, { phase: 'claim', digest: createHash('sha256').update(payload.body, 'utf8').digest('hex') }) as any;
            resolveClientAction(runId, payload.ackId, { phase: 'result', nonce: c.nonce, result: { ok: true, verified: true } });
          }, 1);
        }
        return events.length;
      },
    } as Record<string, any>, { get: (t, k) => (k in t ? t[k as string] : () => { throw new Error(`stub state.${String(k)}`); }) });
    configureTangu({ host: stub, brain: stub, billing: stub, profile: cloud, state: fakeState });
  });
  afterAll(() => {
    ac.abort();
    configureTangu({ host: stub, brain: stub, billing: stub, profile: cloud });
  });

  it('没声明 clientCapability 的工具拿不到 requestClientAction,手机上什么都不发', async () => {
    expect(visible(runCtx)).toContain('probe_plain');
    expect(await call('probe_plain', 'phone')).toBe('no-requester');
    expect(seenInExecute.at(-1)).toEqual({ tool: 'probe_plain', has: false });
    expect(clientCmds()).toHaveLength(0);
    expect(runCtx.requestClientAction).toBe(runRequester); // run 级 ctx 没被改写(收窄只作用于这一次调用的拷贝)
  });

  it('phone.intents 的工具:能发 ns phone,不能发 ns camera(即使本 run 声明了 camera.basic)', async () => {
    const denied = JSON.parse(await call('phone_probe', 'camera'));
    expect(denied).toMatchObject({ ok: false, code: 'undeclared' });
    expect(denied.error).toMatch(/only declared the "phone" client capability[^]*Nothing was sent/);
    expect(clientCmds()).toHaveLength(0);

    expect(JSON.parse(await call('phone_probe', 'phone'))).toEqual({ ok: true, verified: true });
    expect(clientCmds()).toHaveLength(1);
    expect(clientCmds()[0].payload.ns).toBe('phone');
    expect(seenInExecute.filter((s) => s.tool === 'phone_probe').every((s) => s.has)).toBe(true);
  });

  it('isEnabledFor 里一律拿不到(插件不能在可见性判定里存下 run 级闭包再直调)', () => {
    seenInEnabledFor.length = 0;
    visible(runCtx);
    expect(seenInEnabledFor.length).toBeGreaterThan(0);
    expect(seenInEnabledFor.every((has) => !has)).toBe(true);
  });
});
