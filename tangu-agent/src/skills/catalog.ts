/** 用户级与 Agent 级技能管理目录。项目级扫描保持在 localSkills，不经此接口写入。 */
import { promises as fs, constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { agentsDir, skillsDir, tanguHome } from '../core/tanguHome.js';
import { getAgent } from '../agents/agentRegistry.js';
import { bundleSkillRoots } from '../plugins/bundles.js';
import { builtinAgentSkillsDir, builtinSkillsDir, isSkillStageDirName, isUntouchedSeedMirror, parseFrontmatter, seedBuiltinSkills } from './localSkills.js';
import { disabledSkillNames, setSkillDisabled } from './availability.js';

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Existing installations can have names from before the create/import slug rule. They may be
// inspected and copied to a canonical slug, but must not become writable through this API.
const safeExistingDirectoryName = (name: string): boolean =>
  !!name && name !== '.' && name !== '..' && !isSkillStageDirName(name) && !/[\\/\x00-\x1f\x7f]/u.test(name);
const MAX_IMPORT_FILES = 5000;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export type SkillScope = 'user' | 'agent';
export type SkillProvenance = 'builtin' | 'bundle' | 'user' | 'builtin-mirror' | 'agent-builtin' | 'agent' | 'agent-mirror';
export interface CatalogSkill {
  key: string;
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  version: string | null;
  scope: SkillScope;
  owner: string | null;
  path: string;
  provenance: SkillProvenance;
  compatibility: 'legacy-slug' | null;
  origin: 'agent' | null;
  readOnly: boolean;
  disabled: boolean;
  disabledForAgent: boolean;
  availability: 'available' | 'disabled' | 'shadowed';
  shadowedBy: string | null;
}
export interface CatalogSkillDetail extends CatalogSkill {
  content: string;
  files: Array<{ path: string; size: number }>;
}
export class SkillCatalogError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function bad(message: string, status = 400): never { throw new SkillCatalogError(message, status); }
const keyFor = (dir: string): string => createHash('sha256').update(dir).digest('hex').slice(0, 24);
const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const agentRoot = (slug: string): string => path.join(agentsDir(), slug, 'skills');

async function checkedAgent(slug: unknown): Promise<string> {
  if (typeof slug !== 'string' || !SAFE_SLUG.test(slug)) bad('Invalid Agent slug');
  if (!(await getAgent(slug))) bad('Agent not found', 404);
  return slug;
}

async function scanRoot(root: string, scope: SkillScope, owner: string | null, provenance: SkillProvenance): Promise<CatalogSkill[]> {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out: CatalogSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeExistingDirectoryName(entry.name)) continue; // 不跟随技能目录 symlink 或发布暂存目录
    const dir = path.join(root, entry.name);
    const file = path.join(dir, 'SKILL.md');
    try { if (!(await fs.lstat(file)).isFile()) continue; } catch { continue; } // 不跟随 SKILL.md symlink
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    const mirror = (provenance === 'user' || provenance === 'agent') && await isUntouchedSeedMirror(dir).catch(() => false);
    const actual: SkillProvenance = mirror ? (scope === 'user' ? 'builtin-mirror' : 'agent-mirror') : provenance;
    const compatibility = SAFE_SLUG.test(entry.name) ? null : 'legacy-slug';
    out.push({
      key: keyFor(dir), id: `local:${entry.name}`, slug: entry.name,
      name: meta.name || entry.name,
      description: meta.description || body.split('\n').find((line) => line.trim() && !line.trim().startsWith('#'))?.trim().slice(0, 200) || '',
      icon: meta.icon || null, version: meta.version || null,
      scope, owner, path: dir, provenance: actual, compatibility,
      origin: (provenance === 'user' || provenance === 'agent') && meta.origin === 'agent' ? 'agent' : null,
      readOnly: provenance !== 'user' && provenance !== 'agent' || mirror || compatibility !== null,
      disabled: false, disabledForAgent: false, availability: 'available', shadowedBy: null,
    });
  }
  return out;
}

/** 候选按运行时根顺序排列。包含每份版本；胜出与停用状态由同一顺序计算。 */
export async function listSkillCatalog(agentSlug?: string): Promise<CatalogSkill[]> {
  if (agentSlug) await checkedAgent(agentSlug);
  await seedBuiltinSkills();
  const roots: Array<Promise<CatalogSkill[]>> = [
    scanRoot(builtinSkillsDir(), 'user', null, 'builtin'),
    ...bundleSkillRoots().map((root) => scanRoot(root, 'user', null, 'bundle')),
    scanRoot(skillsDir(), 'user', null, 'user'),
  ];
  if (agentSlug) {
    roots.push(scanRoot(builtinAgentSkillsDir(agentSlug), 'agent', agentSlug, 'agent-builtin'));
    roots.push(scanRoot(agentRoot(agentSlug), 'agent', agentSlug, 'agent'));
  }
  const groups = await Promise.all(roots);
  const [globalDisabled, agentDisabled, inheritedDisabled] = await Promise.all([
    disabledSkillNames('user'),
    agentSlug ? disabledSkillNames('agent', agentSlug) : Promise.resolve(new Set<string>()),
    agentSlug ? disabledSkillNames('inherited', agentSlug) : Promise.resolve(new Set<string>()),
  ]);
  const all = groups.flat();
  const winners = new Map<string, CatalogSkill>();
  for (const row of all) {
    row.disabled = row.scope === 'user' ? globalDisabled.has(row.slug) : agentDisabled.has(row.slug);
    row.disabledForAgent = row.scope === 'user' && !!agentSlug && inheritedDisabled.has(row.slug);
    if (row.disabled || row.disabledForAgent) { row.availability = 'disabled'; continue; }
    // 未改动的全局播种镜像不压过同名 bundle（与 listLocalSkills 相同）。
    if (row.provenance === 'builtin-mirror' && winners.has(row.slug)) continue;
    winners.set(row.slug, row);
  }
  for (const row of all) {
    if (row.availability === 'disabled') continue;
    const winner = winners.get(row.slug);
    if (winner && winner.key !== row.key) {
      row.availability = 'shadowed';
      row.shadowedBy = winner.key;
    }
  }
  return all;
}

async function findSkill(key: string, agentSlug?: string): Promise<CatalogSkill> {
  if (!/^[a-f0-9]{24}$/.test(key)) bad('Invalid skill key');
  const skill = (await listSkillCatalog(agentSlug)).find((row) => row.key === key);
  if (!skill) bad('Skill not found', 404);
  return skill;
}

async function checkTree(dir: string, collect = false): Promise<Array<{ path: string; size: number }>> {
  const files: Array<{ path: string; size: number }> = [];
  let bytes = 0;
  const visit = async (current: string, rel: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) bad('Skill directory contains a symbolic link');
      if (entry.isDirectory()) { await visit(child, childRel); continue; }
      if (!entry.isFile()) bad('Skill directory contains an unsupported file type');
      const stat = await fs.lstat(child);
      bytes += stat.size;
      if (files.length >= MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES) bad('Skill directory is too large');
      if (collect) files.push({ path: childRel, size: stat.size });
      else files.push({ path: '', size: 0 });
    }
  };
  await visit(dir, '');
  return files;
}

export async function getSkillCatalogDetail(key: string, agentSlug?: string): Promise<CatalogSkillDetail> {
  const skill = await findSkill(key, agentSlug);
  if (!(await fs.lstat(skill.path)).isDirectory()) bad('Skill directory is not a regular directory', 409);
  const file = path.join(skill.path, 'SKILL.md');
  if (!(await fs.lstat(file)).isFile()) bad('Skill file is not a regular file', 409);
  const { body } = parseFrontmatter(await fs.readFile(file, 'utf8'));
  // 详情能预览文件清单；含不安全 symlink 时仍展示正文但不暴露链接目标。
  let files: Array<{ path: string; size: number }> = [];
  try { files = await checkTree(skill.path, true); } catch { files = [{ path: 'SKILL.md', size: Buffer.byteLength(body) }]; }
  return { ...skill, content: body.trim(), files };
}

async function ownedRoot(scope: SkillScope, agentSlug?: string): Promise<string> {
  if (scope !== 'user' && scope !== 'agent') bad('Invalid skill scope');
  const root = scope === 'user' ? skillsDir() : agentRoot(await checkedAgent(agentSlug));
  await fs.mkdir(tanguHome(), { recursive: true });
  const relative = path.relative(tanguHome(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) bad('Invalid skill root', 403);
  let current = tanguHome();
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (!(await fs.lstat(current)).isDirectory()) bad('Skill root contains a symbolic link', 403);
  }
  const [homeReal, rootReal] = await Promise.all([fs.realpath(tanguHome()), fs.realpath(root)]);
  if (!isInside(homeReal, rootReal)) bad('Skill directory escapes Tangu home', 403);
  return root;
}

function skillSlug(slug: unknown): string {
  if (typeof slug !== 'string' || !SAFE_SLUG.test(slug)) bad('Invalid skill slug');
  return slug;
}
function oneLine(value: unknown): string { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function yamlScalar(value: unknown): string { return JSON.stringify(oneLine(value)); }
function mdFromFields(name: string, description: string, content: string): string {
  return ['---', `name: ${yamlScalar(name)}`, ...(description ? [`description: ${yamlScalar(description)}`] : []), '---', '', content.trim(), ''].join('\n');
}

async function publishDirectory(root: string, slug: string, populate: (stage: string) => Promise<void>): Promise<void> {
  const dest = path.join(root, slug);
  const ensureAbsent = async (): Promise<void> => {
    try { await fs.lstat(dest); bad('Skill already exists', 409); }
    catch (e) {
      if (e instanceof SkillCatalogError || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  };
  await ensureAbsent();
  const stage = path.join(root, `.skill-stage-${randomUUID()}`);
  await fs.mkdir(stage);
  try {
    await populate(stage);
    if (!(await fs.lstat(path.join(stage, 'SKILL.md'))).isFile()) bad('SKILL.md is required');
    await ensureAbsent();
    await fs.rename(stage, dest);
  } finally { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); }
}

export async function createCatalogSkill(input: { scope: SkillScope; agentSlug?: string; slug: string; name: string; description?: string; content: string }): Promise<CatalogSkillDetail> {
  const slug = skillSlug(input.slug);
  const name = oneLine(input.name);
  if (!name || !String(input.content || '').trim()) bad('Name and content are required');
  const root = await ownedRoot(input.scope, input.agentSlug);
  await publishDirectory(root, slug, (stage) => fs.writeFile(path.join(stage, 'SKILL.md'), mdFromFields(name, input.description || '', input.content), { flag: 'wx' }));
  return getSkillCatalogDetail(keyFor(path.join(root, slug)), input.scope === 'agent' ? input.agentSlug : undefined);
}

function replaceFrontmatter(raw: string, patch: { name?: string; description?: string; content?: string }): string {
  const parsed = parseFrontmatter(raw);
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/);
  const entries = match ? match[2].split(/\r?\n/) : [];
  const set = (key: string, value: string): void => {
    const index = entries.findIndex((line) => new RegExp(`^${key}\\s*:`,'i').test(line));
    if (index >= 0) entries[index] = `${key}: ${yamlScalar(value)}`;
    else entries.push(`${key}: ${yamlScalar(value)}`);
  };
  if (patch.name !== undefined) set('name', patch.name);
  if (patch.description !== undefined) set('description', patch.description);
  const body = patch.content !== undefined ? patch.content : parsed.body;
  return ['---', ...entries, '---', '', body.trim(), ''].join('\n');
}

export async function updateCatalogSkill(key: string, patch: { name?: string; description?: string; content?: string }, agentSlug?: string): Promise<CatalogSkillDetail> {
  const skill = await findSkill(key, agentSlug);
  if (skill.readOnly) bad('This skill is read-only; copy it to edit', 403);
  if (patch.name !== undefined && !oneLine(patch.name)) bad('Name cannot be empty');
  if (patch.content !== undefined && !String(patch.content).trim()) bad('Content cannot be empty');
  await ownedRoot(skill.scope, skill.owner || undefined);
  if (!(await fs.lstat(skill.path)).isDirectory()) bad('Skill directory is not a regular directory', 409);
  const file = path.join(skill.path, 'SKILL.md');
  if (!(await fs.lstat(file)).isFile()) bad('Skill file is not a regular file', 409);
  const next = replaceFrontmatter(await fs.readFile(file, 'utf8'), patch);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, next, { flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  return getSkillCatalogDetail(key, agentSlug);
}

export async function setCatalogSkillDisabled(key: string, disabled: boolean, agentSlug?: string): Promise<void> {
  const skill = await findSkill(key, agentSlug);
  if (skill.compatibility) bad('Legacy skill names are read-only; copy with a valid slug to manage', 403);
  const target = skill.scope === 'user' ? (agentSlug ? 'inherited' : 'user') : 'agent';
  await ownedRoot(target === 'user' ? 'user' : 'agent', agentSlug || skill.owner || undefined);
  await setSkillDisabled(target, skill.slug, disabled, agentSlug || skill.owner || undefined);
}

export async function deleteCatalogSkill(key: string, agentSlug?: string): Promise<{ backupPath: string }> {
  const skill = await findSkill(key, agentSlug);
  if (skill.readOnly) bad('This skill is read-only', 403);
  await ownedRoot(skill.scope, skill.owner || undefined);
  if (!(await fs.lstat(skill.path)).isDirectory()) bad('Skill directory is not a regular directory', 409);
  const trash = path.join(tanguHome(), 'skill-trash');
  try { await fs.mkdir(trash); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  if (!(await fs.lstat(trash)).isDirectory()) bad('Skill trash is not a regular directory', 403);
  const backupPath = path.join(trash, `${skill.scope}-${skill.owner || 'global'}-${skill.slug}-${Date.now()}-${randomUUID()}`);
  await fs.rename(skill.path, backupPath); // 整个目录一起移走，辅助文件可恢复
  return { backupPath };
}

async function copyTree(src: string, dest: string): Promise<void> {
  if (!(await fs.lstat(src)).isDirectory()) bad('Source skill is not a regular directory');
  await checkTree(src);
  const copy = async (from: string, to: string): Promise<void> => {
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (entry.name === '.seed-stamp') continue; // 新副本不再由包自动覆盖
      const srcEntry = path.join(from, entry.name);
      const dstEntry = path.join(to, entry.name);
      if (entry.isDirectory()) { await fs.mkdir(dstEntry); await copy(srcEntry, dstEntry); }
      else await fs.copyFile(srcEntry, dstEntry, fsConstants.COPYFILE_EXCL);
    }
  };
  await copy(src, dest);
}

export async function copyCatalogSkill(key: string, target: { scope: SkillScope; agentSlug?: string; slug?: string }, sourceAgentSlug?: string): Promise<CatalogSkillDetail> {
  const source = await findSkill(key, sourceAgentSlug);
  const root = await ownedRoot(target.scope, target.agentSlug);
  const slug = skillSlug(target.slug || source.slug);
  await publishDirectory(root, slug, (stage) => copyTree(source.path, stage));
  return getSkillCatalogDetail(keyFor(path.join(root, slug)), target.scope === 'agent' ? target.agentSlug : undefined);
}

export async function importCatalogSkill(input: { scope: SkillScope; agentSlug?: string; sourcePath: string; slug?: string }): Promise<CatalogSkillDetail> {
  if (typeof input.sourcePath !== 'string' || !path.isAbsolute(input.sourcePath)) bad('An absolute source path is required');
  const sourceStat = await fs.lstat(input.sourcePath).catch(() => null);
  if (!sourceStat || sourceStat.isSymbolicLink()) bad('Source skill not found or is a symbolic link');
  const source = sourceStat.isFile() && path.basename(input.sourcePath) === 'SKILL.md'
    ? path.dirname(input.sourcePath) : input.sourcePath;
  if (!(await fs.lstat(source)).isDirectory()) bad('Choose a skill directory or SKILL.md');
  if (!(await fs.lstat(path.join(source, 'SKILL.md')).catch(() => null))?.isFile()) bad('The directory needs a regular SKILL.md');
  const slug = skillSlug(input.slug || path.basename(source));
  const root = await ownedRoot(input.scope, input.agentSlug);
  await publishDirectory(root, slug, (stage) => copyTree(source, stage));
  return getSkillCatalogDetail(keyFor(path.join(root, slug)), input.scope === 'agent' ? input.agentSlug : undefined);
}
