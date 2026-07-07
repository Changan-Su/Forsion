/**
 * 本地技能加载:扫描 [包内 skills/, ~/.tangu/skills/] 的 <目录>/SKILL.md。
 * 解析 YAML frontmatter(轻量内置解析;复杂 YAML 回退文件名/首段),产出 SkillRecord 形状
 * (id 一律 `local:` 前缀,与云端 id 永不冲突)。mtime 缓存:目录树变更自动失效,无需重启。
 * 仅 standalone/TUI 经 localAssetsBrain overlay 消费;microserver/worker 不触本模块。
 *
 * 注:外部引擎(Claude Code / Codex)的技能**不再**在此自动识别——那会让外来技能冒充自有技能,
 * 混进目录与 system prompt 被 use_skill 直接调用。改由「设置 → Agent CLIs」逐个显式导入
 * (整夹复制进 ~/.tangu/skills/),导入后才以 `local:` 出现。见 engines/assets.ts。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillsDir as userSkillsDir, agentsDir } from '../core/tanguHome.js';
import { currentDisplayAgentSlug, currentRunCwd } from '../seams/runContext.js';
import type { SkillRecord } from '../core/types.js';

export const LOCAL_SKILL_PREFIX = 'local:';

type SkillSource = 'builtin' | 'user' | 'agent' | 'project';

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 包内置技能目录(打包进 npm files;dist/skills/../../skills → 包根 skills/)。 */
function builtinSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/skills
  return path.resolve(here, '..', '..', 'skills');
}

/** 某内置 agent 的默认技能目录(包根 agent-skills/<slug>/;供该 agent 激活时按 agent 级加载 + 播种)。 */
export function builtinAgentSkillsDir(slug: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'agent-skills', slug);
}
/** agent 私有技能目录 ~/.forsion/agents/<slug>/skills(用户为该 agent 增改的)。 */
function agentSkillsDir(slug: string): string {
  return path.join(agentsDir(), slug, 'skills');
}
/** 项目级技能目录 <cwd>/.forsion/skills(对标 Claude Code 的 .claude/skills)。 */
function projectSkillsDir(cwd: string): string {
  return path.join(cwd, '.forsion', 'skills');
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
  return {
    id,
    app_id: 'tangu',
    name: meta.name || fallbackName,
    description: meta.description || firstLine.slice(0, 200) || null,
    icon: meta.icon || null,
    category: meta.category || (source === 'builtin' ? 'built-in' : source === 'agent' ? 'agent' : source === 'project' ? 'project' : 'local'),
    version: meta.version || null,
    author: meta.author || null,
    tools: null,
    content: body.trim(),
    visibility: 'private',
    is_builtin: source === 'builtin',
    // 非标准列:localAssetsBrain/路由透传给客户端打来源徽标
    source: 'local',
  } as SkillRecord & { source: string };
}

async function scanDir(dir: string, source: SkillSource): Promise<SkillRecord[]> {
  const stamp = await dirStamp(dir);
  const cached = cache.get(dir);
  if (cached && cached.stamp === stamp) return cached.skills;

  const skills: SkillRecord[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    cache.set(dir, { stamp, skills });
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
    skills.push(toRecord(`${LOCAL_SKILL_PREFIX}${e.name}`, e.name, raw, source));
  }
  cache.set(dir, { stamp, skills });
  return skills;
}

let seeded = false;

/** 把 srcDir 下的技能子目录复制进 destRoot(逐个;目标已存在则跳过——不覆盖用户编辑/导入)。按目录工作,便于测试。 */
export async function seedSkillsInto(srcDir: string, destRoot: string): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(srcDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return; // 源不存在 → 跳过
  }
  await fs.mkdir(destRoot, { recursive: true }).catch(() => {});
  for (const name of names) {
    const dest = path.join(destRoot, name);
    try {
      await fs.access(path.join(dest, 'SKILL.md')); // 已存在 → 跳过(护用户改动)
    } catch {
      await fs.cp(path.join(srcDir, name), dest, { recursive: true }).catch(() => {});
    }
  }
}

/**
 * 首启把包内置技能复制进 ~/.tangu/skills,让内置技能像 Claude/Codex 那样落用户家目录、可见可改。
 * 已存在则跳过(护用户编辑/导入);包内副本仍作运行时来源 + 兜底(复制失败/首跑竞态时不至于看不到技能)。
 * 幂等,进程内只跑一次。
 */
export async function seedBuiltinSkills(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await seedSkillsInto(builtinSkillsDir(), userSkillsDir());
}

/** 列出当前 run 可见的本地技能。四级作用域,越具体越优先(同 id 覆盖):
 *  内置(全局) < 用户 ~/.forsion/skills < **当前 agent** agents/<slug>/skills(+包内置默认) < **项目** <cwd>/.forsion/skills。
 *  agent/项目级仅在有激活 agent / host cwd 时加入,故云端/无上下文时行为与原来一致。 */
export async function listLocalSkills(): Promise<SkillRecord[]> {
  await seedBuiltinSkills(); // 首启把内置复制进 ~/.forsion/skills(幂等;覆盖 TUI 等不走 standalone 启动的入口)
  const roots: Array<[string, SkillSource]> = [
    [builtinSkillsDir(), 'builtin'],
    [userSkillsDir(), 'user'],
  ];
  const slug = currentDisplayAgentSlug();
  if (slug && SAFE_SLUG.test(slug)) {
    roots.push([builtinAgentSkillsDir(slug), 'agent']); // 该 agent 的包内置默认技能
    roots.push([agentSkillsDir(slug), 'agent']);        // 用户为该 agent 增改的(覆盖同 id 默认)
  }
  const cwd = currentRunCwd();
  if (cwd) roots.push([projectSkillsDir(cwd), 'project']);

  const scanned = await Promise.all(roots.map(([dir, src]) => scanDir(dir, src)));
  const byId = new Map<string, SkillRecord>();
  for (const list of scanned) for (const s of list) byId.set(s.id, s); // 后面的根覆盖前面(越具体越优先)
  return [...byId.values()];
}

export async function getLocalSkill(id: string): Promise<SkillRecord | null> {
  if (!id.startsWith(LOCAL_SKILL_PREFIX)) return null;
  const all = await listLocalSkills();
  return all.find((s) => s.id === id) || null;
}
