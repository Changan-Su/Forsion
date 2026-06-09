/**
 * standalone 接缝:HostServices on 本地 Postgres。
 *
 * core 的 raw SQL 是 Postgres 方言(JSONB/BIGSERIAL/ON CONFLICT/INTERVAL),故 standalone 需本地 PG
 * (不是 SQLite)。query 复刻 Forsion 的 MySQL-style `?` → `$1/$2…` 占位符转换。
 * 鉴权:本地单用户 bearer token(与 standalone 服务自身的 forsion_token 一致即可,简单起见用同一个)。
 */
import type { RequestHandler } from 'express';
import pg from 'pg';
import type { HostServices } from '../../seams/hostServices.js';

export interface LocalHostConfig {
  databaseUrl: string;
  /** 保护 standalone 自身 HTTP 端点的 token(校验 Bearer)。 */
  localToken: string;
  /** 本地单用户 id(所有 run 归属它)。 */
  userId: string;
}

/** `?` 占位符按出现顺序换成 `$1,$2,…`(忽略字符串字面量内的 ? 不在本工具范围;core SQL 未在字面量用 ?)。 */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function createLocalHost(cfg: LocalHostConfig): { host: HostServices; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl });

  const authMiddleware: RequestHandler = (req, res, next) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ') || h.slice(7) !== cfg.localToken) {
      return res.status(401).json({ detail: 'Unauthorized' });
    }
    // 注入与 Forsion AuthRequest 同构的 user(core 只读 userId)。
    (req as any).user = { userId: cfg.userId, username: 'local', role: 'ADMIN' };
    next();
  };

  const host: HostServices = {
    query: async <T = any>(sql: string, params?: any[]): Promise<T> => {
      const r = await pool.query(toPg(sql), params);
      // core 各处把 query 结果当行数组用(SELECT);非 SELECT 返回 rows([])即可。
      return r.rows as unknown as T;
    },
    getDbType: () => 'postgres',
    getNowSql: () => 'CURRENT_TIMESTAMP',
    getDateSql: (column: string) => `DATE(${column})`,
    getDateSubSql: (days: number) => `CURRENT_DATE - INTERVAL '${days} days'`,
    authMiddleware,
    adminMiddleware: (req, res, next) => next(), // 单用户即 admin
    log: (msg, ...a) => console.log('[tangu]', msg, ...a),
    warn: (msg, ...a) => console.warn('[tangu]', msg, ...a),
    error: (msg, ...a) => console.error('[tangu]', msg, ...a),
  };

  return { host, pool };
}
