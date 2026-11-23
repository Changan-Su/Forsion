import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { endsWithQuestion } from './childSessions.js';

/** Caller holds the active Solo lock, including across a concurrent rotation. */
export async function appendProactiveMessage(input: {
  sessionId: string; agentSlug: string; content: string; origin: string; ask: boolean;
}): Promise<{ sessionId: string; messageId: string }> {
  const { sessionId, agentSlug, content, origin, ask } = input;
  const clockSql = `SELECT proactive_at, last_read_at,
    (SELECT MAX(timestamp) FROM chat_messages WHERE session_id = ?) AS latest
    FROM chat_sessions WHERE id = ?`;
  const insertSql = `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error, agent_slug, origin)
      VALUES (?, ?, 'model', ?, ?, NULL, FALSE, ?, ?)`;
  const updateSql = `UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP, proactive_at = ?${ask ? ', awaiting_user = TRUE' : ''} WHERE id = ?`;
  const messageId = uuidv4();
  const timeAfter = (clock: any): number => Math.max(
    Date.now(), Number(clock?.latest || 0) + 1, Number(clock?.proactive_at || 0) + 1, Number(clock?.last_read_at || 0) + 1,
  );
  const host = deps().host;
  if (host.transactionSync) {
    host.transactionSync((run) => {
      const at = timeAfter(run(clockSql, [sessionId, sessionId])[0]);
      run(insertSql, [messageId, sessionId, content, at, agentSlug, origin]);
      run(updateSql, [at, sessionId]);
    });
  } else {
    const [clock] = await query<any[]>(clockSql, [sessionId, sessionId]);
    const at = timeAfter(clock);
    await query(insertSql, [messageId, sessionId, content, at, agentSlug, origin]);
    await query(updateSql, [at, sessionId]);
  }
  return { sessionId, messageId };
}

/** A trailing short sentence after a question still counts as awaiting a reply. */
export function asksUser(text: string): boolean {
  return endsWithQuestion(text) || /[?？][^?？]{1,40}$/.test(text.trim());
}
