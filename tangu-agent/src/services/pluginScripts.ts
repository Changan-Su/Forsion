/**
 * 多账号模式(core/accountScope.ts)的插件脚本入口:引擎在多账号模式下不替任何账号起子进程(core/hostSpawn.ts),这里是唯一的例外,
 * 而且只跑**插件包目录里自带的脚本**(只读的、上架前审过的代码),不跑账号自己写的文件,也没有 shell。
 *
 * - 找脚本:按「技能名 + 技能目录里的相对路径」在插件包目录里找(包顶层的 skills/<技能>/ 和 agents/<人设>/skills/<技能>/);也接受一个绝对路径:
 *   在插件包里的照跑;落在账号文件夹里那份技能副本(开户时从插件包播种进来的,账号写得动)的,换成插件包里的原件 —— 账号文件夹里的那份永远不跑。
 *   真实路径必须在插件包目录里、是普通文件、扩展名认得(.py → python3,.js/.mjs/.cjs → 引擎自己的 node,.sh → sh)。
 * - 参数:字符串数组,不经 shell。看着像路径的(绝对路径、~ 开头、带 .. 段;含 `--x=<路径>` 的值)必须落在当前账号的文件夹里。
 * - 环境:不继承引擎的环境变量(里面有宿主口令、模型凭据、.env 的内容),只给 PATH / 语言 / 时区,外加 HOME / TMPDIR / 缓存目录指向
 *   这一轮的临时目录 `<accountHome>/.scratch/<runId>/`,Python 不写字节码(插件包是所有账号共用的只读目录)。工作目录 = 这一轮的工作目录(在账号文件夹里)。
 * - 一次一个:整个引擎同一时间只跑一个(SCRIPT_CONCURRENCY),其余按先来后到排队;排队和跑都随这一轮中止。
 * - 上限:一次最长 scriptMinutes(到点整组进程先 SIGTERM、3 秒后 SIGKILL);临时目录超过 scriptScratchMB 当场结束;标准输出最多留 1 MB、标准错误最多留尾部 64 KB。
 *   进程组确认退出之后才放下一个。
 * - 跑完扫一遍账号文件夹:脚本留下的软链、有别的硬链接的文件一律删掉(文件工具「先按路径判、再按路径打开」,链接是它唯一的越界口子)。
 * - 临时目录在这一轮结束时删(agentLoop 收尾调 disposeRunScratch),开户时把上次进程留下的整个 .scratch 清掉;不算进账号的磁盘上限,另有单次上限。
 * ⚠️ 残余:脚本以引擎自己的系统身份运行(没有按账号的系统用户),账号隔离靠「只跑审过的代码 + 参数里的路径钳在账号文件夹 + 跑完扫链接」;
 *   放开自由命令行之前,要先换成按账号的系统用户,并把文件访问改成按目录句柄打开。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { accountHome, isMultiAccount, requireAccountId } from '../core/accountScope.js';
import { mbBytes, minutesMs, multiAccountLimits, SCRIPT_CONCURRENCY } from '../core/multiAccountLimits.js';
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

/** 在插件包里按技能名找 <skill>/<rel>:包顶层 skills/ 先于 agents/*\/skills/;都没有 → null。 */
function findInBundles(skill: string, rel: string): { file: string; bundle: string } | null {
  for (const bundle of bundles()) {
    const candidates = [path.join(bundle, 'skills', skill, rel)];
    let agents: string[] = [];
    try { agents = readdirSync(path.join(bundle, 'agents')).sort(); } catch { agents = []; }
    for (const a of agents) candidates.push(path.join(bundle, 'agents', a, 'skills', skill, rel));
    for (const c of candidates) {
      const r = real(c);
      if (!r || !inside(r, bundle)) continue;
      let st;
      try { st = statSync(r); } catch { continue; }
      if (st.isFile()) return { file: r, bundle };
    }
  }
  return null;
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
      try { if (statSync(r).isFile()) found = { file: r, bundle: inBundle }; } catch { /* 不存在 */ }
    } else {
      // 账号文件夹里那份技能副本:换成插件包里的原件(副本账号写得动,永远不跑它)
      const home = accountHome(requireAccountId('plugin script'));
      const rel = path.relative(home, path.resolve(s)).split(path.sep).join('/');
      const m = /^(?:agents\/[^/]+\/)?skills\/([^/]+)\/(.+)$/.exec(rel);
      if (!rel.startsWith('..') && m && SKILL_NAME_RE.test(m[1]) && cleanRel(m[2])) found = findInBundles(m[1], m[2]);
    }
    if (!found) throw new PluginScriptError(`${s} is not a script of an installed plugin. Only scripts that ship inside a plugin's skill folder can run; pass the skill name and the script path inside it.`);
  } else {
    if (typeof skill !== 'string' || !SKILL_NAME_RE.test(skill.trim())) throw new PluginScriptError('skill is required: the name of the plugin skill the script belongs to');
    const rel = s.replace(/^\.\//, '');
    if (!cleanRel(rel)) throw new PluginScriptError('script must be a path inside the skill folder (no "..", no absolute path)');
    found = findInBundles(skill.trim(), rel);
    if (!found) throw new PluginScriptError(`No installed plugin has a script "${rel}" in a skill named "${skill.trim()}".`);
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
function runScratch(account: string, runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'run';
  const dir = path.join(accountHome(account), SCRATCH_DIR, safe);
  for (const sub of ['home', 'tmp', 'cache']) mkdirSync(path.join(dir, sub), { recursive: true });
  scratchOf.set(runId, dir);
  return dir;
}
/** 这一轮结束:删掉它的临时目录(没有 = no-op)。 */
export function disposeRunScratch(runId: string): void {
  const dir = scratchOf.get(runId);
  if (!dir) return;
  scratchOf.delete(runId);
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn(`[tangu] multi-account: removing script scratch ${dir} failed:`, (e as Error)?.message || e); }
}
/** 开户时:清掉上次进程留下的整个临时目录。 */
export function clearAccountScratch(account: string): void {
  try { rmSync(path.join(accountHome(account), SCRATCH_DIR), { recursive: true, force: true }); } catch { /* best-effort */ }
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

/** 扫账号文件夹:软链、有别的硬链接的普通文件一律删掉(不跟链)。返回删掉的(相对账号文件夹)。 */
export function sweepAccountLinks(account: string): string[] {
  const home = accountHome(account);
  const removed: string[] = [];
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
      if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) {
        try { unlinkSync(p); removed.push(path.relative(home, p)); } catch { /* 删不掉:下次再扫 */ }
      } else if (st.isDirectory()) stack.push(p);
    }
  }
  return removed;
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

/**
 * 跑一个插件脚本(多账号模式;调用方已在账号上下文里、run 里)。排队等前一个跑完 → 起进程 → 等它退出 → 扫链接。
 * 中止 / 超时 / 临时目录超限 / 输出太多 → 整组进程结束,照样返回已有的输出与原因。
 */
export async function runPluginScript(o: { skill?: unknown; script: unknown; args?: unknown; cwd: string; runId: string; signal?: AbortSignal }): Promise<PluginScriptResult & { script: string }> {
  if (!isMultiAccount()) throw new PluginScriptError('plugin scripts run only in multi-account mode');
  const account = requireAccountId('plugin script');
  const target = resolvePluginScript(o.skill, o.script);
  const cwdDenied = accountWriteDenied(o.cwd);
  if (cwdDenied) throw new PluginScriptError(cwdDenied);
  const args = checkScriptArgs(o.args, o.cwd);
  const queuedAt = Date.now();
  const release = await acquire(o.signal);
  const startedAt = Date.now();
  try {
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
    const res = await new Promise<PluginScriptResult>((resolve) => {
      let child: ChildProcess;
      let stdout = '';
      let stderr = '';
      let stopped: PluginScriptResult['stopped'];
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
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
        for (const t of timers) clearTimeout(t as ReturnType<typeof setTimeout>);
        killGroup('SIGKILL'); // 主进程退了,组里留下的子进程一并结束
        o.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode: code, signal: sig, stdout, stderr, ...(stopped ? { stopped } : {}), removedLinks: [], waitedMs: startedAt - queuedAt, ranMs: Date.now() - startedAt });
      };
      const onAbort = (): void => stop('aborted');
      try {
        // 多账号模式唯一放行的子进程:插件包里的脚本,不经 shell、参数原样、环境只给上面那几样(见文件头)
        child = spawn(target.command[0], [...target.command.slice(1), target.file, ...args], {
          cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32', windowsHide: true,
        });
      } catch (e) {
        resolve({ exitCode: null, signal: null, stdout: '', stderr: `could not start: ${(e as Error)?.message || e}`, removedLinks: [], waitedMs: startedAt - queuedAt, ranMs: 0 });
        return;
      }
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (stdout.length + d.length > STDOUT_MAX) { stdout += d.slice(0, Math.max(0, STDOUT_MAX - stdout.length)); stop('output'); return; }
        stdout += d;
      });
      child.stderr?.on('data', (d: string) => { stderr = (stderr + d).slice(-STDERR_KEEP); });
      child.on('error', (e) => { stderr += `\n${e.message}`; finish(null, null); });
      child.on('close', (code, sig) => finish(code, sig));
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
    // 进程组已结束(close 之后又补了一次 SIGKILL):扫链接,标脏磁盘用量
    res.removedLinks = sweepAccountLinks(account);
    if (res.removedLinks.length) console.warn(`[tangu] multi-account: removed ${res.removedLinks.length} link(s) left in ${account}'s folder by ${target.file}`);
    markAccountUsageDirty(account);
    return { ...res, script: target.file };
  } finally {
    release();
  }
}
