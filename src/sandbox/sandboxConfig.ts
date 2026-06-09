/**
 * 沙箱运行期配置：并发上限 / 包缓存体积上限 / 缓存保留天数。
 * 默认值来自环境变量；admin 可在后台覆盖（落 global_settings）。
 * 提供同步 getter（semaphore/缓存策略要同步读），启动时 + 每次 set 后从 DB 刷新到内存。
 */
import { query } from '../core/db.js';

const K_MAX_CONCURRENT = 'agent_sandbox.max_concurrent';
const K_CACHE_MAX_MB = 'agent_sandbox.pkg_cache_max_mb';
const K_CACHE_TTL_DAYS = 'agent_sandbox.pkg_cache_ttl_days';

export interface SandboxConfig {
  maxConcurrent: number;   // 同时存活的沙箱容器上限（>=1）
  pkgCacheMaxMB: number;   // 包缓存体积上限 MB（0=不限）
  pkgCacheTtlDays: number; // 包缓存保留天数，超期清空（0=不清）
}

/** 环境变量默认值（admin 未覆盖时生效）。 */
export const SANDBOX_DEFAULTS: SandboxConfig = {
  maxConcurrent: clampInt(Number(process.env.AGENT_SANDBOX_MAX_CONCURRENT) || 6, 1, 64),
  pkgCacheMaxMB: clampInt(Number(process.env.AGENT_SANDBOX_PKG_CACHE_MAX_MB ?? 2048), 0, 1_000_000),
  pkgCacheTtlDays: clampInt(Number(process.env.AGENT_SANDBOX_PKG_CACHE_TTL_DAYS ?? 30), 0, 3650),
};

let current: SandboxConfig = { ...SANDBOX_DEFAULTS };

/** 同步取当前生效配置（内存缓存）。 */
export function sandboxConfig(): SandboxConfig {
  return current;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function readNum(key: string, fallback: number): Promise<number> {
  try {
    const rows = await query<any[]>(`SELECT value FROM global_settings WHERE "key" = ? LIMIT 1`, [key]);
    if (!rows.length) return fallback;
    const n = parseFloat(rows[0].value);
    return Number.isNaN(n) ? fallback : n;
  } catch {
    return fallback;
  }
}

async function writeNum(key: string, value: number): Promise<void> {
  await query(
    `INSERT INTO global_settings ("key", value) VALUES (?, ?)
     ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)],
  );
}

/** 从 DB 读覆盖值刷新到内存（启动时 + set 后调用）。失败则维持现值。 */
export async function loadSandboxConfig(): Promise<SandboxConfig> {
  const [mc, mb, ttl] = await Promise.all([
    readNum(K_MAX_CONCURRENT, SANDBOX_DEFAULTS.maxConcurrent),
    readNum(K_CACHE_MAX_MB, SANDBOX_DEFAULTS.pkgCacheMaxMB),
    readNum(K_CACHE_TTL_DAYS, SANDBOX_DEFAULTS.pkgCacheTtlDays),
  ]);
  current = {
    maxConcurrent: clampInt(mc, 1, 64),
    pkgCacheMaxMB: clampInt(mb, 0, 1_000_000),
    pkgCacheTtlDays: clampInt(ttl, 0, 3650),
  };
  return current;
}

/** admin 设置：只更新传入的字段，校验并持久化，刷新内存。返回最新配置。 */
export async function setSandboxConfig(p: Partial<SandboxConfig>): Promise<SandboxConfig> {
  if (p.maxConcurrent != null) await writeNum(K_MAX_CONCURRENT, clampInt(p.maxConcurrent, 1, 64));
  if (p.pkgCacheMaxMB != null) await writeNum(K_CACHE_MAX_MB, clampInt(p.pkgCacheMaxMB, 0, 1_000_000));
  if (p.pkgCacheTtlDays != null) await writeNum(K_CACHE_TTL_DAYS, clampInt(p.pkgCacheTtlDays, 0, 3650));
  return loadSandboxConfig();
}
