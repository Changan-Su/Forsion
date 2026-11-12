import { query } from '../core/db.js';

/** Monotonic watermark. The update itself checks for newer messages, including arrivals
 * between the caller's message lookup and this write. Works on SQLite and PostgreSQL. */
export async function acknowledgeSessionRead(sessionId: string, through: number): Promise<{ unread: boolean; awaiting: boolean }> {
  await query(`UPDATE chat_sessions SET
    last_read_at = CASE WHEN COALESCE(last_read_at, 0) > ? THEN last_read_at ELSE ? END,
    awaiting_user = CASE WHEN report_run_id IS NULL
      AND COALESCE(proactive_at, 0) <= ?
      AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = chat_sessions.id AND m.timestamp > ?)
      THEN FALSE ELSE awaiting_user END
    WHERE id = ?`, [through, through, through, through, sessionId]);
  const [row] = await query<any[]>(`SELECT proactive_at, last_read_at, awaiting_user FROM chat_sessions WHERE id = ?`, [sessionId]);
  return { unread: Number(row?.proactive_at || 0) > Number(row?.last_read_at || 0), awaiting: !!row?.awaiting_user };
}
