import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tools/toolTypes.js';
import type { AppProfile } from '../seams/appProfile.js';
const state = vi.hoisted(() => ({ config: null as Record<string, unknown> | null, exists: false }));
vi.mock('../core/config.js', () => ({ loadRawConfig: () => state.config, configExists: () => state.exists }));
import { resolveHostSandboxPolicy, isHostSandboxToolAllowed } from './hostSandboxPolicy.js';
import { registerToolProvider, resolveTools, type ToolDef } from '../tools/toolRegistry.js';
import { activatePlugin } from '../plugins/loader.js';

beforeEach(() => { state.config = null; state.exists = false; });
describe('trusted local sandbox policy', () => {
  it('keeps existing installations off, refuses malformed configuration', () => {
    expect(resolveHostSandboxPolicy()).toEqual({ mode: 'off', network: 'deny' });
    state.exists = true;
    expect(() => resolveHostSandboxPolicy()).toThrow('Invalid config.json');
    state.config = { hostSandbox: { mode: 'workspace-writ' } };
    expect(() => resolveHostSandboxPolicy()).toThrow('Invalid hostSandbox');
  });
  it('takes a run snapshot and blocks tools whose execution is not brokered', () => {
    state.config = { hostSandbox: { mode: 'workspace-write' } };
    const ctx = { execMode: 'host', hostSandbox: resolveHostSandboxPolicy() } as ToolContext;
    state.config = { hostSandbox: { mode: 'off' } };
    expect(isHostSandboxToolAllowed('run_bash', ctx)).toBe(true);
    for (const name of ['apply_patch', 'search_files', 'delegate', 'use_skill', 'web_fetch', 'unknown_tool']) {
      expect(isHostSandboxToolAllowed(name, ctx), name).toBe(false);
    }
    expect(isHostSandboxToolAllowed('run_python', { execMode: 'sandbox' })).toBe(true);
  });
  it('cannot replace a covered core tool using plugin or profile providers', () => {
    const make = (name: string, description: string): ToolDef => ({
      name, definition: { type: 'function', function: { name, description, parameters: {} } }, execute: () => description,
    });
    registerToolProvider({ id: 'policy:core', tools: () => [make('read_file', 'core'), make('unbrokered', 'core')] });
    registerToolProvider({ id: 'policy:plugin', origin: 'plugin', tools: () => [make('read_file', 'plugin')] });
    const profile = { toolLoadout: { builtins: 'all', providers: [
      { id: 'profile-tool', tools: () => [make('read_file', 'profile')] },
    ] } } as AppProfile;
    const ctx = { execMode: 'host', hostSandbox: { mode: 'read-only', network: 'deny' } } as ToolContext;
    const tools = resolveTools(profile, ctx);
    expect([...tools.keys()]).toEqual(['read_file']);
    expect(tools.get('read_file')?.definition.function.description).toBe('core');
  });
  it('rejects native plugin imports before any plugin code executes', async () => {
    state.config = { hostSandbox: { mode: 'read-only' } };
    await expect(activatePlugin({ entryUrl: 'file:///must-not-load.mjs' } as any, {} as any))
      .rejects.toThrow('Native plugins are unavailable');
  });
});
