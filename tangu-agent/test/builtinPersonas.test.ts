import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_PERSONAS } from '../src/agents/legacyPersonas.js';

let home: string;
let registry: typeof import('../src/agents/agentRegistry.js');
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-personas-'));
  vi.stubEnv('TANGU_HOME', home);
  vi.resetModules();
  registry = await import('../src/agents/agentRegistry.js');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function writeLegacy(index: number, patch: Record<string, unknown> = {}) {
  const old = LEGACY_PERSONAS[index];
  const def = { ...registry.buildAgentDef(old.slug, null, old as any), ...patch };
  const dir = join(home, 'agents', old.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.toml'), registry.serializeAgentConfig(def));
  writeFileSync(join(dir, 'SOUL.md'), def.soul || '');
  return def;
}

async function restart() {
  vi.resetModules();
  registry = await import('../src/agents/agentRegistry.js');
  return registry.listAgents();
}

describe('built-in roster and non-destructive upgrades', () => {
  it('seeds exactly five agents in order, three portraits, and keeps Arioso as default', async () => {
    const agents = await registry.listAgents();
    expect(agents.map((a) => a.slug)).toEqual(['xyra', 'aria', 'recita', 'coding', 'muse']);
    expect(agents.map((a) => a.name)).toEqual(['Arioso', 'Aria', 'Recita', 'Coding', 'Muse']);
    expect(registry.readAgentsMeta().defaultSlug).toBe('xyra');
    for (const slug of ['xyra', 'aria', 'recita']) {
      const avatar = await registry.readAgentAvatar(slug);
      expect(avatar?.mimeType).toBe('image/jpeg');
      expect(avatar?.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(avatar!.data.length).toBeLessThan(100_000);
    }
    expect((await registry.getAgent('muse'))?.createdBy).toBe('system');
    expect((await restart()).map((a) => a.slug)).toEqual(agents.map((a) => a.slug));
  });

  it('upgrades seeded installations without losing memory, logs, or custom settings', async () => {
    const old = writeLegacy(0, { model: 'custom/model', toolsMode: 'deny', toolsList: ['run_command'],
      compaction: { keepRecentTokens: 12000 }, apps: ['tangu'], cloudSync: true });
    for (let i = 1; i < LEGACY_PERSONAS.length; i++) writeLegacy(i);
    writeFileSync(join(home, 'agents', '.seeded'), 'old installation');
    const dir = join(home, 'agents', 'xyra');
    writeFileSync(join(dir, 'MEMORY.md'), 'Keep this memory');
    mkdirSync(join(dir, 'LOG'));
    writeFileSync(join(dir, 'LOG', '2026-09-01.md'), 'Keep this log');
    const agents = await registry.listAgents();
    expect(agents.map((a) => a.slug)).toEqual(['xyra', 'aria', 'recita', 'coding', 'muse']);
    const arioso = agents[0];
    expect(arioso.systemPrompt).toContain('quiet sensitivity');
    expect(arioso.soul).toContain('A steady presence');
    expect(arioso).toMatchObject({ model: old.model, toolsMode: old.toolsMode, toolsList: old.toolsList,
      compaction: old.compaction, apps: old.apps, cloudSync: true });
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('Keep this memory');
    expect(readFileSync(join(dir, 'LOG', '2026-09-01.md'), 'utf8')).toBe('Keep this log');
    // Retirement is list-only: old sessions can still resolve their agent and its files.
    expect((await registry.getAgent('code-reviewer'))?.systemPrompt).toBe(LEGACY_PERSONAS[2].systemPrompt);
    expect(registry.builtinAgentDef('code-reviewer')).toBeNull();
  });

  it('preserves customized Arioso fields but removes retired identities even with older prompts or custom settings', async () => {
    writeLegacy(0, { name: 'My companion', systemPrompt: 'My instructions', soul: '# My persona' });
    for (let i = 1; i < LEGACY_PERSONAS.length; i++) writeLegacy(i, { systemPrompt: '历史中文提示词', model: 'review-model' });
    writeFileSync(join(home, 'agents', '.meta.json'), JSON.stringify({ order: ['code-reviewer', 'aria'], defaultSlug: 'code-reviewer' }));
    const agents = await registry.listAgents();
    expect(agents.find((a) => a.slug === 'xyra')).toMatchObject({ name: 'My companion', systemPrompt: 'My instructions', soul: '# My persona' });
    expect(agents.map((a) => a.slug).sort()).toEqual(['aria', 'coding', 'muse', 'recita', 'xyra']);
    expect(registry.readAgentsMeta()).toEqual({ order: ['aria'], defaultSlug: 'xyra' });
    expect(await registry.writeAgentsMeta({ defaultSlug: 'general-assistant', order: ['writing-polish', 'recita'] }))
      .toEqual({ order: ['recita'], defaultSlug: 'xyra' });
    expect((await registry.getAgent('code-reviewer'))?.systemPrompt).toBe('历史中文提示词');
  });

  it('upgrades each original Arioso field independently and recognizes the old Xyra name', async () => {
    writeLegacy(0, { name: 'Tangu Xyra', systemPrompt: LEGACY_PERSONAS[0].systemPrompt.replaceAll('Tangu Arioso', 'Tangu Xyra'), soul: 'My soul' });
    const arioso = (await registry.listAgents())[0];
    expect(arioso.name).toBe('Arioso');
    expect(arioso.systemPrompt).toContain('quiet sensitivity');
    expect(arioso.soul).toBe('My soul');
  });

  it('respects agent deletion, avatar removal, replacement, and repairs missing portrait files', async () => {
    await registry.listAgents();
    await registry.deleteAgent('aria');
    await registry.deleteAgentAvatar('recita');
    await restart();
    expect(await registry.getAgent('aria')).toBeNull();
    expect(await registry.readAgentAvatar('recita')).toBeNull();
    const custom = Buffer.from('custom-image');
    await registry.saveAgentAvatar('recita', custom.toString('base64'), 'image/png');
    await restart();
    expect((await registry.readAgentAvatar('recita'))?.data).toEqual(custom);
    rmSync(join(home, 'agents', 'recita', 'Library', 'avatar.png'));
    await restart();
    expect((await registry.readAgentAvatar('recita'))?.mimeType).toBe('image/jpeg');
    expect(existsSync(join(home, 'agents', 'recita', '.avatar-removed'))).toBe(false);
  });

  it('preserves an existing user agent using a new built-in slug and user ordering', async () => {
    const dir = join(home, 'agents', 'aria');
    mkdirSync(dir, { recursive: true });
    const def = registry.buildAgentDef('aria', null, { name: 'My Aria', systemPrompt: 'Custom role', soul: 'Custom soul' });
    writeFileSync(join(dir, 'config.toml'), registry.serializeAgentConfig(def));
    writeFileSync(join(dir, 'SOUL.md'), def.soul!);
    await registry.writeAgentsMeta({ order: ['recita', 'aria'], defaultSlug: 'aria' });
    const agents = await registry.listAgents();
    expect(agents.slice(0, 2).map((a) => a.slug)).toEqual(['recita', 'aria']);
    expect(await registry.getAgent('aria')).toMatchObject({ name: 'My Aria', systemPrompt: 'Custom role', soul: 'Custom soul' });
    expect((await registry.getAgent('aria'))?.avatar).toBeUndefined();
    expect(registry.readAgentsMeta().defaultSlug).toBe('aria');
  });
});
