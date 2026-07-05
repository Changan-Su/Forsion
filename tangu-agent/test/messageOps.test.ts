/**
 * TUI 消息编辑/删除数据操作单测:真 SQLite(内存)经 configureTangu 注入(同 sessionBranch.test 套路)。
 * 覆盖:deleteLastExchange 删最后一条 user 及其之后所有回复、保留更早轮次、空会话返回 null;
 * getLastUserMessageContent 取最新 user 内容。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { query } from '../src/core/db.js';
import { deleteLastExchange, getLastUserMessageContent } from '../src/tui/messageOps.js';

const USER = 'u1';
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });

beforeEach(() => {
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-msgops-'));
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }) });
});

async function seedSession(id: string): Promise<void> {
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id) VALUES (?, ?, 'tangu', 't', 'm1')`, [id, USER]);
}
async function seedMsg(sid: string, id: string, role: string, content: string, ts: number): Promise<void> {
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`, [id, sid, role, content, ts]);
}
function contents(sid: string): Promise<any[]> {
  return query<any[]>(`SELECT content FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC`, [sid]);
}

describe('deleteLastExchange', () => {
  it('删最后一条 user 及其之后的所有回复,保留更早轮次,返回被删 user 内容', async () => {
    await seedSession('S');
    await seedMsg('S', 'm1', 'user', 'q1', 100);
    await seedMsg('S', 'm2', 'model', 'a1', 200);
    await seedMsg('S', 'm3', 'user', 'q2', 300);
    await seedMsg('S', 'm4', 'model', 'a2', 400); // 最后一轮的回复(多条也应一并删)
    await seedMsg('S', 'm5', 'model', 'a2b', 500);

    const deleted = await deleteLastExchange('S');
    expect(deleted).toBe('q2');
    const rows = await contents('S');
    expect(rows.map((r) => r.content)).toEqual(['q1', 'a1']); // 第一轮完整保留
  });

  it('空会话返回 null,不抛', async () => {
    await seedSession('S');
    expect(await deleteLastExchange('S')).toBeNull();
  });

  it('只有一轮时删空', async () => {
    await seedSession('S');
    await seedMsg('S', 'm1', 'user', 'only', 100);
    await seedMsg('S', 'm2', 'model', 'reply', 200);
    expect(await deleteLastExchange('S')).toBe('only');
    expect(await contents('S')).toHaveLength(0);
  });
});

describe('getLastUserMessageContent', () => {
  it('取最新一条 user 内容(忽略其后的 model 回复)', async () => {
    await seedSession('S');
    await seedMsg('S', 'm1', 'user', 'q1', 100);
    await seedMsg('S', 'm2', 'user', 'q2', 300);
    await seedMsg('S', 'm3', 'model', 'a2', 400);
    expect(await getLastUserMessageContent('S')).toBe('q2');
  });
  it('无 user 消息返回 null', async () => {
    await seedSession('S');
    await seedMsg('S', 'm1', 'model', 'sys', 100);
    expect(await getLastUserMessageContent('S')).toBeNull();
  });
});
