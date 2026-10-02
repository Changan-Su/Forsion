/**
 * TUI 输入历史:跨会话落盘到 <tanguHome>/tui_history(dev 形态 TANGU_HOME 已指向隔离家目录,这里不另判)。
 *
 * - 格式:每行一个 JSON 字符串(Alt+Enter 的多行输入原样保留,不会被行切碎);读到坏行按原文收下。
 * - 规则(同 shell 的 HISTCONTROL=ignoreboth):空白行不记;**以空格开头的行不记**(用户主动「别记这条」);
 *   与上一条相同不重复记;↑ 最多翻最近 500 条。盘上不是严格 500 条:攒到 2×500 = 1000 条才整理回最近 500 条
 *   (见下「偶尔整理」),所以文件里最多约 1000 条(拿不到锁时只追加不整理,还会再多几条)。
 * - 形似密钥的行(sk-… / ghp_… / AKIA… / 私钥头)本会话仍可 ↑ 找回,但**不落盘**。
 * - 模块级单例而非组件 useRef:InputBox 在审批 / 选择器弹出时会被卸载,放组件里每次审批都会把历史清空。
 * - 写盘=O_APPEND 追加一行(appendFileSync):两个 tangu 同时开,各自的新行都是一次 append,谁也盖不掉谁。
 *   旧版「读 → 追加 → 原子替换整份」在两个进程同时读到同一份时,后 rename 的会吞掉先写的那行(Codex 评审 tui #3)。
 * - 截断改成「偶尔整理」:文件攒到 2×limit 条才重写成最近 limit 条(每 ~500 次输入一次)。整理=「读 → 截 → 写临时
 *   文件 → rename 盖回」,读与 rename 之间别人追加的行会被旧快照盖掉 —— 只比大小关不死这个窗口(Codex 复核 #6:
 *   核对之后、rename 之前的追加照样丢)。所以**整条落盘(读 → 去重 → 整理或追加)都在跨进程锁里做**:
 *     · 锁=同目录 `<file>.lock`,O_EXCL 独占创建,内容记 pid / 主机名 / 随机 token;正常只持有几毫秒。
 *     · 等锁最多 ~1s(同步小睡,输入路径上最多卡这么久;按单调时钟计,墙钟跳变不拉长);等不到 → 只追加、
 *       **绝不整理**。这条退路最坏只会让「这次没拿到锁的自己那一行」被别人正在做的整理盖掉。
 *     · 陈旧锁:同机且 pid 已不在 → 立即判陈旧;同机且 pid 还活着(含 EPERM=活着但不归我们管)→ 10 分钟没动过
 *       才判陈旧 —— 活着的持有者哪怕被挂起 / 合盖睡了很久也不抢(Codex 复核 R2:10s 就抢,会在它「核完、rename 前」
 *       抢走,锁下写的行照样被它恢复后的 rename 盖掉);10 分钟这档只为兜「持有者崩了、pid 被无关进程复用」,
 *       否则那把锁永远占着、每次回车都白等 1s 且再不整理。异机(共享家目录)/ 锁内容读不出 → 查不了 pid,10s 没动过即判陈旧。
 *       破锁先 rename 到唯一名再核对「就是我判陈旧的那一份」(inode + mtime + 内容),不是就 link 放回 ——
 *       直接 unlink 会在两个进程同时破锁时删掉第三者刚拿到的新锁。
 *     · 整理 rename 前再核一次「锁还是我的」+ 文件大小没变:卡在核对**之前**被破了锁 → 这次不整理。
 *     · 放锁只删 token 是自己的那一份。
 *     · 残余窗口(不假装关死):持有者卡在「核对 → rename」或「核 token → 删锁」之间,且被人合法破了锁 ——
 *       同机要 pid 活着卡满 10 分钟 / 墙钟在睡眠唤醒时跳过 10 分钟后恰好撞上对方正在破锁,异机要卡满 10s。
 *       撞上时:破锁者在锁下追加的行会被恢复后的 rename 盖掉 / 恢复后的放锁会删掉破锁者的锁。
 * - 读时把相邻重复折叠掉(拿不到锁退回裸追加时去重检查可能撞车,只是多一行,读时收拾)。读不上锁:rename 是原子的。
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { tanguHome } from '../core/tanguHome.js';

export const HISTORY_LIMIT = 500;

export const historyFile = (): string => join(tanguHome(), 'tui_history');

/** 会不会记进历史(内存 + 磁盘都看这一条)。 */
export function shouldRecord(line: string): boolean {
  return !!line.trim() && !/^\s/.test(line);
}

const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic 风格
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub token
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
export const looksSecret = (line: string): boolean => SECRET_RES.some((re) => re.test(line));

/** 追加一条(不可变):不记的行原样返回;与末条相同不重复;截到最近 limit 条。 */
export function pushHistory(entries: string[], line: string, limit = HISTORY_LIMIT): string[] {
  if (!shouldRecord(line)) return entries;
  if (entries[entries.length - 1] === line) return entries;
  const next = [...entries, line];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function parseHistory(raw: string): string[] {
  const out: string[] = [];
  const add = (v: string): void => {
    if (out[out.length - 1] !== v) out.push(v); // 相邻重复折叠(见文件头)
  };
  for (const ln of raw.split('\n')) {
    if (!ln) continue;
    try {
      const v = JSON.parse(ln);
      if (typeof v === 'string' && v) add(v);
    } catch {
      add(ln); // 手工编辑 / 旧格式:整行当一条(也包括追加撞车时被截半的行 —— 丢一条总比整份读不出来强)
    }
  }
  return out;
}

export const serializeHistory = (entries: string[]): string => entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');

export function loadHistory(file = historyFile(), limit = HISTORY_LIMIT): string[] {
  try {
    const all = parseHistory(readFileSync(file, 'utf8'));
    return all.length > limit ? all.slice(all.length - limit) : all;
  } catch {
    return [];
  }
}

/** 读盘上现状;size 按字节记(整理前据此判断读后有没有人追加过)。 */
const readRaw = (file: string): { raw: string; size: number } => {
  try {
    const buf = readFileSync(file);
    return { raw: buf.toString('utf8'), size: buf.length };
  } catch {
    return { raw: '', size: 0 };
  }
};

// ───────────── 跨进程锁(见文件头) ─────────────

/** 等锁 / 判陈旧的时限;缺省值之外只给测试调小用。 */
export interface HistoryLockOptions {
  /** 最多等多久(ms);等不到就只追加、不整理。 */
  waitMs?: number;
  /** 查不了 pid 的锁(异机 / 内容读不出)多久没动过判陈旧(ms);同机 pid 已不在 → 立即,同机 pid 活着 → 固定 10 分钟。 */
  staleMs?: number;
}
const LOCK_WAIT_MS = 1000;
const LOCK_STALE_MS = 10_000;
/** 同机、pid 还活着的持有者:只为兜 pid 复用才破(见文件头)。 */
const LOCK_LIVE_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 5;
/** Windows 上锁文件处于「删除挂起」(杀软 / 另一个 tangu 还开着它)时 CREATE_NEW 报 EPERM/EACCES,按「被占」处理;
 *  POSIX 上它们是真权限错误(目录不可写),立刻放弃。同 core/config.ts 的 LOCK_BUSY;调用时判平台(测试要能模拟)。 */
const lockBusy = (code: string | undefined): boolean =>
  code === 'EEXIST' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));

export const historyLockFile = (file: string): string => `${file}.lock`;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** 一次观察到的锁文件:判陈旧、以及破锁后核对「是不是同一份」都靠它。 */
interface LockSnapshot {
  raw: string;
  ino: number;
  mtimeMs: number;
}

const snapshotLock = (path: string): LockSnapshot | null => {
  try {
    const st = statSync(path);
    return { raw: readFileSync(path, 'utf8'), ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
};

const lockField = (raw: string): { pid?: unknown; host?: unknown; token?: unknown } => {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {}; // 持有者刚创建还没写完 / 写坏了:只按时限判
  }
};

function lockIsStale(snap: LockSnapshot, staleMs: number): boolean {
  const age = Date.now() - snap.mtimeMs; // 与锁文件 mtime 比,只能用墙钟
  const { pid, host } = lockField(snap.raw);
  if (typeof pid === 'number' && pid > 0 && host === hostname()) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return true; // 持有者进程已不在
      alive = code === 'EPERM'; // EPERM=活着但不归我们管;别的错误=说不清,按查不了 pid 处理
    }
    if (alive) return age > LOCK_LIVE_STALE_MS; // 活着的持有者卡再久也不按 10s 抢(见文件头)
  }
  return age > staleMs;
}

/** 破一把判为陈旧的锁。返回 true=可以立刻重试取锁。 */
function breakStaleLock(lock: string, seen: LockSnapshot): boolean {
  const aside = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try {
    renameSync(lock, aside);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'; // 别人已破 / 已放:直接重试
  }
  const got = snapshotLock(aside);
  const same = !!got && got.ino === seen.ino && got.mtimeMs === seen.mtimeMs && got.raw === seen.raw;
  if (!same) {
    // 挪走的是别人刚拿到的新锁(另一个进程抢先破了旧锁):link 放回(不覆盖;若这一瞬又被第三者拿到就放不回 ——
    // 被挪的那位 rename 前核「锁还是我的」会失败,只会放弃整理,不会盖行)。
    try {
      linkSync(aside, lock);
    } catch {
      /* ignore */
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    /* ignore */
  }
  return true;
}

/** 取锁;返回 token(放锁 / 核对持有用),等不到或建不了锁返回 null。 */
function acquireHistoryLock(lock: string, opts: HistoryLockOptions = {}): string | null {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const body = JSON.stringify({ pid: process.pid, host: hostname(), token });
  const deadline = performance.now() + waitMs; // 单调时钟:墙钟跳变不拉长等待
  for (;;) {
    let fd: number;
    let busy = '';
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (e) {
      busy = (e as NodeJS.ErrnoException).code ?? '';
      if (!lockBusy(busy)) return null; // 目录不可写之类:没法上锁
      fd = -1;
    }
    if (fd >= 0) {
      let written = false;
      try {
        writeSync(fd, body);
        written = true;
      } catch {
        /* 下面收拾 */
      }
      try {
        closeSync(fd); // 立即关:Windows 上删不掉打开着的文件
      } catch {
        /* ignore */
      }
      if (written) return token;
      try {
        unlinkSync(lock); // 自己刚建、没写成的锁,别留给别人等到陈旧
      } catch {
        /* ignore */
      }
      return null;
    }
    if (performance.now() >= deadline) return null;
    const snap = snapshotLock(lock);
    if (!snap) {
      // EEXIST 却读不到 = 刚被放掉:马上再抢。Windows 删除挂起时 open 报 EPERM、stat 也失败 —— 那种不睡就空转到时限。
      if (busy !== 'EEXIST') sleepSync(LOCK_POLL_MS);
      continue;
    }
    if (lockIsStale(snap, staleMs) && breakStaleLock(lock, snap)) continue;
    sleepSync(LOCK_POLL_MS);
  }
}

const holdsHistoryLock = (lock: string, token: string): boolean => {
  try {
    return lockField(readFileSync(lock, 'utf8')).token === token;
  } catch {
    return false;
  }
};

function releaseHistoryLock(lock: string, token: string): void {
  if (!holdsHistoryLock(lock, token)) return; // 被当成陈旧破掉、别人已接手:不删人家的锁
  try {
    unlinkSync(lock);
  } catch {
    /* ignore */
  }
}

/**
 * 攒到 2×limit 条时重写成最近 limit 条(含本条)。只在持锁时调用。返回是否已由整理写入本条;
 * 锁已不是自己的 / 文件在读后被改过 → 不整理(false),由调用方照常追加。
 */
function compactWith(file: string, readSize: number, all: string[], line: string, limit: number, stillLocked: () => boolean): boolean {
  if (all.length < limit * 2) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, serializeHistory(pushHistory(all.slice(-limit), line, limit)), { mode: 0o600 });
    // 双保险:我们卡太久被当成陈旧破了锁(别的进程可能已在追加),或有不守锁的写者(手工编辑)改过文件 —— 都不整理。
    if (!stillLocked()) throw new Error('lock lost');
    if (statSync(file).size !== readSize) throw new Error('changed');
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      unlinkSync(tmp); // 自己刚写的临时文件,不留残骸
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** 把一条落盘(不落盘的行直接跳过)。失败静默:历史是便利功能,不能因为磁盘问题打断输入。 */
export function persistHistoryLine(line: string, file = historyFile(), limit = HISTORY_LIMIT, lockOpts?: HistoryLockOptions): void {
  if (!shouldRecord(line) || looksSecret(line)) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const lock = historyLockFile(file);
    const token = acquireHistoryLock(lock, lockOpts);
    try {
      const { raw, size } = readRaw(file);
      const all = parseHistory(raw);
      if (all[all.length - 1] === line) return; // 与盘上末条相同:不重复记
      // 没拿到锁绝不整理(整理会盖掉别人正在写的行);只追加 —— O_APPEND 盖不到任何人。
      if (token && compactWith(file, size, all, line, limit, () => holdsHistoryLock(lock, token))) return;
      // 输入可能含私密内容:新建时仅本人可读。整行一次 write,O_APPEND 保证与别的进程的追加不互相覆盖。
      // 手工编辑过、末尾没换行的文件:先补一个换行,别把新行粘到人家最后一行后面。
      const sep = raw && !raw.endsWith('\n') ? '\n' : '';
      appendFileSync(file, sep + serializeHistory([line]), { mode: 0o600 });
    } finally {
      if (token) releaseHistoryLock(lock, token);
    }
  } catch {
    /* ignore */
  }
}

export interface HistoryStore {
  /** 旧 → 新。 */
  list(): string[];
  add(line: string): void;
}

/** 启动时载入一次;本会话新增的行进内存(↑↓ 用)并同步落盘。 */
export function createHistoryStore(file = historyFile(), limit = HISTORY_LIMIT): HistoryStore {
  let entries = loadHistory(file, limit);
  return {
    list: () => entries,
    add(line: string) {
      entries = pushHistory(entries, line, limit);
      persistHistoryLine(line, file, limit);
    },
  };
}

let shared: HistoryStore | null = null;
/** 进程级单例(懒加载:tanguHome 可能在启动早期才由 .env 定下来)。 */
export function inputHistory(): HistoryStore {
  if (!shared) shared = createHistoryStore();
  return shared;
}
