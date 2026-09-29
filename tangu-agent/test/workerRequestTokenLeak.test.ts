/**
 * thin worker 请求期 token(HttpStateStore 的请求 ALS)串号复现:真 express + 真 httpWorkerHost.authMiddleware +
 * 真 HttpStateStore,假网关 /api/agent-state 记录每次收到的 Authorization。
 * 同一条 keep-alive 连接上先后两个请求:第一个带 `Authorization: Bearer T1`,第二个不带 ——
 * 第二个请求 handler 期的 currentToken() / 发往网关的 state 调用绝不能带上 T1(可能是另一个用户的 per-dispatch token)。
 * 修复前(authMiddleware 在请求同步帧里 enterWith)Node 20/22 上 GET 起头的两组实跑为红(网关收到的是 Bearer T1):
 * store 写在按连接复用的 HTTP parser 资源上,下一个请求直接读到;POST 起头那组 enterWith 落在 body 解析后的 tick 上,
 * 修复前也绿(守门)。Node 24+(AsyncContextFrame,Electron 40)修复前三组都绿。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/workerRequestTokenLeak.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Agent, createServer, request, type Server } from 'node:http';
import { createHttpWorkerHost } from '../src/adapters/httpWorkerHost.js';
import { createHttpStateStore, currentToken } from '../src/services/stateStore/httpStateStore.js';

const FLEET = 'fleet-key';
let gateway: Server;
let worker: Server;
let base: string;
/** 假网关收到的 Authorization(按 sessionId)。 */
const seenByGateway = new Map<string, string>();
/** worker handler 期的 currentToken():进 handler 时 / await 一次 state 调用之后。 */
const seenInHandler = new Map<string, { entry?: string; afterAwait?: string }>();

const call = (agent: Agent, method: 'GET' | 'POST', sid: string, token?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const body = method === 'POST' ? JSON.stringify({ x: 1 }) : undefined;
    const headers: Record<string, string | number> = { 'X-Fleet-Auth': FLEET, 'X-Forsion-User': 'u' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    const req = request(`${base}/probe/${sid}`, { method, agent, headers }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.end(body);
  });

beforeAll(async () => {
  gateway = createServer((req, res) => {
    const sid = decodeURIComponent(req.url!.split('/')[4]); // /api/agent-state/sessions/:id/owner
    seenByGateway.set(sid, String(req.headers.authorization));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ owner: 'u' }));
  }).listen(0);
  const { host } = createHttpWorkerHost({ fleetSecret: FLEET });
  const state = createHttpStateStore({ cloudUrl: `http://127.0.0.1:${(gateway.address() as any).port}`, fleetSecret: FLEET });
  const probe: express.RequestHandler = async (req, res) => {
    const rec: { entry?: string; afterAwait?: string } = { entry: currentToken() };
    await state.getSessionOwner(req.params.sid); // handler 期 state 调用:未绑 run → 回退请求 ALS token
    rec.afterAwait = currentToken();
    seenInHandler.set(req.params.sid, rec);
    res.json({ ok: true });
  };
  // 与生产 worker(forsion-worker/src/worker.ts)同序:先 express.json,鉴权挂在路由上
  const router = express.Router();
  router.get('/probe/:sid', host.authMiddleware, probe);
  router.post('/probe/:sid', host.authMiddleware, probe);
  const app = express();
  app.use(express.json());
  app.use(router);
  worker = app.listen(0);
  base = `http://127.0.0.1:${(worker.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => worker.close(r));
  await new Promise((r) => gateway.close(r));
});

describe('thin worker:同一条 keep-alive 连接上,不带 Authorization 的请求读不到上一个请求的 token', () => {
  // ⚠️ GET→GET 保持为第一个用例:Node < 24 上它也是全进程第一次 enterWith(懒启用)的现场
  for (const [first, second] of [['GET', 'GET'], ['GET', 'POST'], ['POST', 'POST']] as const) {
    it(`${first}(Bearer T1) → ${second}(无 Authorization)`, async () => {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 }); // 单 socket:两个请求一定走同一条连接
      const a = `${first}-${second}-a`, b = `${first}-${second}-b`;
      try {
        await call(agent, first, a, 'T1');
        await call(agent, second, b);
      } finally { agent.destroy(); }
      // 带 token 的请求照常可用(修复不能把 handler 期回退弄丢)
      expect(seenInHandler.get(a)).toEqual({ entry: 'T1', afterAwait: 'T1' });
      expect(seenByGateway.get(a)).toBe('Bearer T1');
      // 不带 token 的请求:干净
      expect.soft(seenByGateway.get(b), '发往网关的 state 调用').not.toContain('T1');
      expect.soft(seenInHandler.get(b), 'handler 期 currentToken()').toEqual({ entry: undefined, afterAwait: undefined });
    });
  }
});
