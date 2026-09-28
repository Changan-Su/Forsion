/**
 * P1 · M1A(K9 G7「Muse 周期提示词里的远程会话原话」):远端驱动过的会话不自动流进本机无污点的上下文。
 * 真内存 SQLite + 真查询 / 真 agentLoop(fake brain 抓 wire)。四种会话:
 *   L   本机会话(正对照:每个来源都照常给它);
 *   R1  远端建的(agent_config.remoteOrigin);R2 远端起过 run(input.remote);
 *   R3  本机起、被远端 steer 染色的 run(进程内污点 → remoteTaint 落进 input.remoteTainted,清掉进程内表后照样认得);
 *   BAD agent_config 是坏 JSON(fail-closed:按有污点藏)。
 * 断言:Muse 的「最近会话标题」、检索 / 读会话(带 excludeRemoteSessions)、agentLoop 的自动召回、活动日志读端、log_event 远程硬拒。
 * 负对照:把 remoteTaint.notRemoteTaintedSql 改成恒 `1=1` → 标题 / 检索 / 召回三组红;删掉 readActivityLines 里的 isRemoteActivityLine 过滤 → 活动组红。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/remoteTaintContext.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { taintRunRemote, clearRunRemoteTaint, remoteManagementDenied } from '../src/services/remoteOrigin.js';
import { persistRunTaint, remoteRecallHide, sessionRemoteTainted } from '../src/services/remoteTaint.js';
import { recentSessionTitles } from '../src/services/muse.js';
import { searchSessions } from '../src/services/sessionSearch.js';
import { formatActivityLine, isRemoteActivityLine, readActivityLines, activityDir } from '../src/services/userActivity.js';
import { memoryLogProvider } from '../src/tools/builtin/memoryLog.js';

const USER = 'u1';
let root: string;
let ws: string;
let llmPayloads: any[];
let logWrites: string[];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tangu-m1a-taint-'));
  process.env.TANGU_HOME = join(root, 'forsion', 'tangu'); // 共享域 = …/forsion(活动日志在它下面)
  mkdirSync(process.env.TANGU_HOME, { recursive: true });
  ws = mkdtempSync(join(tmpdir(), 'tangu-m1a-taint-ws-'));
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  llmPayloads = [];
  logWrites = [];
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        llmPayloads.push(o.payload);
        return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: {
      getMemory: async () => ({ content: '' }),
      appendLogEntry: async (_u: string, text: string) => { logWrites.push(text); return { date: '2026-09-28', time: '09:00' }; },
    },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  await runMigration();

  const sess = async (id: string, title: string, cfg: string | null) => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES (?, ?, 'tangu', ?, 'm1', 'user', ?)`, [id, USER, title, cfg]);
    await deps().state.insertUserMessage({ id: `${id}-m`, sessionId: id, content: `zebra ${id}-MARK`, modelId: 'm1', attachments: null });
  };
  await sess('L', 'LOCAL-T', null);
  await sess('R1', 'REMOTE1-T', JSON.stringify({ remoteOrigin: { via: 'tunnel', marked: true } }));
  await sess('R2', 'REMOTE2-T', null);
  await sess('R3', 'REMOTE3-T', null);
  await sess('BAD', 'BAD-T', '{bad');
  const run = (id: string, sid: string, input: Record<string, unknown>) => createRun({ id, sessionId: sid, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${id}-a`, input: { message: 'x', ...input } });
  await run('RL', 'L', {});
  await run('RR2', 'R2', { remote: { via: 'tunnel', marked: true } });
  await run('RR3', 'R3', {});
  taintRunRemote('RR3', { via: 'tunnel', marked: true, callerUnit: '11111111-2222-3333-4444-555555555555', callerKind: 'phone' });
  await persistRunTaint('RR3'); // 订阅已异步落过一次;这里再等一次,免得和下面的断言赛跑
  clearRunRemoteTaint('RR3'); // run 收尾:进程内表清掉,会话级判据只剩库里的记录
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  for (const d of [root, ws]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('会话级污点判据', () => {
  it('远端建 / 远端起过 run / 被远端染色(已清进程内表)/ 坏配置 → 有污点;本机会话 → 无', async () => {
    expect(await sessionRemoteTainted('L')).toBe(false);
    for (const s of ['R1', 'R2', 'R3', 'BAD']) expect(await sessionRemoteTainted(s), s).toBe(true);
    const [row] = await query<any[]>(`SELECT input FROM agent_runs WHERE id = 'RR3'`);
    const input = JSON.parse(row.input);
    expect(input.remoteTainted).toMatchObject({ via: 'tunnel', callerUnit: '11111111-2222-3333-4444-555555555555' });
    expect(input.remote, 'remoteTainted 只是记录,不冒充 input.remote(remoteOf 不读它)').toBeUndefined();
    expect(input.message).toBe('x');
  });
});

describe('Muse 周期提示词:最近会话标题', () => {
  it('只列本机会话', async () => {
    const t = await recentSessionTitles(USER);
    expect(t).toContain('LOCAL-T');
    for (const x of ['REMOTE1-T', 'REMOTE2-T', 'REMOTE3-T', 'BAD-T']) expect(t, x).not.toContain(x);
  });
});

describe('检索 / 读会话', () => {
  const scope = { agentSlug: 'xyra' };
  it('excludeRemoteSessions → 只剩本机会话;不带 → 全在(对照)', async () => {
    const all = await searchSessions({ userId: USER, appId: 'tangu', terms: ['zebra'], limit: 10, toolScope: scope, matchAny: true });
    expect(all.map((h) => h.id).sort()).toEqual(['L', 'R1', 'R2', 'R3']); // BAD 的 agent_config 坏 → 归属谓词本就不认它
    const hidden = await searchSessions({ userId: USER, appId: 'tangu', terms: ['zebra'], limit: 10, toolScope: scope, matchAny: true, excludeRemoteSessions: true });
    expect(hidden.map((h) => h.id)).toEqual(['L']);
  });
  it('read_session 的数据面:藏起来的会话按「范围内无此会话」答', async () => {
    const read = (sessionId: string, excludeRemoteSessions?: boolean) => deps().state.readSessionTranscript({ sessionId, userId: USER, appId: 'tangu', toolScope: scope, limit: 10, perMessageChars: 200, charOffset: 0, excludeRemoteSessions });
    expect((await read('R1')).session?.id).toBe('R1');
    expect((await read('R1', true)).session).toBeNull();
    expect((await read('R3', true)).session).toBeNull();
    expect((await read('L', true)).session?.id).toBe('L');
  });
  it('工具侧:Muse / 无人值守 / 通道 run 藏;本机交互 run 与带远程污点的 run 不藏', () => {
    expect(remoteRecallHide({ muse: true })).toBe(true);
    expect(remoteRecallHide({ runOrigin: 'unattended' })).toBe(true);
    expect(remoteRecallHide({ runOrigin: 'channel' })).toBe(true);
    expect(remoteRecallHide({ runOrigin: 'local' })).toBe(false);
    expect(remoteRecallHide({ runOrigin: 'unattended', remote: { via: 'tunnel', marked: true } })).toBe(false);
  });
});

describe('agentLoop 自动召回(不经任何人点头就进上下文)', () => {
  const runLoop = async (id: string, input: Record<string, unknown>) => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', 'm1', 'user')`, [`S-${id}`, USER]);
    await createRun({ id, sessionId: `S-${id}`, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${id}-a`,
      input: { message: 'zebra progress', userMessageId: `${id}-u`, attachments: [], agentConfig: { execMode: 'host', cwd: ws }, origin: 'client', ...input } });
    const before = llmPayloads.length;
    enqueueRun(`S-${id}`, id);
    const t0 = Date.now();
    for (;;) {
      const r = await getRun(id);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) break;
      if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 25));
    }
    return JSON.stringify(llmPayloads[before]?.messages ?? []);
  };
  it('本机 run:召回片段里有本机会话、没有远端驱动过的会话', async () => {
    const wire = await runLoop('AL', {});
    expect(wire).toContain('L-MARK');
    for (const m of ['R1-MARK', 'R2-MARK', 'R3-MARK']) expect(wire, m).not.toContain(m);
  });
  it('远程 run(对照):远端内容回到远端 run 不是洗白,不藏', async () => {
    const wire = await runLoop('AR', { remote: { via: 'tunnel', marked: true } });
    expect(wire).toMatch(/R[123]-MARK/); // 召回只取 3 个会话,哪几个进窗口看打分;有远端会话即说明没藏
  });
});

describe('活动日志', () => {
  it('远程 run 的行带 remote=1;读端缺省不给,盯任务规则显式要才给;引号里的字面 remote=1 不算', async () => {
    const remoteLine = formatActivityLine('run.done', { agent: 'xyra', s: 'abcdef', status: 'done', remote: 1 })!;
    const spoof = formatActivityLine('agent.edit', { tool: 'write_file', f: 'notes remote=1.md' })!;
    const local = formatActivityLine('run.done', { agent: 'xyra', s: 'fedcba', status: 'done' })!;
    expect(isRemoteActivityLine(remoteLine)).toBe(true);
    expect(isRemoteActivityLine(spoof)).toBe(false);
    expect(isRemoteActivityLine(local)).toBe(false);
    mkdirSync(activityDir(), { recursive: true });
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    writeFileSync(join(activityDir(), `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.log`), [remoteLine, spoof, local].join('\n') + '\n');
    const def = await readActivityLines({ hours: 2 });
    expect(def.some((l) => l.includes('s=abcdef'))).toBe(false);
    expect(def.some((l) => l.includes('s=fedcba'))).toBe(true);
    expect(def.some((l) => l.includes('agent.edit'))).toBe(true);
    const all = await readActivityLines({ hours: 2, includeRemote: true });
    expect(all.some((l) => l.includes('s=abcdef'))).toBe(true);
  });
});

describe('log_event', () => {
  it('远程污点 run 硬拒(审批闸同一判定),不写日志;本机 run 照写', async () => {
    expect(remoteManagementDenied('log_event', undefined)).toMatch(/daily log/);
    const tool = memoryLogProvider.tools().find((t) => t.name === 'log_event')!;
    const ctx: any = { userId: USER, appId: 'tangu', sessionId: 'L', runId: 'x', execMode: 'host' };
    const denied = await tool.execute({ text: 'remote said hi' }, { ...ctx, remote: { via: 'tunnel', marked: true } });
    expect(String(denied)).toMatch(/^Error: Remote sessions cannot write to the daily log/);
    expect(logWrites).toEqual([]);
    await tool.execute({ text: 'local done' }, ctx);
    expect(logWrites).toEqual(['local done']);
  });
});
