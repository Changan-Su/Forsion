/**
 * TUI 消息编辑/删除的数据操作（直连 query，与 /branch 同款；不扩 StateStore 接缝——那要连带改 httpStateStore，
 * 而消息编辑/删除本就是 standalone/TUI 的宿主功能）。抽成模块以便真 sqlite 单测。
 */
import { query } from '../core/db.js';

/** 最近一条 user 消息内容（无则 null）。供 /edit 取初值。 */
export async function getLastUserMessageContent(sessionId: string): Promise<string | null> {
  const rows = await query<any[]>(
    `SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY timestamp DESC LIMIT 1`,
    [sessionId],
  );
  return rows.length ? String(rows[0].content ?? '') : null;
}

/**
 * 删最近一轮 = 删最后一条 user 消息**及其之后的全部回复**（按 timestamp >=）。返回被删的 user 内容（无则 null）。
 * 供 /delete 直接用、/edit 删旧后重发用。
 */
export async function deleteLastExchange(sessionId: string): Promise<string | null> {
  const rows = await query<any[]>(
    `SELECT content, timestamp FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY timestamp DESC LIMIT 1`,
    [sessionId],
  );
  if (!rows.length) return null;
  await query(`DELETE FROM chat_messages WHERE session_id = ? AND timestamp >= ?`, [sessionId, rows[0].timestamp]);
  return String(rows[0].content ?? '');
}
