/**
 * 独立团队注册表(Agent 轨道的持久团队实体;方案 §6.1):~/.tangu/teams/<slug>/{config.toml, TEAM.md, Library/}。
 * 照 agentRegistry 的形状:config.toml 落盘(数组表尾置、多行正文用 ''' 字面串)、mtime 指纹缓存、.meta.json 顺序;
 * 解析/序列化是纯函数(本地云端共用一份)。项目轨道的「团队模式」不落盘、与本文件无关。
 * 发现:v1 单源 = teamsDir(),不扫 cwd;'teams' / .tangu / .forsion 绝不进 PROJECT_ROOT_MARKERS。
 */
import { promises as fs, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { teamsDir } from '../core/tanguHome.js';
import { AVATAR_EXT_MIME, AVATAR_MAX_BYTES, AVATAR_MIME_EXT, isValidSlug, slugify } from './agentRegistry.js';

export interface TeamMember { slug: string; role: string }
export interface TeamDef {
  slug: string;
  name: string;
  description: string;
  /** 可选:起头发言人;缺省 = 第一位成员。调度不走它(被 @ 者优先 → 成员序轮转),只是元数据。
   *  09-16 起团队没有运行模式与轮数上限(旧 config.toml 里的 mode / max_rounds 读时忽略、写时不再落盘)。 */
  lead: string;
  /** 可选 emoji 或 Library/avatar.* 文件名;空 = 成员头像组合。 */
  avatar: string;
  /** 数组顺序 = 发言顺序。 */
  members: TeamMember[];
  createdAt: string;
  /** TEAM.md 正文(模型读取,英文);上限 16KB,超限截断。 */
  doc: string;
  /** 团队会话的 cwd(绝对路径)。 */
  libraryDir: string;
}

export const TEAM_DOC_MAX = 16 * 1024;

export const teamDirOf = (slug: string): string => path.join(teamsDir(), slug);
export const teamLibDirOf = (slug: string): string => path.join(teamDirOf(slug), 'Library');

export function parseTeamConfig(slug: string, tomlRaw: string, doc: string): TeamDef {
  let meta: Record<string, any> = {};
  try { meta = (parseToml(tomlRaw) as Record<string, any>) || {}; } catch { meta = {}; }
  const str = (v: any): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const members: TeamMember[] = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(meta.members) ? meta.members : []) {
    const s = str(m?.slug).trim();
    if (!isValidSlug(s) || seen.has(s)) continue;
    seen.add(s);
    members.push({ slug: s, role: str(m?.role).trim().slice(0, 500) });
  }
  const lead = str(meta.lead).trim();
  return {
    slug,
    name: str(meta.name) || slug,
    description: str(meta.description),
    lead: seen.has(lead) ? lead : (members[0]?.slug || ''),
    avatar: str(meta.avatar).trim().slice(0, 16),
    members,
    createdAt: str(meta.created_at),
    doc: doc.length > TEAM_DOC_MAX ? doc.slice(0, TEAM_DOC_MAX) : doc,
    libraryDir: teamLibDirOf(slug),
  };
}

/** 数组表([[members]])必须尾置:smol-toml 会把顶层标量排在前面,但手写时也别把标量放到 [[members]] 之后(会被吃进最后一个成员)。 */
export function serializeTeamConfig(def: TeamDef): string {
  const head: Record<string, unknown> = { name: def.name };
  if (def.description) head.description = def.description;
  if (def.lead) head.lead = def.lead;
  if (def.avatar) head.avatar = def.avatar;
  head.created_at = def.createdAt || new Date().toISOString();
  const tail = def.members.map((m) => `[[members]]\nslug = ${JSON.stringify(m.slug)}\n${m.role ? `role = ${JSON.stringify(m.role)}\n` : ''}`).join('');
  return stringifyToml(head) + (tail ? '\n' + tail : '');
}

async function parseTeamFolder(slug: string, dir: string): Promise<TeamDef> {
  const toml = await fs.readFile(path.join(dir, 'config.toml'), 'utf8');
  const doc = await fs.readFile(path.join(dir, 'TEAM.md'), 'utf8').catch(() => '');
  return parseTeamConfig(slug, toml, doc);
}

// ── mtime 缓存(config.toml + TEAM.md + .meta.json 指纹)──
let cache: { stamp: string; defs: TeamDef[] } | null = null;
async function dirStamp(dir: string): Promise<string> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 'missing'; }
  const parts: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!isValidSlug(e.name)) continue;
      for (const f of ['config.toml', 'TEAM.md']) {
        try { const st = await fs.stat(path.join(dir, e.name, f)); parts.push(`${e.name}/${f}:${st.mtimeMs}`); } catch { /* ignore */ }
      }
    } else if (e.isFile() && e.name === '.meta.json') {
      try { const st = await fs.stat(path.join(dir, e.name)); parts.push(`.meta:${st.mtimeMs}`); } catch { /* ignore */ }
    }
  }
  return parts.sort().join('|');
}

export interface TeamsMeta { order: string[] }
const metaFile = (): string => path.join(teamsDir(), '.meta.json');
export function readTeamsMeta(): TeamsMeta {
  try {
    const m = JSON.parse(readFileSync(metaFile(), 'utf8'));
    return { order: Array.isArray(m.order) ? m.order.filter((s: any) => typeof s === 'string') : [] };
  } catch { return { order: [] }; }
}
export async function writeTeamsMeta(patch: Partial<TeamsMeta>): Promise<TeamsMeta> {
  const next: TeamsMeta = { order: Array.isArray(patch.order) ? patch.order.filter((s) => typeof s === 'string' && isValidSlug(s)) : readTeamsMeta().order };
  mkdirSync(teamsDir(), { recursive: true });
  await fs.writeFile(metaFile(), JSON.stringify(next, null, 2), 'utf-8');
  cache = null;
  return next;
}

export async function listTeams(): Promise<TeamDef[]> {
  const dir = teamsDir();
  const stamp = await dirStamp(dir);
  if (cache && cache.stamp === stamp) return cache.defs;
  const defs: TeamDef[] = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { cache = { stamp, defs }; return defs; }
  for (const e of entries) {
    if (!e.isDirectory() || !isValidSlug(e.name)) continue;
    if (!existsSync(path.join(dir, e.name, 'config.toml'))) continue;
    try { defs.push(await parseTeamFolder(e.name, path.join(dir, e.name))); } catch { /* 跳过坏目录 */ }
  }
  const order = readTeamsMeta().order;
  const idx = (s: string): number => { const i = order.indexOf(s); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  defs.sort((a, b) => { const d = idx(a.slug) - idx(b.slug); return d !== 0 ? d : a.name.localeCompare(b.name); });
  cache = { stamp, defs };
  return defs;
}

export async function getTeam(slug: string): Promise<TeamDef | null> {
  if (!slug || !isValidSlug(slug)) return null;
  const dir = teamDirOf(slug);
  if (!existsSync(path.join(dir, 'config.toml'))) return null;
  try { return await parseTeamFolder(slug, dir); } catch { return null; }
}

export interface SaveTeamInput {
  slug?: string;
  name: string;
  description?: string;
  lead?: string;
  avatar?: string;
  members?: Array<{ slug: string; role?: string }>;
  doc?: string;
}

/** 纯函数:由输入 + 既有定义合成新定义(members 未传则保留既有)。至少 2 名有效成员。 */
export function buildTeamDef(slug: string, existing: TeamDef | null, input: SaveTeamInput): TeamDef {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  if (!input.name?.trim()) throw new Error('name required');
  const seen = new Set<string>();
  const members: TeamMember[] = (input.members ?? existing?.members ?? [])
    .map((m) => ({ slug: String(m?.slug || '').trim(), role: String(m?.role || '').trim().slice(0, 500) }))
    .filter((m) => isValidSlug(m.slug) && !seen.has(m.slug) && (seen.add(m.slug), true));
  if (members.length < 2) throw new Error('a team needs at least 2 members');
  const lead = (input.lead ?? existing?.lead ?? '').trim();
  const doc = (input.doc ?? existing?.doc ?? '').replace(/\r\n/g, '\n');
  return {
    slug,
    name: input.name.trim().slice(0, 100),
    description: (input.description ?? existing?.description ?? '').trim().slice(0, 500),
    lead: seen.has(lead) ? lead : members[0].slug,
    avatar: (input.avatar ?? existing?.avatar ?? '').trim().slice(0, 16),
    members,
    createdAt: existing?.createdAt || new Date().toISOString(),
    doc: doc.length > TEAM_DOC_MAX ? doc.slice(0, TEAM_DOC_MAX) : doc,
    libraryDir: teamLibDirOf(slug),
  };
}

/** 按 slug upsert(POST 的唯一化在路由做;想更新走 PATCH)。 */
export async function saveTeam(input: SaveTeamInput): Promise<TeamDef> {
  const slug = input.slug && isValidSlug(input.slug) ? input.slug : slugify(input.name || '');
  const existing = await getTeam(slug);
  const def = buildTeamDef(slug, existing, input);
  const dir = teamDirOf(slug);
  mkdirSync(path.join(dir, 'Library'), { recursive: true });
  await fs.writeFile(path.join(dir, 'config.toml'), serializeTeamConfig(def), 'utf-8');
  await fs.writeFile(path.join(dir, 'TEAM.md'), def.doc, 'utf-8');
  cache = null;
  return def;
}

export async function deleteTeam(slug: string): Promise<boolean> {
  if (!isValidSlug(slug)) return false;
  try { await fs.rm(teamDirOf(slug), { recursive: true, force: true }); cache = null; return true; } catch { return false; }
}

const TEAM_AVATAR_FILE = /^avatar\.(png|jpe?g|gif|webp)$/i;

/** 写团队头像进 Library/avatar.<ext> 并更新 config.avatar；校验类型/大小；返回文件名。 */
export async function saveTeamAvatar(slug: string, base64: string, mimeType: string): Promise<string> {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  const ext = AVATAR_MIME_EXT[String(mimeType).toLowerCase()];
  if (!ext) throw new Error('unsupported image type (png/jpeg/gif/webp only)');
  const raw = base64.includes(',') && base64.trimStart().startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('empty image');
  if (buf.length > AVATAR_MAX_BYTES) throw new Error('image too large (max 1MB)');
  const cur = await getTeam(slug);
  if (!cur) throw new Error('team not found');
  const libDir = teamLibDirOf(slug);
  mkdirSync(libDir, { recursive: true });
  try {
    for (const file of await fs.readdir(libDir)) {
      if (TEAM_AVATAR_FILE.test(file)) await fs.rm(path.join(libDir, file), { force: true }).catch(() => { /* ignore */ });
    }
  } catch { /* ignore */ }
  const filename = `avatar.${ext}`;
  await fs.writeFile(path.join(libDir, filename), buf);
  await saveTeam({
    slug, name: cur.name, description: cur.description, lead: cur.lead, avatar: filename,
    members: cur.members, doc: cur.doc,
  });
  return filename;
}

/** 读取团队头像二进制；emoji / 空头像返回 null。 */
export async function readTeamAvatar(slug: string): Promise<{ data: Buffer; mimeType: string } | null> {
  if (!isValidSlug(slug)) return null;
  const cur = await getTeam(slug);
  if (!cur?.avatar || !TEAM_AVATAR_FILE.test(cur.avatar)) return null;
  const ext = (cur.avatar.split('.').pop() || '').toLowerCase();
  try {
    return { data: await fs.readFile(path.join(teamLibDirOf(slug), cur.avatar)), mimeType: AVATAR_EXT_MIME[ext] || 'application/octet-stream' };
  } catch { return null; }
}

/** 删除图片头像并清空 config.avatar；无图片时也按成功返回。 */
export async function deleteTeamAvatar(slug: string): Promise<boolean> {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  const cur = await getTeam(slug);
  if (!cur) throw new Error('team not found');
  const libDir = teamLibDirOf(slug);
  try {
    for (const file of await fs.readdir(libDir)) {
      if (TEAM_AVATAR_FILE.test(file)) await fs.rm(path.join(libDir, file), { force: true }).catch(() => { /* ignore */ });
    }
  } catch { /* no files */ }
  await saveTeam({
    slug, name: cur.name, description: cur.description, lead: cur.lead, avatar: '',
    members: cur.members, doc: cur.doc,
  });
  return true;
}
