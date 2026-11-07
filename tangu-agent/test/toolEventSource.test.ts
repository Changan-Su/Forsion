/**
 * 工具事件的 source(帮助改进 v2 契约 §7):tool_call / tool_result 的 payload 带 builtin | mcp | plugin。
 * Extend 只发 builtin / mcp 的工具名;plugin(插件 provider、自定义工具、认不出来的名字)的名字不外发 —— 所以认不出来的必须落 plugin。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { toolSourceOf, type ToolContext } from '../src/tools/registry.js';
import { registerToolProvider, unregisterToolProvider } from '../src/tools/toolRegistry.js';

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const profile = createTanguProfile({ sandboxMode: 'none' });
const ctx = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp' } as ToolContext;

beforeAll(() => {
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
  registerToolProvider({
    id: 'test:telemetry-plugin', origin: 'plugin',
    tools: () => [{ name: 'acme_secret_tool', mode: 'both', definition: { type: 'function', function: { name: 'acme_secret_tool', description: 'x', parameters: { type: 'object', properties: {} } } }, execute: async () => 'ok' } as any],
  });
});
afterAll(() => { unregisterToolProvider('test:telemetry-plugin'); });

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
