/**
 * 多账号模式(core/accountScope.ts)的磁盘上限:每个账号的文件夹(对话库、Agent、记忆、技能、上传、工作文件)有一个上限,
 * 全部账号合计到一个总量后不再接新账号。数值来自 core/multiAccountLimits.ts。
 *
 * 量法:从账号 home 往下走(lstat,不跟软链;软链本身按 0 算),累加普通文件的大小。插件脚本的临时目录(`<home>/.scratch`)和库的
 * 预写日志不算进每个账号的量(前者脚本跑完、这一轮结束就删,另有单次上限;后者检查点后并回库文件),但都算进全部账号的合计。量的结果缓存一小会儿;写过东西之后标脏、下次重量。
 * 判不出(量失败)按「已满」处理 —— 读失败不当成空。
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { accountHome, engineRoot, isMultiAccount } from '../core/accountScope.js';
import { mbBytes, multiAccountLimits } from '../core/multiAccountLimits.js';

/** 账号文件夹里插件脚本的临时目录名(每轮一个子目录,轮次结束删)。 */
export const SCRATCH_DIR = '.scratch';

export class StorageLimitError extends Error {
  readonly code = 'STORAGE_LIMIT';
  readonly status = 507;
  constructor(message = 'Storage limit reached for this account. Delete files or conversations to continue.') {
    super(message);
    this.name = 'StorageLimitError';
  }
}

const ACCOUNT_MAX_AGE_MS = 30_000;
/** 每个账号的量里不算的顶层项:插件脚本临时目录;库的预写日志与共享内存文件(随写随涨、检查点后并回 state.db,只是过渡)。 */
const ACCOUNT_SKIP: ReadonlySet<string> = new Set([SCRATCH_DIR, 'state.db-wal', 'state.db-shm', 'state.db-journal']);
const TOTAL_MAX_AGE_MS = 60_000;
const MAX_ENTRIES = 500_000; // 走这么多项还没走完 = 量不出(按已满处理)

/** 目录占用(字节);skipTop = 顶层跳过的名字。走不完 / 读不了根 → 抛。 */
async function measure(root: string, skipTop?: ReadonlySet<string>): Promise<number> {
  let total = 0;
  let seen = 0;
  const stack: Array<{ dir: string; top: boolean }> = [{ dir: root, top: true }];
  while (stack.length) {
    const { dir, top } = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (dir === root && (e as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
      if (dir === root) throw e;
      continue; // 子目录读不了(被并发删掉等):跳过
    }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) throw new Error(`too many entries under ${root}`);
      if (top && skipTop?.has(name)) continue;
      const p = join(dir, name);
      let st;
      try { st = await lstat(p); } catch { continue; }
      if (st.isDirectory()) stack.push({ dir: p, top: false });
      else if (st.isFile()) total += st.size;
    }
  }
  return total;
}

interface Cached { bytes: number; at: number; dirty: boolean; pending: Promise<number> | null }
const accounts = new Map<string, Cached>();
let total: Cached | null = null;

function cachedMeasure(slot: Cached, maxAgeMs: number, run: () => Promise<number>): Promise<number> {
  if (!slot.dirty && Date.now() - slot.at < maxAgeMs) return Promise.resolve(slot.bytes);
  if (slot.pending) return slot.pending;
  slot.dirty = false;
  const p = run().then(
    (bytes) => { slot.bytes = bytes; slot.at = Date.now(); return bytes; },
    (e) => { slot.at = 0; throw e; },
  ).finally(() => { if (slot.pending === p) slot.pending = null; });
  slot.pending = p;
  return p;
}

/** 这个账号文件夹的占用(不含插件脚本临时目录),缓存 30 秒或到被标脏。 */
export function accountUsageBytes(id: string): Promise<number> {
  let slot = accounts.get(id);
  if (!slot) accounts.set(id, (slot = { bytes: 0, at: 0, dirty: true, pending: null }));
  return cachedMeasure(slot, ACCOUNT_MAX_AGE_MS, () => measure(accountHome(id), ACCOUNT_SKIP));
}

/** 写过东西了:下次判上限时重量这个账号(合计也跟着重量)。 */
export function markAccountUsageDirty(id: string): void {
  const slot = accounts.get(id);
  if (slot) slot.dirty = true;
  if (total) total.dirty = true;
}

/** 全部账号合计(含插件脚本临时目录),缓存 60 秒。 */
export function totalUsageBytes(): Promise<number> {
  if (!total) total = { bytes: 0, at: 0, dirty: true, pending: null };
  return cachedMeasure(total, TOTAL_MAX_AGE_MS, () => measure(join(engineRoot(), 'accounts')));
}

/** 上次量到的合计(不触发量;没量过 = null)。/health 用。 */
export function lastTotalUsage(): { bytes: number; at: number } | null {
  return total && total.at ? { bytes: total.bytes, at: total.at } : null;
}

/**
 * 这个账号还能不能再写 incoming 字节:已占用 + incoming 超过上限 → StorageLimitError。量不出 → 也按超了处理。
 * 单人模式什么都不做。
 */
export async function assertAccountStorage(id: string, incoming = 0): Promise<void> {
  if (!isMultiAccount()) return;
  const limit = mbBytes(multiAccountLimits().accountStorageMB);
  let used: number;
  try {
    used = await accountUsageBytes(id);
  } catch (e) {
    console.warn(`[tangu] multi-account: measuring the storage of ${id} failed (${(e as Error)?.message || e}); treating it as full`);
    throw new StorageLimitError();
  }
  if (used + Math.max(0, incoming) > limit) throw new StorageLimitError();
}

let lastClosedWarn = 0;
/** 还接不接新账号:全部账号合计没到总量上限。量不出 → 不接(并告警)。到了上限时每小时最多记一条警告给管理员。 */
export async function newAccountsAllowed(): Promise<boolean> {
  const limit = multiAccountLimits().totalStorageGB * 1024 * 1024 * 1024;
  let used: number;
  try {
    used = await totalUsageBytes();
  } catch (e) {
    console.warn(`[tangu] multi-account: measuring the total storage failed (${(e as Error)?.message || e}); not accepting new accounts`);
    return false;
  }
  if (used < limit) return true;
  if (Date.now() - lastClosedWarn > 3600_000) {
    lastClosedWarn = Date.now();
    console.warn(`[tangu] multi-account: accounts use ${(used / 1024 ** 3).toFixed(2)} GB of the ${multiAccountLimits().totalStorageGB} GB limit; new accounts are refused until space is freed or the limit is raised`);
  }
  return false;
}

/** 测试用:清空缓存。 */
export function __resetAccountStorageForTests(): void {
  accounts.clear();
  total = null;
  lastClosedWarn = 0;
}
