/**
 * 多账号模式(core/accountScope.ts)下插件脚本换成单独的系统用户跑。services/pluginScripts.ts 按这里的规矩开关账号文件夹;
 * 账号打开时(开户 / 淘汰后重开)的收口在 adapters/standalone/multiAccountSqliteHost.ts 的 dbFor。
 *
 * 开关:真实环境变量 `TANGU_SCRIPT_ISOLATION`,宿主在部署里放了设备凭据之类脚本不许读的东西时设成 `required`。
 *  - 没设 / 空 = 关:行为照旧(开发机、CI)。
 *  - `required`:脚本一律以 `TANGU_SCRIPT_UID` / `TANGU_SCRIPT_GID`(缺省都是 65534)跑;引擎换不了用户(不是 Linux、不是 root、
 *    缺下面几项能力)就拒绝跑脚本,绝不以引擎自己的身份跑。
 *  - 其余值:当配置错误,同样拒绝(不当成关)。uid / gid 不是 1–2147483647 的整数也拒绝。
 *  每次跑脚本现读,改了不用重启。
 *
 * required 时引擎要有的 Linux 能力:CAP_SETUID / CAP_SETGID(换用户)、CAP_CHOWN(把临时目录交给脚本用户、把文件夹的组改成脚本组)、
 * CAP_KILL(超时 / 中止时结束脚本用户的进程)、CAP_DAC_OVERRIDE(脚本建的 0700 目录和 0600 文件,引擎照样要能量临时目录、删临时目录、
 * 扫链接、让 Agent 读写)。脚本进程本身换用户时能力全清。
 *
 * 一次运行(services/pluginScripts.ts,在「一次一个」的队列里):
 *  1. 结束脚本用户名下所有残留进程(脚本用户是专用的:上一次脚本脱离进程组的子孙进程不许活到下一个账号打开时)。
 *  2. 本进程第一次跑:把 accounts/ 下每个账号文件夹顶层收成 0700(上次引擎跑到一半退出、没收回的)。
 *  3. 临时目录(刚建的那次)交给脚本用户,0700;`.scratch` 本身 0711(只能穿过、看不到别的运行)。
 *  4. 开账号文件夹:账号库 `state.db*` 收成 0600;其余条目组改成脚本组、目录 g+rwx、文件 g+rw(去掉 setuid / setgid),
 *     顶层的 `state.db*` 和 `.scratch` 不碰;最后才把顶层改成「组 = 脚本组、01770」(组可进可写,粘滞位让脚本删不了、改不了名
 *     不是它自己的条目,比如账号库)。
 *     遍历一律 lstat、不跟随软链,改属主 / 权限用 O_NOFOLLOW 打开后的 fd(打开的必须还是 lstat 看到的那个);链接数 >1 的文件不碰
 *     (别人放个硬链接就能让 root 去改凭据文件的权限)。遍历时顶层还是 0700、脚本用户的进程已经清光,没人能在里面调包。
 *  5. 跑完(finally):顶层收回 0700、属主是引擎自己;再清一遍脚本用户的进程。收不回的记下来,下一次跑脚本前先收,收不回就拒绝跑。
 * 同一时刻只有一个账号对脚本用户开着(脚本整个引擎一次一个)。
 *
 * 部署要求:脚本用户得能穿过引擎根目录与它的上级(o+x),读得到插件包(目录 o+rx、文件 o+r);这个 uid 不能给别的服务用
 * (每次跑脚本前后都会结束它名下的所有进程)。
 * ⚠️ 残余:所有账号共用一个脚本用户,/tmp 这类谁都能写的地方仍是两次运行之间的通道(脚本在一个账号里读到的东西可以留到下一个账号的运行里)。
 */
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { accountHome, engineRoot, isValidAccountId } from './accountScope.js';

export const SCRIPT_ISOLATION_ENV = 'TANGU_SCRIPT_ISOLATION';
export const SCRIPT_UID_ENV = 'TANGU_SCRIPT_UID';
export const SCRIPT_GID_ENV = 'TANGU_SCRIPT_GID';
export const DEFAULT_SCRIPT_ID = 65534;
/** spawn 的 uid / gid 只收 int32。 */
const MAX_ID = 2_147_483_647;

/** 给模型 / 用户看的英文原因(services/pluginScripts.ts 转成 PluginScriptError)。 */
export class ScriptIsolationError extends Error {
  constructor(message: string) { super(message); this.name = 'ScriptIsolationError'; }
}

export interface ScriptUser { uid: number; gid: number }

export type ScriptIsolationMode = 'off' | 'required' | 'invalid';
export function scriptIsolationMode(): ScriptIsolationMode {
  const v = process.env[SCRIPT_ISOLATION_ENV];
  if (v === undefined || v === '') return 'off';
  return v === 'required' ? 'required' : 'invalid';
}

function parseId(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return DEFAULT_SCRIPT_ID;
  const n = /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= MAX_ID)) throw new ScriptIsolationError(`Plugin scripts are disabled: ${name} must be a whole number from 1 to ${MAX_ID} (never 0).`);
  return n;
}

// ── 这台机器能不能换用户(测试可以替换)────────────────────────────────────────────────────────
const CAPS: ReadonlyArray<[string, number]> = [['CAP_CHOWN', 0], ['CAP_DAC_OVERRIDE', 1], ['CAP_KILL', 5], ['CAP_SETGID', 6], ['CAP_SETUID', 7]];

export interface ScriptIsolationHost {
  /** 引擎以 root 跑。 */
  root(): boolean;
  /** 为什么换不了用户;能换 → null。 */
  cannotSwitch(): string | null;
  /** 结束这个 uid 名下的全部进程;结束不完就抛。 */
  reap(uid: number): void;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 扫 /proc,真实 / 有效 / 保存的 uid 有一个是它就 SIGKILL,扫到一个都没有为止(进程刚 fork 出来的下一轮再杀)。僵尸不算。 */
function reapUid(uid: number): void {
  if (uid === 0 || uid === process.getuid?.()) throw new ScriptIsolationError('refusing to end processes of the engine\'s own user');
  for (let round = 0; round < 50; round++) {
    let alive = 0;
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      let status: string;
      try { status = readFileSync(`/proc/${name}/status`, 'utf8'); } catch { continue; }
      const state = /^State:\s*(\S)/m.exec(status)?.[1];
      if (state === 'Z' || state === 'X') continue;
      const ids = /^Uid:\s*(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
      if (!ids || ![ids[1], ids[2], ids[3]].some((v) => Number(v) === uid)) continue;
      alive++;
      try { process.kill(Number(name), 'SIGKILL'); } catch { /* 已经没了 */ }
    }
    if (!alive) return;
    sleepSync(20);
  }
  throw new ScriptIsolationError(`processes of the script user (uid ${uid}) are still running`);
}

const realHost: ScriptIsolationHost = {
  root: () => typeof process.geteuid === 'function' && process.geteuid() === 0,
  cannotSwitch: () => {
    if (process.platform !== 'linux') return 'running scripts as a separate user is supported only on Linux hosts';
    if (!realHost.root()) return 'the engine is not running as root';
    let eff: bigint;
    try {
      const m = /^CapEff:\s*([0-9a-f]+)/im.exec(readFileSync('/proc/self/status', 'utf8'));
      if (!m) return 'the engine cannot read its own capabilities';
      eff = BigInt(`0x${m[1]}`);
    } catch { return 'the engine cannot read its own capabilities'; }
    const missing = CAPS.filter(([, bit]) => !(eff & (1n << BigInt(bit)))).map(([n]) => n);
    return missing.length ? `the engine lacks ${missing.join(', ')}` : null;
  },
  reap: reapUid,
};
let host: ScriptIsolationHost = realHost;

/** 测试用:替换「是不是 root / 能不能换用户 / 怎么清进程」;传 null 复原。 */
export function setScriptIsolationHostForTest(over: Partial<ScriptIsolationHost> | null): void {
  host = over ? { ...realHost, ...over } : realHost;
}

/**
 * 这次跑脚本要不要换用户、换成谁:关 → null;required 且换得了 → 脚本用户;其余抛 ScriptIsolationError(英文,说清为什么不跑)。
 */
export function resolveScriptUser(): ScriptUser | null {
  const mode = scriptIsolationMode();
  if (mode === 'off') return null;
  if (mode === 'invalid') throw new ScriptIsolationError(`Plugin scripts are disabled: ${SCRIPT_ISOLATION_ENV} must be "required" or unset.`);
  const user = { uid: parseId(SCRIPT_UID_ENV), gid: parseId(SCRIPT_GID_ENV) };
  const why = host.cannotSwitch();
  if (why) throw new ScriptIsolationError(`Plugin scripts are disabled on this engine: they must run as a separate system user, but ${why}.`);
  return user;
}

export function reapScriptUser(user: ScriptUser): void {
  host.reap(user.uid);
}

// ── 改属主 / 权限:只经 O_NOFOLLOW 打开的 fd ────────────────────────────────────────────────────
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const MAX_ENTRIES = 500_000;
const TOP_CLOSED = 0o700;
/** 组可进可写;粘滞位:组里的人删不了、改不了名不是自己的条目(state.db*、.scratch 都是引擎的)。 */
const TOP_OPEN = 0o1770;
const SPECIAL_BITS = 0o6000;

const engineIds = (): ScriptUser => ({ uid: process.getuid!(), gid: process.getgid!() });
const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;
const isDbFile = (name: string): boolean => name.startsWith('state.db');

/** 不跟链打开 p,确认还是 lstat 看到的那一个(同设备、同 inode、同类型),把 fd 交给 fn;换了人 / 打不开就抛。 */
function withEntry(p: string, seen: Stats, fn: (fd: number, st: Stats) => void): void {
  const fd = openSync(p, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (seen.isDirectory() ? O_DIRECTORY : 0));
  try {
    const st = fstatSync(fd);
    if (st.dev !== seen.dev || st.ino !== seen.ino || st.isDirectory() !== seen.isDirectory() || st.isFile() !== seen.isFile()) {
      throw new Error(`${p} changed while it was being prepared`);
    }
    fn(fd, st);
  } finally {
    closeSync(fd);
  }
}

function setOwnerMode(fd: number, st: Stats, uid: number, gid: number, mode: number): void {
  if (st.uid !== uid || st.gid !== gid) fchownSync(fd, uid, gid); // 先改属主(会清 setuid 位),再定权限
  if ((st.mode & 0o7777) !== mode || st.uid !== uid || st.gid !== gid) fchmodSync(fd, mode);
}

/** 目录 p(不是软链)改成「属主 = 引擎、组 = gid、mode」。不存在 → false;不是目录 → 抛。 */
function setDir(p: string, gid: number, mode: number): boolean {
  let seen: Stats;
  try { seen = lstatSync(p); } catch (e) { if (codeOf(e) === 'ENOENT') return false; throw e; }
  if (!seen.isDirectory()) throw new Error(`${p} is not a directory`);
  const me = engineIds();
  withEntry(p, seen, (fd, st) => setOwnerMode(fd, st, me.uid, gid, mode));
  return true;
}

/** 账号库文件(顶层 state.db*)收成 0600、属主是引擎。有别的硬链接 → 抛;不是普通文件的不碰(跑完扫链接会删软链)。 */
function secureDbFiles(home: string): void {
  const me = engineIds();
  for (const name of readdirSync(home)) {
    if (!isDbFile(name)) continue;
    const p = join(home, name);
    let seen: Stats;
    try { seen = lstatSync(p); } catch { continue; }
    if (!seen.isFile()) continue;
    if (seen.nlink > 1) throw new Error(`${p} has other hard links`);
    withEntry(p, seen, (fd, st) => setOwnerMode(fd, st, me.uid, me.gid, 0o600));
  }
}

/**
 * 账号打开时(开户、淘汰后重开):root 跑时把账号文件夹顶层收成 0700、属主是引擎,账号库文件收成 0600。
 * 覆盖改动前建的文件夹,也覆盖脚本跑到一半引擎退出、没来得及收回的。不是 root → 什么都不做。
 * 失败:开关开着(或值不对)时抛(这次打开失败,不带着开着的文件夹往下走);关着只记一条警告。
 */
export function lockAccountHome(id: string): void {
  if (!host.root()) return;
  try {
    const home = accountHome(id);
    if (setDir(home, engineIds().gid, TOP_CLOSED)) secureDbFiles(home);
  } catch (e) {
    const msg = `multi-account: cannot close the folder of account ${id} to plugin scripts: ${(e as Error)?.message || e}`;
    if (scriptIsolationMode() !== 'off') throw new Error(msg);
    console.warn(`[tangu] ${msg}`);
  }
}

/** accounts/ 下每个账号文件夹的顶层收成 0700(本进程第一次跑脚本前)。不是目录的条目跳过(那种账号也打不开)。失败就抛。 */
export function lockAllAccountHomes(): void {
  let names: string[];
  try { names = readdirSync(join(engineRoot(), 'accounts')); } catch (e) { if (codeOf(e) === 'ENOENT') return; throw e; }
  const gid = engineIds().gid;
  for (const id of names) {
    if (!isValidAccountId(id)) continue;
    const home = accountHome(id);
    try { if (!lstatSync(home).isDirectory()) continue; } catch { continue; }
    setDir(home, gid, TOP_CLOSED);
  }
}

/** 这一轮的临时目录交给脚本用户(只在刚建出来、还没有脚本碰过的时候调):`.scratch` 0711 属引擎,各目录 0700 属脚本用户。 */
export function handScratchToScriptUser(scratchParent: string, dirs: string[], user: ScriptUser): void {
  setDir(scratchParent, engineIds().gid, 0o711);
  for (const d of dirs) {
    const seen = lstatSync(d);
    if (!seen.isDirectory()) throw new Error(`${d} is not a directory`);
    withEntry(d, seen, (fd, st) => setOwnerMode(fd, st, user.uid, user.gid, 0o700));
  }
}

/** 一个条目给脚本组开权限:组 = 脚本组,加 bits;文件去掉 setuid / setgid。打开后发现有了别的硬链接 → 不碰。 */
function grantEntry(p: string, seen: Stats, gid: number, bits: number): void {
  const special = seen.isFile() && (seen.mode & SPECIAL_BITS) !== 0;
  try {
    withEntry(p, seen, (fd, st) => {
      if (st.isFile() && st.nlink > 1) {
        if (special) throw new Error(`${p} has setuid / setgid bits and other hard links`);
        return;
      }
      const mode = st.isFile() ? (st.mode & 0o777) | bits : (st.mode & 0o7777) | bits;
      if (st.gid !== gid) fchownSync(fd, st.uid, gid);
      if ((st.mode & 0o7777) !== mode || st.gid !== gid) fchmodSync(fd, mode);
    });
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return; // 引擎的另一轮刚删掉
    if (special) throw e; // 去不掉 setuid / setgid 就不开
    console.warn(`[tangu] multi-account: could not open ${p} to plugin scripts: ${(e as Error)?.message || e}`);
  }
}

/**
 * 跑脚本前开这个账号的文件夹(文件头第 4 步)。scratchName = 顶层临时目录的名字(不碰)。
 * 先确认顶层是关着的(0700),组权限都改完了才开顶层:改的过程中脚本用户进不来。
 */
export function openAccountToScripts(home: string, user: ScriptUser, scratchName: string): void {
  setDir(home, engineIds().gid, TOP_CLOSED);
  secureDbFiles(home);
  let count = 0;
  const stack: Array<{ dir: string; top: boolean }> = [{ dir: home, top: true }];
  while (stack.length) {
    const { dir, top } = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (++count > MAX_ENTRIES) throw new ScriptIsolationError('The account folder has too many files to open to plugin scripts.');
      if (top && (name === scratchName || isDbFile(name))) continue;
      const p = join(dir, name);
      let seen: Stats;
      try { seen = lstatSync(p); } catch { continue; }
      if (seen.isDirectory()) {
        if (seen.uid !== user.uid) grantEntry(p, seen, user.gid, 0o070);
        stack.push({ dir: p, top: false });
      } else if (seen.isFile()) {
        const special = (seen.mode & SPECIAL_BITS) !== 0;
        if (seen.nlink > 1) {
          if (special && seen.uid !== user.uid) throw new ScriptIsolationError(`Cannot open the account folder to plugin scripts: ${p} has setuid / setgid bits and other hard links.`);
          continue;
        }
        if (seen.uid !== user.uid) grantEntry(p, seen, user.gid, 0o060);
      }
      // 软链、设备、管道、套接字:不碰
    }
  }
  setDir(home, user.gid, TOP_OPEN);
}

/** 跑完关上:顶层收回 0700、属主 / 组都是引擎。失败就抛(调用方记下来,下次跑脚本前再收)。 */
export function closeAccountToScripts(home: string): void {
  setDir(home, engineIds().gid, TOP_CLOSED);
}
