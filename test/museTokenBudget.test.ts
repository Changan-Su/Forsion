/**
 * Muse token 预算窗口:tokensInWindow 只累计「本会话 + 时间窗内」的 agent_runs.tokens_total。
 * 真 SQLite(内存),直接插 agent_runs 造窗口内/外与跨会话数据,验证滑窗 + 会话隔离。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { tokensInWindow } from '../src/services/muse.js';

const SID = 'muse-sess';
let n = 0;

async function insertRun(sessionId: string, tokens: number, hoursAgo: number): Promise<void> {
  const mins = Math.round(hoursAgo * 60); // 整数内联,test-only,无注入
  await query(
    `INSERT INTO agent_runs (id, session_id, user_id, status, tokens_total, created_at)
     VALUES (?, ?, 'local', 'done', ?, datetime('now', '-${mins} minutes'))`,
    [`r${++n}`, sessionId, tokens],
  );
}

beforeEach(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'local' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({
    host,
    brain: {} as any,
    billing: {} as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
});

describe('Muse token 预算窗口', () => {
  it('只累计本会话 + 窗口内的 tokens_total', async () => {
    await insertRun(SID, 30_000, 2); // 窗口内
    await insertRun(SID, 40_000, 4); // 窗口内
    await insertRun(SID, 99_999, 6); // 窗口外(>5h)→ 排除
    await insertRun('other-sess', 50_000, 1); // 他会话 → 排除
    expect(await tokensInWindow(SID, 5)).toBe(70_000);
  });

  it('无 run → 0(边界:首次周期不被误挡)', async () => {
    expect(await tokensInWindow(SID, 5)).toBe(0);
  });
});
