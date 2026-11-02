/** Real native list/get/loadout/use_skill chain; source files remain outside user skills. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerPluginSkillProvider } from './pluginSkills.js';
import { getLocalSkill, listLocalSkills } from './localSkills.js';
import { createLocalAssets } from '../adapters/standalone/localAssetsBrain.js';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { loadSkillLoadout } from '../services/skillLoadout.js';
import { skillsProvider } from '../tools/builtin/skills.js';
import { listSkillCatalog, updateCatalogSkill } from './catalog.js';
import { uninstallSkillByKey } from '../services/skillUninstall.js';

let base: string;
let home: string;
let source: string;
let off = () => {};
const savedHome = process.env.TANGU_HOME;
const id = 'local:plugin/dsh2forsion/dsh/release';
const assets = createLocalAssets({ getSkill: async () => null } as any);
const useSkill = skillsProvider.tools().find(tool => tool.name === 'use_skill')!;
const load = () => useSkill.execute({ skill_id: id }, { userId: 'u1', sessionId: 's1', appId: 'tangu', execMode: 'host', enabledSkillIds: [id] } as any);

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-provider-'));
  home = path.join(base, 'tangu');
  source = path.join(base, 'dsh', 'skills', 'release');
  process.env.TANGU_HOME = home;
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), 'Only the source owns this body.');
  await fs.mkdir(path.join(home, 'skills', 'release'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'release', 'SKILL.md'), '---\nname: Native release\n---\nNative user skill.');
  off = registerPluginSkillProvider('dsh2forsion', { id: 'dsh', list: async () => {
    try { return [{ id: 'release', name: 'DSH release', description: 'Release this project', content: await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), dir: source }]; }
    catch { return []; } // the external source owns absence/disable semantics
  } });
  const stub: any = new Proxy({}, { get: () => () => { throw new Error('unused dependency'); } });
  configureTangu({ host: stub, brain: { assets }, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
});
afterAll(async () => {
  off();
  if (savedHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = savedHome;
  await fs.rm(base, { recursive: true, force: true });
});

it('discovers the provider through native assets and use_skill without replacing or copying user skills', async () => {
  expect((await listLocalSkills()).map(skill => skill.id)).toEqual(expect.arrayContaining(['local:release', id]));
  expect((await assets.listSkills!()).find(skill => skill.id === id)).toMatchObject({ source: 'plugin', origin: null, readOnly: true });
  expect((await assets.getSkill('local:release'))?.content).toBe('Native user skill.');
  const loadout = await loadSkillLoadout('u1', 'tangu', { execMode: 'host', enabledSkillIds: [id], skillsConfigured: true });
  expect(loadout.enabledSkillIds).toContain(id);
  expect(loadout.sections.join('\n')).toContain(id);
  expect(await load()).toContain(`Skill folder: ${source}`);
  expect(await load()).toContain('Only the source owns this body.');
  await expect(fs.stat(path.join(home, 'skills', 'plugin'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await listSkillCatalog()).some(skill => skill.id === id)).toBe(false);
  const native = (await listSkillCatalog()).find(skill => skill.id === 'local:release')!;
  await updateCatalogSkill(native.key, { content: 'Native changed.' });
  await uninstallSkillByKey(native.key);
  expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toBe('Only the source owns this body.');
});

it('re-reads changed, deleted and revoked source skills even for an already permitted skill id', async () => {
  await fs.writeFile(path.join(source, 'SKILL.md'), 'New source instructions.');
  expect(await load()).toContain('New source instructions.');
  await fs.unlink(path.join(source, 'SKILL.md'));
  expect(await getLocalSkill(id)).toBeNull();
  expect(await load()).toContain('not found');
  await fs.writeFile(path.join(source, 'SKILL.md'), 'Restored source.');
  expect(await load()).toContain('Restored source.');
  off();
  expect(await assets.getSkill(id)).toBeNull();
  expect((await assets.listSkills!()).some(skill => skill.id === id)).toBe(false);
  expect(await load()).toContain('not found');
});
