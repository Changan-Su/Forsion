/** 跑在外部引擎上的 Agent(定义里的 engine,11-14 DSH 融合底层第 2 步):真对话循环 + 内存 SQLite + 假引擎管理器。
 *  钉的是「身份合一」这一步的几条规则 ——
 *   · 输入框里发给这个 Agent 的一句(普通对话 / 私聊)交给它的引擎跑,回答记在它名下,用户那一句落库,Historian 写它的记忆域;
 *   · 用不了就明确失败,绝不回落 Tangu 替它答(远程、没装、不认识的引擎、仅聊天模式、团队 / 自动化这些还没接的路);
 *   · 会话里显式选了引擎(Claude Code / Codex)的照旧按选的走;
 *   · 换 harness:换到 DSH 从新的引擎会话开始,换回来再换过去也不接旧的。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const historian = vi.hoisted(() => ({ calls: [] as Array<{ sessionId: string; memScopeSlug?: string }> }));
vi.mock('./localHistorian.js', async (orig) => ({
  ...(await orig<typeof import('./localHistorian.js')>()),
  onUserRunDone: vi.fn(async (sessionId: string, _userId: string, memScopeSlug?: string) => { historian.calls.push({ sessionId, memScopeSlug }); }),
}));

import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { createRun } from './runStore.js';
import { subscribe } from './eventBus.js';
import { abortRun, enqueueRun, waitForRunSettlement } from './agentLoop.js';
import type { EngineManager, EngineRunCtx } from '../engines/manager.js';

type EngineStatus = 'available' | 'needs-signin' | 'not-installed';

let home: string;
let calls: Array<{ engineId: string; resume?: string; cwd?: string; engineModelId?: string; message: string }>;
let llmCalls: number;
let seq: number;
let runs: string[];
let status: EngineStatus;
let tanguReplay: any[] = [];

const engines: EngineManager = {
  list: () => [{ id: 'dsh', name: 'DeepSeek Harness', available: status === 'available', status }, { id: 'codex', name: 'Codex', available: true, status: 'available' }],
  has: (id) => id === 'dsh' || id === 'codex',
  capabilities: async () => ({ models: [], commands: [] }), setDefaultModel: () => {}, dispose: async () => {},
  run: async (ctx: EngineRunCtx) => {
    calls.push({ engineId: ctx.engineId, resume: ctx.resumeSessionId, cwd: ctx.cwd, engineModelId: ctx.engineModelId, message: ctx.message });
    const id = ctx.resumeSessionId || `ext-${++seq}`;
    await ctx.onSession?.({ id, resumable: true, resumed: !!ctx.resumeSessionId, via: 'resume', verifiedForChat: true, agent: 'fake-harness' });
    return { content: `answer to ${ctx.message}`, externalSessionId: id };
  },
};

function writeAgent(slug: string, extra = ''): void {
  mkdirSync(join(home, 'agents', slug, 'Library'), { recursive: true });
  writeFileSync(join(home, 'agents', slug, 'config.toml'), `name = "${slug}"\n${extra}developer_instructions = "persona of ${slug}"\n`);
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-agent-engine-loop-'));
  process.env.TANGU_HOME = home;
  calls = []; llmCalls = 0; seq = 0; runs = []; status = 'available'; historian.calls = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, engines, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: ['read_file'] }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => { tanguReplay = structuredClone(o.messages); return { messages: structuredClone(o.messages), tools: o.tools }; },
        streamProviderCompletion: async (o: any) => { llmCalls++; o.onToken?.('Tangu says hi.'); return { content: 'Tangu says hi.', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 2 }, finishReason: 'stop' }; },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
  writeAgent('ds', 'engine = "dsh"\nengine_model = "agent-default-model"\n');
  writeAgent('plain');
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
});
afterEach(async () => {
  for (const id of runs) { abortRun(id); await waitForRunSettlement(id, 2000); }
  delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true });
});

/** 发一句,等这一轮结束。input 里的 origin 缺省是 'client'(输入框发的);传 null 去掉。 */
async function turn(n: number, cfg: Record<string, unknown> = {}, extra: Record<string, unknown> = { origin: 'client' }, session = 'S') {
  const runId = `r${n}`; runs.push(runId);
  await createRun({ id: runId, sessionId: session, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `a${n}`,
    input: { message: `q${n}`, userMessageId: `u${n}`, attachments: [], agentConfig: { agentSlug: 'ds', execMode: 'host', cwd: home, approvalMode: 'readonly', compaction: { enabled: false }, ...cfg }, ...extra } });
  const out = { done: false, error: '' };
  const ended = new Promise<void>((resolve) => {
    const off = subscribe(runId, (event) => {
      if (event.type === 'done') { out.done = true; off(); resolve(); }
      if (event.type === 'error') { out.error = String((event.payload as any)?.error || 'error'); off(); resolve(); }
    });
  });
  enqueueRun(session, runId);
  await ended; await waitForRunSettlement(runId, 2000);
  return out;
}
const rows = async (session = 'S') => query<any[]>(`SELECT id, role, content, agent_slug FROM chat_messages WHERE session_id = ? ORDER BY timestamp, id`, [session]);

describe('跑在外部引擎上的 Agent', () => {
  it('普通对话里选了它:交给 DSH;回答记在它名下;用户那一句落库;Historian 写它的记忆域;第二句接着第一句', async () => {
    expect((await turn(1)).done).toBe(true);
    expect((await turn(2)).done).toBe(true);
    expect(calls.map((c) => [c.engineId, c.resume ?? null])).toEqual([['dsh', null], ['dsh', 'ext-1']]);
    expect(calls[0].engineModelId).toBe('agent-default-model'); // 会话没另选 → 用 Agent 定义里的
    expect(llmCalls).toBe(0); // Tangu 自己的模型一次没调
    const r = await rows();
    expect(r.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['q1', 'q2']);
    expect(r.filter((m) => m.role === 'model').map((m) => m.agent_slug)).toEqual(['ds', 'ds']);
    await vi.waitFor(() => expect(historian.calls.length).toBe(2));
    expect(historian.calls.every((c) => c.sessionId === 'S' && c.memScopeSlug === 'ds')).toBe(true);
  }, 30_000);

  it('会话里另选的引擎模型优先于 Agent 定义里的', async () => {
    await turn(1, { engineModelId: 'picked-in-composer' });
    expect(calls[0].engineModelId).toBe('picked-in-composer');
  }, 20_000);

  it('私聊:工作区是它自己的 Library,不信 run 带的 cwd', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES ('P', 'u1', 'tangu', 't', 'm1', 'user', ?)`,
      [JSON.stringify({ soloAgentSlug: 'ds', agentSlug: 'ds', execMode: 'host', cwd: join(home, 'agents', 'ds', 'Library'), preset: null })]);
    expect((await turn(1, { cwd: '/somewhere/else' }, { origin: 'client' }, 'P')).done).toBe(true);
    expect(calls[0].cwd).toBe(join(home, 'agents', 'ds', 'Library'));
    expect((await rows('P')).find((m) => m.role === 'model')?.agent_slug).toBe('ds');
    await vi.waitFor(() => expect(historian.calls).toEqual([{ sessionId: 'P', memScopeSlug: 'ds' }]));
  }, 20_000);

  it('普通对话:带了目录就用那个目录;没带目录落在它的 Library,没有就补建', async () => {
    await turn(1);
    expect(calls[0].cwd).toBe(home);
    rmSync(join(home, 'agents', 'ds', 'Library'), { recursive: true, force: true });
    await turn(2, { cwd: undefined }, { origin: 'client' }, 'N');
    expect(calls[1].cwd).toBe(join(home, 'agents', 'ds', 'Library'));
    expect(existsSync(join(home, 'agents', 'ds', 'Library'))).toBe(true);
  }, 20_000);

  it('从远程设备发来:明确失败,不进引擎、不回落 Tangu', async () => {
    const out = await turn(1, {}, { origin: 'client', remote: { via: 'tunnel', marked: true } });
    expect(out.error).toBe('agent_engine_remote:dsh');
    expect(calls).toEqual([]); expect(llmCalls).toBe(0);
  }, 20_000);

  it('DSH 没装:明确失败', async () => {
    status = 'not-installed';
    expect((await turn(1)).error).toBe('agent_engine_not_installed:dsh');
    expect(calls).toEqual([]); expect(llmCalls).toBe(0);
  }, 20_000);

  it('定义里是本版本不认识的引擎:明确失败,不当 Tangu', async () => {
    writeAgent('future', 'engine = "something-new"\n');
    expect((await turn(1, { agentSlug: 'future' })).error).toBe('agent_engine_unsupported:something-new');
    expect(calls).toEqual([]); expect(llmCalls).toBe(0);
  }, 20_000);

  it('仅聊天模式的会话:明确失败;被拒的这一句也落库,重开对话不丢', async () => {
    expect((await turn(1, { preset: 'chat' })).error).toBe('agent_engine_chat_preset:dsh');
    expect(calls).toEqual([]); expect(llmCalls).toBe(0);
    expect((await rows()).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['q1']);
  }, 20_000);

  it('插件任务的会话(存值里有 pluginOwner):客户端追问也不交给 DSH,走到那道闸被拒', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES ('PL', 'u1', 'tangu', 't', 'm1', 'user', ?)`,
      [JSON.stringify({ agentSlug: 'ds', execMode: 'host', cwd: home, preset: null, pluginOwner: 'some-plugin' })]);
    expect((await turn(1, {}, { origin: 'client' }, 'PL')).error).toMatch(/^agent_engine_elsewhere:dsh /);
    expect(calls).toEqual([]); expect(llmCalls).toBe(0);
  }, 20_000);

  it('不是输入框发的(自动化 / 通道之类)和团队成员:走到 Tangu 循环被那道闸拒,不替它答', async () => {
    const auto = await turn(1, {}, {});
    expect(auto.error).toMatch(/^agent_engine_elsewhere:dsh /);
    const member = await turn(2, { teamMember: { teamSessionId: 'T', teamRunId: 'tr', name: 'ds' } });
    expect(member.error).toMatch(/^agent_engine_elsewhere:dsh /);
    expect(calls).toEqual([]); expect(llmCalls).toBe(0);
  }, 20_000);

  it('会话里显式选了别的引擎(Codex):照选的走', async () => {
    await turn(1, { engineId: 'codex' });
    expect(calls.map((c) => c.engineId)).toEqual(['codex']);
    expect((await rows()).find((m) => m.role === 'model')?.agent_slug).toBeNull(); // 普通引擎对话照旧不带身份
  }, 20_000);

  it('普通 Agent 照旧由 Tangu 跑', async () => {
    expect((await turn(1, { agentSlug: 'plain' })).done).toBe(true);
    expect(calls).toEqual([]); expect(llmCalls).toBe(1);
  }, 20_000);

  it('换 harness:DSH → Tangu → DSH,换回来从新的引擎会话开始,不接旧的', async () => {
    await turn(1);
    writeAgent('ds'); // 换成 Tangu(定义里没有 engine 了)
    expect((await turn(2)).done).toBe(true);
    expect(llmCalls).toBe(1);
    writeAgent('ds', 'engine = "dsh"\n'); // 再换回 DSH
    await turn(3);
    expect(calls.map((c) => [c.message, c.resume ?? null])).toEqual([['q1', null], ['q3', null]]);
    // 旧对话照常能看:三轮的用户消息和回答都在
    const r = await rows();
    expect(r.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['q1', 'q2', 'q3']);
    expect(r.filter((m) => m.role === 'model').length).toBe(3);
    // 换回 Tangu 的那一轮,Tangu 照它自己的规矩重放这场对话的历史(含 DSH 答的那一轮):换 harness 不另设上下文边界
    expect(tanguReplay.some((m) => m.role === 'assistant' && String(m.content).includes('answer to q1'))).toBe(true);
  }, 30_000);
});
