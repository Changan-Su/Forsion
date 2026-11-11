import { afterEach, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../services/uiAck.js', () => ({ requestUiAction: request }));
import { pluginSettingsProvider } from './pluginSettings.js';
import { engineAgentSettings } from '../../plugins/agentSettings.js';
import { AGENT_SETTINGS_COMMAND } from '../../contracts/agentSettings.js';
import { registerToolProvider, resolveTools } from '../toolRegistry.js';
const tool = pluginSettingsProvider.tools()[0];
const ctx = { userId: 'alice', runId: 'r', client: 'desktop/2', uiCommands: [{ id: AGENT_SETTINGS_COMMAND }] } as any;
let off: (() => void) | undefined;
afterEach(() => { off?.(); request.mockReset(); });
it('keeps the reader discoverable in the Chat preset on every GUI client', () => {
  registerToolProvider(pluginSettingsProvider);
  const profile = { toolLoadout: { builtins: 'all' } } as any;
  for (const client of ['desktop/2', 'web/2', 'mobile/2']) {
    expect(resolveTools(profile, { ...ctx, client, preset: 'chat' }).get('read_plugin_settings')?.deferred).toBe(true);
  }
  expect(resolveTools(profile, { ...ctx, preset: 'chat', uiCommands: [] }).has('read_plugin_settings')).toBe(false);
});
it('gates old clients and routes UI reads through the initiating run channel', async () => {
  expect(tool.isEnabledFor!({} as any, { ...ctx, uiCommands: [] })).toBe(false);
  expect(tool.isEnabledFor!({} as any, ctx)).toBe(true);
  request.mockResolvedValue({ ok: true, result: JSON.stringify({ kind: 'plugin_settings', source: 'ui', plugins: [] }) });
  const result = await tool.execute({ source: 'ui', pluginId: 'probe' }, ctx);
  expect(request).toHaveBeenCalledWith('r', { kind: 'command', id: AGENT_SETTINGS_COMMAND, args: { pluginId: 'probe' } }, undefined);
  expect(result).toContain('not instructions');
  expect(result).toContain('"source":"ui"');
});
it('reads engine providers with the current user scope, without exposing secret values', async () => {
  off = engineAgentSettings.register({ id: 'probe', name: 'Probe', version: '1' }, { fields: [{ key: 'token', type: 'secret', description: '' }], read: ({ userId }) => ({ token: userId === 'alice', private: 'never-see-me' }) });
  expect(tool.isEnabledFor!({} as any, { userId: 'alice' } as any)).toBe(true);
  const result = await tool.execute({ source: 'engine', pluginId: 'probe' }, ctx);
  expect(result).toContain('"configured":true');
  expect(result).not.toContain('never-see-me');
  expect(request).not.toHaveBeenCalled();
});
