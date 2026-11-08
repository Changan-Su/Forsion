/**
 * 一个项目碰得到的 git 仓(11-07 多仓 Git,仓根 docs/ToBeImproved/多仓Git方案_2026-11-07,方案 C)。
 *
 * 以前 Git 页 / git_* 工具 / 审阅页「未提交」只认会话的 project_path 这一个目录:项目文件夹本身不是仓(仓在里面)、
 * 项目在大仓的子目录里、会话加了额外文件夹 —— 这三种都用不了。现在清单由三部分组成:
 *   - project:项目自己是仓根,或项目所在的大仓(scope = 项目在仓里的相对路径,提交只收那里 = 子目录模式);
 *   - inside :项目文件夹里面往下 ≤3 层找到的仓(跳过 node_modules / 隐藏目录 / 常见的依赖与构建目录);
 *   - extra  :会话额外文件夹所在的仓(或额外文件夹里往下找到的仓)。
 *
 * **清单只在引擎这里算**:写动作 / 工具带回 id,引擎在同一份清单里认(resolveRepo)—— 客户端和模型都给不了任意路径。
 * 默认工作区(~/Forsion,所有不在项目里的对话共用)本身照旧不建仓、不整目录提交(gitActions.assertNotSharedWorkspace),
 * 但它里面的仓照常列出、能在那个仓的根上写。
 */
import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGit } from './gitActions.js';

export interface ProjectRepo {
  /** 项目里的 = 仓根相对项目目录的 posix 路径('.' = 项目自己 / 项目所在的大仓);额外文件夹的 = 仓根绝对路径。 */
  id: string;
  name: string;
  /** 显示用的位置:项目里的 = id;额外文件夹的 = 家目录缩写成 ~ 的绝对路径。 */
  label: string;
  /** 仓根(realpath)。 */
  root: string;
  /** 子目录模式:项目 / 额外文件夹在仓里的 posix 相对路径。 */
  scope?: string;
  group: 'project' | 'inside' | 'extra';
}

/** 往下最多找几层(项目目录本身是第 0 层;~/Forsion/Project/超级变色龙 是第 2 层)。 */
export const SCAN_DEPTH = 3;
/** 清单上限:再多的只回个数(界面写「还有 N 个」)。 */
export const REPOS_LISTED = 20;
/** 一次扫描最多读多少个目录 —— 家目录那种大文件夹也要在一两秒里回来。 */
const SCAN_DIR_BUDGET = 3000;
/** 不往里找的目录:依赖、构建产物、虚拟环境、系统目录。隐藏目录(. 开头)另外一律跳过。 */
const SKIP_DIRS = new Set(['node_modules', 'bower_components', 'vendor_modules', '__pycache__', 'venv', 'env', 'dist', 'build', 'out', 'target', 'Library', 'Applications', 'Pictures', 'Music', 'Movies']);
/** 清单缓存:Git 页每次读上下文都要;写动作之后 invalidateRepos 清掉。 */
const CACHE_MS = 15_000;

const posix = (p: string): string => p.split(path.sep).join('/');
const tildify = (p: string): string => { const home = os.homedir(); return p === home ? '~' : p.startsWith(home + path.sep) ? `~/${posix(path.relative(home, p))}` : p; };
const realpath = (p: string): Promise<string> => fs.realpath(p).catch(() => path.resolve(p));

/** 目录所在的仓根(realpath);不在仓里 / 没装 git → null。 */
export async function repoRootOf(dir: string): Promise<string | null> {
  const r = await readGit(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => null);
  if (!r || r.code !== 0 || !r.stdout.trim()) return null;
  return realpath(r.stdout.trim());
}

/** 往下找带 .git(目录,或子模块 / worktree 的 .git 文件)的文件夹。不跟符号链接;base 自己不算。 */
export async function scanRepos(base: string, maxDepth = SCAN_DEPTH): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: base, depth: 0 }];
  let budget = SCAN_DIR_BUDGET;
  while (queue.length && budget > 0) {
    const { dir, depth } = queue.shift()!;
    budget--;
    let entries: Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    if (depth > 0 && entries.some((e) => e.name === '.git' && (e.isDirectory() || e.isFile()))) found.push(dir);
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return found;
}

/** 会话存的额外文件夹(agent_config.extraRoots):只收绝对路径,去重,封顶 8 个(同 agentLoop)。 */
export function extraRootsOf(agentConfig: unknown): string[] {
  const raw = agentConfig && typeof agentConfig === 'object' ? (agentConfig as { extraRoots?: unknown }).extraRoots : undefined;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((r): r is string => typeof r === 'string' && path.isAbsolute(r.trim())).map((r) => path.resolve(r.trim())))].slice(0, 8);
}

const cache = new Map<string, { at: number; repos: Promise<ProjectRepo[]> }>();
const keyOf = (projectDir: string, extraRoots: readonly string[]): string => [projectDir, ...extraRoots].join('\0');

/** 写动作之后清掉这个项目的清单缓存(新建的仓 / 刚加进 .gitignore 的内嵌仓要马上反映出来)。 */
export function invalidateRepos(projectDir?: string): void {
  if (!projectDir) { cache.clear(); return; }
  for (const k of cache.keys()) if (k === projectDir || k.startsWith(projectDir + '\0')) cache.delete(k);
}

/** 这个项目碰得到的全部仓(未排序、未截断;同一个仓根只出现一次,先到先得:project → inside → extra)。 */
export function listProjectRepos(projectDir: string, extraRoots: readonly string[] = []): Promise<ProjectRepo[]> {
  const key = keyOf(projectDir, extraRoots);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.repos;
  const repos = discover(projectDir, extraRoots);
  cache.set(key, { at: Date.now(), repos });
  repos.catch(() => cache.delete(key));
  return repos;
}

async function discover(projectDir: string, extraRoots: readonly string[]): Promise<ProjectRepo[]> {
  const base = await realpath(projectDir);
  const out: ProjectRepo[] = [];
  const seen = new Set<string>();
  const add = (r: ProjectRepo): void => { if (seen.has(r.root)) return; seen.add(r.root); out.push(r); };

  const top = await repoRootOf(base);
  if (top) {
    const scope = posix(path.relative(top, base));
    add({ id: '.', name: path.basename(top), label: '.', root: top, ...(scope ? { scope } : {}), group: 'project' });
  }
  for (const dir of await scanRepos(base)) {
    const root = await repoRootOf(dir);
    if (!root || root !== await realpath(dir)) continue; // .git 坏了 / 指到别处的,不认
    const id = posix(path.relative(base, root));
    add({ id, name: path.basename(root), label: id, root, group: 'inside' });
  }
  for (const extra of extraRoots) {
    const real = await realpath(extra);
    if (real === base || real.startsWith(base + path.sep)) continue; // 在项目文件夹里面的,上面已经扫过
    const owner = await repoRootOf(real);
    if (owner) {
      const scope = posix(path.relative(owner, real));
      add({ id: owner, name: path.basename(owner), label: tildify(owner), root: owner, ...(scope ? { scope } : {}), group: 'extra' });
      continue;
    }
    for (const dir of await scanRepos(real)) {
      const root = await repoRootOf(dir);
      if (!root || root !== await realpath(dir)) continue;
      add({ id: root, name: path.basename(root), label: tildify(root), root, group: 'extra' });
    }
  }
  return out;
}

/** id → 清单里的那个仓。不给 id(或 '.')= 项目自己的那个;项目不在任何仓里 → null。认不出的 id → null(调用方报 unknown_repo)。 */
export async function resolveRepo(projectDir: string, extraRoots: readonly string[], id: unknown): Promise<ProjectRepo | null> {
  const repos = await listProjectRepos(projectDir, extraRoots);
  const want = typeof id === 'string' ? id.trim() : '';
  if (!want || want === '.') { const own = repos.find((r) => r.group === 'project') ?? null; return own && (await stillThere(own)) ? own : null; }
  // 模型 / 界面可能带个结尾斜杠或 ./ 前缀:按清单里的写法规整一下再认,不做别的推断
  const norm = path.isAbsolute(want) ? path.resolve(want) : posix(path.posix.normalize(want.replace(/\\/g, '/'))).replace(/\/$/, '');
  const hit = repos.find((r) => r.id === norm || r.root === norm) ?? null;
  return hit && (await stillThere(hit)) ? hit : null;
}

/** 清单有 15 秒缓存:动手前再核一次仓根还是那个真实目录(期间被换成指向别处的符号链接 → 不认,Codex 评审)。 */
async function stillThere(r: ProjectRepo): Promise<boolean> {
  return (await fs.realpath(r.root).catch(() => null)) === r.root;
}

/** 写动作 / 读现场用的目录:子目录模式 = 仓根下的那个子目录(git 从这里看只算它的改动);否则仓根。 */
export const repoCwd = (r: ProjectRepo): string => (r.scope ? path.join(r.root, ...r.scope.split('/')) : r.root);
