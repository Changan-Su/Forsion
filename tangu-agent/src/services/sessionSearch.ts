/**
 * 会话检索共享入口:管理界面保留全局用户搜索，运行时工具使用可信 Agent 范围与有界相关性窗口。
 * 两边各写一份的下场是「界面搜得到、模型搜不到」(或反过来),而两边看起来都对——这类错位没有类型能抓。
 *
 * 语义正典(勿改回,见 tools/builtin/searchSessions.ts 头注与记忆 project_tangu_session_recall):
 *  - 每个词「标题/摘要 OR 任一消息 EXISTS」,跨消息 AND(中英词常分散在一问一答两侧)。
 *  - **LIMIT 按会话计**:话痨会话再刷屏也挤不占别人的名额。
 *  - 无 query = 最近列表,且**空壳会话不进榜**(没标题没摘要 = 还没聊出内容)。
 *  - 管理归属按 (user_id, app_id) 且 kind='user';工具额外限制 agent_config.agentSlug；内容检索必须
 *    JOIN chat_sessions 做租户隔离,别改成裸查 chat_messages。
 *  - 方言(desktop=sqlite / 云=PG 同一条 SQL):LOWER+LIKE+ESCAPE '\'、`||` 拼接、COALESCE 两边一致。
 */
import { getDbType, query } from '../core/db.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { currentDisplayAgentSlug } from '../seams/runContext.js';

/** Runtime-only scope. Management routes omit it; model arguments must never supply it. */
export interface SessionToolScope { agentSlug: string; }
export function sessionToolScope(agentSlug?: string): SessionToolScope {
  const active = currentDisplayAgentSlug();
  if (agentSlug && active && agentSlug !== active) throw new Error('History scope does not match the active Agent.');
  return { agentSlug: agentSlug || active || DEFAULT_AGENT_SLUG };
}

/** Keep ownership in every SQL query, including exact message reads. Invalid config is never legacy. */
export function sessionAgentPredicate(scope: SessionToolScope, alias = 's'): { sql: string; params: string[] } {
  const col = `${alias}.agent_config`;
  const slug = scope.agentSlug || DEFAULT_AGENT_SLUG;
  if (getDbType() === 'sqlite') {
    return {
      sql: `(CASE WHEN ${col} IS NULL THEN ? WHEN json_valid(${col}) THEN`
        + ` CASE WHEN json_type(${col}) = 'object' THEN COALESCE(NULLIF(json_extract(${col}, '$.agentSlug'), ''), ?) ELSE NULL END ELSE NULL END) = ?`,
      params: [DEFAULT_AGENT_SLUG, DEFAULT_AGENT_SLUG, slug],
    };
  }
  return { sql: `(CASE WHEN ${col} IS NULL THEN ? WHEN jsonb_typeof(${col}) = 'object'`
    + ` THEN COALESCE(NULLIF(${col} ->> 'agentSlug', ''), ?) ELSE NULL END) = ?`,
  params: [DEFAULT_AGENT_SLUG, DEFAULT_AGENT_SLUG, slug] };
}

export const SESSION_RECALL_MAX_SESSIONS = 64;
export const SESSION_RECALL_MAX_MESSAGES = 64;
export const SESSION_RECALL_MESSAGE_CHARS = 4000;

/**
 * 查询词拆分:空白分隔,`"带空格的短语"` 算一个词,最多 5 个(防超长 AND 链),**单词截到 200 字**。
 * 长度闸不是洁癖:100KB 的一个词进 LIKE 会让 sqlite 直接抛 "LIKE or GLOB pattern too complex",
 * 整条请求 500(Codex 实测)。截断而不是拒绝——用户粘了一大段进来,搜前 200 字是他要的意思。
 * 借 pi 的 session 搜索语法,但**只借引号**:它的 `re:` 整串正则在 SQL 侧不可移植(两方言的
 * 正则支持不一样),而且 pi 自己把非法正则的错误吞掉、用户只看到「无结果」。
 * 引号不闭合时按普通空白拆(不留下裸引号当字面量去匹配 —— pi 那样会让打到一半的短语突然搜不到)。
 */
export const MAX_TERM_CHARS = 200;

export function splitTerms(q: string): string[] {
  const s = q.trim().slice(0, 4000); // 整串先封顶,免得在超长输入上做正则
  if (!s) return [];
  const quotes = (s.match(/"/g) || []).length;
  if (quotes >= 2 && quotes % 2 === 0) {
    const out: string[] = [];
    for (const m of s.match(/"[^"]*"|\S+/g) || []) {
      const t = (m.startsWith('"') ? m.slice(1, -1).trim() : m).slice(0, MAX_TERM_CHARS);
      if (t) out.push(t);
    }
    return out.slice(0, 5);
  }
  return s.replace(/"/g, ' ').split(/\s+/).filter(Boolean).map((t) => t.slice(0, MAX_TERM_CHARS)).slice(0, 5);
}

/** LIKE 模式:小写 + 转义 \ % _(SQL 端配 ESCAPE '\')+ 两侧通配。 */
export function likePattern(term: string): string {
  return '%' + term.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** 空白折叠 + 超长截断(截断处补省略号)。 */
export function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
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
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s)) return null;
  const day = s.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

/** 消息 timestamp(BIGINT 毫秒;PG 驱动把 BIGINT 给成字符串)→ YYYY-MM-DD;非法给 ''。 */
export function tsDate(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toISOString().slice(0, 10);
}

/** 消息 timestamp → 毫秒数字(跳转定位用);非法给 0。 */
export function tsNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
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

/** 命中的那条消息(桌面搜索面据此跳到消息;工具只用 snippet)。 */
export interface SessionHitMessage {
  messageId: string;
  role: string;
  /** 毫秒时间戳(0=未知)。 */
  timestamp: number;
  snippet: string;
}

export interface SessionHit {
  id: string;
  title: unknown;
  summary: unknown;
  archived: unknown;
  updated_at: unknown;
  /** 内容命中时:`role 日期: "…片段…"`;标题/摘要命中的行不填,显示 summary。 */
  match?: string;
  /** 同一条命中的结构化形态(UI 用)。 */
  hit?: SessionHitMessage;
  /** Scoped runtime results use bounded candidates; this is a lexical score, not embedding similarity. */
  score?: number;
}

export interface SessionSearchInput {
  userId: string;
  appId: string;
  /** 排除某个会话:工具传当前会话(它已在模型上下文里、且必霸榜最近列表);UI 不传(你可能就想搜手上这段)。 */
  excludeSessionId?: string;
  /** 已 splitTerms 的查询词;空数组 = 最近列表。 */
  terms: string[];
  /** 已 clamp 的整数(小数会被原样内插进 SQL 的 LIMIT,两方言都直接炸)。 */
  limit: number;
  before?: string | null;
  after?: string | null;
  toolScope?: SessionToolScope;
  signal?: AbortSignal;
  /** Runtime recall uses OR relevance; the search tool keeps its documented cross-message AND. */
  matchAny?: boolean;
  /** Trusted caller may choose smaller automatic-recall windows; never increases hard caps. */
  candidateLimit?: number;
  messagesPerSession?: number;
  messageChars?: number;
}

/** No persistent index: edits/deletions/purge are visible on the next query without stale index resurrection.
 * Search only a bounded recent window, narrowed by dates. Never scan/index the complete message store.
 */
async function searchScopedSessions(input: SessionSearchInput): Promise<SessionHit[]> {
  const scope = input.toolScope!;
  const ownership = sessionAgentPredicate(scope);
  const bounded = (n: number | undefined, cap: number) => Math.min(cap, Math.max(1, Math.floor(n || cap)));
  const candidateLimit = bounded(input.candidateLimit, SESSION_RECALL_MAX_SESSIONS);
  const messageLimit = bounded(input.messagesPerSession, SESSION_RECALL_MAX_MESSAGES);
  const messageChars = bounded(input.messageChars, SESSION_RECALL_MESSAGE_CHARS);
  const terms = input.terms.slice(0, 5).map((term) => term.slice(0, MAX_TERM_CHARS).toLowerCase()).filter(Boolean);
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit) || 10));
  const conditions = ["s.user_id = ?", "s.app_id = ?", "s.kind = 'user'", ownership.sql];
  const params: unknown[] = [input.userId, input.appId, ...ownership.params];
  if (input.excludeSessionId) { conditions.push('s.id <> ?'); params.push(input.excludeSessionId); }
  if (input.before) { conditions.push('s.updated_at < ?'); params.push(input.before); }
  if (input.after) { conditions.push('s.updated_at >= ?'); params.push(input.after); }
  conditions.push("(COALESCE(s.title, '') <> '' OR COALESCE(s.summary, '') <> '')");
  input.signal?.throwIfAborted();
  const candidates = await query<SessionHit[]>(
    `SELECT s.id, substr(s.title, 1, 500) AS title, substr(s.summary, 1, 4000) AS summary, s.archived, s.updated_at`
      + ` FROM chat_sessions s WHERE ${conditions.join(' AND ')} ORDER BY s.updated_at DESC, s.id DESC LIMIT ${candidateLimit}`,
    params,
  );
  input.signal?.throwIfAborted();
  if (!terms.length) return candidates.slice(0, limit);
  const hits: SessionHit[] = [];
  for (const candidate of candidates) {
    input.signal?.throwIfAborted();
    const title = String(candidate.title || '').toLowerCase();
    const meta = `${title} ${candidate.summary || ''}`.toLowerCase();
    const found = new Set(terms.filter((term) => meta.includes(term)));
    let score = terms.reduce((n, term) => n + (title.includes(term) ? 6 : meta.includes(term) ? 3 : 0), 0);
    const messages = await query<Array<{ id: string; role: string; content: string; timestamp: unknown }>>(
      `SELECT m.id, m.role, substr(m.content, 1, ${messageChars}) AS content, m.timestamp`
        + ` FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id`
        + ` WHERE s.id = ? AND s.user_id = ? AND s.app_id = ? AND s.kind = 'user' AND ${ownership.sql}`
        + ` ORDER BY m.timestamp DESC, m.id DESC LIMIT ${messageLimit}`,
      [candidate.id, input.userId, input.appId, ...ownership.params],
    );
    input.signal?.throwIfAborted();
    let best: SessionHitMessage | undefined;
    let bestScore = 0;
    for (const row of messages) {
      const content = String(row.content || '');
      const lower = content.toLowerCase();
      const matched = terms.filter((term) => lower.includes(term));
      matched.forEach((term) => found.add(term));
      if (matched.length > bestScore) {
        bestScore = matched.length;
        best = { messageId: row.id, role: row.role === 'model' ? 'assistant' : row.role,
          timestamp: tsNum(row.timestamp), snippet: snippetAround(content, matched[0], 220) };
      }
    }
    if (input.matchAny ? found.size === 0 : found.size < terms.length) continue;
    score += bestScore * 2;
    hits.push({ ...candidate, score, ...(best ? { hit: best, match: `${best.role} ${tsDate(best.timestamp)}: "${best.snippet}"` } : {}) });
  }
  const updated = (value: unknown) => new Date(value instanceof Date ? value : String(value)).getTime() || 0;
  return hits.sort((a, b) => (b.score || 0) - (a.score || 0)
    || updated(b.updated_at) - updated(a.updated_at)).slice(0, limit);
}

/**
 * 检索/列出会话。返回按 updated_at 降序的会话行;带 query 时给每个「非标题命中」的会话补一条
 * 代表性命中消息(最新的那条)。
 */
export async function searchSessions(input: SessionSearchInput): Promise<SessionHit[]> {
  if (input.toolScope) return searchScopedSessions(input);
  const { userId, appId, excludeSessionId, terms, before, after } = input;
  const limit = Math.min(Math.max(1, Math.floor(input.limit) || 10), 50);

  // `p` 是列前缀(JOIN 查询里要挂 s.)。
  const scopeSql = (p: string): string => {
    let sql = `${p}user_id = ? AND ${p}app_id = ? AND ${p}kind = 'user'`;
    if (excludeSessionId) sql += ` AND ${p}id <> ?`;
    if (before) sql += ` AND ${p}updated_at < ?`;
    if (after) sql += ` AND ${p}updated_at >= ?`;
    return sql;
  };
  const scopeParams = [
    userId, appId,
    ...(excludeSessionId ? [excludeSessionId] : []),
    ...(before ? [before] : []),
    ...(after ? [after] : []),
  ];
  const cols = 'id, title, summary, archived, updated_at';

  // limit 已 clamp 成整数,内联进 SQL(LIMIT 占位符不是所有后端都吃,同 read_session)。
  if (!terms.length) {
    // 空壳会话(没标题没摘要=还没聊出内容)不进最近列表——否则每个新开的空聊天都霸榜
    // (借 Codex threads 目录 `preview <> ''` 部分索引的同一招)。带 query 的路径天然排除。
    return query<SessionHit[]>(
      `SELECT ${cols} FROM chat_sessions WHERE ${scopeSql('')}`
        + ` AND (COALESCE(title, '') <> '' OR COALESCE(summary, '') <> '')`
        + ` ORDER BY updated_at DESC LIMIT ${limit}`,
      scopeParams,
    );
  }

  // 检索语义:每个词都出现在该会话**某处**(标题/摘要 OR 任一消息;EXISTS 走
  // idx_chat_messages_session 逐会话短路探测)。跨消息也算命中。LIMIT 限的是会话数。
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
  if (!hits.length) return hits;

  // 标题/摘要自证命中的行显示摘要;其余行补一条代表性命中消息(最新)做片段,带角色+日期。
  //
  // 两处**每会话独立**,别退回「一条查询打全部」(codex 2026-08-17 两条 P2):
  //  ① **探针词按会话各自挑**:原来固定用 `patterns[0]`。多词查询里第一个词可能只出现在标题/摘要、
  //     而把这个会话捞进来的是**后面某个词**命中了正文 —— 拿第一个词去探正文自然探不到,于是
  //     `hit` 缺席、桌面点了跳不到那条消息。这里挑「元数据里**没有**的第一个词」:外层查询已经
  //     保证每个词都命中(元数据或正文之一),元数据里没有的那个必然在正文里。
  //  ② **每会话各取一条**:原来是一条 `LIMIT 100` 的全局查询。某个会话只要有 100 条以上含探针词的
  //     消息,就能把整个结果集占满,别的会话一条都拿不到 → 它们的 `hit` 全部缺席。
  //     会话数 = 外层 limit(默认 20),逐个 `LIMIT 1` 走索引,比一次大查询更可控。
  const needSnippet = new Map<string, SessionHit>();
  const probeTerm = new Map<string, string>();
  for (const h of hits) {
    const meta = `${h.title ?? ''} ${h.summary ?? ''}`.toLowerCase();
    if (terms.every((t) => meta.includes(t.toLowerCase()))) continue;
    needSnippet.set(h.id, h);
    const i = terms.findIndex((t) => !meta.includes(t.toLowerCase()));
    probeTerm.set(h.id, terms[i >= 0 ? i : 0]);
  }
  if (needSnippet.size) {
    const rows = await Promise.all(
      [...needSnippet.keys()].map(async (id) => {
        const term = probeTerm.get(id) ?? terms[0];
        const r = await query<any[]>(
          `SELECT id, session_id, role, content, timestamp FROM chat_messages`
            + ` WHERE session_id = ? AND LOWER(content) LIKE ? ESCAPE '\\'`
            + ` ORDER BY timestamp DESC LIMIT 1`,
          [id, likePattern(term)],
        );
        return r[0] ? { row: r[0], term } : null;
      }),
    );
    for (const hit of rows) {
      if (!hit) continue;
      const r = hit.row;
      const h = needSnippet.get(String(r.session_id));
      if (!h || h.match) continue;
      const role = r.role === 'model' ? 'assistant' : String(r.role || '');
      const d = tsDate(r.timestamp);
      const snippet = snippetAround(String(r.content ?? ''), hit.term);
      h.match = `${role}${d ? ' ' + d : ''}: "${snippet}"`;
      h.hit = { messageId: String(r.id ?? ''), role, timestamp: tsNum(r.timestamp), snippet };
    }
  }
  return hits;
}
