/**
 * 重启自愈按持有者处理在飞 run(PI-DSH 评审 R2;端到端复现台架见 scripts/run-recovery.repro.mjs):
 *   ① 别的活着的引擎进程持有的(running / queued)一概不碰;
 *   ② running 但持有者已死 → 标中断 + 终态事件,不从头重跑;
 *   ③ queued 且持有者已死 / 不明(升级前的行)→ 认领成本进程再入队;
 *   ④ 本机 SQLite 建 run 时记下持有进程(`<pid>:<启动时刻秒>`,见 services/runOwner.ts);
 *   ⑤ 陈旧清扫也跳过活进程持有的行;认领刷新 updated_at;非 SQLite 库按独占库处理(Codex 两轮评审);
 *   ⑥ pid 还在但启动时刻对不上 = pid 被无关进程复用 → 按已死处理;本进程自己的行不碰。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun } from '../src/services/runStore.js';
import { recoverQueuedRuns } from '../src/services/agentLoop.js';
import { SELF_OWNER, processStartedAt } from '../src/services/runOwner.js';

const USER = 'u1';
let home: string;
let llmCalls: number;
const DEAD = `${spawnSync(process.execPath, ['-e', '0']).pid}:1700000000`; // 已退出的进程
const PPID_STARTED = await processStartedAt(process.ppid); // 真探测(ps / PowerShell)
const LIVE = `${process.ppid}:${PPID_STARTED}`; // 活着的另一个进程
const REUSED = `${process.ppid}:${(PPID_STARTED ?? 0) - 3600}`; // 同 pid、早一小时启动的那个进程 = pid 已被复用

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-recover-'));
  process.env.TANGU_HOME = home;
  llmCalls = 0;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
    streamProviderCompletion: async () => {
      llmCalls++;
      return { content: 'done', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 2 }, finishReason: 'stop' };
    },
  };
  configureTangu({
    host,
    brain: { llm: fakeLlm, users: { getUserById: async () => ({ id: USER, username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false } } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 每个 run 一个会话(互不排队),行状态与持有者直接写库。 */
async function seed(id: string, status: string, owner: string | null): Promise<void> {
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', 'm1', 'user')`, [`S-${id}`, USER]);
  await createRun({ id, sessionId: `S-${id}`, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${id}`, input: { message: 'go', userMessageId: `U-${id}`, attachments: [], agentConfig: {} } });
  await query(`UPDATE agent_runs SET status = ?, owner = ? WHERE id = ?`, [status, owner, id]);
}
const row = async (id: string): Promise<any> => (await query<any[]>(`SELECT status, error, owner FROM agent_runs WHERE id = ?`, [id]))[0];
const events = async (id: string): Promise<any[]> =>
  (await query<any[]>(`SELECT type, payload FROM agent_run_events WHERE run_id = ? ORDER BY seq`, [id])).map((e) => ({ type: e.type, payload: JSON.parse(e.payload) }));
async function settled(ids: string[]): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const rows = await Promise.all(ids.map(row));
    if (rows.every((r) => !['queued', 'running'].includes(r.status))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('认领的 run 没跑完');
}

describe('重启自愈 × 持有进程', () => {
  it('④ 本机 SQLite 建 run 记下本进程为持有者', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
    await createRun({ id: 'R', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A', input: { message: 'go' } });
    expect((await row('R')).owner).toBe(SELF_OWNER);
    expect(SELF_OWNER.startsWith(`${process.pid}:`)).toBe(true);
  });

  it('探测:本进程自算的启动时刻与 ps / PowerShell 实测对得上(差 ≤3 秒),父进程探得到', async () => {
    const self = Number(SELF_OWNER.split(':')[1]);
    const probed = await processStartedAt(process.pid);
    expect(probed).not.toBeNull();
    expect(Math.abs((probed as number) - self)).toBeLessThanOrEqual(3);
    expect(PPID_STARTED).not.toBeNull();
  });

  it('⑥ pid 被复用(在但启动时刻对不上)按已死处理;本进程自己的行不碰', async () => {
    await seed('reused-running', 'running', REUSED);
    await seed('self-running', 'running', SELF_OWNER);
    expect(await recoverQueuedRuns()).toBe(0);
    expect(await row('reused-running')).toMatchObject({ status: 'failed', error: 'orphaned' });
    expect(await row('self-running')).toMatchObject({ status: 'running', owner: SELF_OWNER });
  });

  it('①②③ 活进程的不碰;死持有者的 running 标中断不重跑;queued 认领后入队', async () => {
    expect(DEAD).toMatch(/^\d+:/);
    await seed('live-running', 'running', LIVE);
    await seed('live-queued', 'queued', LIVE);
    await seed('dead-running', 'running', DEAD);
    await seed('dead-queued', 'queued', DEAD);
    await seed('legacy-queued', 'queued', null);

    expect(await recoverQueuedRuns()).toBe(2);

    expect(await row('live-running')).toMatchObject({ status: 'running', owner: LIVE });
    expect(await row('live-queued')).toMatchObject({ status: 'queued', owner: LIVE });
    expect(await events('live-running')).toEqual([]);

    expect(await row('dead-running')).toMatchObject({ status: 'failed', error: 'orphaned' }); // 桌面 chat.err.orphaned 认这个裸码
    expect((await events('dead-running')).at(-1)).toMatchObject({ type: 'error', payload: { error: 'orphaned' } });

    await settled(['dead-queued', 'legacy-queued']);
    expect((await row('dead-queued')).owner).toBe(SELF_OWNER);
    expect((await row('legacy-queued')).owner).toBe(SELF_OWNER);
    expect(llmCalls).toBe(2); // 只有两条 queued 真跑了;interrupted 那条没被从头重跑
  }, 20_000);

  it('陈旧清扫(30 分钟)同样跳过活进程持有的行:TUI 等审批超过 30 分钟时桌面引擎启动,不能把它标失败', async () => {
    await seed('live-old', 'running', LIVE);
    await seed('dead-old', 'running', DEAD);
    await query(`UPDATE agent_runs SET updated_at = datetime('now', '-2 hours') WHERE id IN ('live-old', 'dead-old')`);
    expect(await recoverQueuedRuns()).toBe(0);
    expect(await row('live-old')).toMatchObject({ status: 'running', owner: LIVE });
    expect(await row('dead-old')).toMatchObject({ status: 'failed', error: 'stale: process restarted' });
  });

  it('非 SQLite 库(外部 PG / PGlite)不记持有者 → 按独占库处理:running 标 orphaned、queued 认领,不会卡在 running', async () => {
    await seed('pg-running', 'running', null);
    await seed('pg-queued', 'queued', null);
    const host = deps().host;
    const orig = host.getDbType;
    host.getDbType = () => 'postgres';
    try {
      expect(await recoverQueuedRuns()).toBe(1);
    } finally {
      host.getDbType = orig;
    }
    expect(await row('pg-running')).toMatchObject({ status: 'failed', error: 'orphaned' });
    await settled(['pg-queued']);
    expect(llmCalls).toBe(1);
  });

  it('认领时刷新 updated_at:同时启动的另一个引擎按旧快照清扫时不会把它当陈旧', async () => {
    await seed('almost-stale', 'queued', DEAD);
    await query(`UPDATE agent_runs SET updated_at = datetime('now', '-29 minutes') WHERE id = 'almost-stale'`);
    expect(await recoverQueuedRuns()).toBe(1);
    const [r] = await query<any[]>(`SELECT owner, updated_at >= datetime('now', '-1 minutes') AS fresh FROM agent_runs WHERE id = 'almost-stale'`);
    expect(r).toMatchObject({ owner: SELF_OWNER, fresh: 1 });
    await settled(['almost-stale']);
  });

  it('认领是 CAS:读完列表后被另一个引擎抢先认领的 queued 行不再入队', async () => {
    await seed('raced', 'queued', LIVE); // 库里已是别人的
    const st = deps().state;
    const orig = st.listPendingRunsForRecovery;
    st.listPendingRunsForRecovery = async () => [{ id: 'raced', session_id: 'S-raced', status: 'queued', owner: DEAD }]; // 本进程读到的旧快照
    try {
      expect(await recoverQueuedRuns()).toBe(0);
    } finally {
      st.listPendingRunsForRecovery = orig;
    }
    expect(await row('raced')).toMatchObject({ status: 'queued', owner: LIVE });
    expect(llmCalls).toBe(0);
  });
});
