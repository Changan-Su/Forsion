/**
 * 设备能力 MCP 方案 P0 · 终审收口:远程来源的一轮不写长期记忆 —— 「这一轮是否来自远端」由 agentLoop 在 run **收尾时**算好传给 Historian。
 * 远端 steer / 询问 / 截屏 / ui_ 回执给本机 run 打的是进程内污点,run 收尾即清;Historian 异步起来时已查不到,只能靠收尾时带过去(Codex 09-27)。
 * 真 loop(内存 SQLite + 真 agentLoop + 脚本化 fake llm);只把 Historian 入口换成记录器。
 * 负对照:把 agentLoop 里传给 onUserRunDone 的第 5 个参数去掉 → 「被远端染色的本机 run」一条变红(见日志)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const calls = vi.hoisted(() => ({ list: [] as Array<{ sessionId: string; runRemote: unknown }> }));
vi.mock('../src/services/localHistorian.js', async (orig) => ({
  ...(await orig<any>()),
  onUserRunDone: vi.fn(async (sessionId: string, _u: string, _m?: string, _f?: unknown, runRemote?: unknown) => { calls.list.push({ sessionId, runRemote }); }),
}));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { taintRunRemote } from '../src/services/remoteOrigin.js';
import { historianRoundRemote } from '../src/services/localHistorian.js';

const USER = 'u1';
const REMOTE = { via: 'tunnel' as const, marked: true };
const profile = createTanguProfile({ sandboxMode: 'none' });
let home: string;
let ws: string;

beforeEach(async () => {
  calls.list = [];
  home = mkdtempSync(join(tmpdir(), 'tangu-hist-flag-'));
  process.env.TANGU_HOME = home;
  ws = mkdtempSync(join(tmpdir(), 'tangu-hist-flag-ws-'));
  mkdirSync(join(home, 'agents', 'yolo', 'Library'), { recursive: true });
  writeFileSync(join(home, 'agents', 'yolo', 'config.toml'), 'name = "yolo"\n');
  writeFileSync(join(home, 'agents', 'yolo', 'SOUL.md'), 'You are yolo.');
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async () => ({ content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' }),
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile } as any);
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
});

let seq = 0;
async function runOnce(opts: { remote?: boolean; taint?: boolean }): Promise<unknown> {
  const runId = `HF${++seq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: 'hi', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'host', cwd: ws, agentSlug: 'yolo' }, origin: 'client', ...(opts.remote ? { remote: REMOTE } : {}) },
  });
  if (opts.taint) taintRunRemote(runId, REMOTE); // 模拟远端 steer / 询问答复给这条本机 run 染了色
  const before = calls.list.length;
  enqueueRun('S', runId);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status)) && calls.list.length > before) break;
    if (Date.now() - t0 > 15_000) throw new Error(`run did not settle (status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 25));
  }
  return calls.list[calls.list.length - 1].runRemote;
}

describe('Historian 拿到「这一轮是否来自远端」', () => {
  it('本机 run → false;带 input.remote 的 run → true;被远端染色的本机 run → true(修复前:进程内污点丢失,恒 false)', async () => {
    expect(await runOnce({})).toBe(false);
    expect(await runOnce({ remote: true })).toBe(true);
    expect(await runOnce({ taint: true })).toBe(true);
  });

  it('historianRoundRemote:传入标记为真,或会话带 remoteOrigin → 远程;坏配置按本机', () => {
    expect(historianRoundRemote({ agent_config: null }, true)).toBe(true);
    expect(historianRoundRemote({ agent_config: null }, false)).toBe(false);
    expect(historianRoundRemote({ agent_config: JSON.stringify({ remoteOrigin: { via: 'tunnel' } }) })).toBe(true);
    expect(historianRoundRemote({ agent_config: '{bad' })).toBe(false);
  });
});
