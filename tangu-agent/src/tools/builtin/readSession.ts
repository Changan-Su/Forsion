/**
 * read_session —— 按 id 读**另一个会话**的对话记录。
 *
 * 由来:桌面工作区侧栏可以把一条会话拖进聊天,落成 `[[session:<id>|标题]]` 引用。
 * 没有这个工具时那只是给人看的书签,agent 读不到内容;有了它,引用才真的是引用。
 *
 * 归属边界:**只按 (user_id, app_id) 取会话**,拿不到别人的。云端多租户同一张表,
 * 这条 WHERE 是唯一的隔离,别改成只按 session_id 查。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { query } from '../../core/db.js';

/** 一条消息压成一行(工具调用只留名字;正文按 perMsg 截断)。
 *  ⚠️助手消息在库里 role='model'(不是 'assistant'),这里归一化,免得模型把它当成用户发言。 */
export function formatSessionRow(
  row: { role: string; content: string | null; tool_calls: unknown },
  perMsg: number,
): string {
  const role = row.role === 'model' ? 'assistant' : row.role;
  const body = String(row.content ?? '').replace(/\s+/g, ' ').trim();
  let calls: string[] = [];
  try {
    const tc = typeof row.tool_calls === 'string' ? JSON.parse(row.tool_calls) : row.tool_calls;
    if (Array.isArray(tc)) calls = tc.map((c: any) => String(c?.function?.name || c?.name || '')).filter(Boolean);
  } catch { /* 坏 JSON:当没有工具调用 */ }
  const text = body.length > perMsg ? body.slice(0, perMsg) + '…' : body;
  const tail = calls.length ? ` [tools: ${calls.join(', ')}]` : '';
  // 正文与工具调用都空的行(纯 tool 结果占位)照样输出角色,免得轮次对不上。
  return `${role}: ${text}${tail}`;
}

export const readSessionProvider: ToolProvider = {
  id: 'builtin:read_session',
  tools: () => [
    {
      name: 'read_session',
      mode: 'both',
      capabilities: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 15_000 },
      definition: {
        type: 'function',
        function: {
          name: 'read_session',
          description:
            "Read the transcript of ANOTHER chat session of the same user, by its id. "
            + "When the user's message contains a reference like `[[session:<id>|title]]`, that is a pointer to a past "
            + 'conversation — call this tool with that id to actually see what was said there, instead of guessing from the title. '
            + 'Returns the session title plus messages oldest-first, one per line, with long bodies truncated. '
            + 'Only the current user\'s own sessions are reachable.',
          parameters: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session id, e.g. the `<id>` inside a `[[session:<id>|title]]` reference' },
              limit: { type: 'number', description: 'Max messages returned, newest kept (default 60, max 300)' },
              chars_per_message: { type: 'number', description: 'Truncate each message body to this many chars (default 600, max 4000)' },
            },
            required: ['session_id'],
          },
        },
      },
      execute: async (args, ctx) => {
        const sid = String(args.session_id || '').trim();
        if (!sid) return 'read_session: session_id is required.';
        const limit = Math.min(Math.max(1, Number(args.limit) || 60), 300);
        const perMsg = Math.min(Math.max(80, Number(args.chars_per_message) || 600), 4000);

        if (sid === ctx.sessionId) return 'read_session: that is the current session — its history is already in context.';
        const sess = await query<any[]>(
          `SELECT id, title FROM chat_sessions WHERE id = ? AND user_id = ? AND app_id = ?`,
          [sid, ctx.userId, ctx.appId],
        );
        if (!sess.length) return `read_session: no session ${sid} (it may belong to someone else, or have been deleted).`;

        // 取最近 limit 条(DESC + LIMIT),再翻回时间正序展示。
        // limit 已 clamp 成 1..300 的整数,内联进 SQL(LIMIT 占位符不是所有后端都吃)。
        const rows = (await query<any[]>(
          `SELECT role, content, tool_calls FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ${limit}`,
          [sid],
        )).slice().reverse();
        const title = sess[0].title || '(untitled)';
        if (!rows.length) return `Session "${title}" (${sid}) has no messages.`;
        const head = `Session "${title}" (${sid}) — ${rows.length} message(s), oldest first${rows.length >= limit ? ' (truncated to the most recent)' : ''}:`;
        return `${head}\n${rows.map((r: any) => formatSessionRow(r, perMsg)).join('\n')}`;
      },
    },
  ],
};
