/**
 * 个人形态(standalone / TUI / desktop)的 HostServices on **原生 SQLite**(better-sqlite3)。
 *
 * 取代 PGlite——PGlite 单进程独占数据目录,TUI(进程内)与 Desktop 的 tangu-server 子进程
 * 不能同时打开同一个库,导致本地会话不共享。SQLite 在 **WAL 模式**下「一写多读、多进程共享
 * 一个文件」,故 ~/.tangu/state.db 可被两端同时打开,会话/run 本地即时共享(用户的诉求)。
 *
 * 方言:占位符用原生 `?`(不转 $n);DDL 经 toSqliteDDL(JSONB→TEXT、BIGSERIAL→AUTOINCREMENT);
 * INTERVAL 经 getOlderThanSql 走 datetime();CURRENT_TIMESTAMP / ON CONFLICT 两方言一致。
 * better-sqlite3 是同步 API,包成 Promise 满足 HostServices.query 的 async 签名(单用户低并发,够用)。
 */
import type { RequestHandler } from 'express';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { HostServices } from '../../seams/hostServices.js';

export interface SqliteHostConfig {
  /** SQLite 落盘文件路径;undefined/'memory' → 内存库(进程退出即丢)。 */
  dataDir?: string;
  /** 保护本地 HTTP 端点的 token(校验 Bearer)。 */
  localToken: string;
  /** 本地单用户 id(所有 run 归属它)。 */
  userId: string;
}

/** WAL(一写多读);NFS/SMB/WSL1 上 WAL 不可用时回落 DELETE(照 Hermes apply_wal_with_fallback)。 */
function applyWalWithFallback(db: Database.Database): void {
  try {
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (String(mode).toLowerCase() !== 'wal') db.pragma('journal_mode = DELETE');
  } catch {
    try { db.pragma('journal_mode = DELETE'); } catch { /* 兜底:保持默认 journal */ }
  }
}

/** better-sqlite3 绑定不接受 undefined / boolean → 归一化(undefined→null,bool→0/1)。 */
function sanitize(v: any): any {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function createSqliteHost(cfg: SqliteHostConfig): { host: HostServices; db: Database.Database } {
  const persistent = cfg.dataDir && cfg.dataDir !== 'memory';
  if (persistent) mkdirSync(dirname(cfg.dataDir as string), { recursive: true });
  const db = new Database(persistent ? (cfg.dataDir as string) : ':memory:');
  applyWalWithFallback(db);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // 跨进程写竞争时等待而非立刻 SQLITE_BUSY

  const authMiddleware: RequestHandler = (req, res, next) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ') || h.slice(7) !== cfg.localToken) {
      return res.status(401).json({ detail: 'Unauthorized' });
    }
    (req as any).user = { userId: cfg.userId, username: 'local', role: 'ADMIN' };
    next();
  };

  const host: HostServices = {
    query: async <T = any>(sql: string, params?: any[]): Promise<T> => {
      const clean = (params ?? []).map(sanitize);
      const stmt = db.prepare(sql);
      // 返回行的语句(SELECT / RETURNING)用 .all();写语句 .run() 后回空数组
      // (core 各处把非 SELECT 的 query 结果当行数组用,空数组即可)。
      if (stmt.reader) return stmt.all(...clean) as unknown as T;
      stmt.run(...clean);
      return [] as unknown as T;
    },
    getDbType: () => 'sqlite',
    getNowSql: () => 'CURRENT_TIMESTAMP',
    getDateSql: (column: string) => `date(${column})`,
    getDateSubSql: (days: number) => `date('now', '-${Math.max(0, Math.floor(days))} days')`,
    getOlderThanSql: (column: string, minutes: number) =>
      `${column} < datetime('now', '-${Math.max(0, Math.floor(minutes))} minutes')`,
    authMiddleware,
    adminMiddleware: (_req, _res, next) => next(), // 单用户即 admin
    log: (msg, ...a) => console.log('[tangu]', msg, ...a),
    warn: (msg, ...a) => console.warn('[tangu]', msg, ...a),
    error: (msg, ...a) => console.error('[tangu]', msg, ...a),
  };

  return { host, db };
}
