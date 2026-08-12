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
 * 归属边界:同 read_session,只按 (user_id, app_id) 取,且 kind='user'(muse/fork 等
 * 内部会话不出现)。chat_messages 没有 user_id 列,内容检索必须 JOIN chat_sessions 做
 * 租户隔离,别改成裸查 chat_messages。
 *
 * 方言约束(desktop=sqlite / 云=PG 同一条 SQL):LOWER+LIKE+ESCAPE '\'、`||` 拼接、
 * COALESCE 两边行为一致;sqlite LOWER 只折 ASCII,对 CJK 是恒等,与 PG 语义相容。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { query } from '../../core/db.js';

/** 查询词拆分:空白分隔,最多 5 个(防超长 AND 链)。 */
export function splitTerms(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
}

/** LIKE 模式:小写 + 转义 \ % _(SQL 端配 ESCAPE '\')+ 两侧通配。 */
export function likePattern(term: string): string {
  return '%' + term.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** 空白折叠 + 超长截断(截断处补省略号)。 */
function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

/** 摘掉标题里会破坏 [[session:id|title]] 引用语法的字符(与桌面端 chatDragRef.safeLabel 同旨),
 *  并镜像桌面端标题 60 字上限。 */
function safeTitle(title: unknown): string {
  const t = String(title ?? '').replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return t || '(untitled)';
}

/** updated_at 归一成 YYYY-MM-DD:sqlite 给 'YYYY-MM-DD HH:MM:SS' 字符串,PG 驱动给 Date。 */
export function fmtDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').trim().slice(0, 10);
}

/** before/after 参数:只认 YYYY-MM-DD(或其 ISO 延长形),归一成日期;非法返回 null。
 *  必须前置校验——乱串直传 PG 会在 timestamp cast 上炸整条查询(sqlite 只是静默不中)。 */
export function dayArg(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s) ? s.slice(0, 10) : null;
}

/** boolean 归一:PG 驱动给 true/false,sqlite 给 0/1。 */
function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

/** 消息 timestamp(BIGINT 毫秒;PG 驱动把 BIGINT 给成字符串)→ YYYY-MM-DD;非法给 ''。 */
export function tsDate(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toISOString().slice(0, 10);
}

/** 内容命中片段:围绕首个命中词截 ~span 字,空白折叠,截断处加省略号。 */
export function snippetAround(content: string, term: string, span = 120): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const idx = flat.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return clip(flat, span);
  const lead = Math.floor(span / 4);
  const start = Math.max(0, idx - lead);
  const end = Math.min(flat.length, idx + term.length + (span - lead));
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

export interface SessionHit {
  id: string;
  title: unknown;
  summary: unknown;
  archived: unknown;
  updated_at: unknown;
  /** 内容命中时:`role: "…片段…"`;标题/摘要命中的行不填,显示 summary。 */
  match?: string;
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

        // 范围:本用户 × 本 app × 用户会话 × 排除当前会话(它已在上下文里,而且最近列表必被它霸榜)
        // × 可选时间窗。`p` 是列前缀(JOIN 查询里要挂 s.)。
        const scopeSql = (p: string) => {
          let sql = `${p}user_id = ? AND ${p}app_id = ? AND ${p}kind = 'user' AND ${p}id <> ?`;
          if (before) sql += ` AND ${p}updated_at < ?`;
          if (after) sql += ` AND ${p}updated_at >= ?`;
          return sql;
        };
        const scopeParams = [ctx.userId, ctx.appId, ctx.sessionId, ...(before ? [before] : []), ...(after ? [after] : [])];
        const cols = 'id, title, summary, archived, updated_at';

        // limit 已 clamp 成 1..20 的整数,内联进 SQL(LIMIT 占位符不是所有后端都吃,同 read_session)。
        if (!terms.length) {
          // 空壳会话(没标题没摘要=还没聊出内容)不进最近列表——否则每个新开的空聊天都霸榜
          // (借 Codex threads 目录 `preview <> ''` 部分索引的同一招)。带 query 的路径天然排除。
          const rows = await query<SessionHit[]>(
            `SELECT ${cols} FROM chat_sessions WHERE ${scopeSql('')}`
              + ` AND (COALESCE(title, '') <> '' OR COALESCE(summary, '') <> '')`
              + ` ORDER BY updated_at DESC LIMIT ${limit}`,
            scopeParams,
          );
          if (!rows.length) {
            return before || after
              ? 'No past chat sessions in that date range. Widen or drop `before`/`after` to see more.'
              : 'No past chat sessions found for this user yet.';
          }
          const lines = rows.map(formatHit);
          return `The user's ${rows.length} most recent past session(s), newest first:\n${lines.join('\n')}\n`
            + `${FOOTER} Search by keyword with \`query\`; page further back by passing the oldest date above as \`before\`.`;
        }

        // 检索语义:每个词都出现在该会话**某处**(标题/摘要 OR 任一消息;EXISTS 走
        // idx_chat_messages_session 逐会话短路探测)。跨消息也算命中——中英词常分散在
        // 一问一答两侧,「同一条消息里全命中」偏严。LIMIT 限的是会话数,单会话再话痨
        // 也挤不占别人的名额(旧版按消息池截 200 条会被刷屏挤占,Codex 评审抓的)。
        const patterns = terms.map(likePattern);
        const perTerm = terms
          .map(() =>
            `(LOWER(COALESCE(s.title, '') || ' ' || COALESCE(s.summary, '')) LIKE ? ESCAPE '\\'`
            + ` OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id AND LOWER(m.content) LIKE ? ESCAPE '\\'))`)
          .join(' AND ');
        const hits = await query<SessionHit[]>(
          `SELECT s.id, s.title, s.summary, s.archived, s.updated_at FROM chat_sessions s`
            + ` WHERE ${scopeSql('s.')} AND ${perTerm} ORDER BY s.updated_at DESC LIMIT ${limit}`,
          [...scopeParams, ...patterns.flatMap((p) => [p, p])],
        );
        if (!hits.length) {
          return `No past sessions matched "${terms.join(' ')}". Try fewer or broader keywords, `
            + 'or call search_sessions without `query` to list recent sessions.';
        }

        // 标题/摘要自证命中的行显示摘要;其余行补一条代表性命中消息(最新)做片段,带角色+日期。
        // ponytail: 片段探针固定用第一个词,探不到就回退摘要——够用,别为片段再开一轮 per-term 查询。
        const needSnippet = new Map<string, SessionHit>();
        for (const h of hits) {
          const meta = `${h.title ?? ''} ${h.summary ?? ''}`.toLowerCase();
          if (!terms.every((t) => meta.includes(t.toLowerCase()))) needSnippet.set(h.id, h);
        }
        if (needSnippet.size) {
          const ids = [...needSnippet.keys()];
          const msgRows = await query<any[]>(
            `SELECT session_id, role, content, timestamp FROM chat_messages`
              + ` WHERE session_id IN (${ids.map(() => '?').join(', ')}) AND LOWER(content) LIKE ? ESCAPE '\\'`
              + ` ORDER BY timestamp DESC LIMIT 100`,
            [...ids, patterns[0]],
          );
          for (const r of msgRows) {
            const h = needSnippet.get(String(r.session_id));
            if (!h || h.match) continue; // 每会话只留最新一条命中
            const role = r.role === 'model' ? 'assistant' : String(r.role || '');
            const d = tsDate(r.timestamp);
            h.match = `${role}${d ? ' ' + d : ''}: "${snippetAround(String(r.content ?? ''), terms[0])}"`;
          }
        }

        const lines = hits.map(formatHit);
        return `${hits.length} past session(s) matching "${terms.join(' ')}", newest first:\n${lines.join('\n')}\n${FOOTER}`;
      },
    },
  ],
};
