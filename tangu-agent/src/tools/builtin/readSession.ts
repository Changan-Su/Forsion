/**
 * read_session —— 按 id 读**另一个会话**的对话记录。
 *
 * 由来:桌面工作区侧栏可以把一条会话拖进聊天,落成 `[[session:<id>|标题]]` 引用。
 * 没有这个工具时那只是给人看的书签,agent 读不到内容;有了它,引用才真的是引用。
 *
 * 运行时边界是 user + app + Agent。管理界面的会话浏览由 routes 独立提供。
 * 数据经 deps().state.readSessionTranscript(SQL 在 services/sessionSearchSql.ts;thin worker 经网关代查)——
 * 本文件只剩入参整形与输出措辞,不再直连 core/db.js(否则云端 Web / 移动端整体抛错)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { deps } from '../../seams/runtime.js';
import { sessionToolScope } from '../../services/sessionSearch.js';

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
            "Read the transcript of ANOTHER chat session belonging to this Agent and the current user, by its id. "
            + "When the user's message contains a reference like `[[session:<id>|title]]`, that is a pointer to a past "
            + 'conversation — call this tool with that id to actually see what was said there, instead of guessing from the title. '
            + 'Returns the session title plus messages oldest-first, one per line, with long bodies truncated. '
            + 'Other Agents\' sessions are inaccessible, including when their ids are supplied. '
            + 'If the user refers to a past conversation WITHOUT giving a link or id, find it first with `search_sessions`.',
          parameters: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session id, e.g. the `<id>` inside a `[[session:<id>|title]]` reference' },
              limit: { type: 'number', description: 'Max messages returned, newest kept (default 60, max 300)' },
              chars_per_message: { type: 'number', description: 'Truncate each message body to this many chars (default 600, max 4000)' },
              message_id: { type: 'string', description: 'Read exactly this message from a search hit; it must belong to the requested session.' },
              char_offset: { type: 'number', description: 'Character offset within each message body (default 0, max 1000000); use to read beyond a truncated excerpt.' },
              before_message_id: { type: 'string', description: 'Page older messages before this message id in the same session.' },
            },
            required: ['session_id'],
          },
        },
      },
      execute: async (args, ctx) => {
        const sid = String(args.session_id || '').trim();
        if (!sid) return 'read_session: session_id is required.';
        // floor:小数会被原样内插进 SQL 的 LIMIT / 传给 slice,先取整
        const limit = Math.min(Math.max(1, Math.floor(Number(args.limit) || 60)), 300);
        const perMsg = Math.min(Math.max(80, Math.floor(Number(args.chars_per_message) || 600)), 4000);
        const charOffset = Math.min(1_000_000, Math.max(0, Math.floor(Number(args.char_offset) || 0)));
        const messageId = String(args.message_id || '').trim();
        const beforeId = String(args.before_message_id || '').trim();
        const toolScope = sessionToolScope(ctx.agentSlug);
        ctx.signal?.throwIfAborted();

        if (sid === ctx.sessionId) return 'read_session: that is the current session — its history is already in context.';
        const transcript = await deps().state.readSessionTranscript({
          sessionId: sid, userId: ctx.userId, appId: ctx.appId, toolScope,
          limit, perMessageChars: perMsg, charOffset,
          messageId: messageId || undefined, beforeMessageId: beforeId || undefined, signal: ctx.signal,
        });
        ctx.signal?.throwIfAborted();
        if (!transcript.session) return `read_session: no session ${sid} (it may belong to someone else, or have been deleted).`;
        if (transcript.anchorMissing) return 'read_session: message not found in this session.';
        // 取最近 limit 条(DESC + LIMIT),再翻回时间正序展示。
        const rows = transcript.rows.slice().reverse();
        if (messageId && !rows.length) return 'read_session: message not found in this session.';
        const title = transcript.session.title || '(untitled)';
        // Historian 摘要放头部:引用消费的第一跳先看摘要,再决定要不要细读逐条消息。
        const summary = String(transcript.session.summary || '').trim();
        const summaryLine = summary ? `\nSummary: ${summary}` : '';
        if (!rows.length) return `Session "${title}" (${sid}) has no messages.${summaryLine}`;
        const head = `Session "${title}" (${sid}) — ${rows.length} message(s), oldest first${rows.length >= limit ? ' (truncated to the most recent)' : ''}:`;
        const lines: string[] = [];
        let chars = head.length + summaryLine.length;
        for (const row of rows) {
          const line = `[message_id=${row.id}; timestamp=${row.timestamp}; char_offset=${charOffset}] ${formatSessionRow(row, perMsg)}`;
          if (chars + line.length > 24_000) { lines.push('[Output budget reached; use message_id or before_message_id to continue.]'); break; }
          lines.push(line); chars += line.length + 1;
        }
        return `${head}${summaryLine}\n${lines.join('\n')}`;
      },
    },
  ],
};
