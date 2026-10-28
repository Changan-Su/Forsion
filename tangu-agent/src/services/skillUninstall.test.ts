/** 删技能的收尾:选了它的 Agent 清单、停用记录跟着清,恢复时接回;改过的内置技能 = 还原为内置版本,恢复换回改过的那份。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let home: string;
beforeAll(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-skill-un-')); process.env.TANGU_HOME = home; });
afterAll(async () => { delete process.env.TANGU_HOME; await fs.rm(home, { recursive: true, force: true }); });

describe('skill uninstall', () => {
  it('unpicks it, clears its paused entries, and restore puts both back', async () => {
    const { saveAgent, getAgent } = await import('../agents/agentRegistry.js');
    const { createCatalogSkill } = await import('../skills/catalog.js');
    const { disabledSkillNames, setSkillDisabled } = await import('../skills/availability.js');
    const { skillUninstallPreview, uninstallSkillByKey, restoreSkill } = await import('./skillUninstall.js');
    const skill = await createCatalogSkill({ scope: 'user', slug: 'weekly', name: 'Weekly report', content: 'Write it.' });
    await saveAgent({ slug: 'penn', name: 'Penn', systemPrompt: 'x', enabledSkillIds: ['local:weekly', 'local:other'] });
    await setSkillDisabled('inherited', 'weekly', true, 'penn');

    expect(await skillUninstallPreview(skill.key)).toMatchObject({ mode: 'delete', picks: [{ slug: 'penn', name: 'Penn' }], disabled: true });
    const entry = await uninstallSkillByKey(skill.key);
    expect((await getAgent('penn'))!.enabledSkillIds).toEqual(['local:other']);
    expect((await disabledSkillNames('inherited', 'penn')).has('weekly')).toBe(false);

    expect(await restoreSkill(entry)).toMatchObject({ renamed: false });
    expect((await getAgent('penn'))!.enabledSkillIds).toEqual(['local:other', 'local:weekly']);
    expect((await disabledSkillNames('inherited', 'penn')).has('weekly')).toBe(true);
  });

  it('a modified built-in goes back to the built-in version; restoring brings the edit back', async () => {
    const { listSkillCatalog } = await import('../skills/catalog.js');
    const { skillUninstallPreview, uninstallSkillByKey, restoreSkill } = await import('./skillUninstall.js');
    const mirror = (await listSkillCatalog()).find((r) => r.provenance === 'builtin-mirror')!;
    expect(await skillUninstallPreview(mirror.key)).toMatchObject({ mode: 'pause' });
    const file = path.join(mirror.path, 'SKILL.md');
    await fs.writeFile(file, `${await fs.readFile(file, 'utf8')}\nMy own step.\n`);
    const edited = (await listSkillCatalog()).find((r) => r.path === mirror.path)!;
    expect(edited.provenance).toBe('user');
    expect((await skillUninstallPreview(edited.key)).mode).toBe('restore-builtin');
    const entry = await uninstallSkillByKey(edited.key);
    expect(await fs.readFile(file, 'utf8')).not.toContain('My own step.'); // 立刻重新播种了原样的
    expect((await listSkillCatalog()).find((r) => r.path === mirror.path)!.provenance).toBe('builtin-mirror');
    await restoreSkill(entry);
    expect(await fs.readFile(file, 'utf8')).toContain('My own step.');
  });
});
