import { query } from '../core/db.js';
import { normalizeSessionEmoji } from '../core/sessionEmoji.js';

/** Fill only an unset icon. The SQL guard preserves a manual edit made while the model was running. */
export async function applyHistorianEmoji(sessionId: string, userId: string, value: unknown): Promise<string | null> {
  const emoji = normalizeSessionEmoji(value);
  if (!emoji) return null;
  const rows = await query<any[]>(
    "UPDATE chat_sessions SET emoji = ? WHERE id = ? AND user_id = ? AND COALESCE(emoji, '') = '' RETURNING id",
    [emoji, sessionId, userId],
  );
  return rows.length ? emoji : null;
}
