import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { executeTool, getToolDefinitions, listDeferredTools } from '../src/tools/registry.js';
import { registerToolProvider, resolveTools, listToolProviders, listLoadoutTools, declaredApproval, declaredAutomationSafe, declaredPersistPlaceholder } from '../src/tools/toolRegistry.js';
import { buildOpenAiCompatPayload, streamOpenAiCompat } from '../src/llm/openaiCompat.js';
import { createHttpBrain } from '../src/adapters/standalone/httpBrain.js';

const definition = (name: string) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const tool = (name: string, extra: any = {}) => ({ name, definition: definition(name), execute: vi.fn(() => 'ok'), ...extra });
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
function context(tools: any[]) {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  profile.toolLoadout = { builtins: [], providers: [{ id: 'fixture:app', tools: () => tools }] };
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
  return { profile, userId: 'u', sessionId: 's', appId: profile.appId, execMode: 'host', unlockTools: () => {} } as any;
}

afterEach(() => vi.restoreAllMocks());

describe('invalid tool definitions do not poison a request', () => {
  it('tools[40] missing definition is omitted without changing the valid prefix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefix = Array.from({ length: 40 }, (_, i) => tool(`valid_${i}`));
    const broken = tool('broken_41st', { definition: undefined });
    const ctx = context([...prefix, broken, tool('valid_tail')]);
    const defs = getToolDefinitions(ctx);
    expect(JSON.parse(JSON.stringify(defs)).every((t: any) => t !== null)).toBe(true);
    expect(defs.slice(0, 40)).toEqual(prefix.map(t => t.definition));
    expect(defs[40]).toEqual(definition('valid_tail'));
    expect(resolveTools(ctx.profile, ctx).has('broken_41st')).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).toContain('fixture:app');
    expect(warn.mock.calls.flat().join(' ')).toContain('broken_41st');
  });

  it('null entries and mismatched names never reach execution, deferred tools or the UI catalog', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = tool('validation_broken', { definition: null, deferred: true });
    const mismatch = tool('validation_mismatch', { definition: definition('different_name') });
    registerToolProvider({ id: 'fixture:plugin-invalid', origin: 'plugin', tools: () => [null, broken, mismatch, tool('validation_ok')] } as any);
    const ctx = context([]);
    ctx.profile.toolLoadout.builtins = 'all';
    expect(listToolProviders().find(p => p.id === 'fixture:plugin-invalid')!.tools().map(t => t.name)).toEqual(['validation_ok']);
    expect(getToolDefinitions(ctx).some(t => t.function.name === 'validation_ok')).toBe(true);
    expect(listDeferredTools(ctx).some(t => t.name === broken.name)).toBe(false);
    expect(listLoadoutTools().some(t => t.name === mismatch.name)).toBe(false);
    expect(declaredApproval(mismatch.name)).toBeUndefined();
    expect(declaredAutomationSafe(mismatch.name)).toBe(false);
    expect(declaredPersistPlaceholder(mismatch.name)).toBeUndefined();
    const result = await executeTool({ id: 'bad-call', type: 'function', function: { name: mismatch.name, arguments: '{}' } } as any, ctx);
    expect(result.isError).toBe(true);
    expect(mismatch.execute).not.toHaveBeenCalled();
  });

  it('a repaired provider becomes available without restarting', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repaired = tool('repairable', { definition: null });
    const ctx = context([repaired]);
    expect(getToolDefinitions(ctx)).toEqual([]);
    repaired.definition = definition('repairable');
    expect(getToolDefinitions(ctx)).toEqual([definition('repairable')]);
  });

  it('custom and MCP bad definitions are isolated, with the MCP server named in the warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = context([]);
    ctx.customTools = new Map([['custom_bad', { name: 'custom_bad', definition: undefined }], ['custom_unnamed', { definition: definition('(unnamed)') }], ['custom_ok', { name: 'custom_ok', definition: definition('custom_ok') }]]);
    ctx.mcpTools = new Map([['mcp_bad', { name: 'mcp_bad', serverName: 'fixture-mcp', definition: null }], ['mcp_ok', { name: 'mcp_ok', serverName: 'fixture-mcp', definition: definition('mcp_ok') }]]);
    expect(getToolDefinitions(ctx)).toEqual([definition('custom_ok'), definition('mcp_ok')]);
    expect(warn.mock.calls.flat().join(' ')).toContain('fixture-mcp');
  });

  it('direct payload rejects an unexpected null locally with its index', () => {
    expect(() => buildOpenAiCompatPayload({ model: {} as any, apiModelId: 'fixture', messages: [], tools: [definition('ok'), null] as any }))
      .toThrow(/tools\[1\]/);
  });

  it('managed payload rejects an unexpected undefined before serializing it to null', async () => {
    const brain = createHttpBrain({ cloudUrl: 'https://tool-validation.test', token: 'fixture' });
    await expect(brain.llm.buildProviderPayload({ model: { id: 'fixture' } as any, apiModelId: 'fixture', messages: [], tools: [undefined] as any }))
      .rejects.toThrow(/tools\[0\]/);
  });

  it('both transports reject a payload corrupted after construction without making a network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const build = { model: { id: 'fixture' } as any, apiModelId: 'fixture', messages: [], tools: [definition('ok')] as any };
    const direct = buildOpenAiCompatPayload(build);
    direct.tools[0] = null;
    await expect(streamOpenAiCompat({ apiKey: 'fixture', baseUrl: 'https://tool-validation.test', payload: direct })).rejects.toThrow(/tools\[0\]/);
    const brain = createHttpBrain({ cloudUrl: 'https://tool-validation.test', token: 'fixture' });
    const managed = await brain.llm.buildProviderPayload({ ...build, tools: [definition('ok')] as any });
    managed.tools[0] = undefined;
    await expect(brain.llm.streamProviderCompletion({ apiKey: 'fixture', baseUrl: '', payload: managed })).rejects.toThrow(/tools\[0\]/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
