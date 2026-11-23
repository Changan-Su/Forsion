/**
 * 多账号模式(core/accountScope.ts)的上限:每个账号同时几个任务、整个引擎同时几个对话、排队多久算忙、一轮多长、一次插件脚本多长、
 * 每个账号多少磁盘、全部账号合计多少磁盘后不再接新账号,以及打开的账号库多久没用就关。
 *
 * 只认引擎级的一份文件 `<engineRoot>/multi-account-limits.json`(不在任何账号的文件夹里,请求也改不了它),宿主的管理端以后写这份文件来调;
 * 引擎每隔几秒看一次修改时间,改了就重读,不用重启。
 *
 * 读写纪律(读失败 ≠ 空):
 *  - 文件不存在 = 没配置 → 全部用缺省值。
 *  - 读不出 / 不是 JSON / 不是对象 → 保留上一次读成功的值(启动时就坏 → 缺省值),记一条警告。绝不当成「没有上限」。
 *  - 单个字段不是正数 → 这一项用缺省值,其余照用;超过平台上限的按平台上限截。
 * 插件脚本一次只跑一个是写死的(SCRIPT_CONCURRENCY),不进这份文件:岛的内存只够同时一个抓取。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { engineRoot } from './accountScope.js';

export interface MultiAccountLimits {
  /** 每个账号同时在跑的任务(run)数;多出来的排队。 */
  runsPerAccount: number;
  /** 整个引擎同时在跑的任务数;多出来的排队。 */
  concurrentRuns: number;
  /** 每个账号最多排着几个任务(超过当场回忙,别让一个账号占满整条队)。 */
  queuedRunsPerAccount: number;
  /** 因为引擎满了而排队,超过这么久还没轮到 → 回「忙」。 */
  queueTimeoutMinutes: number;
  /** 一轮对话从开跑起最长多久(到点中止,已生成的部分照常保存)。 */
  runMinutes: number;
  /** 一次插件脚本最长多久(到点连同子进程一起结束)。 */
  scriptMinutes: number;
  /** 一次插件脚本的临时目录最多多大(超了当场结束)。 */
  scriptScratchMB: number;
  /** 每个账号的磁盘上限(账号文件夹,不含插件脚本的临时目录)。 */
  accountStorageMB: number;
  /** 全部账号合计到这么多后不再接新账号(已有账号照常用)。 */
  totalStorageGB: number;
  /** 账号库多久没用就关掉(下次用时自动重开)。 */
  idleCloseMinutes: number;
  /** 同时打开的账号库最多几个(超出时先关最久没用、手上没事的)。 */
  maxOpenAccounts: number;
}

export const DEFAULT_LIMITS: Readonly<MultiAccountLimits> = Object.freeze({
  runsPerAccount: 1,
  concurrentRuns: 3,
  queuedRunsPerAccount: 5,
  queueTimeoutMinutes: 10,
  runMinutes: 15,
  scriptMinutes: 5,
  scriptScratchMB: 2048,
  accountStorageMB: 200,
  totalStorageGB: 10,
  idleCloseMinutes: 10,
  maxOpenAccounts: 64,
});

/** 平台上限:配置文件只能在这以内调。 */
const PLATFORM_MAX: Readonly<MultiAccountLimits> = Object.freeze({
  runsPerAccount: 8,
  concurrentRuns: 64,
  queuedRunsPerAccount: 50,
  queueTimeoutMinutes: 120,
  runMinutes: 240,
  scriptMinutes: 60,
  scriptScratchMB: 20_480,
  accountStorageMB: 102_400,
  totalStorageGB: 10_240,
  idleCloseMinutes: 1440,
  maxOpenAccounts: 4096,
});

/** 插件脚本整个引擎同一时间只跑一个(写死,不进配置)。 */
export const SCRIPT_CONCURRENCY = 1;

/** 只有这些字段是整数(个数);其余是时长 / 容量,允许小数。 */
const INTEGER_FIELDS = new Set<keyof MultiAccountLimits>(['runsPerAccount', 'concurrentRuns', 'queuedRunsPerAccount', 'maxOpenAccounts']);

export const LIMITS_FILE_NAME = 'multi-account-limits.json';
export const limitsFile = (): string => join(engineRoot(), LIMITS_FILE_NAME);

const RECHECK_MS = 5_000;
let current: MultiAccountLimits = { ...DEFAULT_LIMITS };
let lastCheck = 0;
let lastSig: string | null = null; // 上次读过的文件签名(mtime + 大小);null = 不存在 / 没读过

function sanitize(raw: Record<string, unknown>, file: string): MultiAccountLimits {
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof MultiAccountLimits>) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || (INTEGER_FIELDS.has(key) && !Number.isInteger(v))) {
      console.warn(`[tangu] multi-account: ${file}: "${key}" must be a positive ${INTEGER_FIELDS.has(key) ? 'integer' : 'number'}; using the default (${DEFAULT_LIMITS[key]})`);
      continue;
    }
    if (v > PLATFORM_MAX[key]) {
      console.warn(`[tangu] multi-account: ${file}: "${key}" = ${v} is above the platform maximum; using ${PLATFORM_MAX[key]}`);
      out[key] = PLATFORM_MAX[key];
      continue;
    }
    out[key] = v;
  }
  return out;
}

let warnedUnreadable: string | null = null;
function reload(): void {
  const file = limitsFile();
  let sig: string | null;
  try {
    const st = statSync(file);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      if (lastSig !== null) console.log(`[tangu] multi-account: ${file} removed; using the default limits`);
      lastSig = null;
      current = { ...DEFAULT_LIMITS };
      return;
    }
    console.warn(`[tangu] multi-account: cannot read ${file} (${(e as Error)?.message || e}); keeping the previous limits`);
    return;
  }
  if (sig === lastSig) return;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    // 读不出来(权限等)≠ 坏文件:不记这一版的签名,下次照样再读;只报一次
    if (warnedUnreadable !== sig) console.warn(`[tangu] multi-account: cannot read ${file} (${(e as Error)?.message || e}); keeping the previous limits`);
    warnedUnreadable = sig;
    return;
  }
  warnedUnreadable = null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.warn(`[tangu] multi-account: cannot parse ${file} (${(e as Error)?.message || e}); keeping the previous limits`);
    lastSig = sig; // 同一份坏文件不反复报;改了再读
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[tangu] multi-account: ${file} is not a JSON object; keeping the previous limits`);
    lastSig = sig;
    return;
  }
  current = sanitize(raw as Record<string, unknown>, file);
  lastSig = sig;
}

/** 当前生效的上限(每 5 秒最多看一次文件的修改时间)。 */
export function multiAccountLimits(): Readonly<MultiAccountLimits> {
  const now = Date.now();
  if (now - lastCheck >= RECHECK_MS) {
    lastCheck = now;
    reload();
  }
  return current;
}

/** 立即重读(测试 / 管理端写完文件后)。 */
export function reloadMultiAccountLimits(): Readonly<MultiAccountLimits> {
  lastCheck = Date.now();
  reload();
  return current;
}

export const minutesMs = (m: number): number => Math.round(m * 60_000);
export const mbBytes = (mb: number): number => Math.round(mb * 1024 * 1024);
