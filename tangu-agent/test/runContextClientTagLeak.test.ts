/**
 * run 上下文(AsyncLocalStorage)串标复现:真 express + 真 runs 路由 + 真 agentLoop + 内存 SQLite + 假 brain。
 * 前一个 run 的 clientTag 不许串进之后起的无标签 run(createRun 会从当前 ALS 抄 client 进 input)——
 * 否则电脑历史等按客户端标签放行的门禁、后台额度的分桶都会被绕过。
 *   ① 进程内调用方(TUI / 开机就起的长跑循环同款:自己 createRun + enqueueRun):Node < 24 的 ALS 懒启用时,
 *      第一个 run 的 enterWith 落在进程级兜底资源上,调用方随后就读到它。**必须是本文件第一个用到 run 上下文的用例**
 *      (修复前在 Node 22 上实跑为红;Node 24+ 的 AsyncContextFrame 本来就不串)。
 *   ② HTTP:两个先后到达的请求(同一条 keep-alive 连接 / 同会话排队),请求入口与第二个 run 都是干净的(修复前也绿,守门)。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/runContextClientTagLeak.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Agent, request, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { query } from '../src/core/db.js';
import { currentRunClientTag, currentRunId } from '../src/seams/runContext.js';
import runsRouter from '../src/routes/runs.js';

let srv: Server;
let base: string;
let home: string;
/** runId → 该 run 调模型时 ALS 里的 clientTag(假 brain 在 run 的异步子树里读)。 */
const seen = new Map<string, string | undefined>();
/** 设了就卡住模型调用,直到放行(造「同会话排队」)。 */
let gate: Promise<void> | null = null;
/** 每个请求进到 express 时 ALS 里的 clientTag / runId(请求入口必须是干净的)。 */
const entry: Array<{ tag?: string; run?: string }> = [];
/** 单 socket keep-alive:两个请求一定走同一条连接(串标若经连接资源传,这里必现)。 */
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

const post = (body: Record<string, unknown>): Promise<string> => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = request(`${base}/agent/runs`, {
    method: 'POST', agent,
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(buf).runId) : reject(new Error(`${res.statusCode} ${buf}`))));
  });
  req.on('error', reject);
  req.end(data);
});
const settled = async (id: string): Promise<any> => {
  for (const t0 = Date.now(); ;) {
    const r = await getRun(id);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > 15_000) throw new Error(`run ${id} 未结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 20));
  }
};
const inputOf = async (id: string): Promise<any> => { const i = (await getRun(id))!.input; return typeof i === 'string' ? JSON.parse(i) : i; };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-als-leak-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const brain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async () => {
        const id = currentRunId();
        if (id && !seen.has(id)) seen.set(id, currentRunClientTag());
        if (gate) await gate;
        return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
      },
    },
    users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const billing: any = {
    canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0, logApiUsage: async () => {},
  };
  configureTangu({ host, brain, billing, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express();
  app.use((_req, _res, next) => { entry.push({ tag: currentRunClientTag(), run: currentRunId() }); next(); });
  app.use(express.json()); app.use(runsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  agent.destroy();
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('run 上下文不把上一个 run 的 clientTag 串给下一个', () => {
  // ⚠️ 保持为第一个用例(见文件头 ①)
  it('进程内调用方:跑完一个带 desktop/x 的 run 后,自己上下文里没有它的标签,再起的无标签 run 也不被盖上', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('SI', 'u1', 'tangu', 't', 'm1', 'user')`);
    const mk = (id: string, extra: Record<string, unknown>) => createRun({
      id, sessionId: 'SI', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${id}`,
      input: { message: 'hi', userMessageId: `U-${id}`, attachments: [], agentConfig: {}, ...extra },
    });
    await mk('IA', { client: 'desktop/x' });
    enqueueRun('SI', 'IA');
    await settled('IA');
    expect(seen.get('IA')).toBe('desktop/x');
    expect(currentRunClientTag(), '调用方自己的上下文').toBeUndefined();
    await mk('IB', {});
    expect((await inputOf('IB')).client, '落库的 input.client').toBeUndefined();
  }, 30_000);

  it('不同会话、先后两个请求(同一条 keep-alive 连接):第二个不带 client 的 run 仍是无标签', async () => {
    const a = await post({ session_id: 'SA', model_id: 'm1', message: 'hi', client: 'desktop/x' });
    await settled(a);
    const b = await post({ session_id: 'SB', model_id: 'm1', message: 'hi' });
    await settled(b);
    expect((await inputOf(a)).client).toBe('desktop/x');
    expect(seen.get(a)).toBe('desktop/x');
    expect(entry.at(-1), '第二个请求进 express 时的 ALS').toEqual({ tag: undefined, run: undefined });
    expect((await inputOf(b)).client, '落库的 input.client').toBeUndefined();
    expect(seen.get(b), 'run 里 ALS 的 clientTag').toBeUndefined();
  }, 30_000);

  it('同一会话排队:第二个 run 在第一个 run 收尾时起跑,也不继承它的标签', async () => {
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    const a = await post({ session_id: 'SQ', model_id: 'm1', message: 'hi', client: 'desktop/x' });
    const b = await post({ session_id: 'SQ', model_id: 'm1', message: 'again' });
    expect(String((await getRun(b))!.status)).not.toBe('running'); // 真的在排队
    gate = null;
    release();
    await settled(a);
    await settled(b);
    expect((await inputOf(b)).client, '落库的 input.client').toBeUndefined();
    expect(seen.get(b), 'run 里 ALS 的 clientTag').toBeUndefined();
  }, 30_000);
});
