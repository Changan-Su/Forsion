/**
 * 会话设置「不开子会话」(插件开发优化方案 2026-11-23 第四节 A)与计划模式拿掉 delegate 的工具门控:
 *  - noChildSessions 开着:start_session、delegate 不进工具表(defs / 目录 / 按名解析同一处,模型看不到也调不到);别的工具不动
 *  - 计划模式:delegate 不再可见(之前在白名单里);Muse 例外 —— 它的周期跑在计划模式里,提示让它 delegate 给 escalateTo
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/tools/noChildSessions.test.ts
 */
import { describe, it, expect } from 'vitest';
import { registerToolProvider, resolveTools, CHILD_SESSION_TOOLS, type ToolDef } from './toolRegistry.js';
import type { ToolContext } from './toolTypes.js';
import type { AppProfile } from '../seams/appProfile.js';

const mk = (name: string): ToolDef => ({
  name,
  definition: { type: 'function', function: { name, description: `${name} desc`, parameters: {} } },
  execute: () => '',
});
registerToolProvider({ id: 'test:nochild', tools: () => [mk('start_session'), mk('delegate'), mk('read_file'), mk('send_to_session'), mk('exit_plan_mode')] });
const profile = { toolLoadout: { builtins: 'all', providers: [] } } as unknown as AppProfile;
const ctx = (over?: Partial<ToolContext>): ToolContext => ({ userId: 'u', sessionId: 's', appId: 'a', ...over }) as ToolContext;
const names = (over?: Partial<ToolContext>): string[] => [...resolveTools(profile, ctx(over)).keys()];

describe('不开子会话', () => {
  it('缺省允许:两个工具都在', () => {
    expect(names()).toEqual(expect.arrayContaining(['start_session', 'delegate']));
  });
  it('开着:只拿掉 start_session 和 delegate', () => {
    expect([...CHILD_SESSION_TOOLS].sort()).toEqual(['delegate', 'start_session']);
    expect(names({ noChildSessions: true })).toEqual(['read_file', 'send_to_session', 'exit_plan_mode']);
  });
});

describe('计划模式', () => {
  it('delegate 不可见(start_session 本来就不在)', () => {
    const n = names({ planMode: true });
    expect(n).not.toContain('delegate');
    expect(n).not.toContain('start_session');
    expect(n).toContain('read_file');
  });
  it('Muse 的计划模式周期照旧能 delegate;「不开子会话」开着时 Muse 也拿不到', () => {
    expect(names({ planMode: true, muse: true } as Partial<ToolContext>)).toContain('delegate');
    expect(names({ planMode: true, muse: true, noChildSessions: true } as Partial<ToolContext>)).not.toContain('delegate');
  });
});
