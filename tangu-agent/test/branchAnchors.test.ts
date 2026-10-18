/**
 * 挂点(方案「Chat 画布分支」10-18 第一步):分支血缘 fork_message_id / fork_session_id、agent 的 <branches> 段、顺便问落库。
 * 真 SQLite(内存)经 configureTangu 注入,同 sessionBranch.test.ts。
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
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { branchSession } from '../src/services/sessionBranch.js';
import { branchesSection } from '../src/services/branchContext.js';
import { deleteAside, listAsides, saveAside } from '../src/services/aside.js';
import { SESSION_COLS } from '../src/routes/sessions.js';

const USER = 'u1';
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });

beforeEach(async () => {
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-anchors-'));
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});

async function seed(id: string, title: string, extra: { parent?: string; fork?: string } = {}): Promise<void> {
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, parent_session_id, fork_message_id) VALUES (?, ?, 'tangu', ?, ?, ?)`,
    [id, USER, title, extra.parent || null, extra.fork || null],
  );
}
async function msg(sid: string, id: string, role: string, content: string, ts: number): Promise<void> {
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`, [id, sid, role, content, ts]);
}

/** 主线 u1 a1 u2 a2;从 a1 分出「如果用 CRDT」(复制 u1 a1 + 新问答两条)。 */
async function tree(): Promise<string> {
  await seed('R', 'Offline sync');
  await msg('R', 'u1', 'user', 'How to sync offline?', 100);
  await msg('R', 'a1', 'model', 'Three routes, from **smallest** change to largest', 200);
  await msg('R', 'u2', 'user', 'Which modules change?', 300);
  await msg('R', 'a2', 'model', 'When the merge fails, the user sees a banner', 400);
  const b = await branchSession({ sourceSessionId: 'R', userId: USER, appId: 'tangu', messageId: 'a1', title: 'If we use CRDT', parentSessionId: 'R', forkMessageId: 'a1' });
  await msg(b!.id, 'c1', 'user', 'What if CRDT?', 500);
  await msg(b!.id, 'c2', 'model', 'Yjs fits; the cost is a bigger bundle', 600);
  return b!.id;
}

describe('分支血缘', () => {
  it('branchSession 记 fork_message_id;SESSION_COLS 反查出分叉点所在的会话', async () => {
    const b = await tree();
    const [row] = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ?`, [b]);
    expect(row.parent_session_id).toBe('R');
    expect(row.fork_message_id).toBe('a1');
    expect(row.fork_session_id).toBe('R');
    const [root] = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = 'R'`);
    expect(root.fork_message_id).toBeNull();
    expect(root.fork_session_id).toBeNull();
  });
});

describe('<branches> 段', () => {
  it('没分叉 → null;子会话(parent 有、fork 空)不算分支', async () => {
    await seed('R', 'Solo');
    await msg('R', 'u1', 'user', 'hi', 100);
    await seed('K', 'child', { parent: 'R' });
    expect(await branchesSection('R', USER)).toBeNull();
    expect(await branchesSection('K', USER)).toBeNull();
  });

  it('在分支里:说出自己从哪分出,列主线(全部条数)和最后一句', async () => {
    const b = await tree();
    const sec = (await branchesSection(b, USER))!;
    expect(sec).toContain('<branches>');
    expect(sec).toContain('It now has 2 branches. You are in "If we use CRDT", which forked after assistant: "Three routes, from smallest change to largest"');
    expect(sec).toContain('- main (session id R) — 4 messages; last: "When the merge fails, the user sees a banner"');
    expect(sec).toContain('read_session');
  });

  it('在主线:列分支,条数只算分叉之后的', async () => {
    const b = await tree();
    const sec = (await branchesSection('R', USER))!;
    expect(sec).toContain('You are in main.');
    expect(sec).toContain(`- "If we use CRDT" (session id ${b}) — 2 messages since it forked; last: "Yjs fits; the cost is a bigger bundle"`);
  });

  it('还没起名的分支(New Chat)不把占位名当标题', async () => {
    const b = await tree();
    await query(`UPDATE chat_sessions SET title = 'New Chat' WHERE id = ?`, [b]);
    expect(await branchesSection(b, USER)).toContain('You are in an untitled branch, which forked after');
    expect(await branchesSection('R', USER)).toContain(`- an untitled branch (session id ${b})`);
  });

  it('别人的会话 / 归档的分支不列', async () => {
    const b = await tree();
    expect(await branchesSection(b, 'someone-else')).toBeNull();
    await query(`UPDATE chat_sessions SET archived = TRUE WHERE id = ?`, [b]);
    expect(await branchesSection('R', USER)).toBeNull();
  });

  it('本 run 无远程污点 → 远端驱动过的别的支不列;自己那支照列(Codex 10-18 #1)', async () => {
    const b = await tree();
    await query(`UPDATE chat_sessions SET title = 'Remote said this', agent_config = ? WHERE id = ?`, [JSON.stringify({ remoteOrigin: { deviceId: 'd' } }), b]);
    expect(await branchesSection('R', USER)).toContain('Remote said this');
    expect(await branchesSection('R', USER, { hideRemote: true })).toBeNull();
    expect(await branchesSection(b, USER, { hideRemote: true })).toContain('You are in "Remote said this"');
  });

  it('主线是远端驱动过的 → 本机无污点的分支里不摘主线上那条分叉消息(Codex 10-18 复核)', async () => {
    const b = await tree();
    await seed('C', 'clean sibling', { parent: 'R', fork: 'a1' });
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'R'`, [JSON.stringify({ remoteContent: true })]);
    const sec = (await branchesSection(b, USER, { hideRemote: true }))!;
    expect(sec).toContain('forked after an earlier message');
    expect(sec).not.toContain('(session id R)');
  });
});

describe('顺便问落库', () => {
  it('新开一条挂在消息上;续写以库里为准只追加;别会话的消息 / 没给 → 挂本会话最近一条回答', async () => {
    await seed('R', 'x');
    await msg('R', 'a1', 'model', 'answer', 100);
    await msg('R', 'a2', 'model', 'later answer', 200);
    await seed('S', 'other');
    await msg('S', 'z1', 'model', 'nope', 100);
    const { id } = (await saveAside({ sessionId: 'R', userId: USER, messageId: 'a1', turn: { question: 'What is Yjs?', answer: 'A CRDT library.' }, thread: [] }))!;
    const { id: id2 } = (await saveAside({ asideId: id, sessionId: 'R', userId: USER, messageId: 'a1', turn: { question: 'Size?', answer: 'About 70 KB.' }, thread: [] }))!;
    expect(id2).toBe(id);
    const { id: loose, messageId: looseAt } = (await saveAside({ sessionId: 'R', userId: USER, messageId: 'z1', turn: { question: 'q', quote: 'excerpt', answer: 'a' }, thread: [] }))!;
    const { id: bare } = (await saveAside({ sessionId: 'R', userId: USER, turn: { question: 'q', answer: 'a' }, thread: [] }))!;
    const rows = await listAsides('R', USER);
    expect(rows.map((r) => [r.id, r.message_id, r.turns.length])).toEqual([[id, 'a1', 2], [loose, 'a2', 1], [bare, 'a2', 1]]);
    expect(rows[1].turns[0].quote).toBe('excerpt');
    expect(looseAt).toBe('a2');
  });

  it('两扇窗同时续同一段 → 两问都留下(比对旧值再写,Codex 10-18 #2)', async () => {
    await seed('R', 'x');
    await msg('R', 'a1', 'model', 'answer', 100);
    const { id } = (await saveAside({ sessionId: 'R', userId: USER, messageId: 'a1', turn: { question: 'q0', answer: 'a0' }, thread: [] }))!;
    await Promise.all(['A', 'B'].map((q) => saveAside({ asideId: id, sessionId: 'R', userId: USER, turn: { question: q, answer: q }, thread: [] })));
    expect((await listAsides('R', USER))[0].turns.map((t) => t.question).sort()).toEqual(['A', 'B', 'q0']);
  });

  it('一条回答都没有(空会话里问的)→ 不存(Codex 10-18 #5)', async () => {
    await seed('R', 'x');
    expect(await saveAside({ sessionId: 'R', userId: USER, turn: { question: 'q', answer: 'a' }, thread: [] })).toBeNull();
    expect(await listAsides('R', USER)).toEqual([]);
  });

  it('拿着别人的 / 删掉的 id 续写 → 另开一条;删除只删本人本会话的', async () => {
    await seed('R', 'x');
    await msg('R', 'a1', 'model', 'answer', 100);
    const { id } = (await saveAside({ sessionId: 'R', userId: USER, turn: { question: 'q', answer: 'a' }, thread: [] }))!;
    const { id: other } = (await saveAside({ asideId: id, sessionId: 'R', userId: 'u2', turn: { question: 'q2', answer: 'a2' }, thread: [] }))!;
    expect(other).not.toBe(id);
    await deleteAside(id, 'R', 'u2');
    expect((await listAsides('R', USER)).length).toBe(1);
    await deleteAside(id, 'R', USER);
    expect(await listAsides('R', USER)).toEqual([]);
    const { id: again } = (await saveAside({ asideId: id, sessionId: 'R', userId: USER, turn: { question: 'q3', answer: 'a3' }, thread: [{ question: 'q', answer: 'a' }] }))!;
    expect(again).not.toBe(id);
    expect((await listAsides('R', USER))[0].turns.map((t) => t.question)).toEqual(['q', 'q3']);
  });
});
