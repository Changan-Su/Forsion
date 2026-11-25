/**
 * 多账号模式(core/accountScope.ts)的插件脚本入口:引擎在多账号模式下不替任何账号起子进程(core/hostSpawn.ts),这里是唯一的例外,
 * 而且只跑**插件包目录里自带的脚本**(只读的、上架前审过的代码),不跑账号自己写的文件,也没有 shell。
 *
 * - 找脚本:按「技能名 + 技能目录里的相对路径」在插件包目录里找(包顶层的 skills/<技能>/ 和 agents/<人设>/skills/<技能>/);也接受一个绝对路径:
 *   在插件包里的照跑;落在账号文件夹里那份技能副本(开户时从插件包播种进来的,账号写得动)的,换成插件包里的原件 —— 账号文件夹里的那份永远不跑。
 *   真实路径必须还在那个技能目录里(包里别处的代码,比如多账号模式不加载的 tangu-plugins/,不跑)、是普通文件、扩展名认得
 *   (.py → python3,.js/.mjs/.cjs → 引擎自己的 node,.sh → sh)。人设技能的副本只换成同一个人设的原件。Windows 主机上不提供。
 * - 参数:字符串数组,不经 shell。看着像路径的(绝对路径、~ 开头、带 .. 段;含 `--x=<路径>` 的值)必须落在当前账号的文件夹里。
 * - 环境:不继承引擎的环境变量(里面有宿主口令、模型凭据、.env 的内容),只给 PATH / 语言 / 时区,外加 HOME / TMPDIR / 缓存目录指向
 *   这一轮的临时目录 `<accountHome>/.scratch/<runId>/`,Python 不写字节码(插件包是所有账号共用的只读目录)。工作目录 = 这一轮的工作目录(在账号文件夹里)。
 * - 一次一个:整个引擎同一时间只跑一个(SCRIPT_CONCURRENCY),其余按先来后到排队;排队和跑都随这一轮中止。
 * - 上限:一次最长 scriptMinutes(到点整组进程先 SIGTERM、3 秒后 SIGKILL);临时目录超过 scriptScratchMB 当场结束;标准输出最多留 1 MB、标准错误最多留尾部 64 KB。
 *   进程组确认退出之后才放下一个。
 * - 跑完扫一遍账号文件夹(文件工具「先按路径判、再按路径打开」,链接是它唯一的越界口子):软链删掉;和账号文件夹之外共用的硬链接,
 *   这次新出现的名字删掉、原来就有的文件换成独立的一份(名字和内容都留着);名字全在账号文件夹里的硬链接不动。
 *   脚本退出后它起的、脱离了进程组的子孙进程还拿着输出管道时,最多再等 2 秒就收尾放下一个(那个子孙进程本身管不到,见下面的残余)。
 * - 临时目录在这一轮结束时删(agentLoop 收尾调 disposeRunScratch),开户时把上次进程留下的整个 .scratch 清掉;不算进账号的磁盘上限,另有单次上限;
 *   账号自己的文件工具不能往 .scratch 里写(services/accessDomain.ts)。
 * - 换用户(core/scriptIsolation.ts):宿主设了 TANGU_SCRIPT_ISOLATION=required 时,脚本以单独的系统用户跑(缺省 uid / gid 65534),
 *   跑的期间只对这个账号的文件夹开组权限(账号库 state.db* 与 .scratch 除外),跑完收回;引擎换不了用户就不跑。没设这个开关时以引擎自己的身份跑。
 * ⚠️ 残余:没开换用户时,账号隔离靠「只跑审过的代码 + 参数里的路径钳在账号文件夹 + 跑完扫链接」,脱离进程组的子孙进程不归这里管;
 *   开了换用户,所有账号共用一个脚本用户(见 core/scriptIsolation.ts 的残余)。放开自由命令行之前,要先换成按账号的系统用户,并把文件访问改成按目录句柄打开。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, copyFileSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { accountHome, isMultiAccount, requireAccountId } from '../core/accountScope.js';
import { mbBytes, minutesMs, multiAccountLimits, SCRIPT_CONCURRENCY } from '../core/multiAccountLimits.js';
import {
  closeAccountToScripts, dropForeignDbEntries, handScratchToScriptUser, lockAllAccountHomes, openAccountToScripts, reapScriptUser,
  resolveScriptUser, ScriptIsolationError, type ScriptUser,
} from '../core/scriptIsolation.js';
import { bundleDirs } from '../plugins/bundles.js';
import { accountWriteDenied } from './accessDomain.js';
import { markAccountUsageDirty, SCRATCH_DIR } from './accountStorage.js';

const INTERPRETERS: Record<string, () => string[]> = {
  '.py': () => [process.env.TANGU_PYTHON_BIN || 'python3'],
  '.js': () => [process.execPath],
  '.mjs': () => [process.execPath],
  '.cjs': () => [process.execPath],
  '.sh': () => ['sh'],
};
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;
const STDOUT_MAX = 1024 * 1024;
const STDERR_KEEP = 64 * 1024;
const KILL_GRACE_MS = 3_000;
const EXIT_GRACE_MS = 2_000;
const SCRATCH_POLL_MS = 2_000;
/** 只传这几个环境变量(其余引擎环境一概不给脚本)。 */
const ENV_PASS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'WINDIR'];

export class PluginScriptError extends Error {
  constructor(message: string) { super(message); this.name = 'PluginScriptError'; }
}

const real = (p: string): string | null => { try { return realpathSync.native(p); } catch { return null; } };
const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};
/** 相对路径的每一段都是普通名字(没有 ..、没有 .、没有反斜杠、不是绝对路径)。 */
const cleanRel = (rel: string): boolean =>
  !!rel && !path.isAbsolute(rel) && !rel.includes('\0') && !rel.includes('\\') && rel.split('/').every((seg) => seg && seg !== '.' && seg !== '..');

/** 插件包目录(真实路径)。 */
function bundles(): string[] {
  let dirs: string[] = [];
  try { dirs = bundleDirs(); } catch { dirs = []; }
  return dirs.map((d) => real(d)).filter((d): d is string => !!d);
}

/** 技能目录(包顶层 skills/<技能>/ 或 agents/<人设>/skills/<技能>/)里的这个文件:真实路径必须还在这个技能目录里(不许借软链跑到包里别处,
 *  比如多账号模式不加载的 tangu-plugins/),是普通文件。 */
function inSkillDir(bundle: string, skillDir: string, rel: string): string | null {
  const dir = real(skillDir);
  if (!dir || !inside(dir, bundle)) return null;
  const r = real(path.join(skillDir, rel));
  if (!r || !inside(r, dir)) return null;
  try { return statSync(r).isFile() ? r : null; } catch { return null; }
}

/**
 * 在插件包里按技能名找 <skill>/<rel>。agent 给了(账号文件夹里某个人设的技能副本)→ 只找那个人设的 agents/<agent>/skills/;
 * agent === ''(账号顶层 skills/ 的副本)→ 只找包顶层 skills/;不给 → 包顶层 skills/ 先于 agents/*\/skills/。都没有 → null。
 */
function findInBundles(skill: string, rel: string, agent?: string): { file: string; bundle: string } | null {
  for (const bundle of bundles()) {
    const dirs: string[] = [];
    if (agent === undefined || agent === '') dirs.push(path.join(bundle, 'skills', skill));
    if (agent) dirs.push(path.join(bundle, 'agents', agent, 'skills', skill));
    else if (agent === undefined) {
      let agents: string[] = [];
      try { agents = readdirSync(path.join(bundle, 'agents')).sort(); } catch { agents = []; }
      for (const a of agents) dirs.push(path.join(bundle, 'agents', a, 'skills', skill));
    }
    for (const d of dirs) {
      const file = inSkillDir(bundle, d, rel);
      if (file) return { file, bundle };
    }
  }
  return null;
}

/** 包里的一个绝对真实路径落在哪个技能目录里:`(agents/<a>/)?skills/<s>/<rel>`;不在任何技能目录里 → null。 */
const SKILL_PATH_RE = /^(?:agents\/([^/]+)\/)?skills\/([^/]+)\/(.+)$/;

/** 这个技能在插件包里能跑的脚本(技能目录下、支持的扩展名、真实路径不出包;找不到脚本时报给模型,最多 20 个)。 */
function listBundleScripts(skill: string): string[] {
  const out: string[] = [];
  for (const bundle of bundles()) {
    let agents: string[] = [];
    try { agents = readdirSync(path.join(bundle, 'agents')).sort(); } catch { agents = []; }
    for (const dir of [path.join(bundle, 'skills', skill), ...agents.map((a) => path.join(bundle, 'agents', a, 'skills', skill))]) {
      const root = real(dir);
      if (!root || !inside(root, bundle)) continue;
      const walk = (d: string, depth: number): void => {
        if (out.length >= 20 || depth > 3) return;
        let ents: import('node:fs').Dirent[] = [];
        try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
          if (out.length >= 20) return;
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (e.isFile() && INTERPRETERS[path.extname(e.name).toLowerCase()]) {
            const rel = path.relative(root, p).split(path.sep).join('/');
            if (!out.includes(rel)) out.push(rel);
          }
        }
      };
      walk(root, 0);
    }
  }
  return out;
}

/**
 * 解析要跑的脚本。skill + script(技能目录里的相对路径),或者 script 是绝对路径(插件包里的原件 / 账号文件夹里的技能副本)。
 * 返回插件包里那份原件的真实路径;找不到 / 不许跑 → PluginScriptError(给模型看的英文原因)。
 */
export function resolvePluginScript(skill: unknown, script: unknown): { file: string; bundle: string; command: string[] } {
  if (typeof script !== 'string' || !script.trim()) throw new PluginScriptError('script is required: the path of the script inside the skill folder, e.g. "scripts/run.py"');
  const s = script.trim();
  let found: { file: string; bundle: string } | null = null;
  if (path.isAbsolute(s)) {
    const r = real(s);
    const inBundle = r ? bundles().find((b) => inside(r, b)) : undefined;
    if (r && inBundle) {
      // 包里的原件:只认技能目录里的(包里别的代码,比如 tangu-plugins/ 的引擎插件,多账号模式不加载,也不许当脚本跑)
      const m = SKILL_PATH_RE.exec(path.relative(inBundle, r).split(path.sep).join('/'));
      if (m) found = (() => { const file = inSkillDir(inBundle, path.join(inBundle, ...(m[1] ? ['agents', m[1]] : []), 'skills', m[2]), m[3]); return file ? { file, bundle: inBundle } : null; })();
    } else {
      // 账号文件夹里那份技能副本:换成插件包里同一个位置(同一个人设 / 包顶层)的原件(副本账号写得动,永远不跑它)
      const home = accountHome(requireAccountId('plugin script'));
      const rel = path.relative(home, path.resolve(s)).split(path.sep).join('/');
      const m = SKILL_PATH_RE.exec(rel);
      if (!rel.startsWith('..') && m && (!m[1] || SKILL_NAME_RE.test(m[1])) && SKILL_NAME_RE.test(m[2]) && cleanRel(m[3])) found = findInBundles(m[2], m[3], m[1] ?? '');
    }
    if (!found) throw new PluginScriptError(`${s} is not a script of an installed plugin. Only scripts that ship inside a plugin's skill folder can run; pass the skill name and the script path inside it.`);
  } else {
    // 技能目录里的 id 带来源前缀(`local:<名字>`),模型常原样照抄:去掉前缀按名字找
    const name = typeof skill === 'string' ? skill.trim().replace(/^[a-z][a-z0-9_-]*:/i, '') : '';
    if (!SKILL_NAME_RE.test(name)) throw new PluginScriptError('skill is required: the name of the plugin skill the script belongs to');
    const rel = s.replace(/^\.\//, '');
    if (!cleanRel(rel)) throw new PluginScriptError('script must be a path inside the skill folder (no "..", no absolute path)');
    found = findInBundles(name, rel);
    if (!found) {
      const have = listBundleScripts(name);
      throw new PluginScriptError(have.length
        ? `The skill "${name}" has no script "${rel}". Its scripts: ${have.join(', ')}`
        : `No installed plugin has a script "${rel}" in a skill named "${name}".`);
    }
  }
  const ext = path.extname(found.file).toLowerCase();
  const interp = INTERPRETERS[ext];
  if (!interp) throw new PluginScriptError(`Scripts of type "${ext || '(none)'}" cannot run here; supported: ${Object.keys(INTERPRETERS).join(', ')}`);
  return { ...found, command: interp() };
}

/** 看着像路径的参数(或 --x=值 里的值):绝对路径、~ 开头、带 .. 段。网址不算。 */
function pathLike(v: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v)) return false;
  return path.isAbsolute(v) || v.startsWith('~') || v.split(/[\\/]/).includes('..');
}

/** 参数检查:字符串数组;像路径的必须落在当前账号的文件夹里。返回清洗后的参数。 */
export function checkScriptArgs(args: unknown, cwd: string): string[] {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) throw new PluginScriptError('args must be a list of strings');
  if (args.length > MAX_ARGS) throw new PluginScriptError(`at most ${MAX_ARGS} arguments`);
  return args.map((a, i) => {
    if (typeof a !== 'string') throw new PluginScriptError(`args[${i}] must be a string`);
    if (a.length > MAX_ARG_CHARS || a.includes('\0')) throw new PluginScriptError(`args[${i}] is too long or contains a NUL byte`);
    const eq = /^--?[A-Za-z0-9][A-Za-z0-9_-]*=(.*)$/s.exec(a);
    for (const v of eq ? [a, eq[1]] : [a]) {
      if (!pathLike(v)) continue;
      if (v.startsWith('~')) throw new PluginScriptError(`args[${i}]: "~" paths are not allowed; use a path inside your account folder`);
      const denied = accountWriteDenied(path.resolve(cwd, v));
      if (denied) throw new PluginScriptError(`args[${i}]: ${denied}`);
    }
    return a;
  });
}

// ── 一次一个 ────────────────────────────────────────────────────────────────────────────────
let running = 0;
const queue: Array<{ go: () => void; abort: () => void }> = [];
function acquire(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      running--;
      const next = queue.shift();
      if (next) next.go();
    };
    const start = (): void => { running++; resolve(release); };
    if (running < SCRIPT_CONCURRENCY && !queue.length) return start();
    if (signal?.aborted) return reject(abortErr());
    const entry = {
      go: () => { signal?.removeEventListener('abort', entry.abort); start(); },
      abort: () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(abortErr()); },
    };
    signal?.addEventListener('abort', entry.abort, { once: true });
    queue.push(entry);
  });
}
const abortErr = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** 测试 / 诊断:有几个在跑、几个在排。 */
export function pluginScriptQueue(): { running: number; waiting: number } {
  return { running, waiting: queue.length };
}

// ── 这一轮的临时目录 ─────────────────────────────────────────────────────────────────────────
const scratchOf = new Map<string, string>(); // runId → 目录
/** 临时目录已经交给脚本用户的运行 → 交给了谁(交过之后脚本拥有这棵树,可能把里面的目录换成软链:不再以 root 去改它)。 */
const handedScratch = new Map<string, ScriptUser>();
const SCRATCH_SUBDIRS = ['home', 'tmp', 'cache'];
function runScratch(account: string, runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'run';
  const parent = path.join(accountHome(account), SCRATCH_DIR);
  try { if (!lstatSync(parent).isDirectory()) rmSync(parent, { force: true }); } catch { /* 还没有 */ }
  const dir = path.join(parent, safe);
  for (const sub of SCRATCH_SUBDIRS) mkdirSync(path.join(dir, sub), { recursive: true });
  scratchOf.set(runId, dir);
  return dir;
}
/** 这一轮结束:删掉它的临时目录(没有 = no-op)。 */
export function disposeRunScratch(runId: string): void {
  const user = handedScratch.get(runId);
  handedScratch.delete(runId);
  const dir = scratchOf.get(runId);
  if (!dir) return;
  scratchOf.delete(runId);
  if (user) return removeScriptOwnedTree(dir, user);
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn(`[tangu] multi-account: removing script scratch ${dir} failed:`, (e as Error)?.message || e); }
}
/** 开户时:清掉上次进程留下的整个临时目录。 */
export function clearAccountScratch(account: string): void {
  const dir = path.join(accountHome(account), SCRATCH_DIR);
  let user: ScriptUser | null = null;
  try { user = resolveScriptUser(); } catch { user = null; }
  if (user) return removeScriptOwnedTree(dir, user);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
/**
 * 换用户时临时目录归脚本用户:root 的递归删除要在脚本队列里做(那时没有脚本在跑),并先结束脚本用户名下的进程 ——
 * 否则还活着的脚本进程能在删到一半时把里面的目录换成软链,让 root 删到账号文件夹外面去。删不掉的下次开户再删。
 */
function removeScriptOwnedTree(dir: string, user: ScriptUser): void {
  void acquire().then((release) => {
    try {
      reapScriptUser(user);
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[tangu] multi-account: removing script scratch ${dir} failed:`, (e as Error)?.message || e);
    } finally {
      release();
    }
  });
}

async function dirBytes(root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    let names: string[];
    try { names = await readdir(d); } catch { continue; }
    for (const n of names) {
      const p = path.join(d, n);
      let st;
      try { st = await lstat(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) total += st.size;
    }
  }
  return total;
}

/** 账号文件夹里的普通文件:路径 → 「设备:inode」(不跟链)。跑脚本前记一份,跑完扫链接时用来分清哪些名字是原来就有的。 */
export type FileIds = Map<string, string>;
function walkAccount(home: string, visit: (p: string, st: import('node:fs').Stats) => void): void {
  const stack = [home];
  let seen = 0;
  while (stack.length && seen < 500_000) {
    const d = stack.pop()!;
    let names: string[];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      seen++;
      const p = path.join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      visit(p, st);
      if (st.isDirectory()) stack.push(p);
    }
  }
}
export function snapshotAccountFiles(account: string): FileIds {
  const ids: FileIds = new Map();
  walkAccount(accountHome(account), (p, st) => { if (st.isFile()) ids.set(p, `${st.dev}:${st.ino}`); });
  return ids;
}

/**
 * 跑完扫账号文件夹(不跟链),返回动过的(相对账号文件夹):
 * - 软链一律删(文件工具「先按路径判、再按路径打开」,链接是它的越界口子;账号自己的写接口从来不建链接)。
 * - 有多个硬链接名字的普通文件:同一个文件的名字全在账号文件夹里(脚本自己的「先写临时名再改名」之类)→ 不动;
 *   有名字在账号文件夹之外 → 这次新出现的名字删掉,原来就有的名字(before 里同一个文件)换成一份独立的拷贝(断开共享、内容和名字都留着)。
 *   before 缺 = 不知道哪些是原来的 → 只删、不拷(与旧行为一致)。
 */
export function sweepAccountLinks(account: string, before?: FileIds): string[] {
  const home = accountHome(account);
  const touched: string[] = [];
  const multi = new Map<string, { nlink: number; paths: string[] }>();
  walkAccount(home, (p, st) => {
    if (st.isSymbolicLink()) {
      try { unlinkSync(p); touched.push(path.relative(home, p)); } catch { /* 删不掉:下次再扫 */ }
    } else if (st.isFile() && st.nlink > 1) {
      const id = `${st.dev}:${st.ino}`;
      const e = multi.get(id) ?? { nlink: st.nlink, paths: [] };
      e.paths.push(p);
      multi.set(id, e);
    }
  });
  for (const [id, e] of multi) {
    if (e.paths.length >= e.nlink) continue; // 名字都在账号文件夹里
    for (const p of e.paths) {
      try {
        if (before?.get(p) === id) {
          const tmp = `${p}.unlink-${process.pid}-${Date.now()}`;
          copyFileSync(p, tmp, constants.COPYFILE_EXCL);
          // 拷贝带着原件的权限位:不去掉 setuid / setgid,引擎(root)拷出来的就是一个 root 的 setuid 程序(经不跟链的 fd 改)
          const fd = openSync(tmp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try { fchmodSync(fd, fstatSync(fd).mode & 0o777); } finally { closeSync(fd); }
          renameSync(tmp, p);
        } else unlinkSync(p);
        touched.push(path.relative(home, p));
      } catch { /* 下次再扫 */ }
    }
  }
  return touched;
}

export interface PluginScriptResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** 被结束的原因:超时 / 临时目录超限 / 输出太多 / 本轮中止;正常退出没有。 */
  stopped?: 'timeout' | 'scratch' | 'output' | 'aborted';
  /** 跑完扫掉的链接(相对账号文件夹)。 */
  removedLinks: string[];
  waitedMs: number;
  ranMs: number;
}

// ── 换用户(core/scriptIsolation.ts)───────────────────────────────────────────────────────────
let allHomesLocked = false; // 本进程第一次换用户跑脚本前,收一遍所有账号文件夹(上次引擎跑到一半退出、没收回的)
const stuckOpen = new Set<string>(); // 跑完没收回的账号文件夹:下次跑脚本前先收,收不回就不跑
const sweepPending = new Map<string, FileIds>(); // 跑完没清光脚本进程、所以没扫链接的账号(→ 那次跑之前的快照):下次清光之后再扫

const isolationErr = (e: unknown): PluginScriptError =>
  new PluginScriptError(e instanceof ScriptIsolationError ? e.message : `Plugin scripts are disabled right now: ${(e as Error)?.message || e}`);

/** 拿到脚本队列之后、开账号文件夹之前:清残留进程,收没收回的文件夹,补扫上次没扫的。任何一步不成 → PluginScriptError(这次不跑)。 */
function prepareScriptUser(user: ScriptUser): void {
  try {
    reapScriptUser(user);
    if (!allHomesLocked) { lockAllAccountHomes(); allHomesLocked = true; }
    for (const home of [...stuckOpen]) { closeAccountToScripts(home); stuckOpen.delete(home); }
    for (const [account, before] of [...sweepPending]) {
      dropForeignDbEntries(accountHome(account), user.uid);
      sweepAccountLinks(account, before);
      sweepPending.delete(account);
    }
  } catch (e) {
    console.error('[tangu] multi-account: cannot prepare the plugin script user:', (e as Error)?.message || e);
    throw isolationErr(e);
  }
}

/**
 * 跑完(含没起来):收回顶层、再清一遍脚本用户的进程、删掉脚本占的库旁文件名。不抛:收不回的记进 stuckOpen;
 * 清不完进程 → 返回 false(这时 root 不在账号文件夹里按路径动东西,扫链接留到下次清光之后)。
 */
function finishScriptUser(home: string, user: ScriptUser): boolean {
  try { closeAccountToScripts(home); } catch (e) {
    stuckOpen.add(home);
    console.error(`[tangu] multi-account: could not close ${home} to plugin scripts:`, (e as Error)?.message || e);
  }
  try { reapScriptUser(user); } catch (e) {
    console.error('[tangu] multi-account: could not end leftover plugin script processes:', (e as Error)?.message || e);
    return false;
  }
  try { dropForeignDbEntries(home, user.uid); } catch (e) {
    console.error(`[tangu] multi-account: could not clean ${home} after a plugin script:`, (e as Error)?.message || e);
  }
  return true;
}

/**
 * 跑一个插件脚本(多账号模式;调用方已在账号上下文里、run 里)。排队等前一个跑完 → (换用户时:开账号文件夹)起进程 → 等它退出 →
 * (收回)→ 扫链接。中止 / 超时 / 临时目录超限 / 输出太多 → 整组进程结束,照样返回已有的输出与原因。
 */
export async function runPluginScript(o: { skill?: unknown; script: unknown; args?: unknown; cwd: string; runId: string; signal?: AbortSignal }): Promise<PluginScriptResult & { script: string }> {
  if (!isMultiAccount()) throw new PluginScriptError('plugin scripts run only in multi-account mode');
  if (process.platform === 'win32') throw new PluginScriptError('plugin scripts are not available on Windows hosts');
  const account = requireAccountId('plugin script');
  const target = resolvePluginScript(o.skill, o.script);
  const cwdDenied = accountWriteDenied(o.cwd);
  if (cwdDenied) throw new PluginScriptError(cwdDenied);
  const args = checkScriptArgs(o.args, o.cwd);
  let user: ScriptUser | null;
  try { user = resolveScriptUser(); } catch (e) { throw isolationErr(e); } // 要换用户却换不了:不跑,也不以引擎自己的身份跑
  const queuedAt = Date.now();
  const release = await acquire(o.signal);
  const startedAt = Date.now();
  try {
    try { user = resolveScriptUser(); } catch (e) { throw isolationErr(e); } // 排队期间开关变了:以拿到队列时的为准
    if (user) prepareScriptUser(user);
    const home = accountHome(account);
    const before = snapshotAccountFiles(account);
    const scratch = scratchOf.get(o.runId) ?? runScratch(account, o.runId);
    const env: Record<string, string> = {};
    for (const k of ENV_PASS) if (typeof process.env[k] === 'string') env[k] = process.env[k]!;
    Object.assign(env, {
      HOME: path.join(scratch, 'home'),
      TMPDIR: path.join(scratch, 'tmp'), TMP: path.join(scratch, 'tmp'), TEMP: path.join(scratch, 'tmp'),
      XDG_CACHE_HOME: path.join(scratch, 'cache'),
      PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
      FORSION_SCRIPT_SCRATCH: scratch,
    });
    const limits = multiAccountLimits();
    let opened = false;
    let canSweep = true;
    let cwd = o.cwd;
    let res: PluginScriptResult & { startError?: string };
    try {
      if (user) {
        try {
          if (!handedScratch.has(o.runId)) {
            handScratchToScriptUser(path.dirname(scratch), [scratch, ...SCRATCH_SUBDIRS.map((d) => path.join(scratch, d))], user);
            handedScratch.set(o.runId, user);
          }
          opened = true; // 开到一半失败也要收
          openAccountToScripts(home, user, SCRATCH_DIR);
        } catch (e) {
          console.error(`[tangu] multi-account: cannot open ${account}'s folder to plugin scripts:`, (e as Error)?.message || e);
          throw isolationErr(e);
        }
        // 起进程时先以 root 进工作目录再换用户:工作目录按真实路径给,而且必须还在这个账号的文件夹里(路径上有链接被换过就不跑)
        const realCwd = real(o.cwd);
        const realHome = real(home);
        if (!realCwd || !realHome || !inside(realCwd, realHome)) throw new PluginScriptError('The working directory is not inside your account folder.');
        cwd = realCwd;
      }
      res = await spawnScript(target, args, { cwd, signal: o.signal }, env, scratch, limits, user, queuedAt, startedAt);
    } finally {
      if (user && opened) canSweep = finishScriptUser(home, user);
    }
    // 换用户起不来(缺能力、解释器脚本用户执行不了…):当拒绝,不退回以引擎自己的身份跑
    if (user && res.startError) throw new PluginScriptError(`The script could not start as the script user (uid ${user.uid}): ${res.startError}`);
    delete res.startError;
    // 进程组已结束(close 之后又补了一次 SIGKILL):扫链接,标脏磁盘用量(脚本用户的进程没清光时不扫,留到下次)
    if (!canSweep) sweepPending.set(account, before);
    res.removedLinks = canSweep ? sweepAccountLinks(account, before) : [];
    if (res.removedLinks.length) console.warn(`[tangu] multi-account: removed ${res.removedLinks.length} link(s) left in ${account}'s folder by ${target.file}`);
    markAccountUsageDirty(account);
    return { ...res, script: target.file };
  } finally {
    release();
  }
}

/** 起进程、等它(和它的进程组)结束。user 给了就以那个系统用户跑;起不来时 startError 带原因(调用方据此拒绝)。 */
function spawnScript(
  target: { file: string; command: string[] }, args: string[], o: { cwd: string; signal?: AbortSignal }, env: Record<string, string>,
  scratch: string, limits: ReturnType<typeof multiAccountLimits>, user: ScriptUser | null, queuedAt: number, startedAt: number,
): Promise<PluginScriptResult & { startError?: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let stdout = '';
    let stderr = '';
    let stopped: PluginScriptResult['stopped'];
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let spawned = false;
    let startError: string | undefined;
    const timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
    const killGroup = (sig: NodeJS.Signals): void => {
      if (!child?.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const stop = (why: NonNullable<PluginScriptResult['stopped']>): void => {
      if (stopped || settled) return;
      stopped = why;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (exitGrace) clearTimeout(exitGrace);
      for (const t of timers) clearTimeout(t as ReturnType<typeof setTimeout>);
      killGroup('SIGKILL'); // 主进程退了,组里留下的子进程一并结束
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, signal: sig, stdout, stderr, ...(stopped ? { stopped } : {}), ...(startError ? { startError } : {}), removedLinks: [], waitedMs: startedAt - queuedAt, ranMs: Date.now() - startedAt });
    };
    const onAbort = (): void => stop('aborted');
    let exitGrace: ReturnType<typeof setTimeout> | null = null;
    try {
      // 多账号模式唯一放行的子进程:插件包里的脚本,不经 shell、参数原样、环境只给上面那几样(见文件头);换用户时带 uid / gid
      child = spawn(target.command[0], [...target.command.slice(1), target.file, ...args], {
        cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32', windowsHide: true,
        ...(user ? { uid: user.uid, gid: user.gid } : {}),
      });
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      resolve({ exitCode: null, signal: null, stdout: '', stderr: `could not start: ${msg}`, startError: msg, removedLinks: [], waitedMs: startedAt - queuedAt, ranMs: 0 });
      return;
    }
    child.on('spawn', () => { spawned = true; });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length + d.length > STDOUT_MAX) { stdout += d.slice(0, Math.max(0, STDOUT_MAX - stdout.length)); stop('output'); return; }
      stdout += d;
    });
    child.stderr?.on('data', (d: string) => { stderr = (stderr + d).slice(-STDERR_KEEP); });
    child.on('error', (e) => { if (!spawned) startError = e.message; stderr += `\n${e.message}`; finish(null, null); });
    child.on('close', (code, sig) => finish(code, sig));
    // 脚本自己退了,但它起的子孙进程(脱离了进程组)还拿着输出管道 → close 永远不来、整个引擎的脚本队列卡死:退出后最多再等 2 秒收尾
    child.on('exit', (code, sig) => {
      if (settled || exitGrace) return;
      exitGrace = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(code, sig); }, EXIT_GRACE_MS);
      exitGrace.unref?.();
    });
    if (o.signal?.aborted) stop('aborted');
    else o.signal?.addEventListener('abort', onAbort, { once: true });
    const t = setTimeout(() => stop('timeout'), minutesMs(limits.scriptMinutes));
    timers.push(t);
    const cap = mbBytes(limits.scriptScratchMB);
    const poll = setInterval(() => {
      void dirBytes(scratch).then((n) => { if (n > cap) stop('scratch'); }, () => {});
    }, SCRATCH_POLL_MS);
    timers.push(poll);
    for (const x of timers) (x as any).unref?.();
  });
}
