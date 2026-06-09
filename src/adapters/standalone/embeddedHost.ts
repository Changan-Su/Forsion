/**
 * standalone 接缝:HostServices on **嵌入式 PGlite**(进程内真 Postgres,WASM)。
 *
 * 与 localHost(外部 Postgres 服务)同构,但**零安装**——PGlite 在进程内跑、落一个本地文件,
 * 用户不需要装/起任何 Postgres。core 的 PG 方言 SQL(JSONB/BIGSERIAL/ON CONFLICT/INTERVAL)
 * 原样可用(PGlite 是真 Postgres 编到 WASM)。
 *
 * 注:PGlite 的 `query()` 走扩展协议(单语句),core 各处恰好都是单语句(runStore/eventBus/migrate
 * 每次只发一条),兼容;多语句的 base schema 用 `db.exec()`(见 standalone/main.ts)。
 * 单连接、单用户、低并发——standalone 场景完全够。
 */
import type { RequestHandler } from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { HostServices } from '../../seams/hostServices.js';

export interface EmbeddedHostConfig {
  /** PGlite 落盘目录;undefined/'memory' → 内存(进程退出即丢)。 */
  dataDir?: string;
  /** 保护 standalone 自身 HTTP 端点的 token(校验 Bearer)。 */
  localToken: string;
  /** 本地单用户 id(所有 run 归属它)。 */
  userId: string;
}

/** `?` 占位符按出现顺序换成 `$1,$2,…`(与 localHost 一致;PGlite 也用 $n)。 */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function createEmbeddedHost(cfg: EmbeddedHostConfig): Promise<{ host: HostServices; db: PGlite }> {
  const persistent = cfg.dataDir && cfg.dataDir !== 'memory';
  const db = persistent ? await PGlite.create({ dataDir: cfg.dataDir }) : await PGlite.create();

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
      const r = await db.query(toPg(sql), params as any[]);
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

  return { host, db };
}
