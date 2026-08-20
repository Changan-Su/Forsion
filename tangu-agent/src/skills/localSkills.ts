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
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillsDir as userSkillsDir, agentsDir } from '../core/tanguHome.js';
import { bundleSkillRoots } from '../plugins/bundles.js';
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

let seeding: Promise<SeedReport> | null = null;

/**
 * 播种指纹:**与被描述的东西同住**——写在技能目录里的 `.seed-stamp`,内容 = 我们写下去时**整棵目录树**的哈希。
 *
 * 为什么不是集中式账本(第一版就是,codex 一次打穿):账本与目录是两次独立写入,复制成功而账本写失败
 * (只读/磁盘满)就永久错位——目标已是 v2、账本还记 v1,下一版把它误判成「用户改过」而永久停更;
 * 反过来复制中途失败、账本却已推进,缺的文件永远补不回来。同住 + 整目录原子替换就没有这个断层。
 *
 * 为什么哈希整棵树而不只 SKILL.md:用户可能只改了 `scripts/` 或模板而没碰 SKILL.md,只看 SKILL.md
 * 会把他的改动当「没动过」覆盖掉。
 */
const SEED_STAMP = '.seed-stamp';

/** 操作系统垃圾:不是技能内容,却会进哈希 —— 2026-08-19 实翻:`skill-creator` 因为源与家目录各有
 *  一个内容不同的 `.DS_Store`(Finder 一开文件夹就写),被永久判成「用户改过」保护住,内置更新
 *  再也传不下去,还朝用户喊「删掉你的技能目录」。判据必须只看技能内容。 */
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** 目录树指纹:相对路径 + 内容,排序后一起哈希;`.seed-stamp` 与 OS 垃圾不参与(都不是内容)。
 *
 *  ⚠️ **收窄参与集不是自动向后兼容的**(Codex 2026-08-19 P1):老版本按「含 OS 垃圾」算出的指纹
 *  已经写在用户机器上了。若只改算法不认旧值,那些**目录里恰好有 `.DS_Store` 的、原本一直正常跟更新的**
 *  镜像会在下一次内置更新时算出不同的 curHash → 被误判成「用户改过」→ 永久停更。也就是把本次要修的
 *  病换个人群复发。所以判定处必须**两种算法都认**(`legacy=true` 复现旧值),更新/自愈时再把指纹
 *  改写成新算法值,逐台迁移过去。 */
async function treeHash(dir: string, legacy = false): Promise<string | null> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && r !== SEED_STAMP && (legacy || !OS_JUNK.has(e.name))) files.push(r);
    }
  };
  try {
    await walk('');
  } catch {
    return null; // 目录不存在
  }
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(await fs.readFile(path.join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

const readStamp = async (dir: string): Promise<string | null> =>
  fs
    .readFile(path.join(dir, SEED_STAMP), 'utf8')
    .then((s) => s.trim() || null)
    .catch(() => null);

/**
 * 整目录**替换**(不是 merge):先复制到同盘暂存目录,再原子换上去。
 * merge 的毛病是源里删掉的文件会残留在用户那边 —— 上一版留下的脚本还在,还可能被枚举执行(codex)。
 * 指纹写在暂存目录里一起换上去,所以「目录内容」与「它的指纹」永远是同一次提交,不会各自成功一半。
 */
async function replaceDir(srcDir: string, destDir: string, stamp: string): Promise<boolean> {
  const staging = `${destDir}.seed-tmp-${process.pid}`;
  const trash = `${destDir}.seed-old-${process.pid}`;
  try {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.cp(srcDir, staging, { recursive: true });
    await fs.writeFile(path.join(staging, SEED_STAMP), stamp, 'utf8');
    let hadOld = false;
    try {
      await fs.rename(destDir, trash);
      hadOld = true;
    } catch {
      /* 目标本来就不存在 */
    }
    try {
      await fs.rename(staging, destDir);
    } catch (e) {
      if (hadOld) await fs.rename(trash, destDir).catch(() => {}); // 换不上去 → 把旧的放回来
      throw e;
    }
    if (hadOld) await fs.rm(trash, { recursive: true, force: true }).catch(() => {});
    return true;
  } catch {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

export interface SeedReport {
  installed: string[];
  updated: string[];
  /** 有新版但被保护住没更新的(用户改过 / 老装机无指纹)。上层据此提示,而不是静默停更。 */
  protectedStale: string[];
}

/**
 * 把 srcDir 下的技能子目录复制进 destRoot。按目录工作,便于测试。
 *
 * 语义(2026-07-26 改):**用户没改过的副本跟着内置更新,改过的原样保护**。
 * 旧写法是「目标已存在就永远跳过」,本意护用户改动,实际后果是内置技能的修订**永远传不下去** ——
 * 而查表时用户目录优先,于是陈年副本一直遮住仓库里已修好的版本(实测:forsion-plugin 仓库 1.3.0、
 * 家目录 1.0.0,新增的一整节 agent 根本看不到)。
 *
 * 判据是**目录树哈希**而非版本号:版本号靠作者自觉 bump,哈希不会说谎。
 *
 * ⚠️**没有指纹的既有副本一律保护,不自动迁移**。诱惑是「假定它没被改过,覆盖了事」——但那会吃掉用户
 * 在旧机制下做过的所有编辑,而旧机制恰恰鼓励编辑(播种的初衷就是「可见可改」)。代价是老装机上的陈年
 * 副本仍挡着新版,所以这里**必须把话说出来**(见 protectedStale),让上层提示用户,而不是静默停更。
 */
export async function seedSkillsInto(srcDir: string, destRoot: string): Promise<SeedReport> {
  const out: SeedReport = { installed: [], updated: [], protectedStale: [] };
  let names: string[];
  try {
    names = (await fs.readdir(srcDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return out; // 源不存在 → 跳过
  }
  await fs.mkdir(destRoot, { recursive: true }).catch(() => {});
  for (const name of names) {
    const srcSkill = path.join(srcDir, name);
    const dest = path.join(destRoot, name);
    const hasSkillMd = await fs
      .access(path.join(srcSkill, 'SKILL.md'))
      .then(() => true)
      .catch(() => false);
    if (!hasSkillMd) continue; // 不是技能目录
    const srcHash = await treeHash(srcSkill);
    if (!srcHash) continue;
    const curHash = await treeHash(dest);
    if (curHash === null) {
      if (await replaceDir(srcSkill, dest, srcHash)) out.installed.push(name);
      continue;
    }
    if (curHash === srcHash) {
      // 已经是这一版。老装机可能没有指纹、或指纹是旧算法(含 OS 垃圾)算的 → 写一个新算法值:
      // 内容既然与内置逐字节相同,改它吃不掉任何改动,于是下一次内置更新就能正常跟上
      // (这是老装机唯一安全的自愈口子;旧算法指纹的迁移也走这里)。
      if ((await readStamp(dest)) !== curHash) {
        await fs.writeFile(path.join(dest, SEED_STAMP), srcHash, 'utf8').catch(() => {});
      }
      continue;
    }
    const stamp = await readStamp(dest);
    // 指纹与「现在的目录内容」对得上 = 用户没动过。新旧两种算法都认:旧值是上一版代码写下的,
    // 不认它就等于把一批本来正常的镜像判成「用户改过」(见 treeHash 注释)。更新后写的是新算法值。
    const untouched = !!stamp && (stamp === curHash || stamp === (await treeHash(dest, true)));
    if (untouched) {
      if (await replaceDir(srcSkill, dest, srcHash)) out.updated.push(name); // 用户没动过 → 跟着更新
    } else {
      out.protectedStale.push(name); // 用户改过 / 老装机无指纹 → 保护并报告
    }
  }
  return out;
}

/**
 * 首启把包内置技能复制进 ~/.tangu/skills,让内置技能像 Claude/Codex 那样落用户家目录、可见可改。
 * 已存在则跳过(护用户编辑/导入);包内副本仍作运行时来源 + 兜底(复制失败/首跑竞态时不至于看不到技能)。
 * 幂等,进程内只跑一次。
 */
export async function seedBuiltinSkills(): Promise<SeedReport> {
  // ⚠️共享 Promise,不是布尔闩:布尔闩的语义其实是「后来的调用**不等**第一次跑完」——并发首调会去扫
  // 一个正在被写的目录,读到半个技能;而且第一次抛错后闩仍为 true,本进程永不重试(codex)。
  if (!seeding) {
    seeding = seedSkillsInto(builtinSkillsDir(), userSkillsDir()).catch((e) => {
      seeding = null; // 失败允许下次重试
      throw e;
    });
  }
  const r = await seeding;
  // 有新版却被保护住的,说出来 —— 静默停更就是这次事故的成因(用户看不到内置技能已经修好了)。
  if (r.protectedStale.length) {
    console.warn(
      `[skills] 内置技能有更新但你的副本不同,已保护未覆盖: ${r.protectedStale.join(', ')}。` +
        `想用新版就删掉 ${userSkillsDir()}/<名字> 后重启。`,
    );
  }
  return r;
}

/** 列出当前 run 可见的本地技能。作用域从泛到专,越具体越优先(同 id 覆盖):
 *  内置(全局) < bundle(Forsion 插件内嵌) < 用户 ~/.forsion/skills < **当前 agent** agents/<slug>/skills(+包内置默认) < **项目** <cwd>/.forsion/skills。
 *  agent/项目级仅在有激活 agent / host cwd 时加入,故云端/无上下文时行为与原来一致。 */
/** 用户目录里指纹仍匹配的技能 id 集合 —— 即「原样的内置镜像,用户没动过」。 */
async function untouchedMirrors(destRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  let names: string[];
  try {
    names = (await fs.readdir(destRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  await Promise.all(
    names.map(async (n) => {
      const dir = path.join(destRoot, n);
      const stamp = await readStamp(dir);
      if (stamp && stamp === (await treeHash(dir))) out.add(`${LOCAL_SKILL_PREFIX}${n}`);
    }),
  );
  return out;
}

export async function listLocalSkills(): Promise<SkillRecord[]> {
  await seedBuiltinSkills(); // 首启把内置复制进 ~/.forsion/skills(幂等;覆盖 TUI 等不走 standalone 启动的入口)
  const roots: Array<[string, SkillSource]> = [
    [builtinSkillsDir(), 'builtin'],
    // Forsion bundle 内嵌技能(共享域 plugins/<id>/skills/):内置 < bundle < 用户(同 id 用户改动胜)
    ...bundleSkillRoots().map((d): [string, SkillSource] => [d, 'user']),
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
  // ⚠️用户目录里那些**未被改动的内置镜像**不算「用户技能」:它们只是为了可见可改而复制过去的副本,
  // 却因为排在最后而把同名的 bundle 技能盖掉,声明的 builtin < bundle < user 优先级形同虚设(codex)。
  // 判据:目录指纹仍等于我们写下去时的那一份 = 用户没动过 → 降格,让 bundle 能盖住它;
  // 用户真改过才升格为 user 层。
  const mirrors = await untouchedMirrors(userSkillsDir());
  const bundleRoots = new Set(bundleSkillRoots());
  const fromBundle = new Set<string>();
  const byId = new Map<string, SkillRecord>();
  for (let i = 0; i < scanned.length; i++) {
    const isUserRoot = roots[i][0] === userSkillsDir();
    const isBundleRoot = bundleRoots.has(roots[i][0]);
    for (const s of scanned[i]) {
      if (isUserRoot && mirrors.has(s.id) && byId.has(s.id)) continue; // 未改镜像不覆盖已有(bundle)条目
      // ⚠️无指纹的用户副本挡住 bundle 技能 —— 说出来,别静默。
      // 怎么会有这种副本:某个技能原本是**内置**、被播种进用户目录,后来它随能力搬进了 Forsion 插件
      // 捆绑包。播种早于指纹机制的老装机留下的那份没有指纹,于是既判不出「用户没改过」(不能降格),
      // 内置源也没了(seedSkillsInto 再也扫不到它,连 protectedStale 都报不出来)→ 用户永远用着
      // 陈年版本还不知道。分不清「老副本」与「用户自己写的同名技能」是设计使然(所以不自动删),
      // 但把话说出来的成本是零。
      if (isUserRoot && fromBundle.has(s.id) && !mirrors.has(s.id)) {
        console.warn(
          `[skills] ${userSkillsDir()}/${s.id.slice(LOCAL_SKILL_PREFIX.length)} 挡住了插件随包提供的同名技能。` +
            `没改过它就删掉该目录,以后随插件更新。`,
        );
      }
      if (isBundleRoot) fromBundle.add(s.id);
      byId.set(s.id, s);
    }
  }
  return [...byId.values()];
}

export async function getLocalSkill(id: string): Promise<SkillRecord | null> {
  if (!id.startsWith(LOCAL_SKILL_PREFIX)) return null;
  const all = await listLocalSkills();
  return all.find((s) => s.id === id) || null;
}

/** 该 slug 是否为包内置技能(受保护:manage_skill 不得 create 覆盖 / update / delete)。 */
export async function isBuiltinSkillName(slug: string): Promise<boolean> {
  try {
    await fs.access(path.join(builtinSkillsDir(), slug, 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
}
