import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('user and Agent skill catalog', () => {
  let base: string;
  let home: string;
  let source: string;
  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-catalog-'));
    home = path.join(base, 'home');
    source = path.join(base, 'import-me');
    process.env.TANGU_HOME = home;
    const bundle = path.join(base, 'bundle');
    await fs.mkdir(path.join(bundle, 'skills', 'catalog-sample'), { recursive: true });
    await fs.writeFile(path.join(bundle, 'manifest.json'), '{}');
    await fs.writeFile(path.join(bundle, 'skills', 'catalog-sample', 'SKILL.md'), '---\nname: Bundle sample\n---\nBundle body\n');
    process.env.TANGU_BUNDLE_DIRS = JSON.stringify([bundle]);
    await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: Imported sample\n---\nImported body\n');
    await fs.writeFile(path.join(source, 'scripts', 'run.sh'), '#!/bin/sh\necho ready\n');
  });
  afterAll(async () => {
    delete process.env.TANGU_HOME;
    delete process.env.TANGU_BUNDLE_DIRS;
    await fs.rm(base, { recursive: true, force: true });
  });

  it('shows every source, resolves precedence, and keeps read-only bundles protected', async () => {
    const api = await import('./catalog.js');
    const bundle = (await api.listSkillCatalog()).find((row) => row.slug === 'catalog-sample' && row.provenance === 'bundle');
    expect(bundle).toMatchObject({ scope: 'user', readOnly: true, availability: 'available' });
    await expect(api.updateCatalogSkill(bundle!.key, { content: 'changed' })).rejects.toMatchObject({ status: 403 });
    await expect(api.deleteCatalogSkill(bundle!.key)).rejects.toMatchObject({ status: 403 });

    const user = await api.createCatalogSkill({ scope: 'user', slug: 'catalog-sample', name: 'Writing: #playbook', description: 'When: "foo" # bar', content: 'User body' });
    expect(user).toMatchObject({ name: 'Writing: #playbook', description: 'When: "foo" # bar', content: 'User body' });
    const rows = (await api.listSkillCatalog()).filter((row) => row.slug === 'catalog-sample');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.provenance === 'bundle')).toMatchObject({ availability: 'shadowed', shadowedBy: user.key });
    expect(rows.find((row) => row.provenance === 'user')).toMatchObject({ availability: 'available', readOnly: false });
    const { parseFrontmatter } = await import('./localSkills.js');
    expect(parseFrontmatter(await fs.readFile(path.join(user.path, 'SKILL.md'), 'utf8')).meta).toMatchObject({ name: 'Writing: #playbook', description: 'When: "foo" # bar' });
  });

  it('uses separate global and per-Agent disable state without blocking an Agent override', async () => {
    const api = await import('./catalog.js');
    const { runWithAgentSlug, setRunCwd } = await import('../seams/runContext.js');
    const { getLocalSkill } = await import('./localSkills.js');
    const user = (await api.listSkillCatalog()).find((row) => row.slug === 'catalog-sample' && row.provenance === 'user')!;
    await api.setCatalogSkillDisabled(user.key, true);
    expect((await api.listSkillCatalog()).filter((row) => row.slug === 'catalog-sample').every((row) => row.availability === 'disabled')).toBe(true);
    expect(await getLocalSkill(user.id)).toBeNull();
    await api.setCatalogSkillDisabled(user.key, false);

    const agent = await api.copyCatalogSkill(user.key, { scope: 'agent', agentSlug: 'coding' });
    expect(agent).toMatchObject({ scope: 'agent', owner: 'coding', availability: 'available' });
    const rows = (await api.listSkillCatalog('coding')).filter((row) => row.slug === 'catalog-sample');
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.scope === 'user').every((row) => row.shadowedBy === agent.key)).toBe(true);

    await api.setCatalogSkillDisabled(user.key, true, 'coding'); // only coding loses the inherited copy
    expect((await api.listSkillCatalog('coding')).find((row) => row.key === user.key)).toMatchObject({ disabledForAgent: true, availability: 'disabled' });
    expect((await api.listSkillCatalog()).find((row) => row.key === user.key)?.availability).toBe('available');
    expect((await runWithAgentSlug('coding', () => getLocalSkill(user.id)))?.name).toBe('Writing: #playbook'); // Agent override still works
    await api.setCatalogSkillDisabled(agent.key, true, 'coding');
    expect(await runWithAgentSlug('coding', () => getLocalSkill(user.id))).toBeNull();
    expect((await getLocalSkill(user.id))?.name).toBe('Writing: #playbook');

    const project = path.join(base, 'project');
    await fs.mkdir(path.join(project, '.tangu', 'skills', 'catalog-sample'), { recursive: true });
    await fs.writeFile(path.join(project, '.tangu', 'skills', 'catalog-sample', 'SKILL.md'), '---\nname: Project copy\n---\nProject body\n');
    expect((await runWithAgentSlug('coding', async () => { setRunCwd(project); return getLocalSkill(user.id); }))?.name).toBe('Project copy');
  });

  it('imports full directories without overwriting, preserves helpers on edit, and backs up the entire folder on delete', async () => {
    const api = await import('./catalog.js');
    const imported = await api.importCatalogSkill({ scope: 'user', sourcePath: source, slug: 'imported-sample' });
    expect(imported.files).toEqual(expect.arrayContaining([{ path: 'scripts/run.sh', size: 21 }]));
    await expect(api.importCatalogSkill({ scope: 'user', sourcePath: source, slug: 'imported-sample' })).rejects.toMatchObject({ status: 409 });
    const edited = await api.updateCatalogSkill(imported.key, { name: 'Imported: revised', content: 'Revised body' });
    expect(edited.content).toBe('Revised body');
    expect(await fs.readFile(path.join(edited.path, 'scripts', 'run.sh'), 'utf8')).toContain('echo ready');
    const { backupPath } = await api.deleteCatalogSkill(edited.key);
    expect(await fs.readFile(path.join(backupPath, 'SKILL.md'), 'utf8')).toContain('Revised body');
    expect(await fs.readFile(path.join(backupPath, 'scripts', 'run.sh'), 'utf8')).toContain('echo ready');
    await expect(fs.lstat(edited.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink in an imported skill directory', async () => {
    const api = await import('./catalog.js');
    await fs.symlink(path.join(source, 'SKILL.md'), path.join(source, 'scripts', 'link'));
    await expect(api.importCatalogSkill({ scope: 'user', sourcePath: source, slug: 'unsafe-import' })).rejects.toThrow('symbolic link');
    await expect(fs.lstat(path.join(home, 'skills', 'unsafe-import'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lists existing legacy directory names as read-only and allows copying to a new slug', async () => {
    const api = await import('./catalog.js');
    const { getLocalSkill } = await import('./localSkills.js');
    for (const legacyName of ['Legacy_Skill', '中文技能']) {
      const dir = path.join(home, 'skills', legacyName);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${legacyName}\n---\nLegacy body\n`);
      expect((await getLocalSkill(`local:${legacyName}`))?.name).toBe(legacyName);
      const entry = (await api.listSkillCatalog()).find((row) => row.slug === legacyName);
      expect(entry).toMatchObject({ scope: 'user', compatibility: 'legacy-slug', readOnly: true });
      expect((await api.getSkillCatalogDetail(entry!.key)).content).toBe('Legacy body');
      await expect(api.updateCatalogSkill(entry!.key, { content: 'Changed' })).rejects.toMatchObject({ status: 403 });
      await expect(api.deleteCatalogSkill(entry!.key)).rejects.toMatchObject({ status: 403 });
      await expect(api.setCatalogSkillDisabled(entry!.key, true)).rejects.toMatchObject({ status: 403 });
      await expect(api.copyCatalogSkill(entry!.key, { scope: 'user' })).rejects.toMatchObject({ status: 400 });
      const copy = await api.copyCatalogSkill(entry!.key, { scope: 'user', slug: `legacy-copy-${legacyName === '中文技能' ? 'zh' : 'en'}` });
      expect(copy).toMatchObject({ compatibility: null, readOnly: false, content: 'Legacy body' });
    }
    await expect(api.createCatalogSkill({ scope: 'user', slug: 'Legacy_Skill', name: 'new', content: 'body' })).rejects.toMatchObject({ status: 400 });

    const agentLegacy = path.join(home, 'agents', 'coding', 'skills', 'Agent_Skill');
    await fs.mkdir(agentLegacy, { recursive: true });
    await fs.writeFile(path.join(agentLegacy, 'SKILL.md'), '---\nname: Agent legacy\n---\nAgent body\n');
    const agentEntry = (await api.listSkillCatalog('coding')).find((row) => row.slug === 'Agent_Skill');
    expect(agentEntry).toMatchObject({ scope: 'agent', owner: 'coding', compatibility: 'legacy-slug', readOnly: true });
    await expect(api.deleteCatalogSkill(agentEntry!.key, 'coding')).rejects.toMatchObject({ status: 403 });
  });

  it('does not expose an in-progress publish stage to the runtime or catalog', async () => {
    const api = await import('./catalog.js');
    const { getLocalSkill, listLocalSkills } = await import('./localSkills.js');
    const stage = path.join(home, 'skills', '.skill-stage-incomplete');
    await fs.mkdir(stage, { recursive: true });
    await fs.writeFile(path.join(stage, 'SKILL.md'), '---\nname: Incomplete stage\n---\nHalf copied body\n');
    expect((await listLocalSkills()).some((skill) => skill.id === 'local:.skill-stage-incomplete')).toBe(false);
    expect(await getLocalSkill('local:.skill-stage-incomplete')).toBeNull();
    expect((await api.listSkillCatalog()).some((skill) => skill.slug === '.skill-stage-incomplete')).toBe(false);

    await fs.rename(stage, path.join(home, 'skills', 'committed-stage-sample'));
    expect((await getLocalSkill('local:committed-stage-sample'))?.name).toBe('Incomplete stage');
    expect((await api.listSkillCatalog()).some((skill) => skill.slug === 'committed-stage-sample')).toBe(true);
  });

  it('keeps both changes when two settings windows disable different skills at once', async () => {
    const { setSkillDisabled, disabledSkillNames } = await import('./availability.js');
    await Promise.all([
      setSkillDisabled('user', 'concurrent-a', true),
      setSkillDisabled('user', 'concurrent-b', true),
    ]);
    const names = await disabledSkillNames('user');
    expect(names.has('concurrent-a')).toBe(true);
    expect(names.has('concurrent-b')).toBe(true);
  });
});
