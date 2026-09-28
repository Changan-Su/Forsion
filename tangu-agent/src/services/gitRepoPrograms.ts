/**
 * P1 · G5 方案 B:仓库有没有配置「git 会替你跑的程序」。
 *
 * 远程 shell 的写保护刻意不拒 `.git`(远程 run 要能 commit / init / clone),于是被批准的远程命令能在工作区仓库里摆
 * `filter.<x>.clean` + `.gitattributes`、`core.fsmonitor`、`.git/hooks/post-index-change` 这类东西,之后**本机**一条看似无害的
 * git 读命令(引擎每个 run 开头的 git 现场、项目详情面板、模型免审批的 `git status`)就会以用户身份执行它。
 * 这里只**读**配置,绝不在仓库里跑 git:
 *   · 配置文件逐个 `git config --no-includes --file <f> --list --null`,cwd 固定为 `/`(在仓库里跑,发现阶段会读仓库配置并跟 include);
 *   · 子模块按 index 里的 gitlink(mode 160000)找 —— `git status` 会递归进**已检出**的 gitlink,.gitmodules 里没登记的也一样(实测)。
 * 任何读不懂的情形(git 报错、index 版本 / 扩展不认、层数或个数超界、`.git` 是软链)一律 'unknown',调用方按「配置了」处理(失败即关)。
 * 只看仓库级配置,不看全局 / 系统配置:git-lfs 的 `filter.lfs.*` 就在 ~/.gitconfig 里,算进来等于人人 `git status` 都要批;
 * 而那两处远程 shell 写不进(家目录顶层点文件与 ~/.config 在拒写名单里),本机 run 写它们也要审批。
 */
import { existsSync, lstatSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { metadataSegment } from '../tools/fsPolicy.js';
import { canonicalFuturePath } from '../sandbox/hostSandboxProtection.js';

/** Apple 的 /usr/bin/git 是 xcrun 垫片,每个私有沙箱缓存都可能起 xcodebuild —— 直接用开发者工具里的真 git(runGit 同款)。 */
export function gitExecutable(): string {
  return process.platform === 'darwin'
    ? ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git'].find(existsSync) || 'git'
    : 'git';
}

/** 这几个环境变量会把 git 整个指到别的仓去(GIT_DIR 泄进来时 `-C cwd` 形同虚设);引擎自己跑 git 时一律剥掉(同 desktop gitHistory.ts)。 */
export const GIT_SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE'];
/** 模型的 `git …` 继承引擎环境:这些变量在时,git 用的仓 / index / 配置不是下面按目录推出来的那份 → 分类器不认(unvetted)。 */
const GIT_REDIRECT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];

// ── 发现(K10b-2,自 approvals.ts 挪来:runtimeContext 也要用,不能反向依赖审批模块)──────────────

/** Does `.git` (a directory or a `gitdir:` file) lead to a git dir that structured writes cannot reach? A directory named
 * `.git` is protected by fsPolicy; a `gitdir:` file must point at a path carrying a `.git` segment (worktrees →
 * `.git/worktrees/<name>`, submodules → `.git/modules/<name>`), in both its literal and its realpath form — a
 * `--separate-git-dir` target in an ordinary folder is writable, so its config is not trusted. Symlinks and anything
 * without a HEAD are not vetted. */
function protectedDotGit(top: string): boolean {
  const dotgit = path.join(top, '.git');
  let st;
  try { st = lstatSync(dotgit); } catch { return false; }
  if (st.isDirectory()) return existsSync(path.join(dotgit, 'HEAD'));
  if (!st.isFile()) return false;
  let m: RegExpExecArray | null;
  try { m = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(readFileSync(dotgit, 'utf8')); } catch { return false; }
  if (!m) return false;
  const target = path.resolve(top, m[1]);
  const inGitSegment = (p: string): boolean => p.split(path.sep).some((part) => metadataSegment(part) === '.git');
  return [target, canonicalFuturePath(target)].every(inGitSegment) && existsSync(path.join(target, 'HEAD'));
}

/** Where git's discovery lands from a directory: a vetted work tree, no repository at all, or somewhere whose config the
 * agent may have written. */
export type GitDiscovery = { top: string } | 'none' | 'unvetted';

/** Walk one directory chain the way git's discovery does (setup_git_directory): at each level `D/.git` first, then `D`
 * itself as a git dir. */
function discoverFrom(start: string): GitDiscovery {
  let cur = start;
  for (;;) {
    if (existsSync(path.join(cur, '.git'))) return protectedDotGit(cur) ? { top: cur } : 'unvetted';
    // A git dir needs HEAD (plus objects/ and refs/); HEAD alone is the conservative test — false positives only cost a card.
    if (existsSync(path.join(cur, 'HEAD'))) return 'unvetted';
    const parent = path.dirname(cur);
    if (parent === cur) return 'none';
    cur = parent;
  }
}

/** What `git` would use from `dir` (review K10b-2): known-safe `git status` / `log` / … read the discovered git dir's
 * config, and a git-dir layout (HEAD, config, objects/, refs/) with no `.git` segment can be planted with ordinary
 * in-workspace writes — its `core.fsmonitor` then ran under the known-safe label with zero approvals. A work tree counts
 * only when discovery lands on a protected `.git`, on both the literal and the realpath chain (git itself walks getcwd(),
 * i.e. the realpath). 'none' = neither chain has a `.git` or a HEAD anywhere up to the root, so git reads no repository
 * config and just reports "not a git repository" — harmless. GIT_DIR (and the other redirecting variables) in the
 * environment bypass discovery entirely — not modelled, so unvetted; so are chains that disagree on whether there is a
 * repo at all. `honourEnv:false` is for the engine's own git (runGit scrubs those variables from the child). */
export function gitDiscovery(dir: string, opts: { honourEnv?: boolean } = {}): GitDiscovery {
  if (opts.honourEnv !== false && GIT_REDIRECT_ENV.some((k) => process.env[k])) return 'unvetted';
  const literal = path.resolve(dir);
  const lit = discoverFrom(literal);
  const real = canonicalFuturePath(literal);
  const rea = real === literal ? lit : discoverFrom(real);
  if (lit === 'unvetted' || rea === 'unvetted') return 'unvetted';
  if (lit === 'none' && rea === 'none') return 'none';
  if (lit === 'none' || rea === 'none') return 'unvetted';
  return lit;
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

/** 命中的配置键(git 的 --list 写法:节名 / 键名小写,子节原样)。engine = 引擎 runGit 的固定前缀中和不了的那部分
 *  (前缀关了 fsmonitor / hooksPath / 外部 diff / gpg,加 --no-pager;引擎只跑 rev-parse / status / log / remote / rev-list,不联网)。 */
export interface RepoPrograms { keys: string[]; engine: string[] }
export type RepoProgramsResult = RepoPrograms | 'unknown';

const FALSY = new Set(['false', 'no', 'off', '0', '']);
/** 一条配置 → 它会不会让 git 跑程序;null = 不会。只列「这个键的值就是要执行的命令 / 会引入不可见的配置」的键。 */
function classify(key: string, value: string | null): { engine: boolean } | null {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first < 0) return null;
  const section = key.slice(0, first);
  const name = key.slice(last + 1);
  const sub = first < last;
  switch (section) {
    case 'filter': return sub && ['clean', 'smudge', 'process'].includes(name) ? { engine: true } : null;
    case 'include': return name === 'path' ? { engine: true } : null; // 被包含的文件里可以有上面任何一条
    case 'includeif': return sub && name === 'path' ? { engine: true } : null;
    case 'hook': return { engine: true }; // 较新 git 的配置式钩子(hook.<名>.command),core.hooksPath=/dev/null 关不掉
    case 'core':
      if (sub) return null;
      if (name === 'fsmonitor') return value !== null && FALSY.has(value.trim().toLowerCase()) ? null : { engine: false };
      return ['hookspath', 'sshcommand', 'pager', 'editor', 'askpass', 'gitproxy'].includes(name) ? { engine: false } : null;
    case 'diff': return (!sub && name === 'external') || (sub && ['command', 'textconv'].includes(name)) ? { engine: false } : null;
    case 'pager': return { engine: false };
    case 'gpg': return name === 'program' ? { engine: false } : null;
    case 'credential': return name === 'helper' ? { engine: false } : null;
    case 'uploadpack': case 'receivepack': return { engine: false };
    case 'remote': return sub && ['uploadpack', 'receivepack'].includes(name) ? { engine: false } : null;
    case 'alias': return value !== null && value.trimStart().startsWith('!') ? { engine: false } : null;
    case 'sequence': return name === 'editor' ? { engine: false } : null;
    case 'merge': return sub && name === 'driver' ? { engine: false } : null;
    case 'interactive': return name === 'difffilter' ? { engine: false } : null;
    default: return null;
  }
}

const statSig = (st: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string =>
  `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
function boundedSet<V>(m: Map<string, V>, k: string, v: V): V {
  if (m.size > 256) m.clear(); // ponytail: 只防无界增长
  m.set(k, v);
  return v;
}

type ConfigEntries = Array<[string, string | null]>;
const configCache = new Map<string, { sig: string; entries: ConfigEntries | 'unknown' }>();
/** 一份配置文件的全部条目(不跟 include —— include 本身算命中)。不存在 = 空;读不了 / git 报错 = unknown。 */
function listConfig(file: string): ConfigEntries | 'unknown' {
  let st;
  try { st = statSync(file); } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : 'unknown'; }
  if (!st.isFile()) return 'unknown'; // FIFO / 目录:git 读它的结果我们判断不了
  const sig = statSig(st);
  const hit = configCache.get(file);
  if (hit && hit.sig === sig) return hit.entries;
  let entries: ConfigEntries | 'unknown';
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    for (const k of [...GIT_SCRUBBED_ENV, 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG']) delete env[k];
    // cwd = '/':在仓库里跑,git 的发现阶段会读那个仓库的配置并跟 include(实测 --file 也挡不住)
    const out = execFileSync(gitExecutable(), ['--no-pager', 'config', '--no-includes', '--file', file, '--list', '--null'], {
      cwd: '/', env, timeout: 2000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    });
    entries = out.split('\0').filter(Boolean).map((rec): [string, string | null] => {
      const nl = rec.indexOf('\n');
      return nl < 0 ? [rec, null] : [rec.slice(0, nl), rec.slice(nl + 1)];
    });
  } catch { entries = 'unknown'; }
  boundedSet(configCache, file, { sig, entries });
  return entries;
}

const indexCache = new Map<string, { sig: string; links: string[] | 'unknown' }>();
/** index 里的 gitlink(子模块 / 嵌套仓)路径。v2 / v3 / v4,sha1 / sha256;分拆 index(link 扩展)与读不懂的一律 unknown。 */
export function indexGitlinks(file: string, hashLen = 20): string[] | 'unknown' {
  let st;
  try { st = statSync(file); } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : 'unknown'; }
  if (!st.isFile()) return 'unknown';
  const sig = `${statSig(st)}:${hashLen}`;
  const hit = indexCache.get(file);
  if (hit && hit.sig === sig) return hit.links;
  let links: string[] | 'unknown';
  try { links = parseIndexGitlinks(readFileSync(file), hashLen); } catch { links = 'unknown'; }
  boundedSet(indexCache, file, { sig, links });
  return links;
}
function parseIndexGitlinks(buf: Buffer, hashLen: number): string[] | 'unknown' {
  if (buf.length < 12 + hashLen || buf.toString('latin1', 0, 4) !== 'DIRC') return 'unknown';
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return 'unknown';
  const count = buf.readUInt32BE(8);
  const end = buf.length - hashLen;
  const links: string[] = [];
  let off = 12;
  let prev: Buffer = Buffer.alloc(0); // v4:上一条的路径(前缀压缩)
  for (let i = 0; i < count; i++) {
    const flagsAt = off + 40 + hashLen;
    if (flagsAt + 2 > end) return 'unknown';
    const mode = buf.readUInt32BE(off + 24);
    const flags = buf.readUInt16BE(flagsAt);
    let p = flagsAt + 2;
    if (flags & 0x4000) { if (version < 3) return 'unknown'; p += 2; }
    let name: Buffer;
    if (version === 4) {
      let c = buf[p++];
      let strip = c & 127;
      while (c & 128) { strip += 1; c = buf[p++]; strip = strip * 128 + (c & 127); }
      const nul = buf.indexOf(0, p);
      if (nul < 0 || nul >= end || strip > prev.length) return 'unknown';
      name = Buffer.concat([prev.subarray(0, prev.length - strip), buf.subarray(p, nul)]);
      prev = name;
      off = nul + 1;
    } else {
      const nameLen = flags & 0xfff;
      const nul = nameLen < 0xfff ? p + nameLen : buf.indexOf(0, p);
      if (nul < 0 || nul >= end || buf[nul] !== 0) return 'unknown';
      name = buf.subarray(p, nul);
      off += ((p - off) + (nul - p) + 8) & ~7; // 条目按 8 字节对齐,路径后 1–8 个 NUL
    }
    if (off > end) return 'unknown';
    if ((mode & 0o170000) === 0o160000) links.push(name.toString('utf8'));
  }
  // 扩展:分拆 index(link)的大部分条目在另一个文件里 —— 不跟,按读不懂处理
  while (off + 8 <= end) {
    const sigName = buf.toString('latin1', off, off + 4);
    if (sigName === 'link') return 'unknown';
    off += 8 + buf.readUInt32BE(off + 4);
  }
  return links;
}

/** `<top>/.git` 指向的 git 目录:目录本身,或 gitdir: 文件的目标。没有 = null;软链 / 读不懂 = unknown。 */
function gitDirOf(top: string): string | null | 'unknown' {
  const dotgit = path.join(top, '.git');
  let st;
  try { st = lstatSync(dotgit); } catch { return null; }
  if (st.isDirectory()) return dotgit;
  if (!st.isFile()) return 'unknown';
  try {
    const m = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(readFileSync(dotgit, 'utf8'));
    return m ? path.resolve(top, m[1]) : 'unknown';
  } catch { return 'unknown'; }
}

const MAX_REPOS = 32;
const MAX_DEPTH = 4;
function scanRepo(top: string, gitdir: string, depth: number, seen: Set<string>, out: RepoPrograms): boolean {
  if (depth > MAX_DEPTH || seen.size >= MAX_REPOS) return false;
  let key: string;
  try { key = realpathSync(gitdir); } catch { return false; }
  if (seen.has(key)) return true;
  seen.add(key);
  let commondir = gitdir;
  const cf = path.join(gitdir, 'commondir');
  if (existsSync(cf)) {
    try { commondir = path.resolve(gitdir, readFileSync(cf, 'utf8').trim()); } catch { return false; }
  }
  const tag = depth ? `${path.basename(top)}:` : '';
  let hooksPath = false;
  let sha256 = false;
  for (const file of new Set([path.join(commondir, 'config'), path.join(gitdir, 'config.worktree'), path.join(commondir, 'config.worktree')])) {
    const entries = listConfig(file);
    if (entries === 'unknown') return false;
    for (const [k, v] of entries) {
      if (k === 'core.hookspath') hooksPath = true;
      if (k === 'extensions.objectformat' && v?.trim().toLowerCase() === 'sha256') sha256 = true;
      // core.worktree:子模块的 git 目录天生带(指回检出目录,即 top);指到别处 = 工作树挪走了,下面按 top 找 gitlink 的前提不成立
      if (k === 'core.worktree' && (v === null || canonicalFuturePath(path.resolve(gitdir, v)) !== canonicalFuturePath(top))) {
        out.keys.push(tag + k);
        out.engine.push(tag + k);
      }
      const c = classify(k, v);
      if (!c) continue;
      out.keys.push(tag + k);
      if (c.engine) out.engine.push(tag + k);
    }
  }
  // 读命令唯一会触发的钩子:git status 刷新并写回 index 时跑 post-index-change(实测)。引擎的 hooksPath=/dev/null 关得掉,模型的裸 git 关不掉。
  if (!hooksPath && existsSync(path.join(commondir, 'hooks', 'post-index-change'))) out.keys.push(`${tag}hooks/post-index-change`);
  const links = indexGitlinks(path.join(gitdir, 'index'), sha256 ? 32 : 20);
  if (links === 'unknown') return false;
  for (const link of links) {
    const subTop = path.join(top, link);
    const sub = gitDirOf(subTop);
    if (sub === null) continue; // 没检出:git status 不进去
    if (sub === 'unknown' || !scanRepo(subTop, sub, depth + 1, seen, out)) return false;
  }
  return true;
}

/** `top` 这个工作树(含已检出的子模块 / 嵌套仓)的仓库级配置里,会让 git 跑程序的键。读不懂 → 'unknown'。 */
export function repoGitPrograms(top: string): RepoProgramsResult {
  const gitdir = gitDirOf(top);
  if (gitdir === null || gitdir === 'unknown') return 'unknown';
  const out: RepoPrograms = { keys: [], engine: [] };
  return scanRepo(top, gitdir, 0, new Set(), out) ? out : 'unknown';
}

/** 引擎自己的 git(runGit)在**没有** Seatbelt 的平台上该不该跑:仓库配了前缀中和不了的程序(filter / include / 配置式钩子 /
 *  core.worktree)、发现落在不受保护的 git 目录、或读不懂 → 不跑(失败即关:这一轮不注入 git 现场,面板显示不可用)。 */
export function engineGitBlocked(cwd: string): boolean {
  const found = gitDiscovery(cwd, { honourEnv: false });
  if (found === 'none') return false;
  if (found === 'unvetted') return true;
  const r = repoGitPrograms(found.top);
  return r === 'unknown' || r.engine.length > 0;
}
