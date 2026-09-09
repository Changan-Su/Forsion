import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from './toolTypes.js';
import { createTanguProfile } from '../profiles/tangu.js';
const effects = vi.hoisted(() => ({ execute: vi.fn(), snapshot: vi.fn(), custom: vi.fn(), mcp: vi.fn() }));
vi.mock('../core/config.js', () => ({ configExists: () => true, loadRawConfig: () => ({ hostSandbox: { mode: 'read-only', network: 'deny' } }), getRawSection: () => undefined }));
vi.mock('./hostExec.js', () => ({ hostExecProvider: {
  id: 'builtin:host-exec', tools: () => ['read_file', 'write_file'].map(name => ({
    name, mode: 'host', definition: { type: 'function', function: { name, parameters: {}, description: '' } },
    execute: effects.execute,
  })),
} }));
vi.mock('../services/checkpoints.js', () => ({ snapshotBeforeWrite: effects.snapshot, recordPostWrite: vi.fn() }));
vi.mock('../services/userActivity.js', () => ({ appendActivityLine: vi.fn() }));
import { executeTool, getToolDefinitions } from './registry.js';

const call = (name: string) => ({ id: name, type: 'function' as const, function: { name, arguments: '{"path":"test.txt","content":"test"}' } });
const context = (): ToolContext => ({
  userId: 'u', appId: 'tangu', sessionId: 's', runId: 'r', cwd: '/tmp', execMode: 'host',
  profile: createTanguProfile({ sandboxMode: 'none' }),
  customTools: new Map([['custom_escape', { name: 'custom_escape', execute: effects.custom }], ['read_file', { name: 'read_file', execute: effects.custom }]]) as any,
  mcpTools: new Map([['mcp_escape', { name: 'mcp_escape', execute: effects.mcp }]]) as any,
} as ToolContext);

beforeEach(() => { vi.clearAllMocks(); effects.execute.mockReturnValue('Error: writes denied by sandbox'); });
describe('sandbox at the shared execution boundary', () => {
  it('injects trusted policy into legacy callers and skips unbrokered checkpoint writes', async () => {
    await executeTool(call('write_file'), context());
    expect(effects.execute).toHaveBeenCalledOnce();
    expect(effects.execute.mock.calls[0][1].hostSandbox).toEqual({ mode: 'read-only', network: 'deny' });
    expect(effects.snapshot).not.toHaveBeenCalled();
  });
  it('hides and rejects custom/MCP entry points, including same-name overrides', async () => {
    const ctx = context();
    const names = getToolDefinitions(ctx).map(d => d.function.name);
    expect(names).not.toContain('custom_escape');
    expect(names).not.toContain('mcp_escape');
    for (const name of ['custom_escape', 'mcp_escape', 'apply_patch']) expect((await executeTool(call(name), ctx)).isError).toBe(true);
    await executeTool(call('read_file'), ctx);
    expect(effects.custom).not.toHaveBeenCalled();
    expect(effects.mcp).not.toHaveBeenCalled();
    expect(effects.execute).toHaveBeenCalledOnce();
  });
});
