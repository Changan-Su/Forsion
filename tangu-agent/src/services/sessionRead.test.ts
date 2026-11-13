import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({ db: null as any }));
vi.mock('../core/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  h.db = new Database(':memory:');
  h.db.exec('CREATE TABLE chat_sessions (id TEXT, proactive_at BIGINT, last_read_at BIGINT, awaiting_user INT, report_run_id TEXT); CREATE TABLE chat_messages (id TEXT, session_id TEXT, timestamp BIGINT)');
  return { query: async (sql: string, params: any[]) => { const s = h.db.prepare(sql); return s.reader ? s.all(...params) : (s.run(...params), []); } };
});
import { acknowledgeSessionRead } from './sessionRead.js';
beforeEach(() => {
  h.db.exec("DELETE FROM chat_sessions; DELETE FROM chat_messages; INSERT INTO chat_sessions VALUES ('s', 200, 0, 1, NULL); INSERT INTO chat_messages VALUES ('new', 's', 200)");
});
describe('bounded read receipt', () => {
  it('later arrival remains unread and waiting', async () => {
    expect(await acknowledgeSessionRead('s', 100)).toEqual({ unread: true, awaiting: true });
  });
  it('observed latest message clears unread and trailing question', async () => {
    expect(await acknowledgeSessionRead('s', 200)).toEqual({ unread: false, awaiting: false });
  });
  it('out-of-order receipts cannot move the watermark backwards', async () => {
    await acknowledgeSessionRead('s', 200);
    expect(await acknowledgeSessionRead('s', 100)).toEqual({ unread: false, awaiting: false });
    expect(h.db.prepare('SELECT last_read_at FROM chat_sessions').get().last_read_at).toBe(200);
  });
  it('newer ordinary reply keeps awaiting; other session does not interfere', async () => {
    h.db.exec("INSERT INTO chat_messages VALUES ('reply', 's', 300)");
    expect((await acknowledgeSessionRead('s', 200)).awaiting).toBe(true);
    h.db.exec("DELETE FROM chat_messages WHERE id='reply'; INSERT INTO chat_messages VALUES ('other', 'elsewhere', 400)");
    expect((await acknowledgeSessionRead('s', 200)).awaiting).toBe(false);
  });
  it('ordinary reply with equal or later timestamp cannot read an unseen proactive message', async () => {
    expect(await acknowledgeSessionRead('s', 200, false)).toEqual({ unread: true, awaiting: true });
    expect(await acknowledgeSessionRead('s', 300, false)).toEqual({ unread: true, awaiting: true });
  });
  it('pending child delivery keeps awaiting', async () => {
    h.db.exec("UPDATE chat_sessions SET report_run_id='run'");
    expect(await acknowledgeSessionRead('s', 200)).toEqual({ unread: false, awaiting: true });
  });
});
