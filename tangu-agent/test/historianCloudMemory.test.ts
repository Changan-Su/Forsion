// 云端按轮 Historian(网关跑,服务 web/安卓 tangu 会话):worker 上报 run done → 到点轮维护标题 + LOG + 长期记忆,
// 按用户自己的设置触发、扣用户主额度。真 SQLite(内存)+ 真 SqlStateStore 监听 + 真 express(设置端点)。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

vi.mock('../src/agents/cloudAgentStore.js', () => ({
  cloudGetAgent: async (_u: string, slug: string) => (slug === 'gone' ? null : { slug, shareDefaultMemory: false }),
}));

import { configureTangu, deps } from '../src/seams/runtime.js';
import { createAiStudioProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { currentAgentSlug } from '../src/seams/runContext.js';
import { startHistorian, stopHistorian } from '../src/services/historian.js';
import { setHistorianConfig, saveUserHistorianConfig } from '../src/services/historianConfig.js';
import specialRouter from '../src/routes/special.js';

const U = 'u';
let db: ReturnType<typeof createSqliteHost>['db'];
let mem: { slug: string | undefined; text: string }[];
let logs: { slug: string | undefined; text: string }[];
let prompts: string[];
let models: string[];
let charged: number[];
let usage: string[];
let quotaOk: boolean;
let reply: string;
let seq = 0;
let sid = '';

const settle = () => new Promise((r) => setTimeout(r, 30));
/** 模拟 worker 跑完一轮:插 run + 用户消息,经 SqlStateStore 把 run 写成 done(= state-API 上报)。 */
async function finishRun(sessionId = sid): Promise<void> {
  const id = `r${++seq}`;
  await query(`INSERT INTO agent_runs (id, session_id, user_id, app_id, status) VALUES (?, ?, ?, 'tangu', 'running')`, [id, sessionId, U]);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, 'user', '以后代码都用 TypeScript', ?)`, [`m${seq}`, sessionId, Date.now() + seq]);
  await deps().state.updateRunStatus(id, 'done');
  await settle();
}
// 会话 id 每次都新:lastRound 去重表是模块级,跨用例共享
async function newSession(agentConfig: string | null = '{"agentSlug":"aria"}', extra: { app?: string; kind?: string } = {}): Promise<string> {
  const id = `s${++seq}`;
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, agent_config, kind) VALUES (?, ?, ?, '旧标题', ?, ?)`, [id, U, extra.app || 'tangu', agentConfig, extra.kind || 'user']);
  return id;
}

beforeEach(async () => {
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: U });
  db = local.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  mem = []; logs = []; prompts = []; models = []; charged = []; usage = []; quotaOk = true;
  reply = JSON.stringify({
    title: '新标题',
    log: '确定团队只用 TypeScript',
    memory: ['用户团队只用 TypeScript', '用户的数据库密码是 hunter2', 'Build uses sk-abcdefghijklmnopqrstuvwx1234 style ids', 'x'.repeat(301), '第四条记忆内容', '第五条记忆内容'],
  });
  configureTangu({
    host: local.host,
    profile: createAiStudioProfile({ sandboxMode: 'none' }), // 网关:非 hostExec
    brain: {
      llm: {
        resolveModelAndKey: async (id: string) => { models.push(id); return { model: { name: id, provider: 'p' }, apiKey: 'k', baseUrl: 'b', apiModelId: id }; },
        buildProviderPayload: async (p: any) => { prompts.push(p.messages.at(-1).content); return p; },
        streamProviderCompletion: async () => ({ content: reply, usage: { prompt_tokens: 100, completion_tokens: 10 } }),
      },
      users: { getUserById: async () => ({ username: 'alice' }) },
      models: { listModelsForProject: async (app: string) => ({ models: [], defaultModelId: 'chat-default', backgroundModelId: app === 'tangu' ? 'tangu-bg' : 'other-bg' }) },
      memory: {
        getMemory: async () => ({ content: '已有:用户住在杭州', updatedAt: null }),
        appendMemoryEntry: async (_u: string, text: string) => { mem.push({ slug: currentAgentSlug(), text }); return { appended: true, length: 0 }; },
        appendLogEntry: async (_u: string, text: string) => { logs.push({ slug: currentAgentSlug(), text }); return {}; },
      },
    } as any,
    billing: {
      calculateCost: async (_m: string, tin: number, tout: number) => Math.round(tin + tout),
      canConsumeTokenPoints: async () => ({ ok: quotaOk }),
      consumeTokenPoints: async (_u: string, n: number) => { charged.push(n); return { ok: true }; },
      logApiUsage: async (...a: any[]) => { usage.push(String(a[8])); },
    } as any,
  });
  await runMigration();
  await setHistorianConfig({ enabled: true, modelId: '', idleMinutes: 10 });
  startHistorian(3_600_000);
  sid = await newSession();
});
afterEach(() => { stopHistorian(); db.close(); });

describe('cloud per-round Historian (tangu sessions)', () => {
  it('fires on rounds 1 and 3 (desktop defaults), not 2; charges the user; memory gated into the session agent scope', async () => {
    await finishRun();
    expect(models).toEqual(['tangu-bg']); // 模型跟随 tangu 的辅助槽(不是网关基线 app 的)
    await finishRun();
    expect(models).toHaveLength(1);
    await finishRun();
    expect(models).toHaveLength(2);

    expect(charged).toEqual([110, 110]);
    expect(usage).toEqual(['tangu-historian', 'tangu-historian']);
    // ≤3 条、超 300 字丢、提到凭据的整条丢、令牌形状脱敏;都落 aria 的记忆域
    expect(mem.slice(0, 3).map((m) => m.text)).toEqual(['用户团队只用 TypeScript', expect.stringContaining('[REDACTED]'), '第四条记忆内容']);
    expect(mem.every((m) => m.slug === 'aria')).toBe(true);
    expect(mem.some((m) => m.text.includes('hunter2') || m.text.includes('sk-abc'))).toBe(false);
    expect(logs.map((l) => l.slug)).toEqual(['aria', 'aria']);
    expect(prompts[0]).toContain('[Existing memory]\n已有:用户住在杭州');
    expect((await query<any[]>(`SELECT title FROM chat_sessions WHERE id = ?`, [sid]))[0].title).toBe('新标题');
  });

  it('respects the user\'s own settings (rounds / first round / off) and model choice', async () => {
    await saveUserHistorianConfig(U, { everyRounds: 2, firstRoundTrigger: false, modelId: 'my-model' });
    await finishRun();
    expect(models).toHaveLength(0);
    await finishRun();
    expect(models).toEqual(['my-model']);
    await saveUserHistorianConfig(U, { enabled: false });
    await finishRun(); await finishRun();
    expect(models).toHaveLength(1);
  });

  it('admin master switch off / quota exhausted → no model request, no charge', async () => {
    await setHistorianConfig({ enabled: false });
    await finishRun();
    expect(models).toHaveLength(0);
    await setHistorianConfig({ enabled: true });
    quotaOk = false;
    await finishRun(await newSession());
    expect(models).toHaveLength(1); // 解析了模型做预检
    expect(prompts).toHaveLength(0); // 但没发请求
    expect(charged).toHaveLength(0);
  });

  it('a re-reported done for the same round does not run twice', async () => {
    await finishRun();
    const run = (await query<any[]>(`SELECT id FROM agent_runs WHERE session_id = ? LIMIT 1`, [sid]))[0];
    await deps().state.updateRunStatus(run.id, 'done');
    await settle();
    expect(models).toHaveLength(1);
  });

  it('skips non-tangu / non-user sessions; unresolvable agent → title only, no LOG / memory', async () => {
    await finishRun(await newSession(null, { app: 'ai-studio' }));
    await finishRun(await newSession(null, { kind: 'historian' }));
    expect(models).toHaveLength(0);
    const gone = await newSession('{"agentSlug":"gone"}');
    await finishRun(gone);
    expect(models).toHaveLength(1);
    expect(mem).toHaveLength(0);
    expect(logs).toHaveLength(0);
    expect((await query<any[]>(`SELECT title FROM chat_sessions WHERE id = ?`, [gone]))[0].title).toBe('新标题');
  });
});

describe('GET/POST /agent/special/config on cloud (per-user)', () => {
  let srv: Server;
  let base = '';
  beforeEach(() => {
    const app = express();
    app.use(express.json());
    app.use(specialRouter);
    srv = app.listen(0);
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
  });
  afterEach(() => new Promise<void>((r) => srv.close(() => r())));
  const call = async (method: string, body?: any) => {
    const r = await fetch(`${base}/agent/special/config`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  it('returns desktop defaults with cloud:true; POST keeps only the four historian keys', async () => {
    const g = await call('GET');
    expect(g.status).toBe(200);
    expect(g.body.cloud).toBe(true);
    expect(g.body.config.historian).toMatchObject({ enabled: true, modelId: '', everyRounds: 3, firstRoundTrigger: true });
    expect(g.body.config.muse.enabled).toBe(false);
    // 旧版前端整包 POST:muse / mode / prompt 一律忽略
    const p = await call('POST', { historian: { everyRounds: 5, mode: 'fork', prompt: 'x' }, muse: { enabled: true } });
    expect(p.status).toBe(200);
    expect(p.body.config.historian).toMatchObject({ everyRounds: 5, mode: 'independent' });
    expect(p.body.config.muse.enabled).toBe(false);
    expect((await call('GET')).body.config.historian.everyRounds).toBe(5);
  });
});
