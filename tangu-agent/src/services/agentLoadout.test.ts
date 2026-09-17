import { describe, expect, it } from 'vitest';
import { buildAgentDef, parseAgentConfig, serializeAgentConfig } from '../agents/agentRegistry.js';
import { applyAgentActivation } from './agentActivation.js';

describe('agent loadout persistence and activation', () => {
  it('round trips selected and empty equipment, retains it on unrelated edits and supports reset', () => {
    const a = buildAgentDef('test', null, { name: 'Test', systemPrompt: 'Test', enabledSkillIds: ['local:one'], enabledMcpServers: [] });
    const b = parseAgentConfig('test', serializeAgentConfig(a), '');
    expect(b.enabledSkillIds).toEqual(['local:one']);
    expect(b.enabledMcpServers).toEqual([]);
    const c = buildAgentDef('test', b, { name: 'Renamed', systemPrompt: 'Test' });
    expect(c.enabledSkillIds).toEqual(['local:one']);
    expect(c.enabledMcpServers).toEqual([]);
    const d = buildAgentDef('test', c, { name: 'Renamed', systemPrompt: 'Test', enabledSkillIds: null, enabledMcpServers: null });
    expect(parseAgentConfig('test', serializeAgentConfig(d), '').enabledSkillIds).toBeUndefined();
    expect(d.enabledMcpServers).toBeUndefined();
  });
  it('applies agent defaults, including an explicitly empty selection, while preserving session overrides', async () => {
    const agent = buildAgentDef('test', null, { name: 'Test', systemPrompt: 'Test', enabledSkillIds: [], enabledMcpServers: ['files'] });
    const cfg: any = { agentSlug: 'test' };
    await applyAgentActivation(cfg, 'u', async () => agent);
    expect(cfg).toMatchObject({ enabledSkillIds: [], skillsConfigured: true, enabledMcpServers: ['files'] });
    const override: any = { agentSlug: 'test', enabledSkillIds: ['local:two'], enabledMcpServers: [] };
    await applyAgentActivation(override, 'u', async () => agent);
    expect(override.enabledSkillIds).toEqual(['local:two']);
    expect(override.enabledMcpServers).toEqual([]);
    const selected = { ...agent, enabledSkillIds: ['local:one'] };
    const legacy: any = { agentSlug: 'test', enabledSkillIds: [] };
    await applyAgentActivation(legacy, 'u', async () => selected);
    expect(legacy.enabledSkillIds).toEqual(['local:one']);
    const none: any = { agentSlug: 'test', enabledSkillIds: [], skillsConfigured: true };
    await applyAgentActivation(none, 'u', async () => selected);
    expect(none.enabledSkillIds).toEqual([]);
  });
});
