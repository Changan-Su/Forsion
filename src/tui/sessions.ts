/** /sessions 与 /resume 的数据层：查嵌入式库的 chat_sessions / chat_messages（跨重启持久）。 */
import { query } from '../core/db.js';
import type { TranscriptItem, Block } from './types.js';

export interface SessionRow {
  id: string;
  title: string;
  modelId: string | null;
  updatedAt: string | number | null;
}

/** 列出该用户在 tangu app 下最近的会话（供 /sessions 选择恢复）。 */
export async function listSessions(userId: string, limit = 20): Promise<SessionRow[]> {
  const rows = await query<any[]>(
    `SELECT id, title, model_id, updated_at FROM chat_sessions
     WHERE user_id = ? AND app_id = 'tangu'
     ORDER BY updated_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({ id: r.id, title: r.title || '(未命名)', modelId: r.model_id, updatedAt: r.updated_at }));
}

/**
 * 加载某会话历史为 transcript 项（供 /resume 回放）。assistant 行的工具调用/结果在恢复时
 * 折叠为简短工具块；正文走 markdown 渲染。id 从 startId 起递增，返回新 nextId。
 */
export async function loadSessionItems(
  sessionId: string,
  startId: number,
): Promise<{ items: TranscriptItem[]; nextId: number }> {
  const rows = await query<any[]>(
    `SELECT role, content, tool_calls, tool_results FROM chat_messages
     WHERE session_id = ? ORDER BY timestamp ASC LIMIT 200`,
    [sessionId],
  );
  const items: TranscriptItem[] = [];
  let id = startId;
  for (const r of rows) {
    const role = r.role === 'model' ? 'assistant' : r.role;
    const content = typeof r.content === 'string' ? r.content : '';
    if (role === 'user') {
      if (!content.trim()) continue;
      items.push({ id: id++, kind: 'user', text: content });
    } else if (role === 'assistant') {
      const blocks: Block[] = [];
      if (content.trim()) blocks.push({ type: 'text', text: content });
      const toolCalls = parseJson(r.tool_calls);
      const toolResults = parseJson(r.tool_results);
      if (Array.isArray(toolCalls)) {
        for (const c of toolCalls) {
          const name = c?.function?.name || c?.name || 'tool';
          const args = c?.function?.arguments || '';
          const res = Array.isArray(toolResults)
            ? toolResults.find((t: any) => t.tool_call_id === c.id)
            : undefined;
          blocks.push({
            type: 'tool',
            id: c?.id || `${id}`,
            name,
            args,
            result: res?.content,
            isError: !!res?.isError,
            done: true,
          });
        }
      }
      if (blocks.length) items.push({ id: id++, kind: 'assistant', blocks });
    }
  }
  return { items, nextId: id };
}

function parseJson(v: any): any {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
