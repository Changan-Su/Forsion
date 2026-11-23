/**
 * 工具事件的 source(帮助改进 v2 契约 §7):tool_call / tool_result 的 payload 带 builtin | mcp | plugin。
 * Extend 只发 builtin / mcp 的工具名;plugin(插件 provider、自定义工具、认不出来的名字)的名字不外发 —— 所以认不出来的必须落 plugin。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { toolOriginOf, toolPluginOwnerOf, toolSourceOf, type ToolContext } from '../src/tools/registry.js';
import { registerToolProvider, unregisterToolProvider } from '../src/tools/toolRegistry.js';

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const profile = createTanguProfile({ sandboxMode: 'none' });
const ctx = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp' } as ToolContext;

beforeAll(() => {
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
  registerToolProvider({
    id: 'test:telemetry-plugin', origin: 'plugin', official: false, ownerPlugin: 'market-7d3f0c52-6a41-4c8e-9f0b-2e5d8a1c4b67',
    tools: () => [{ name: 'acme_secret_tool', mode: 'both', definition: { type: 'function', function: { name: 'acme_secret_tool', description: 'x', parameters: { type: 'object', properties: {} } } }, execute: async () => 'ok' } as any],
  });
  registerToolProvider({
    id: 'test:telemetry-official', origin: 'plugin', official: true, ownerPlugin: 'forsion-calendar',
    tools: () => [{ name: 'acme_official_tool', mode: 'both', definition: { type: 'function', function: { name: 'acme_official_tool', description: 'x', parameters: { type: 'object', properties: {} } } }, execute: async () => 'ok' } as any],
  });
});
afterAll(() => { unregisterToolProvider('test:telemetry-plugin'); unregisterToolProvider('test:telemetry-official'); });

describe('toolSourceOf', () => {
  it('内置工具 = builtin', () => {
    expect(toolSourceOf('read_file', ctx)).toBe('builtin');
    expect(toolSourceOf('remember', ctx)).toBe('builtin');
  });
  it('mcp__ 前缀 = mcp', () => {
    expect(toolSourceOf('mcp__github__create_issue', ctx)).toBe('mcp');
  });
  it('插件 provider 的工具 = plugin', () => {
    expect(toolSourceOf('acme_secret_tool', ctx)).toBe('plugin');
  });
  it('认不出来的名字(自定义工具 / 模型编的)= plugin,名字不外发', () => {
    expect(toolSourceOf('my_private_http_tool', ctx)).toBe('plugin');
  });
});

describe('toolOriginOf(遥测 v3:插件工具带主人)', () => {
  it('内置 / MCP 只有 source,不多出键', () => {
    expect(toolOriginOf('read_file', ctx)).toEqual({ source: 'builtin' });
    expect(toolOriginOf('mcp__github__create_issue', ctx)).toEqual({ source: 'mcp' });
  });
  it('插件 provider 的工具带 pluginId(注册它的插件 id,原样)与 pluginOfficial(宿主判定)', () => {
    expect(toolOriginOf('acme_secret_tool', ctx)).toEqual({ source: 'plugin', pluginId: 'market-7d3f0c52-6a41-4c8e-9f0b-2e5d8a1c4b67', pluginOfficial: false });
    expect(toolOriginOf('acme_official_tool', ctx)).toEqual({ source: 'plugin', pluginId: 'forsion-calendar', pluginOfficial: true });
    expect(toolPluginOwnerOf('acme_official_tool', ctx)).toEqual({ pluginId: 'forsion-calendar', pluginOfficial: true });
  });
  it('认不出主人的只有 source:plugin', () => {
    expect(toolOriginOf('my_private_http_tool', ctx)).toEqual({ source: 'plugin' });
    expect(toolPluginOwnerOf('my_private_http_tool', ctx)).toEqual({});
  });
});
