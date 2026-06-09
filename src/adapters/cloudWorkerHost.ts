/**
 * 云端 worker 接缝:HostServices on 共享云端 Postgres + 多用户 JWT 验签。
 *
 * 与 standalone/localHost(单用户、本地库)并列,是「分离式云 worker」部署形态的 host 适配器:
 *   - query 指向**共享云端 Postgres** → run/会话态跨机共享(任意 worker 读写同一份,session 亲和路由下无锁)。
 *   - authMiddleware 用 JWT_SECRET **本地验签** forsion_token(镜像 server/src/middleware/auth.ts:verifyToken),
 *     把每个请求解析成**真实 userId** —— 一个进程服务多用户,无云端往返。
 *   - LLM/计费走 brain-api(worker 用 httpBrain + noopBilling,计费在云端收口),本 host 不涉 LLM。
 */
import type { RequestHandler } from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import type { HostServices } from '../seams/hostServices.js';

export interface CloudWorkerHostConfig {
  databaseUrl: string; // 共享云端 Postgres 连接串
  jwtSecret: string; // 与 Forsion 同一 JWT_SECRET(HS256)
}

/** forsion_token 的 JWT payload(对齐 server/src/middleware/auth.ts JwtPayload)。 */
interface ForsionJwt {
  userId: string;
  username: string;
  role: string;
}

/** `?` 占位符按出现顺序换成 `$1,$2,…`(与 localHost 一致)。 */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function createCloudWorkerHost(cfg: CloudWorkerHostConfig): { host: HostServices; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl });

  const authMiddleware: RequestHandler = (req, res, next) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ detail: 'Unauthorized' });
    let payload: ForsionJwt;
    try {
      payload = jwt.verify(h.slice(7), cfg.jwtSecret) as ForsionJwt;
    } catch {
      return res.status(401).json({ detail: 'Invalid token' });
    }
    if (!payload?.userId) return res.status(401).json({ detail: 'Invalid token' });
    // 注入与 Forsion AuthRequest 同构的 user(core 只读 userId)。
    (req as any).user = { userId: payload.userId, username: payload.username, role: payload.role };
    next();
  };

  const adminMiddleware: RequestHandler = (req, res, next) => {
    if ((req as any).user?.role !== 'ADMIN') return res.status(403).json({ detail: 'Forbidden' });
    next();
  };

  const host: HostServices = {
    query: async <T = any>(sql: string, params?: any[]): Promise<T> => {
      const r = await pool.query(toPg(sql), params);
      return r.rows as unknown as T;
    },
    getDbType: () => 'postgres',
    getNowSql: () => 'CURRENT_TIMESTAMP',
    getDateSql: (column: string) => `DATE(${column})`,
    getDateSubSql: (days: number) => `CURRENT_DATE - INTERVAL '${days} days'`,
    authMiddleware,
    adminMiddleware,
    log: (msg, ...a) => console.log('[tangu-worker]', msg, ...a),
    warn: (msg, ...a) => console.warn('[tangu-worker]', msg, ...a),
    error: (msg, ...a) => console.error('[tangu-worker]', msg, ...a),
  };

  return { host, pool };
}
