/**
 * 会话分支(branchSession)单测:真 SQLite(内存)经 configureTangu 注入。
 * 覆盖:中点分支只复制 timestamp<=分支点 的消息、字段/顺序保留、新 id≠旧 id、源会话不变、
 * 配置克隆;末条分支=全量;messageId 跨会话拒绝;非本人/非本 app 拒绝。
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
import { branchSession } from '../src/services/sessionBranch.js';

const USER = 'u1';
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });

beforeEach(() => {
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-branch-'));
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }) });
});

async function seedSession(id: string, app = 'tangu'): Promise<void> {
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, agent_config, project_path, project_name)
     VALUES (?, ?, ?, '原会话', 'm1', ?, '/tmp/proj', 'Proj')`,
    [id, USER, app, JSON.stringify({ approvalMode: 'auto-edit' })],
  );
}

async function seedMsg(sid: string, id: string, role: string, content: string, ts: number, toolCalls?: any): Promise<void> {
  await query(
    `INSERT INTO chat_messages (id, session_id, role, content, timestamp, tool_calls) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, sid, role, content, ts, toolCalls ? JSON.stringify(toolCalls) : null],
  );
}

describe('branchSession', () => {
  it('中点分支:只复制 timestamp<=分支点 的消息,字段/顺序保留,id 全新,源会话不变,配置克隆', async () => {
    await seedSession('S');
    await seedMsg('S', 'm1', 'user', 'q1', 100);
    await seedMsg('S', 'm2', 'model', 'a1', 200, [{ id: 't', type: 'function', function: { name: 'foo', arguments: '{}' } }]);
    await seedMsg('S', 'm3', 'user', 'q2', 300);
    await seedMsg('S', 'm4', 'model', 'a2', 400);

    const r = await branchSession({ sourceSessionId: 'S', userId: USER, appId: 'tangu', messageId: 'm2' });
    expect(r).not.toBeNull();
    expect(r!.copied).toBe(2);

    const rows = await query<any[]>(
      `SELECT id, role, content, timestamp, tool_calls FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC`,
      [r!.id],
    );
    expect(rows.map((x) => x.content)).toEqual(['q1', 'a1']);
    expect(rows.map((x) => x.role)).toEqual(['user', 'model']);
    expect(rows.map((x) => Number(x.timestamp))).toEqual([100, 200]);
    // 全新 id,非复用源 id
    expect(rows.some((x) => x.id === 'm1' || x.id === 'm2')).toBe(false);
    // JSON 字段原样保留
    expect(JSON.parse(rows[1].tool_calls)[0].function.name).toBe('foo');

    // 源会话消息不变(4 条)
    const src = await query<any[]>(`SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = 'S'`);
    expect(Number(src[0].c)).toBe(4);

    // 新会话克隆了模型/工程信息
    const sess = await query<any[]>(`SELECT model_id, project_name FROM chat_sessions WHERE id = ?`, [r!.id]);
    expect(sess[0].model_id).toBe('m1');
    expect(sess[0].project_name).toBe('Proj');
  });

  it('从最后一条分支 = 全量复制', async () => {
    await seedSession('S');
    await seedMsg('S', 'm1', 'user', 'q1', 100);
    await seedMsg('S', 'm2', 'model', 'a1', 200);
    const r = await branchSession({ sourceSessionId: 'S', userId: USER, appId: 'tangu', messageId: 'm2' });
    expect(r!.copied).toBe(2);
  });

  it('messageId 不属于源会话 → null', async () => {
    await seedSession('S');
    await seedMsg('S', 'm1', 'user', 'q1', 100);
    expect(await branchSession({ sourceSessionId: 'S', userId: USER, appId: 'tangu', messageId: 'nope' })).toBeNull();
  });

  it('非本人 / 非本 app → null', async () => {
    await seedSession('S');
    await seedMsg('S', 'm1', 'user', 'q1', 100);
    expect(await branchSession({ sourceSessionId: 'S', userId: 'other', appId: 'tangu', messageId: 'm1' })).toBeNull();
    expect(await branchSession({ sourceSessionId: 'S', userId: USER, appId: 'ai-studio', messageId: 'm1' })).toBeNull();
  });
});
