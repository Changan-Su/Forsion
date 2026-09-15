/**
 * Muse token 预算窗口:tokensInWindow 按 usage 事件累计「该用户的**全部** Muse 会话 + 时间窗内」的
 * **计费** token(Σ prompt − cached + completion;缓存命中不计)与**毛量**(Σ prompt)。
 * 2026-09-15 起口径从「单会话」改为「kind='muse' + user_id」(会话轮换后预算不清零),
 * 故这里同时钉住两条排除轴:别的用户的 muse 会话、同一用户的非 muse 会话。
 * SQLite 与 PGlite(进程内真 Postgres)各跑一遍:同一条 JOIN + getOlderThanSql 窗口;
 * payload 在 PG 回对象、SQLite 回 JSON 串。
 * 直接插 chat_sessions / agent_runs / agent_run_events 造窗口内外、跨会话、跨用户、失败 run 与缓存命中的数据。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createEmbeddedHost } from '../src/adapters/standalone/embeddedHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { tokensInWindow } from '../src/services/muse.js';

const USER = 'local';
const SID = 'muse-sess'; // 当前活动的 muse 会话
const SID2 = 'muse-sess-2'; // 轮换出来的另一个 muse 会话(同一用户 → 仍计入预算)
const OTHER_USER_SID = 'muse-sess-other-user'; // 别人的 muse 会话 → 排除
const USER_SID = 'user-sess'; // 同一用户的普通会话 → 排除
type Usage = { prompt: number; completion: number; cached?: number };

for (const dialect of ['sqlite', 'postgres'] as const) describe(`Muse token 预算窗口(${dialect})`, () => {
  let close: () => unknown = () => {};
  let n = 0;
  // 整数内联,test-only,无注入
  const ago = (mins: number) => (dialect === 'sqlite' ? `datetime('now', '-${mins} minutes')` : `CURRENT_TIMESTAMP - INTERVAL '${mins} minutes'`);

  async function insertSession(id: string, kind: string, userId: string): Promise<void> {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, kind) VALUES (?, ?, 'tangu', ?)`, [id, userId, kind]);
  }

  /** 造一个 run(tokens_total 填毛量,预算不该读它)+ 逐次 usage 事件 + 一条非 usage 事件,时间都在 hoursAgo 前。 */
  async function insertRun(sessionId: string, usages: Usage[], hoursAgo: number, status = 'done'): Promise<void> {
    const at = ago(Math.round(hoursAgo * 60));
    const id = `r${++n}`;
    const gross = usages.reduce((a, u) => a + u.prompt + u.completion, 0);
    await query(
      `INSERT INTO agent_runs (id, session_id, user_id, status, tokens_total, created_at) VALUES (?, ?, 'local', ?, ?, ${at})`,
      [id, sessionId, status, gross],
    );
    const events: Array<[string, object]> = [...usages.map((u): [string, object] => ['usage', u]), ['token', { delta: 'x', prompt: 99_999 }]];
    for (const [i, [type, payload]] of events.entries()) {
      await query(
        `INSERT INTO agent_run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ${at})`,
        [id, i + 1, type, JSON.stringify(payload)],
      );
    }
  }

  beforeAll(async () => {
    let host: any;
    if (dialect === 'sqlite') {
      const h = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'local' });
      h.db.exec(toSqliteDDL(STANDALONE_SCHEMA));
      host = h.host; close = () => h.db.close();
    } else {
      const h = await createEmbeddedHost({ dataDir: 'memory', localToken: 'x', userId: 'local' });
      await h.db.exec(STANDALONE_SCHEMA);
      host = h.host; close = () => h.db.close();
    }
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
    await runMigration();
  });
  afterAll(() => close());
  beforeEach(async () => {
    await query('DELETE FROM agent_run_events');
    await query('DELETE FROM agent_runs');
    await query('DELETE FROM chat_sessions');
    await insertSession(SID, 'muse', USER);
    await insertSession(SID2, 'muse', USER);
    await insertSession(OTHER_USER_SID, 'muse', 'someone-else');
    await insertSession(USER_SID, 'user', USER);
  });

  it('累计本用户全部 muse 会话 + 窗口内;失败 run 也计(tokens_total 只在 done 时写,事件不漏)', async () => {
    await insertRun(SID, [{ prompt: 25_000, completion: 5_000 }], 2); // 窗口内
    await insertRun(SID, [{ prompt: 30_000, completion: 10_000 }], 4, 'failed'); // 窗口内、失败 → 计
    await insertRun(SID2, [{ prompt: 7_000, completion: 1_000 }], 1); // 轮换出来的另一个 muse 会话 → 计
    await insertRun(SID, [{ prompt: 90_000, completion: 9_999 }], 6); // 窗口外(>5h)→ 排除
    await insertRun(OTHER_USER_SID, [{ prompt: 50_000, completion: 0 }], 1); // 他人的 muse 会话 → 排除
    await insertRun(USER_SID, [{ prompt: 40_000, completion: 0 }], 1); // 同用户的普通会话 → 排除
    expect(await tokensInWindow(USER, 5)).toEqual({ billable: 78_000, gross: 62_000 });
  });

  it('无 run → 0(边界:首次周期不被误挡)', async () => {
    expect(await tokensInWindow(USER, 5)).toEqual({ billable: 0, gross: 0 });
  });

  it('缓存命中不计入计费、但计入毛量(09-11 live 实测形状:prompt 逐轮涨、九成以上命中前缀缓存)', async () => {
    await insertRun(SID, [
      { prompt: 15_551, cached: 14_848, completion: 400 }, // 703 + 400
      { prompt: 38_251, cached: 37_376, completion: 600 }, // 875 + 600
      { prompt: 100, cached: 150, completion: 10 }, // 上报异常 cached>prompt → prompt 部分钳到 0
    ], 1);
    // 毛量 = Σprompt = 53_902(不含 completion);run.tokens_total 记的 54_912 预算不该读
    expect(await tokensInWindow(USER, 5)).toEqual({ billable: 2_588, gross: 53_902 });
  });
});
