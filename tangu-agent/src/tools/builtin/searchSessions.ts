/**
 * search_sessions —— 列出/检索用户的其他会话(过去的对话)。
 *
 * 由来:read_session 只认 id(设计初衷是消费 [[session:<id>|标题]] 引用)。真实会话
 * (2026-08-08 导出)证实两处断档:用户问「你能知道最近我们的对话吗」,模型先答「没有
 * 会话列表可翻」;被点醒后靠 6 次 run_bash 翻本地 state.db 拼凑列表——云端(PG)连这条
 * 野路都没有。本工具补上「找会话」这一跳:无 query=最近列表,带 query=按标题/摘要/正文
 * 检索。输出行用 [[session:<id>|标题]] 格式——既是 read_session 的入参,桌面聊天里又
 * 渲染成可点击的会话引用。
 *
 * **查询本体已抽到 services/sessionSearch.ts**(2026-08-17,桌面搜索面共用同一条 SQL:
 * 两边各写一份就会出现「界面搜得到、模型搜不到」)。归属边界、方言约束、LIMIT 按会话计等
 * 语义正典见那里;本文件只剩模型侧的措辞与行格式。
 */
import type { ToolProvider } from '../toolRegistry.js';
import {
  clip, dayArg, fmtDate, likePattern, searchSessions, snippetAround, splitTerms, tsDate,
  type SessionHit,
} from '../../services/sessionSearch.js';

// 纯函数面从服务层原样再导出:既有单测(searchSessions.test.ts)与其它 import 点不变。
export { splitTerms, likePattern, snippetAround, fmtDate, dayArg, tsDate };
export type { SessionHit };

/** 摘掉标题里会破坏 [[session:id|title]] 引用语法的字符(与桌面端 chatDragRef.safeLabel 同旨),
 *  并镜像桌面端标题 60 字上限。 */
function safeTitle(title: unknown): string {
  const t = String(title ?? '').replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return t || '(untitled)';
}

/** boolean 归一:PG 驱动给 true/false,sqlite 给 0/1。 */
function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

/** 一行一个会话:[[session:id|标题]] — 日期 [标记] — 摘要或命中片段。 */
export function formatHit(h: SessionHit): string {
  const tag = toBool(h.archived) ? ' [archived]' : '';
  const desc = h.match ?? clip(String(h.summary ?? ''), 150);
  return `- [[session:${h.id}|${safeTitle(h.title)}]] — ${fmtDate(h.updated_at)}${tag}${desc ? ` — ${desc}` : ''}`;
}

const FOOTER = 'Read a full transcript with `read_session` (pass the id).';

export const searchSessionsProvider: ToolProvider = {
  id: 'builtin:search_sessions',
  tools: () => [
    {
      name: 'search_sessions',
      mode: 'both',
      capabilities: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 15_000 },
      deferHint: "Find the user's past chat sessions by keyword or recency (then read one with read_session).",
      definition: {
        type: 'function',
        function: {
          name: 'search_sessions',
          description:
            "List or search the user's PAST chat sessions (their other conversations in this app; the current session is excluded — it is already in your context). "
            + 'Use it whenever the user refers to an earlier conversation ("last time", "that chat about X") or asks what has been discussed before. '
            + 'Without `query` it returns the most recent sessions; with `query` it keyword-searches session titles, summaries and message contents (space-separated terms, all must match — use distinctive content words like topics or project names, not meta-words like "yesterday" or "discussed"; put time anchors in `before`/`after` instead). '
            + 'Each result line is a `[[session:<id>|title]]` reference plus last-active date and a summary or matched snippet — pass the id to `read_session` to read the full transcript.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Keywords to search for (space-separated, matched against title/summary/message text). Omit to just list the most recent sessions.',
              },
              limit: { type: 'number', description: 'Max sessions returned (default 10, max 20)' },
              before: {
                type: 'string',
                description: 'Only sessions last active BEFORE this date, exclusive (YYYY-MM-DD, UTC). Also the pagination cursor: pass the oldest date from the previous result to get older sessions.',
              },
              after: { type: 'string', description: 'Only sessions last active ON or AFTER this date (YYYY-MM-DD, UTC).' },
            },
            required: [],
          },
        },
      },
      execute: async (args, ctx) => {
        // floor:小数会被原样内插进 SQL 的 LIMIT,两方言都直接炸
        const limit = Math.min(Math.max(1, Math.floor(Number(args.limit) || 10)), 20);
        const terms = splitTerms(String(args.query ?? ''));
        for (const k of ['before', 'after'] as const) {
          if (String(args[k] ?? '').trim() && !dayArg(args[k])) {
            return `search_sessions: \`${k}\` must be a YYYY-MM-DD date.`;
          }
        }
        const before = dayArg(args.before);
        const after = dayArg(args.after);

        const hits = await searchSessions({
          userId: ctx.userId,
          appId: ctx.appId,
          // 当前会话已在模型上下文里,而且最近列表必被它霸榜 → 服务端排除(别指望提示词)
          excludeSessionId: ctx.sessionId,
          terms,
          limit,
          before,
          after,
        });

        if (!terms.length) {
          if (!hits.length) {
            return before || after
              ? 'No past chat sessions in that date range. Widen or drop `before`/`after` to see more.'
              : 'No past chat sessions found for this user yet.';
          }
          const lines = hits.map(formatHit);
          return `The user's ${hits.length} most recent past session(s), newest first:\n${lines.join('\n')}\n`
            + `${FOOTER} Search by keyword with \`query\`; page further back by passing the oldest date above as \`before\`.`;
        }

        if (!hits.length) {
          return `No past sessions matched "${terms.join(' ')}". Try fewer or broader keywords, `
            + 'or call search_sessions without `query` to list recent sessions.';
        }
        const lines = hits.map(formatHit);
        return `${hits.length} past session(s) matching "${terms.join(' ')}", newest first:\n${lines.join('\n')}\n${FOOTER}`;
      },
    },
  ],
};
