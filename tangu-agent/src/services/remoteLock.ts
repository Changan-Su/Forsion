/**
 * 远程锁定(设备能力 MCP 方案 P1 · K2 §3.1,方案 §6.5):「急停」之后这台电脑拒绝一切非本机发起的执行,直到本机经系统认证解锁。
 *
 * 真源在桌面主进程:它落 `<userData>/remote-lock.json`(`{v:1, lock:null|{locked,at,source}, hotkey}`),经 env
 * FORSION_REMOTE_LOCK_FILE 把绝对路径交给引擎(同电脑历史第二道闸的先例)。引擎**不缓存**、每次现读(几百字节):
 *   - env 没设 / 不是绝对路径 → 未锁(独立 CLI / TUI 没有桌面锁的概念);
 *   - ENOENT → 未锁(从未急停过);
 *   - 读错 / 坏 JSON / 没有 lock 键 / lock 既不是 null 也不是 {locked:true} → **锁定**(fail closed:只有字面 `lock: null` 才算没锁);
 *   - lock.locked === true → 锁定;
 *   - 进程内闩(latchRemoteLock,estop 路由无条件上)→ 锁定:主进程写盘失败 / 引擎先于主进程收到急停时的兜底。
 * 清闩只在「锁文件可读且 lock === null」时成立(= 主进程已经过系统认证并写好解锁):只凭本机引擎令牌(渲染层也有)清不掉。
 *
 * ⚠️ 名字镜像 desktop/shared/remoteSafety.ts 的 REMOTE_LOCK_FILE_ENV(引擎 rootDir 不含 desktop/,不 import;改名两处同步,各有一条测试钉字符串)。
 * ⚠️ 锁只收紧、不放宽:它决定「拒不拒」,从不改变任何放行判定。
 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const REMOTE_LOCK_FILE_ENV = 'FORSION_REMOTE_LOCK_FILE';
export const REMOTE_LOCKED = 'REMOTE_LOCKED';
export const remoteLockedBody = {
  code: REMOTE_LOCKED,
  detail: 'Remote access to this computer is locked. Unlock it on the computer itself.',
} as const;

export interface RemoteLockState {
  locked: boolean;
  /** file = 锁文件(含读不出 = fail closed);latch = 仅进程内闩;null = 未锁。 */
  source: 'file' | 'latch' | null;
  /** 锁文件里的急停时刻(epoch ms);闩 = 上闩时刻。 */
  at?: number;
}

type FileVerdict = { kind: 'none' } | { kind: 'unlocked' } | { kind: 'locked'; at?: number } | { kind: 'broken' };

let latchedAt: number | null = null;

/** 读锁文件 → 判定(纯读,不抛)。 */
function readLockFile(): FileVerdict {
  const file = process.env[REMOTE_LOCK_FILE_ENV];
  if (!file || !isAbsolute(file)) return { kind: 'none' };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e: any) {
    return e?.code === 'ENOENT' ? { kind: 'none' } : { kind: 'broken' };
  }
  let o: any;
  try { o = JSON.parse(raw); } catch { return { kind: 'broken' }; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Object.prototype.hasOwnProperty.call(o, 'lock')) return { kind: 'broken' };
  const lock = o.lock;
  if (lock === null) return { kind: 'unlocked' };
  if (lock && typeof lock === 'object' && !Array.isArray(lock) && lock.locked === true) {
    return { kind: 'locked', ...(Number.isFinite(lock.at) ? { at: Number(lock.at) } : {}) };
  }
  return { kind: 'broken' };
}

/** 此刻是否锁定(文件 ∨ 闩)。不抛。 */
export function remoteLocked(): boolean {
  return remoteLockState().locked;
}

export function remoteLockState(): RemoteLockState {
  const f = readLockFile();
  if (f.kind === 'locked') return { locked: true, source: 'file', ...(f.at !== undefined ? { at: f.at } : {}) };
  if (f.kind === 'broken') return { locked: true, source: 'file' };
  if (latchedAt !== null) return { locked: true, source: 'latch', at: latchedAt };
  return { locked: false, source: null };
}

/** 上闩(只由 estop 路由调;幂等,保留第一次的时刻)。 */
export function latchRemoteLock(): void {
  if (latchedAt === null) latchedAt = Date.now();
}

/**
 * 清闩(只由 unlock 路由调)。只有锁文件**可读且 lock === null** 才清 → true;
 * ENOENT / 读错 / 坏 JSON / 仍 locked → false,闩不动(本机令牌清不掉系统认证之前的锁)。
 */
export function clearRemoteLatch(): boolean {
  if (readLockFile().kind !== 'unlocked') return false;
  latchedAt = null;
  return true;
}

/** @internal 测试用。 */
export function __resetRemoteLatchForTests(): void {
  latchedAt = null;
}
