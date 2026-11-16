import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ db: null as any, failAfterChunks: -1, chunks: 0 }));
vi.mock('../core/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { STANDALONE_SCHEMA } = await import('../db/schemaStandalone.js');
  h.db = new Database(':memory:');
  h.db.exec(STANDALONE_SCHEMA);
  return {
    getDbType: () => 'sqlite',
    // 同宿主的 sqlite 适配:布尔按 0/1 绑定
    query: async (sql: string, params: any[] = []) => {
      if (/INSERT INTO chat_messages/.test(sql) && h.failAfterChunks >= 0 && h.chunks++ >= h.failAfterChunks) throw new Error('disk full');
      const s = h.db.prepare(sql);
      const p = params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
      return s.reader ? s.all(...p) : (s.run(...p), []);
    },
  };
});

import { importConversations, importedSessionId, settleTimestamps, validateImportBody, type ImportRequest } from './sessionImport.js';

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5);
const conv = (id: string, extra: Record<string, unknown> = {}) => ({
  external_id: id,
  title: 'Old chat',
  created_at: T0,
  updated_at: T0 + 60_000,
  messages: [
    { role: 'user' as const, content: 'hello', timestamp: T0 },
    { role: 'assistant' as const, content: 'hi there', reasoning: 'greet back', timestamp: T0 + 5_000, model_id: 'deepseek-chat' },
  ],
  ...extra,
});
const req = (conversations: any[]): ImportRequest => ({
  userId: 'u1', appId: 'tangu', source: 'deepseek', modelId: 'm1', projectless: true,
  agentConfig: { agentSlug: 'deepseek', preset: 'chat', execMode: 'sandbox' }, conversations,
});

beforeEach(() => {
  h.failAfterChunks = -1;
  h.chunks = 0;
  h.db.exec('DELETE FROM chat_sessions; DELETE FROM chat_messages');
});

describe('importConversations', () => {
  it('writes a continuable session with original times, no unread, manual title and an import stamp', async () => {
    const [r] = await importConversations(req([conv('c1')]));
    expect(r).toMatchObject({ status: 'created', messages: 2 });
    const s = h.db.prepare('SELECT * FROM chat_sessions').get();
    expect(s.id).toBe(importedSessionId('u1', 'tangu', 'deepseek', 'c1'));
    expect(s.title).toBe('Old chat');
    expect(s.title_manual).toBe(1);
    expect(s.kind).toBe('user');
    expect(s.projectless).toBe(1);
    expect(s.proactive_at).toBeNull();
    expect(s.created_at).toBe('2026-01-02 03:04:05');
    expect(s.updated_at).toBe('2026-01-02 03:05:05');
    expect(JSON.parse(s.agent_config)).toEqual({ agentSlug: 'deepseek', preset: 'chat', execMode: 'sandbox', imported: { source: 'deepseek', id: 'c1' } });
    const msgs = h.db.prepare('SELECT role, content, reasoning, timestamp, model_id, agent_slug, origin FROM chat_messages ORDER BY timestamp').all();
    expect(msgs).toEqual([
      { role: 'user', content: 'hello', reasoning: null, timestamp: T0, model_id: null, agent_slug: null, origin: 'import' },
      { role: 'assistant', content: 'hi there', reasoning: 'greet back', timestamp: T0 + 5_000, model_id: 'deepseek-chat', agent_slug: 'deepseek', origin: 'import' },
    ]);
  });

  it('appends, never overwrites: the same conversation again is reported as exists and left untouched', async () => {
    await importConversations(req([conv('c1')]));
    h.db.prepare("INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('later', ?, 'user', 'continued here', ?)").run(importedSessionId('u1', 'tangu', 'deepseek', 'c1'), Date.now());
    const [r] = await importConversations(req([conv('c1', { title: 'Renamed upstream' })]));
    expect(r.status).toBe('exists');
    expect(h.db.prepare('SELECT title FROM chat_sessions').get().title).toBe('Old chat');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n).toBe(3);
  });

  it('ids are per user and per source', () => {
    const a = importedSessionId('u1', 'tangu', 'deepseek', 'c1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(importedSessionId('u2', 'tangu', 'deepseek', 'c1')).not.toBe(a);
    expect(importedSessionId('u1', 'tangu', 'chatgpt', 'c1')).not.toBe(a);
  });

  it('a write that dies halfway leaves no visible session, and importing again completes it without duplicates', async () => {
    const messages = Array.from({ length: 150 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` }));
    h.failAfterChunks = 1 // 第一块(100 条)写进去,第二块失败
    const [r] = await importConversations(req([{ external_id: 'half', messages }]))
    expect(r).toMatchObject({ status: 'error', error: 'disk full' })
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get().n).toBe(0)
    h.failAfterChunks = -1
    const [again] = await importConversations(req([{ external_id: 'half', messages }]))
    expect(again).toMatchObject({ status: 'created', messages: 150 })
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n).toBe(150)
  })

  it('never deletes messages on failure (a concurrent writer could own them)', async () => {
    const sid = importedSessionId('u1', 'tangu', 'deepseek', 'c1')
    h.db.prepare("INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('someone-else', ?, 'user', 'x', 1)").run(sid)
    h.failAfterChunks = 0
    await importConversations(req([conv('c1')]))
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE id = 'someone-else'").get().n).toBe(1)
  })

  it('a retry with different content replaces the leftovers instead of mixing them in', async () => {
    const a = Array.from({ length: 150 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `old${i}` }))
    h.failAfterChunks = 1
    await importConversations(req([{ external_id: 'v', created_at: T0, messages: a }]))
    h.failAfterChunks = -1
    const b = Array.from({ length: 80 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `new${i}` }))
    const [r] = await importConversations(req([{ external_id: 'v', created_at: T0, messages: b }]))
    expect(r).toMatchObject({ status: 'created', messages: 80 })
    const rows = h.db.prepare('SELECT content FROM chat_messages ORDER BY timestamp').all().map((x: any) => x.content)
    expect(rows).toEqual(b.map((m) => m.content))
  })

  it('long chats are inserted in chunks', async () => {
    const messages = Array.from({ length: 250 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const [r] = await importConversations(req([{ external_id: 'long', messages }]));
    expect(r).toMatchObject({ status: 'created', messages: 250 });
    const ts = h.db.prepare('SELECT timestamp FROM chat_messages ORDER BY rowid').all().map((x: any) => x.timestamp);
    expect(ts.every((t: number, i: number) => i === 0 || t > ts[i - 1])).toBe(true);
    // 没标题 → 取第一句用户话
    expect(h.db.prepare('SELECT title FROM chat_sessions').get().title).toBe('m0');
  });
});

describe('settleTimestamps', () => {
  it('fills gaps after the previous message and keeps order strictly increasing', () => {
    const out = settleTimestamps({ external_id: 'x', created_at: T0, messages: [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b', timestamp: T0 - 10 }, { role: 'user', content: 'c', timestamp: T0 + 9000 },
    ] });
    expect(out).toEqual([T0, T0 + 1, T0 + 9000]);
  });
  it('with only an update time, history ends at that time instead of running past it', () => {
    const now = Date.now();
    const out = settleTimestamps({ external_id: 'x', updated_at: now, messages: Array.from({ length: 150 }, () => ({ role: 'user' as const, content: 'a' })) }, now);
    expect(out[out.length - 1]).toBe(now);
  });
  it('a start close to now with many untimed messages is pulled back so nothing lands in the future', () => {
    const now = Date.now();
    const out = settleTimestamps({ external_id: 'x', created_at: now - 10_000, updated_at: now, messages: Array.from({ length: 150 }, () => ({ role: 'user' as const, content: 'a' })) }, now);
    expect(out[out.length - 1]).toBeLessThanOrEqual(now);
    expect(out.every((t, i) => i === 0 || t > out[i - 1])).toBe(true);
  });
  it('a chat with no times at all ends no later than now (never in the future)', () => {
    const now = Date.now();
    const out = settleTimestamps({ external_id: 'x', messages: Array.from({ length: 101 }, () => ({ role: 'user' as const, content: 'a' })) }, now);
    expect(out[out.length - 1]).toBeLessThanOrEqual(now);
    expect(out.every((t, i) => i === 0 || t > out[i - 1])).toBe(true);
  });
});

describe('validateImportBody', () => {
  it('accepts a normal batch', () => expect(validateImportBody('deepseek', [conv('a')])).toBeNull());
  it('rejects bad sources, empty chats, unknown roles, second-precision times and duplicates', () => {
    expect(validateImportBody('Deep Seek', [conv('a')])).toMatch(/source/);
    expect(validateImportBody('deepseek', [{ external_id: 'a', messages: [] }])).toMatch(/at least one message/);
    expect(validateImportBody('deepseek', [{ external_id: 'a', messages: [{ role: 'system', content: 'x' }] }])).toMatch(/role/);
    expect(validateImportBody('deepseek', [conv('a', { created_at: 1_735_000_000 })])).toMatch(/created_at/);
    expect(validateImportBody('deepseek', [conv('a'), conv('a')])).toMatch(/duplicate/);
    expect(validateImportBody('deepseek', [])).toMatch(/non-empty/);
  });
});
