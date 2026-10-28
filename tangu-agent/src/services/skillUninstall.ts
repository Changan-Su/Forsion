/**
 * 删除技能(10-28 手动卸载规范 A + D):文件夹进回收站,顺手清掉它留下的两样 ——
 *   选了它的 Agent 的清单(enabledSkillIds)、停用名单里的记录(不清,以后同名的新技能一装上就是停用的)。
 *   这两样只在「删了之后同名的再也找不到」时清:同名的内置 / 插件技能还在,清单和停用照旧作用在它身上。
 * 内置、插件自带、原样播种的镜像只能停用;改过的内置技能删 = 还原为内置版本(删掉改过的那份,立刻重新播种)。
 * 设置页、商店卸载、manage_skill 工具都走这里。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { skillsDir } from '../core/tanguHome.js';
import { listAgents, getAgent, patchAgent } from '../agents/agentRegistry.js';
import { listSkillCatalog, findSkill, ownedRoot, SkillCatalogError, type CatalogSkill } from '../skills/catalog.js';
import { builtinSkillsDir, seedSkillsInto, isUntouchedSeedMirror, SHARED_SKILL_ID_RE } from '../skills/localSkills.js';
import { disabledSkillNames, setSkillDisabled } from '../skills/availability.js';
import { moveToTrash, pathSize, restoreTrashItems, type TrashEntry } from './trash.js';

type DisableTarget = 'user' | 'agent' | 'inherited';
interface Pick { agent: string; id: string }
interface Disabled { target: DisableTarget; agent?: string }
interface SkillExtra { picks?: Pick[]; disabled?: Disabled[]; reseeded?: boolean }

export interface SkillUninstallPreview {
  key: string; name: string; slug: string; scope: 'user' | 'agent'; owner: string | null; size: number;
  /** delete = 进回收站;restore-builtin = 改过的内置技能,还原为内置版本;pause = 只能停用;none = 旧名字的技能,只读。 */
  mode: 'delete' | 'restore-builtin' | 'pause' | 'none';
  picks: Array<{ slug: string; name: string }>;
  disabled: boolean;
}

const isBuiltinName = (slug: string): Promise<boolean> => fs.access(path.join(builtinSkillsDir(), slug, 'SKILL.md')).then(() => true, () => false);

async function modeOf(skill: CatalogSkill): Promise<SkillUninstallPreview['mode']> {
  if (skill.compatibility) return 'none';
  if (skill.readOnly) return 'pause';
  return skill.scope === 'user' && await isBuiltinName(skill.slug) ? 'restore-builtin' : 'delete';
}

/** 删掉 key 这一份之后,agent 选的 id 还能不能找到同名的(catalog 按 agent 列,含全局与它自己的)。 */
function resolver(excludeKey: string): (id: string, agent: string) => Promise<boolean> {
  const lists = new Map<string, Promise<CatalogSkill[]>>();
  const list = (agent: string): Promise<CatalogSkill[]> => {
    if (!lists.has(agent)) lists.set(agent, listSkillCatalog(agent).catch(() => []));
    return lists.get(agent)!;
  };
  return async (id, agent) => {
    const shared = SHARED_SKILL_ID_RE.exec(id);
    if (shared) return (await list(shared[1])).some((r) => r.key !== excludeKey && r.scope === 'agent' && r.owner === shared[1] && r.slug === shared[2]);
    const slug = id.replace(/^local:/, '');
    return (await list(agent)).some((r) => r.key !== excludeKey && r.slug === slug);
  };
}

async function leftovers(skill: CatalogSkill): Promise<{ picks: Pick[]; disabled: Disabled[] }> {
  const ids = skill.scope === 'user' ? [`local:${skill.slug}`] : [`local:${skill.slug}`, `local:@${skill.owner}/${skill.slug}`];
  const resolves = resolver(skill.key);
  const picks: Pick[] = [];
  const agents = await listAgents();
  for (const a of agents) {
    for (const id of a.enabledSkillIds ?? []) {
      if (!ids.includes(id)) continue;
      if (id === `local:${skill.slug}` && skill.scope === 'agent' && a.slug !== skill.owner) continue; // 别人的 local:<slug> 指的是它们自己 / 全局那份
      if (!(await resolves(id, a.slug))) picks.push({ agent: a.slug, id });
    }
  }
  const disabled: Disabled[] = [];
  const sameNameLeft = async (agent?: string): Promise<boolean> =>
    (await listSkillCatalog(agent).catch(() => [])).some((r) => r.key !== skill.key && r.slug === skill.slug && r.scope === skill.scope && (skill.scope === 'user' || r.owner === skill.owner));
  if (skill.scope === 'user') {
    if (!(await sameNameLeft())) {
      if ((await disabledSkillNames('user')).has(skill.slug)) disabled.push({ target: 'user' });
      for (const a of agents) if ((await disabledSkillNames('inherited', a.slug)).has(skill.slug)) disabled.push({ target: 'inherited', agent: a.slug });
    }
  } else if (skill.owner && !(await sameNameLeft(skill.owner)) && (await disabledSkillNames('agent', skill.owner)).has(skill.slug)) {
    disabled.push({ target: 'agent', agent: skill.owner });
  }
  return { picks, disabled };
}

export async function skillUninstallPreview(key: string, agentSlug?: string): Promise<SkillUninstallPreview> {
  const skill = await findSkill(key, agentSlug);
  const mode = await modeOf(skill);
  const left = mode === 'delete' ? await leftovers(skill) : { picks: [], disabled: [] };
  const names = new Map((await listAgents()).map((a) => [a.slug, a.name || a.slug]));
  return {
    key, name: skill.name, slug: skill.slug, scope: skill.scope, owner: skill.owner, size: await pathSize(skill.path), mode,
    picks: [...new Set(left.picks.map((p) => p.agent))].map((slug) => ({ slug, name: names.get(slug) || slug })),
    disabled: left.disabled.length > 0,
  };
}

async function unpick(picks: Pick[]): Promise<void> {
  for (const p of picks) await patchAgent(p.agent, (cur) => ({ enabledSkillIds: (cur.enabledSkillIds ?? []).filter((id) => id !== p.id) })).catch(() => { /* Agent 没了 */ });
}

/** 删一份技能:进回收站 + 清单 / 停用名单收尾(改过的内置技能另外立刻重新播种)。只读的抛 403。 */
export async function uninstallSkill(skill: CatalogSkill): Promise<TrashEntry> {
  const mode = await modeOf(skill);
  if (mode === 'pause' || mode === 'none') throw new SkillCatalogError('This skill is read-only', 403);
  await ownedRoot(skill.scope, skill.owner || undefined);
  if (!(await fs.lstat(skill.path)).isDirectory()) throw new SkillCatalogError('Skill directory is not a regular directory', 409);
  const left = mode === 'delete' ? await leftovers(skill) : { picks: [], disabled: [] };
  const extra: SkillExtra = { picks: left.picks, disabled: left.disabled, ...(mode === 'restore-builtin' ? { reseeded: true } : {}) };
  const entry = await moveToTrash({ kind: 'skill', ref: skill.id, name: skill.name, paths: [{ path: skill.path, role: 'dir' }], extra: { ...extra, scope: skill.scope, owner: skill.owner } });
  if (!entry) throw new SkillCatalogError('Skill not found', 404);
  await unpick(left.picks);
  for (const d of left.disabled) await setSkillDisabled(d.target, skill.slug, false, d.agent).catch(() => {});
  if (mode === 'restore-builtin') await seedSkillsInto(builtinSkillsDir(), skillsDir()).catch(() => {});
  return entry;
}

export async function uninstallSkillByKey(key: string, agentSlug?: string): Promise<TrashEntry> {
  return uninstallSkill(await findSkill(key, agentSlug));
}

export async function restoreSkill(entry: TrashEntry): Promise<{ path: string; renamed: boolean }> {
  const extra = (entry.extra ?? {}) as SkillExtra;
  const from = entry.items[0]?.from;
  // 还原为内置版本时原处已经重新播种了一份原样的:换回用户改过的那份(原样的随时能再播种)。
  if (extra.reseeded && from && await isUntouchedSeedMirror(from).catch(() => false)) await fs.rm(from, { recursive: true, force: true });
  const placed = await restoreTrashItems(entry);
  const at = (from && placed.get(from)) || from || '';
  const renamed = at !== from;
  if (!renamed) {
    const slug = path.basename(at);
    for (const p of extra.picks ?? []) {
      const a = await getAgent(p.agent);
      if (a && !(a.enabledSkillIds ?? []).includes(p.id)) await patchAgent(p.agent, (cur) => ({ enabledSkillIds: [...(cur.enabledSkillIds ?? []), p.id] })).catch(() => {});
    }
    for (const d of extra.disabled ?? []) await setSkillDisabled(d.target, slug, true, d.agent).catch(() => {});
  }
  return { path: at, renamed };
}
