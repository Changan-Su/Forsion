/**
 * TUI 消息编辑/删除的数据操作（直连 query，与 /branch 同款；不扩 StateStore 接缝——那要连带改 httpStateStore，
 * 而消息编辑/删除本就是 standalone/TUI 的宿主功能）。抽成模块以便真 sqlite 单测。
 */
import { query } from '../core/db.js';
import type { TranscriptItem } from './types.js';

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
