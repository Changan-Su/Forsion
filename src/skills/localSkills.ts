/**
 * 本地技能加载:扫描 [包内 skills/, ~/.tangu/skills/] 的 <目录>/SKILL.md,外加**实时识别外部生态**
 * (默认开,env TANGU_EXTERNAL_SKILLS=off 关闭):
 *   - ~/.claude/skills/<目录>/SKILL.md → id `local:claude:<目录>`(Claude Code 技能,零拷贝直读)
 *   - ~/.codex/prompts/<名>.md        → id `local:codex:<名>`(Codex prompt 当技能)
 * 解析 YAML frontmatter(轻量内置解析,兼容 .claude 技能的常见单行字段;复杂 YAML 回退
 * 文件名/首段),产出 SkillRecord 形状(id 一律 `local:` 前缀,与云端 id 永不冲突)。
 * mtime 缓存:目录树变更(新增/编辑)自动失效,无需重启。
 * 仅 standalone/TUI 经 localAssetsBrain overlay 消费;microserver/worker 不触本模块。
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillsDir as userSkillsDir } from '../core/tanguHome.js';
import type { SkillRecord } from '../core/types.js';

export const LOCAL_SKILL_PREFIX = 'local:';

type SkillSource = 'builtin' | 'user' | 'claude' | 'codex';

function externalSkillsEnabled(): boolean {
  return process.env.TANGU_EXTERNAL_SKILLS !== 'off';
}

/** 包内置技能目录(打包进 npm files;dist/skills/../../skills → 包根 skills/)。 */
function builtinSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/skills
  return path.resolve(here, '..', '..', 'skills');
}

/** 极简 frontmatter 解析:--- 包围块内的顶层 `key: value` 单行标量(带引号可)。 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    if (/^\s/.test(line)) continue; // 嵌套结构(metadata: 等)跳过
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1].toLowerCase()] = v;
  }
  return { meta, body: raw.slice(m[0].length) };
}

interface CacheEntry {
  stamp: string;
  skills: SkillRecord[];
}
const cache = new Map<string, CacheEntry>();

/** 目录树指纹:各技能 SKILL.md 的 mtime 拼接(目录浅扫,够用且快)。 */
async function dirStamp(dir: string): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 'missing';
  }
  const parts: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const st = await fs.stat(path.join(dir, e.name, 'SKILL.md'));
      parts.push(`${e.name}:${st.mtimeMs}`);
    } catch {
      /* 无 SKILL.md 的目录忽略 */
    }
  }
  return parts.sort().join('|');
}

function toRecord(id: string, fallbackName: string, raw: string, source: SkillSource): SkillRecord {
  const { meta, body } = parseFrontmatter(raw);
  const firstLine = body.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() || '';
  const defaultCategory =
    source === 'builtin' ? 'built-in' : source === 'claude' ? 'claude-code' : source === 'codex' ? 'codex' : 'local';
  return {
    id,
    app_id: 'tangu',
    name: meta.name || fallbackName,
    description: meta.description || firstLine.slice(0, 200) || null,
    icon: meta.icon || null,
    category: meta.category || defaultCategory,
    version: meta.version || null,
    author: meta.author || null,
    tools: null,
    content: body.trim(),
    visibility: 'private',
    is_builtin: source === 'builtin',
    // 非标准列:localAssetsBrain/路由透传给客户端打来源徽标
    source: source === 'builtin' || source === 'user' ? 'local' : source,
  } as SkillRecord & { source: string };
}

async function scanDir(dir: string, source: SkillSource, idPrefix = ''): Promise<SkillRecord[]> {
  const cacheKey = `${dir}|${idPrefix}`;
  const stamp = await dirStamp(dir);
  const cached = cache.get(cacheKey);
  if (cached && cached.stamp === stamp) return cached.skills;

  const skills: SkillRecord[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    cache.set(cacheKey, { stamp, skills });
    return skills;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    skills.push(toRecord(`${LOCAL_SKILL_PREFIX}${idPrefix}${e.name}`, e.name, raw, source));
  }
  cache.set(cacheKey, { stamp, skills });
  return skills;
}

/** 平铺 .md 目录(codex prompts):每个 <名>.md 一个技能。 */
async function scanFlatMdDir(dir: string, source: SkillSource, idPrefix: string): Promise<SkillRecord[]> {
  const cacheKey = `${dir}|flat|${idPrefix}`;
  let stamp = 'missing';
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
    const parts: string[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      try {
        const st = await fs.stat(path.join(dir, e.name));
        parts.push(`${e.name}:${st.mtimeMs}`);
      } catch { /* ignore */ }
    }
    stamp = parts.sort().join('|');
  } catch {
    entries = null;
  }
  const cached = cache.get(cacheKey);
  if (cached && cached.stamp === stamp) return cached.skills;

  const skills: SkillRecord[] = [];
  if (entries) {
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, e.name), 'utf-8');
      } catch {
        continue;
      }
      const stem = e.name.slice(0, -3);
      skills.push(toRecord(`${LOCAL_SKILL_PREFIX}${idPrefix}${stem}`, stem, raw, source));
    }
  }
  cache.set(cacheKey, { stamp, skills });
  return skills;
}

/**
 * 列出全部本地技能:包内置 + ~/.tangu/skills(同 id 用户覆盖内置)
 * + 外部生态实时识别(~/.claude/skills、~/.codex/prompts;id 前缀隔离,永不与前两者撞)。
 */
export async function listLocalSkills(): Promise<SkillRecord[]> {
  const scans: Array<Promise<SkillRecord[]>> = [
    scanDir(builtinSkillsDir(), 'builtin'),
    scanDir(userSkillsDir(), 'user'),
  ];
  if (externalSkillsEnabled()) {
    scans.push(scanDir(path.join(homedir(), '.claude', 'skills'), 'claude', 'claude:'));
    scans.push(scanFlatMdDir(path.join(homedir(), '.codex', 'prompts'), 'codex', 'codex:'));
  }
  const [builtin, user, ...external] = await Promise.all(scans);
  const byId = new Map<string, SkillRecord>();
  for (const s of builtin) byId.set(s.id, s);
  for (const s of user) byId.set(s.id, s); // 用户同名覆盖内置
  for (const list of external) for (const s of list) byId.set(s.id, s);
  return [...byId.values()];
}

export async function getLocalSkill(id: string): Promise<SkillRecord | null> {
  if (!id.startsWith(LOCAL_SKILL_PREFIX)) return null;
  const all = await listLocalSkills();
  return all.find((s) => s.id === id) || null;
}
