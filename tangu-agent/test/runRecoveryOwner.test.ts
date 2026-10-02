/**
 * 重启自愈按持有者处理在飞 run(PI-DSH 评审 R2;端到端复现台架见 scripts/run-recovery.repro.mjs):
 *   ① 别的活着的引擎进程持有的(running / queued)一概不碰;
 *   ② running 但持有者已死 → 标中断 + 终态事件,不从头重跑;
 *   ③ queued 且持有者已死 / 不明(升级前的行)→ 认领成本进程再入队;
 *   ④ 本机 SQLite 建 run 时记下持有进程。
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

const USER = 'u1';
let home: string;
let llmCalls: number;
const DEAD = spawnSync(process.execPath, ['-e', '0']).pid; // 已退出的进程号
const LIVE = process.ppid; // 活着的另一个进程

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
async function seed(id: string, status: string, owner: number | null): Promise<void> {
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', 'm1', 'user')`, [`S-${id}`, USER]);
  await createRun({ id, sessionId: `S-${id}`, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${id}`, input: { message: 'go', userMessageId: `U-${id}`, attachments: [], agentConfig: {} } });
  await query(`UPDATE agent_runs SET status = ?, owner_pid = ? WHERE id = ?`, [status, owner, id]);
}
const row = async (id: string): Promise<any> => (await query<any[]>(`SELECT status, error, owner_pid FROM agent_runs WHERE id = ?`, [id]))[0];
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
    expect((await row('R')).owner_pid).toBe(process.pid);
  });

  it('①②③ 活进程的不碰;死持有者的 running 标中断不重跑;queued 认领后入队', async () => {
    expect(DEAD).toBeGreaterThan(0);
    await seed('live-running', 'running', LIVE);
    await seed('live-queued', 'queued', LIVE);
    await seed('dead-running', 'running', DEAD);
    await seed('dead-queued', 'queued', DEAD);
    await seed('legacy-queued', 'queued', null);

    expect(await recoverQueuedRuns()).toBe(2);

    expect(await row('live-running')).toMatchObject({ status: 'running', owner_pid: LIVE });
    expect(await row('live-queued')).toMatchObject({ status: 'queued', owner_pid: LIVE });
    expect(await events('live-running')).toEqual([]);

    expect(await row('dead-running')).toMatchObject({ status: 'failed', error: 'interrupted: engine restarted mid-run' });
    expect((await events('dead-running')).at(-1)).toMatchObject({ type: 'error', payload: { error: 'interrupted' } });

    await settled(['dead-queued', 'legacy-queued']);
    expect((await row('dead-queued')).owner_pid).toBe(process.pid);
    expect((await row('legacy-queued')).owner_pid).toBe(process.pid);
    expect(llmCalls).toBe(2); // 只有两条 queued 真跑了;interrupted 那条没被从头重跑
  }, 20_000);

  it('认领是 CAS:读完列表后被另一个引擎抢先认领的 queued 行不再入队', async () => {
    await seed('raced', 'queued', LIVE); // 库里已是别人的
    const st = deps().state;
    const orig = st.listPendingRunsForRecovery;
    st.listPendingRunsForRecovery = async () => [{ id: 'raced', session_id: 'S-raced', status: 'queued', owner_pid: DEAD }]; // 本进程读到的旧快照
    try {
      expect(await recoverQueuedRuns()).toBe(0);
    } finally {
      st.listPendingRunsForRecovery = orig;
    }
    expect(await row('raced')).toMatchObject({ status: 'queued', owner_pid: LIVE });
    expect(llmCalls).toBe(0);
  });
});
