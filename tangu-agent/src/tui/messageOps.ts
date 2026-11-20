/**
 * TUI 消息编辑/删除的数据操作（直连 query，与 /branch 同款；不扩 StateStore 接缝——那要连带改 httpStateStore，
 * 而消息编辑/删除本就是 standalone/TUI 的宿主功能）。抽成模块以便真 sqlite 单测。
 */
import { getDbType, messageTimeOrder, query } from '../core/db.js';
import { bumpHistoryRevision } from '../services/historyRevision.js';
import type { TranscriptItem } from './types.js';

// 引擎落库的机器行(role 也是 user,但不是人说的话):打断标记、续跑、审批 / 提问回执、子会话通报、跨会话来信。
// 与 desktop chat2/canvasTree.ts 的 MACHINE 同一份名单;/edit 把它当「最后一句」会把标记原文塞进编辑框。
const MACHINE_USER_ROW = /^<(?:(?:turn_interrupted|turn_resume|approval_update|inquiry_update|child_sessions_update)>|session_message )/;

/** 最后一条人说的 user 消息。同一毫秒落库的几行按落库先后认最新(SQLite 带 rowid,#762 同类);/edit 读和删认同一条。 */
async function lastUserRow(sessionId: string): Promise<{ content: string; timestamp: number; rowid?: number } | null> {
  const sqlite = getDbType() === 'sqlite';
  // 一次多取几条:末尾可能是连着的机器行(打断标记后面又有审批回执之类)
  const rows = await query<any[]>(
    `SELECT content, timestamp${sqlite ? ', rowid AS rid' : ''} FROM chat_messages WHERE session_id = ? AND role = 'user'
     ORDER BY ${messageTimeOrder('DESC')} LIMIT 50`,
    [sessionId],
  );
  const r = rows.find((x) => !MACHINE_USER_ROW.test(String(x.content ?? '')));
  if (!r) return null;
  return { content: String(r.content ?? ''), timestamp: Number(r.timestamp), ...(sqlite ? { rowid: Number(r.rid) } : {}) };
}

/** 最近一条 user 消息内容（无则 null）。供 /edit 取初值。 */
export async function getLastUserMessageContent(sessionId: string): Promise<string | null> {
  return (await lastUserRow(sessionId))?.content ?? null;
}

/**
 * 删最近一轮 = 删最后一条 user 消息**及其之后落库的全部行**。返回被删的 user 内容（无则 null）。
 * 供 /delete 直接用、/edit 删旧后重发用。
 * 边界:SQLite 上按 (timestamp, rowid) 切 —— 只按 timestamp >= 切时,同一毫秒里先落库的行(另一条插话、上一轮的回答)会被连带删掉。
 * PG 没有 rowid,保持 timestamp >=(与 #762 同口径,PG 先不动)。
 */
export async function deleteLastExchange(sessionId: string): Promise<string | null> {
  const row = await lastUserRow(sessionId);
  if (!row) return null;
  if (row.rowid !== undefined) {
    await query(
      `DELETE FROM chat_messages WHERE session_id = ? AND (timestamp > ? OR (timestamp = ? AND rowid >= ?))`,
      [sessionId, row.timestamp, row.timestamp, row.rowid],
    );
  } else {
    await query(`DELETE FROM chat_messages WHERE session_id = ? AND timestamp >= ?`, [sessionId, row.timestamp]);
  }
  bumpHistoryRevision(sessionId); // 在飞的后台摘要落库前复核版本 → 基于已删消息的结果作废
  return row.content;
}

/**
 * 会话 → Markdown（/export 用）。只导出对话本身：用户消息、助手正文、工具调用一行摘要；
 * 思考内容与 notice 不导出（前者可能含未定稿推理，后者是 TUI 自己的提示，都不属于对话记录）。
 */
export function renderSessionMarkdown(items: TranscriptItem[], model: string): string {
  const lines: string[] = ['# Tangu 会话记录', '', `模型：${model || '(未设置)'}`, ''];
  for (const it of items) {
    if (it.kind === 'user') {
      lines.push('## 我', '', it.text.trim(), '');
    } else if (it.kind === 'assistant') {
      lines.push('## Tangu', '');
      for (const b of it.blocks) {
        if (b.type === 'text' && b.text.trim()) lines.push(b.text.trim(), '');
        else if (b.type === 'tool') lines.push(`> 🔧 \`${b.name}\`${b.isError ? '（失败）' : ''}`, '');
      }
    }
  }
  return lines.join('\n');
}
