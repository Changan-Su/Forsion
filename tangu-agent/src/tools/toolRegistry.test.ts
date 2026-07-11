/**
 * resolveTools 的每-agent 内置工具黑白名单(tools_mode/tools_list)+ listLoadoutTools 目录范围。
 * 铁律:名单只约束「无门禁、非豁免」的内置工具——门禁工具/exit_plan_mode/ask_user/非内置(MCP/app)
 * 一律不受名单影响(allow 模式不得饿死 Muse/inbox 系)。
 */
import { describe, it, expect } from 'vitest';
import { registerToolProvider, resolveTools, listLoadoutTools, type ToolDef, type ToolProvider } from './toolRegistry.js';
import type { ToolContext } from './toolTypes.js';
import type { AppProfile } from '../seams/appProfile.js';

const mk = (name: string, extra?: Partial<ToolDef>): ToolDef => ({
  name,
  definition: { type: 'function', function: { name, description: `${name} desc`, parameters: {} } },
  execute: () => '',
  ...extra,
});

// 本文件独立模块环境(vitest isolate):注册假 provider 不污染其他测试
registerToolProvider({
  id: 'test:loadout',
  tools: () => [
    mk('plain_a'),
    mk('plain_b'),
    mk('gated_x', { isEnabledFor: () => true }),
    mk('exit_plan_mode'),
  ],
});

const appProvider: ToolProvider = { id: 'test:app', tools: () => [mk('app_tool')] };
const profile = (withApp = false): AppProfile =>
  ({ toolLoadout: { builtins: 'all', providers: withApp ? [appProvider] : [] } }) as unknown as AppProfile;
const ctx = (over?: Partial<ToolContext>): ToolContext =>
  ({ userId: 'u', sessionId: 's', appId: 'a', ...over }) as ToolContext;

describe('resolveTools tools_mode/tools_list', () => {
  it('无名单:全部可见', () => {
    const names = [...resolveTools(profile(), ctx()).keys()];
    expect(names).toEqual(['plain_a', 'plain_b', 'gated_x', 'exit_plan_mode']);
  });

  it('deny:名单内的普通工具被砍,其余保留', () => {
    const names = [...resolveTools(profile(), ctx({ toolsMode: 'deny', toolsList: ['plain_a'] })).keys()];
    expect(names).toEqual(['plain_b', 'gated_x', 'exit_plan_mode']);
  });

  it('allow:仅名单内的普通工具保留;门禁/豁免工具不受影响(空名单不饿死它们)', () => {
    const names = [...resolveTools(profile(), ctx({ toolsMode: 'allow', toolsList: [] })).keys()];
    expect(names).toEqual(['gated_x', 'exit_plan_mode']);
    const names2 = [...resolveTools(profile(), ctx({ toolsMode: 'allow', toolsList: ['plain_b'] })).keys()];
    expect(names2).toEqual(['plain_b', 'gated_x', 'exit_plan_mode']);
  });

  it('deny 砍不动门禁与豁免工具;非内置(app/MCP)工具不受 allow 约束', () => {
    const names = [...resolveTools(profile(true), ctx({ toolsMode: 'deny', toolsList: ['gated_x', 'exit_plan_mode', 'app_tool'] })).keys()];
    expect(names).toContain('gated_x');
    expect(names).toContain('exit_plan_mode');
    expect(names).toContain('app_tool');
    const allowNames = [...resolveTools(profile(true), ctx({ toolsMode: 'allow', toolsList: [] })).keys()];
    expect(allowNames).toContain('app_tool');
  });
});

describe('listLoadoutTools', () => {
  it('目录=无门禁、非豁免的内置工具(与名单约束范围严格一致)', () => {
    const names = listLoadoutTools().map((t) => t.name);
    expect(names).toEqual(['plain_a', 'plain_b']);
    expect(listLoadoutTools()[0].description).toBe('plain_a desc');
  });
});
