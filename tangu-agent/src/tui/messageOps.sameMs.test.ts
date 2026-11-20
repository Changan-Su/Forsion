/** TUI /edit /delete 与同一毫秒落库的几行(#762 / #778 的同类):真 SQLite(内存库),不 mock 查询。
 *  timestamp 只到毫秒;现有索引下 SQLite 把同毫秒里最早落库的那条排在 DESC 最前,所以「最后一条」要靠 rowid 定。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { TURN_INTERRUPTED_MARKER } from '../services/agentLoop.js';
import { deleteLastExchange, getLastUserMessageContent } from './messageOps.js';

const TS = 1_795_000_000_000;
let home: string;

const msg = (id: string, role: 'user' | 'model', content: string, ts: number) => query(
  `INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, 'S', ?, ?, ?)`, [id, role, content, ts],
);
const ids = async () => (await query<any[]>(`SELECT id FROM chat_messages WHERE session_id = 'S' ORDER BY timestamp ASC, rowid ASC`)).map((r) => r.id);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-tui-same-ms-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: [] }), brain: {} as any, billing: {} as any });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 'S', 'm1', 'user')`);
});
afterEach(() => { delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true }); });

describe('TUI /edit /delete:同一毫秒落库的几行', () => {
  it('两条插话同一毫秒:/edit 读到的是后落库那条,删除只删它和它之后的', async () => {
    await msg('u1', 'user', 'First question', TS);
    await msg('a1', 'model', 'First answer', TS + 10);
    await msg('s1', 'user', 'Steer one', TS + 20);
    await msg('s2', 'user', 'Steer two', TS + 20);
    await msg('a2', 'model', 'Answer to steers', TS + 30);
    expect(await getLastUserMessageContent('S')).toBe('Steer two');
    expect(await deleteLastExchange('S')).toBe('Steer two');
    // 旧写法按 timestamp >= 删,把 s1 一起删掉,而 /edit 编辑框里放的却是 s1 —— 两头对不上
    expect(await ids()).toEqual(['u1', 'a1', 's1']);
  });

  it('中止的一轮(半截回答 + 打断标记同一毫秒):打断标记不算用户的话,整轮从用户那句起删', async () => {
    await msg('u1', 'user', 'First question', TS);
    await msg('a1', 'model', 'First answer', TS + 10);
    await msg('u2', 'user', 'Explain the plan', TS + 20);
    await msg('a2', 'model', 'The plan has three parts. First', TS + 50);
    await msg('m2', 'user', TURN_INTERRUPTED_MARKER, TS + 50);
    expect(await getLastUserMessageContent('S')).toBe('Explain the plan');
    expect(await deleteLastExchange('S')).toBe('Explain the plan');
    expect(await ids()).toEqual(['u1', 'a1']);
  });

  it('同一毫秒里用户那句排在回答之后落库:回答留着(它属于上一轮)', async () => {
    await msg('u1', 'user', 'First question', TS);
    await msg('a1', 'model', 'First answer', TS + 10);
    await msg('u2', 'user', 'Next question', TS + 10);
    expect(await deleteLastExchange('S')).toBe('Next question');
    expect(await ids()).toEqual(['u1', 'a1']);
  });

  it('只有机器行:没有可编辑 / 可删除的', async () => {
    await msg('m1', 'user', TURN_INTERRUPTED_MARKER, TS);
    expect(await getLastUserMessageContent('S')).toBeNull();
    expect(await deleteLastExchange('S')).toBeNull();
    expect(await ids()).toEqual(['m1']);
  });

  it('用户自己以同名标签开头的话(没有配对的收尾标签)照样算人说的', async () => {
    await msg('u1', 'user', 'First question', TS);
    await msg('u2', 'user', '<turn_interrupted> is the XML tag I need documented', TS + 10);
    expect(await getLastUserMessageContent('S')).toBe('<turn_interrupted> is the XML tag I need documented');
    expect(await deleteLastExchange('S')).toBe('<turn_interrupted> is the XML tag I need documented');
    expect(await ids()).toEqual(['u1']);
  });

  it('末尾攒了超过一页的机器行(子会话来信):仍能往前找到人说的那句', async () => {
    await msg('u1', 'user', 'Start the children', TS);
    for (let i = 0; i < 60; i++) {
      await msg(`c${i}`, 'user', `<session_message from="c${i}" title="t" relation="child">\nDone ${i}\n</session_message>\nA message from a child session you started.`, TS + 10 + i);
    }
    expect(await getLastUserMessageContent('S')).toBe('Start the children');
  });

  it('删掉的轮次被压缩检查点覆盖过:检查点一并失效,更早的检查点留着', async () => {
    await msg('u1', 'user', 'First question', TS);
    await msg('a1', 'model', 'First answer', TS + 10);
    await msg('u2', 'user', 'Second question', TS + 20);
    await msg('a2', 'model', 'Second answer', TS + 30);
    await query(`INSERT INTO session_summaries (id, session_id, summary, through_timestamp) VALUES ('k1', 'S', 'old', ?), ('k2', 'S', 'new', ?)`, [TS + 10, TS + 30]);
    expect(await deleteLastExchange('S')).toBe('Second question');
    expect((await query<any[]>(`SELECT id FROM session_summaries WHERE session_id = 'S'`)).map((r) => r.id)).toEqual(['k1']);
  });
});
