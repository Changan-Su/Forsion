/**
 * httpWorkerHost —— thin worker 的 HostServices(无 pg、无 JWT_SECRET)。
 *
 * 取代 cloudWorkerHost:thin worker 不持库、不验 JWT。入站请求由**网关**(已验用户 token)注入受信头
 * `X-Forsion-User`,本中间件据此填 req.user;网关同时把 per-dispatch token 放 Authorization,
 * 本中间件 stash 进 HttpStateStore 的请求 ALS(供 handler 期 state 调用)。**入站信任靠网络隔离**
 * (仅网关可达 worker)。host.query 不被调用(状态全经 deps().state = HttpStateStore)。
 */
import type { RequestHandler } from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostServices } from '../seams/hostServices.js';
import type { StateStore } from '../seams/stateStore.js';
import { createHttpStateStore, currentToken, enterRequestToken } from '../services/stateStore/httpStateStore.js';

export function createHttpWorkerHost(opts?: { fleetSecret?: string }): { host: HostServices } {
  const fleetSecret = opts?.fleetSecret;
  if (!fleetSecret) {
    console.warn('[tangu-worker] 未配置 worker 配对密钥:入站仅靠网络隔离(仅网关可达),生产务必配对。');
  }
  const authMiddleware: RequestHandler = (req, res, next) => {
    // fleet 通道鉴权:证明请求来自网关(持同一 TANGU_FLEET_SECRET),再信任 X-Forsion-User。
    if (fleetSecret && req.headers['x-fleet-auth'] !== fleetSecret) {
      return res.status(401).json({ detail: 'Unauthorized (fleet auth)' });
    }
    const userId = req.headers['x-forsion-user'];
    if (!userId || typeof userId !== 'string') {
      return res.status(401).json({ detail: 'Unauthorized (missing trusted gateway context)' });
    }
    const role = (req.headers['x-forsion-role'] as string) || 'USER';
    const username = (req.headers['x-forsion-username'] as string) || 'tangu-user';
    (req as any).user = { userId, username, role };
    // 网关注入的 per-dispatch token(出站凭证)→ stash 进请求 ALS,供 handler 期 state 调用回退取用。
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) enterRequestToken(auth.slice(7));
    next();
  };

  const adminMiddleware: RequestHandler = (req, res, next) => {
    if ((req as any).user?.role !== 'ADMIN') return res.status(403).json({ detail: 'Forbidden' });
    next();
  };

  const unavailable = (): never => {
    throw new Error('host.query 在 thin worker 不可用:状态请经 deps().state(HttpStateStore)。');
  };

  const host: HostServices = {
    query: unavailable as any,
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
  return { host };
}

/**
 * thin worker 装配工厂:把 httpWorkerHost + HttpStateStore + httpBrain token 函数一并装好。
 * worker 插件用它构造 createTanguModule 的 host/state/brain(token)。
 */
/**
 * 解析本 worker 的**配对密钥**(一 worker 一密钥):env TANGU_WORKER_KEY > ~/.tangu/worker-key(持久) >
 * 自动生成并持久化。返回密钥 + 来源(供打印)。
 */
function resolveWorkerKey(explicit?: string): { key: string; source: string } {
  if (explicit && explicit.trim()) return { key: explicit.trim(), source: 'env TANGU_WORKER_KEY' };
  const dir = process.env.TANGU_HOME || path.join(os.homedir(), '.tangu');
  const file = path.join(dir, 'worker-key');
  try {
    const k = readFileSync(file, 'utf8').trim();
    if (k) return { key: k, source: file };
  } catch { /* 不存在 → 生成 */ }
  const k = randomBytes(24).toString('hex');
  try { mkdirSync(dir, { recursive: true }); writeFileSync(file, k + '\n', { mode: 0o600 }); } catch { /* 持久化失败也用 */ }
  return { key: k, source: `自动生成并持久化到 ${file}` };
}

export function createThinWorker(cfg: { cloudUrl: string; workerKey?: string }): {
  host: HostServices;
  state: StateStore;
  /** 供 httpBrain.token:当前 run(ALS runId)的 per-dispatch token。 */
  brainToken: () => string;
} {
  const { key, source } = resolveWorkerKey(cfg.workerKey);
  // 打印配对密钥:admin 在「实例管理」登记本 worker 时填它,配对一致才放行。
  const line = '─'.repeat(66);
  console.log(`\n${line}`);
  console.log('[tangu-worker] 配对密钥 (WORKER KEY) —— 在 Forsion admin →「实例管理」登记本 worker 时填入「配对密钥」:');
  console.log(`\n    ${key}\n`);
  console.log(`  来源: ${source}`);
  console.log('  固定: 设 env TANGU_WORKER_KEY=<key>(否则用 ~/.tangu/worker-key 的持久值,重启不变)。');
  console.log(`${line}\n`);

  const { host } = createHttpWorkerHost({ fleetSecret: key });
  const state = createHttpStateStore({ cloudUrl: cfg.cloudUrl, fleetSecret: key });
  return { host, state, brainToken: () => currentToken() ?? '' };
}
