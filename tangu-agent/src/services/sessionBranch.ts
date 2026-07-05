/**
 * 会话分支(branch):从某条历史消息「之后」复制出一个新会话,继承到该点为止的全部对话。
 * 区别于 /new(空会话)——新会话即一个普通独立会话,已预填历史,可直接续聊走另一条方向。
 *
 * 同时供 HTTP 路由(routes/sessions.ts)与 TUI(tui/app.tsx)进程内调用——两者都走 core/db 的 query。
 * SQLite(standalone)/Postgres(microserver) 通吃。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';

/** JSON 列归一:对象→字符串、字符串原样、空→null。匹配既有 INSERT 风格(两后端都吃字符串)。 */
function asJsonText(v: any): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export interface BranchSessionInput {
  sourceSessionId: string;
  userId: string;
  appId: string;
  /** 分支点消息 id(含该点)——其 timestamp 及之前的消息会被继承。须属于源会话。 */
  messageId: string;
  /** 新会话标题;缺省取源会话标题。 */
  title?: string;
  /** 新会话 kind(缺省 'user');Historian 辅助讨论传 'discussion' → 不进用户会话列表。 */
  kind?: string;
  /** 只继承分支点前最近 N 条消息(缺省全量);后台讨论用轻量窗口,避免长会话整表复制。 */
  lastN?: number;
  /** Background Session 父链接:指回来源会话(右栏「子聊天」经 /background 端点持久列出)。缺省 null。 */
  parentSessionId?: string;
}

/**
 * 从 sourceSessionId 的 messageId(含)处分支出新会话。
 * 返回 { id, copied } 或 null(源会话不存在/非本人本 app,或 messageId 不属于该会话)。
 */
export async function branchSession(input: BranchSessionInput): Promise<{ id: string; copied: number } | null> {
  const { sourceSessionId, userId, appId, messageId, title, kind, lastN, parentSessionId } = input;

  // 1) 源会话 + owner/app 校验
  const srcRows = await query<any[]>(
    `SELECT id, user_id, app_id, title, model_id, emoji, agent_config, project_path, project_name
     FROM chat_sessions WHERE id = ? LIMIT 1`,
    [sourceSessionId],
  );
  const src = srcRows[0];
  if (!src || src.user_id !== userId || src.app_id !== appId) return null;

  // 2) 分支点时间戳(含该消息);消息须属于源会话
  const msgRows = await query<any[]>(
    `SELECT timestamp FROM chat_messages WHERE id = ? AND session_id = ? LIMIT 1`,
    [messageId, sourceSessionId],
  );
  if (!msgRows[0]) return null;
  const throughTs = Number(msgRows[0].timestamp);

  // 3) 建新会话:克隆模型/配置/工程信息(archived/todos 走默认,从干净状态起;kind 可指定,缺省 'user')
  const newId = uuidv4();
  const newTitle = (typeof title === 'string' && title.trim() ? title.trim() : (src.title || 'New Chat')).slice(0, 200);
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, emoji, agent_config, project_path, project_name, kind, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId, userId, appId, newTitle, src.model_id, src.emoji,
     asJsonText(src.agent_config), src.project_path, src.project_name, kind || 'user', parentSessionId || null],
  );

  // 4) 复制 timestamp <= 分支点 的消息:新 uuid,保留原 timestamp 与全部字段(lastN → 只取最近 N 条)
  const msgs = lastN && lastN > 0
    ? (await query<any[]>(
        `SELECT role, content, timestamp, model_id, reasoning, is_error, tool_calls, tool_results, attachments
         FROM chat_messages WHERE session_id = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ?`,
        [sourceSessionId, throughTs, Math.floor(lastN)],
      )).reverse()
    : await query<any[]>(
        `SELECT role, content, timestamp, model_id, reasoning, is_error, tool_calls, tool_results, attachments
         FROM chat_messages WHERE session_id = ? AND timestamp <= ? ORDER BY timestamp ASC`,
        [sourceSessionId, throughTs],
      );
  // ponytail: 逐行插入。分支是一次性操作(非热路径),量大再批量;与既有删除级联一样不开显式事务。
  for (const m of msgs) {
    await query(
      `INSERT INTO chat_messages
         (id, session_id, role, content, timestamp, model_id, reasoning, is_error, tool_calls, tool_results, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), newId, m.role, m.content, m.timestamp, m.model_id, m.reasoning, m.is_error,
       asJsonText(m.tool_calls), asJsonText(m.tool_results), asJsonText(m.attachments)],
    );
  }

  return { id: newId, copied: msgs.length };
}
