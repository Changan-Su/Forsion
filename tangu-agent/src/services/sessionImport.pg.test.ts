/**
 * 会话导入在 server 网关形态下(Postgres + chat_messages.session_id 外键指向 chat_sessions)的回归。
 * 表结构照 server 的核心迁移(src/db/migrate-postgres.ts)+ 引擎 runMigration 补的列;宿主事务用 PGlite 的 transaction 实现,
 * 与 server 用一条独占连接 BEGIN / COMMIT 的语义相同。sqlite 老路见 sessionImport.test.ts。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { configureTangu } from '../seams/runtime.js';
import { importConversations, importedSessionId, type ImportRequest } from './sessionImport.js';

const pg = (sql: string) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };

let db: PGlite;
let failMessagesAt = -1; // 第几次写 chat_messages 时报一次错(从 0 数,-1 = 不报)
let messageWrites = 0;
const failing = async (sql: string, run: () => Promise<any>) => {
  if (/INSERT INTO chat_messages/.test(sql) && failMessagesAt >= 0 && messageWrites++ === failMessagesAt) throw new Error('disk full');
  return run();
};
const query = (sql: string, params: any[] = []) => failing(sql, async () => (await db.query(pg(sql), params)).rows);
const transaction = <T>(fn: (q: (sql: string, params?: any[]) => Promise<any>) => Promise<T>): Promise<T> =>
  db.transaction((tx) => fn((sql, params = []) => failing(sql, async () => (await tx.query(pg(sql), params)).rows)));

const configure = (withTx: boolean) => configureTangu({
  host: { getDbType: () => 'postgres', query, ...(withTx ? { transaction } : {}) },
  brain: {}, billing: {}, profileStore: {}, profile: {},
} as any);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE users (id VARCHAR(36) PRIMARY KEY);
    INSERT INTO users VALUES ('u1'), ('u2');
    CREATE TABLE chat_sessions (
      id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, app_id VARCHAR(50) NOT NULL DEFAULT 'ai-studio',
      title VARCHAR(500) NOT NULL DEFAULT 'New Chat', model_id VARCHAR(200) DEFAULT '', archived BOOLEAN DEFAULT FALSE,
      agent_config JSONB DEFAULT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      kind VARCHAR(16) NOT NULL DEFAULT 'user', last_read_at BIGINT, title_manual BOOLEAN NOT NULL DEFAULT FALSE,
      projectless BOOLEAN NOT NULL DEFAULT FALSE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE chat_messages (
      id VARCHAR(36) PRIMARY KEY, session_id VARCHAR(36) NOT NULL, role VARCHAR(20) NOT NULL, content TEXT,
      timestamp BIGINT NOT NULL, model_id VARCHAR(200) DEFAULT NULL, reasoning TEXT DEFAULT NULL,
      agent_slug VARCHAR(64), origin VARCHAR(24),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE);
  `);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  failMessagesAt = -1;
  messageWrites = 0;
  await db.exec('DELETE FROM chat_messages; DELETE FROM chat_sessions');
  configure(true);
});

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5);
const conv = (id: string, n = 2) => ({
  external_id: id, title: 'Old chat', created_at: T0, updated_at: T0 + 60_000,
  messages: Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}`, timestamp: T0 + i * 1000 })),
});
const req = (conversations: any[], userId = 'u1'): ImportRequest => ({
  userId, appId: 'tangu', source: 'deepseek', modelId: 'm1', projectless: true,
  agentConfig: { agentSlug: 'deepseek' }, conversations,
});
const count = async (table: string) => (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;

describe('importConversations on Postgres with the chat_messages → chat_sessions foreign key', () => {
  it('negative control: without a host transaction, messages-before-session is rejected by the foreign key', async () => {
    configure(false);
    const [r] = await importConversations(req([conv('c1')]));
    expect(r.status).toBe('error');
    expect((r as any).error).toMatch(/foreign key/);
    expect(await count('chat_sessions')).toBe(0);
  });

  it('with the host transaction, a conversation imports and can be continued', async () => {
    const [r] = await importConversations(req([conv('c1')]));
    expect(r).toMatchObject({ status: 'created', messages: 2, session_id: importedSessionId('u1', 'tangu', 'deepseek', 'c1') });
    const s = (await db.query<any>('SELECT user_id, title, title_manual, projectless, agent_config FROM chat_sessions')).rows[0];
    expect(s).toMatchObject({ user_id: 'u1', title: 'Old chat', title_manual: true, projectless: true });
    expect(s.agent_config.imported).toEqual({ source: 'deepseek', id: 'c1' });
    const msgs = (await db.query<any>('SELECT role, content, origin, agent_slug FROM chat_messages ORDER BY timestamp')).rows;
    expect(msgs).toEqual([
      { role: 'user', content: 'm0', origin: 'import', agent_slug: null },
      { role: 'assistant', content: 'm1', origin: 'import', agent_slug: 'deepseek' },
    ]);
    const [again] = await importConversations(req([conv('c1')]));
    expect(again).toMatchObject({ status: 'exists' });
    expect(await count('chat_messages')).toBe(2);
  });

  it('a write that dies halfway rolls back the whole conversation (no visible session), and a retry completes it', async () => {
    failMessagesAt = 1; // 250 条:第一块写进去,第二块失败
    const [r] = await importConversations(req([conv('half', 250)]));
    expect(r).toMatchObject({ status: 'error', error: 'disk full' });
    expect(await count('chat_sessions')).toBe(0);
    expect(await count('chat_messages')).toBe(0);
    failMessagesAt = -1;
    const [again] = await importConversations(req([conv('half', 250)]));
    expect(again).toMatchObject({ status: 'created', messages: 250 });
    expect(await count('chat_messages')).toBe(250);
  });

  it('one failing conversation does not take down the rest of the batch', async () => {
    failMessagesAt = 1; // c-a 写第一块就成功;c-big 第二块失败;c-b 之后照写
    const out = await importConversations(req([conv('c-a'), conv('c-big', 250), conv('c-b')]));
    expect(out.map((r) => r.status)).toEqual(['created', 'error', 'created']);
    expect(await count('chat_sessions')).toBe(2);
  });

  it('concurrent imports of the same conversation: one creates it, the other reports exists, no duplicate rows', async () => {
    // 两份内容不同(消息 id 不同):输的那一份若还往里写,会多出两条 —— 相同输入会被消息表的 DO NOTHING 吞掉、测不出来
    const other = { ...conv('race'), messages: conv('race').messages.map((m) => ({ ...m, content: `${m.content}-other` })) };
    const [[a], [b]] = await Promise.all([importConversations(req([conv('race')])), importConversations(req([other]))]);
    expect([a.status, b.status].sort()).toEqual(['created', 'exists']);
    expect(await count('chat_sessions')).toBe(1);
    const contents = (await db.query<any>('SELECT content FROM chat_messages ORDER BY timestamp')).rows.map((r) => r.content);
    expect(contents).toEqual(a.status === 'created' ? ['m0', 'm1'] : ['m0-other', 'm1-other']);
  });

  it('orphan leftovers from an earlier non-transactional run survive a failed retry with different content', async () => {
    // 老宿主(没有事务、表上也没外键)留下的半截导入:在这里用一张无外键的临时消息形状模拟 —— 先关外键检查插孤儿行
    const sid = importedSessionId('u1', 'tangu', 'deepseek', 'orphan');
    await db.exec(`SET session_replication_role = replica`);
    await db.query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp, origin) VALUES ('left-1', $1, 'user', 'old', 1, 'import')`, [sid]);
    await db.exec(`SET session_replication_role = DEFAULT`);
    failMessagesAt = 0; // 新内容的第一块就失败
    const [r] = await importConversations(req([conv('orphan')]));
    expect(r.status).toBe('error');
    expect(await count('chat_messages')).toBe(1); // 清残留与失败的写同一事务,一起回滚
    failMessagesAt = -1;
    const [ok] = await importConversations(req([conv('orphan')]));
    expect(ok).toMatchObject({ status: 'created', messages: 2 });
    const rows = (await db.query<any>('SELECT id, content FROM chat_messages WHERE session_id = $1 ORDER BY timestamp', [sid])).rows;
    expect(rows.map((x) => x.content)).toEqual(['m0', 'm1']); // 换了内容的残留被清掉,没混进来
  });

  it('the same external id from another user lands in a separate session', async () => {
    const [mine] = await importConversations(req([conv('shared')], 'u1'));
    const [theirs] = await importConversations(req([conv('shared')], 'u2'));
    expect(theirs.status).toBe('created');
    expect((theirs as any).session_id).not.toBe((mine as any).session_id);
  });
});
