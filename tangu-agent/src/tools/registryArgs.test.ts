import { describe, expect, it, vi } from 'vitest';
import { createTanguProfile } from '../profiles/tangu.js';
import type { ToolContext } from './toolTypes.js';

vi.mock('../services/checkpoints.js', () => ({ snapshotBeforeWrite: vi.fn(async () => null), recordPostWrite: vi.fn() }));
vi.mock('../services/userActivity.js', () => ({ appendActivityLine: vi.fn() }));
import { closeToolNames, executeTool } from './registry.js';

function context(execute: (args: any) => string): ToolContext {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  profile.toolLoadout.providers = [{ id: 'args-test', tools: () => [{
    name: 'write_file', mode: 'host', capabilities: { sideEffect: 'read' },
    definition: { type: 'function', function: { name: 'write_file', description: '', parameters: {} } }, execute,
  }] }];
  return { userId: 'u', appId: 'tangu', sessionId: 's', runId: 'r', cwd: '/tmp', execMode: 'host',
    profile, hostSandbox: { mode: 'off', network: 'deny' } } as ToolContext;
}
const call = (args: string, name = 'write_file') => ({ id: 'c1', type: 'function' as const, function: { name, arguments: args } });

describe('tool arguments are never silently replaced (R4)', () => {
  it('invalid JSON → error, tool not executed', async () => {
    const execute = vi.fn(() => 'ran');
    const r = await executeTool(call('{"path":"a.txt", "content": "x'), context(execute));
    expect(execute).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/not valid JSON[\s\S]*Nothing was executed/);
  });

  it('non-object JSON → error; null and empty → {}', async () => {
    const execute = vi.fn((args: any) => `ok:${JSON.stringify(args)}`);
    expect((await executeTool(call('["a"]'), context(execute))).result).toMatch(/must be a JSON object/);
    expect(execute).not.toHaveBeenCalled();
    expect((await executeTool(call('null'), context(execute))).result).toBe('ok:{}');
    expect((await executeTool(call(''), context(execute))).result).toBe('ok:{}');
  });

  it('unknown tool names suggest close matches', async () => {
    const r = await executeTool(call('{}', 'WriteFile'), context(() => 'ran'));
    expect(r.isError).toBe(true);
    expect(r.result).toContain('Did you mean "write_file"?');
    expect(closeToolNames('bash', ['run_bash', 'read_file', 'web_search'])).toEqual(['run_bash']);
    expect(closeToolNames('zz', ['run_bash'])).toEqual([]);
    expect(closeToolNames('totally_unrelated', ['run_bash', 'read_file'])).toEqual([]);
  });
});

describe.runIf(process.platform === 'darwin')('direct application activation in host shell tools', () => {
  it.each(['run_bash', 'run_background'])('routes %s only when Computer Use is available', async (name) => {
    const execute = vi.fn(() => 'shell ran');
    const ctx = context(execute);
    ctx.profile!.toolLoadout.providers = [{ id: 'route-test', tools: () => [name, 'act_ui'].map(tool => ({
      name: tool, mode: 'host' as const,
      capabilities: { sideEffect: 'read' as const, concurrencyKey: tool === 'act_ui' ? 'computer-use' : undefined },
      definition: { type: 'function' as const, function: { name: tool, description: '', parameters: {} } }, execute,
    })) }];
    const activate = call(JSON.stringify({ command: 'if true; then open /Applications/Music.app; fi' }), name);
    expect((await executeTool(activate, ctx)).result).toContain('Use ensure_app');
    expect(execute).not.toHaveBeenCalled();
    const inspect = call(JSON.stringify({ command: 'echo "open -a Music"' }), name);
    expect((await executeTool(inspect, ctx)).result).toBe('shell ran');
    ctx.computerUseUnavailable = 'no-image-input';
    expect((await executeTool(activate, ctx)).result).toBe('shell ran');
  });
});
