/**
 * 会话检索 / 会话转录的 **SQL 本体**(SqlStateStore 专用;desktop=sqlite / 网关=PG 同一条 SQL)。
 *
 * 从 services/sessionSearch.ts 原样搬来(2026-09-13):业务侧只经 `deps().state.searchSessions /
 * readSessionTranscript` 访问 —— thin worker(云端 Web / 移动端)不持库,由 HttpStateStore 经网关
 * `/api/agent-state/sessions/*` 代查;此前直连 core/db.js 让 search_sessions / read_session / 记忆召回的
 * 历史段在云端整体不可用。语义正典(归属三元组、LIMIT 按会话计、方言约束)见 sessionSearch.ts 头注,勿在两处各改一份。
 *
 * 命名约定:`*Sql.ts` = 持库后端实现,是 test/memorySeamBoundary.test.ts 棘轮唯一放行直连 core/db.js 的地方。
 */
import path from 'node:path';
import { getDbType, query } from '../core/db.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { notRemoteTaintedSql } from './remoteTaint.js';
import {
  likePattern, snippetAround, tsDate, tsNum, MAX_TERM_CHARS,
  SESSION_RECALL_MAX_SESSIONS, SESSION_RECALL_MAX_MESSAGES, SESSION_RECALL_MESSAGE_CHARS,
  type SessionHit, type SessionHitMessage, type SessionSearchInput, type SessionToolScope,
  type SessionTranscript, type SessionTranscriptInput,
} from './sessionSearch.js';

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

/** 「chat_messages tc 这行调过 tool」(tool_calls 两方言都 CAST 成文本比;工具名里的 _ 经 likePattern 转义)。
 *  召回藏匿(noToolCallPredicate)与 Historian 跳过自动记忆提取(sessionCalledTool)共用这一个判据,改一处即两处。 */
const toolCallMatch = (tool: string): { sql: string; params: string[] } =>
  ({ sql: `LOWER(CAST(tc.tool_calls AS TEXT)) LIKE ? ESCAPE '\\'`, params: [likePattern(tool)] });

/** 「有任一消息调过 tool 的会话」排除谓词。 */
function noToolCallPredicate(tool: string, alias = 's'): { sql: string; params: string[] } {
  const m = toolCallMatch(tool);
  return { sql: `NOT EXISTS (SELECT 1 FROM chat_messages tc WHERE tc.session_id = ${alias}.id AND ${m.sql})`, params: m.params };
}

/** 该会话是否有任一消息调过 tool(按会话不按消息:追问轮会复述结果而不再调工具)。localHistorian 用它把
 *  调过 read_computer_history 的会话挡在自动记忆提取之外;持库后端专属(Historian 本就只在本地形态跑)。 */
export async function sessionCalledTool(sessionId: string, tool: string): Promise<boolean> {
  const m = toolCallMatch(tool);
  const rows = await query<any[]>(`SELECT 1 AS hit FROM chat_messages tc WHERE tc.session_id = ? AND ${m.sql} LIMIT 1`, [sessionId, ...m.params]);
  return rows.length > 0;
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
  if (input.excludeSessionsWithTool) {
    const hide = noToolCallPredicate(input.excludeSessionsWithTool);
    conditions.push(hide.sql); params.push(...hide.params);
  }
  if (input.excludeRemoteSessions) conditions.push(notRemoteTaintedSql('s'));
  if (input.before) { conditions.push('s.updated_at < ?'); params.push(input.before); }
  if (input.after) { conditions.push('s.updated_at >= ?'); params.push(input.after); }
  conditions.push("(COALESCE(s.title, '') <> '' OR COALESCE(s.summary, '') <> '')");
  input.signal?.throwIfAborted();
  // 项目出处(10-04 记忆分项目级 / 全局级):候选会话属于哪个项目、是不是当前会话的那个。两边都拿库里的原值比,不做路径规范化。
  const cols = 's.id, substr(s.title, 1, 500) AS title, substr(s.summary, 1, 4000) AS summary, s.archived, s.updated_at';
  const tail = ` FROM chat_sessions s WHERE ${conditions.join(' AND ')} ORDER BY s.updated_at DESC, s.id DESC LIMIT ${candidateLimit}`;
  const here = input.excludeSessionId ? '(SELECT c.project_path FROM chat_sessions c WHERE c.id = ?)' : 'NULL';
  let rows: Array<SessionHit & { project_path?: unknown; current_project_path?: unknown }>;
  try {
    rows = await query(`SELECT ${cols}, s.project_path AS project_path, ${here} AS current_project_path${tail}`, [...(input.excludeSessionId ? [input.excludeSessionId] : []), ...params]);
  } catch {
    // 出处只是个标注,不能让它把检索本身带挂:哪个部署的会话表还没有 project_path 列,就退回不带出处的那条查询
    // (真出了别的故障,这条同样会抛)。src/tools/builtin/searchSessions.test.ts 的表就没有这一列,跑的正是这条退路。
    input.signal?.throwIfAborted();
    rows = await query(`SELECT ${cols}${tail}`, params);
  }
  const candidates: SessionHit[] = rows.map(({ project_path, current_project_path, ...c }) => ({
    ...c,
    ...(project_path ? { project: path.basename(String(project_path)), ...(current_project_path && String(current_project_path) !== String(project_path) ? { otherProject: true } : {}) } : {}),
  }));
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
export async function searchSessionsInDb(input: SessionSearchInput): Promise<SessionHit[]> {
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

/**
 * read_session 的原始数据面:会话头 + 一页消息(最新在前;工具侧翻回正序并塑形)。
 * 三条查询与归属谓词原样来自 tools/builtin/readSession.ts;数字入参在此夹紧后才内联进 SQL(经网关来的
 * worker 请求不可信任其已 clamp)。
 */
export async function readSessionTranscriptInDb(input: SessionTranscriptInput): Promise<SessionTranscript> {
  const ownership = sessionAgentPredicate(input.toolScope);
  const scope = `s.id = ? AND s.user_id = ? AND s.app_id = ? AND s.kind = 'user' AND ${ownership.sql}`;
  const scopeParams = [input.sessionId, input.userId, input.appId, ...ownership.params];
  const limit = Math.min(Math.max(1, Math.floor(Number(input.limit) || 60)), 300);
  const perMsg = Math.min(Math.max(80, Math.floor(Number(input.perMessageChars) || 600)), 4000);
  const charOffset = Math.min(1_000_000, Math.max(0, Math.floor(Number(input.charOffset) || 0)));
  const messageId = String(input.messageId || '').trim();
  const beforeId = String(input.beforeMessageId || '').trim();
  input.signal?.throwIfAborted();
  const hide = input.excludeSessionsWithTool ? noToolCallPredicate(input.excludeSessionsWithTool) : null;
  const noRemote = input.excludeRemoteSessions ? ` AND ${notRemoteTaintedSql('s')}` : '';
  const sess = await query<any[]>(
    `SELECT s.id, substr(s.title, 1, 500) AS title, substr(s.summary, 1, 2000) AS summary FROM chat_sessions s WHERE ${scope}${hide ? ` AND ${hide.sql}` : ''}${noRemote}`,
    [...scopeParams, ...(hide ? hide.params : [])],
  );
  input.signal?.throwIfAborted();
  if (!sess.length) return { session: null, rows: [] };
  const session = { id: String(sess[0].id), title: sess[0].title, summary: sess[0].summary };

  let pageSql = '';
  const pageParams: unknown[] = [];
  if (messageId) { pageSql = ' AND m.id = ?'; pageParams.push(messageId); }
  else if (beforeId) {
    const anchor = await query<any[]>(
      `SELECT m.id, m.timestamp FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE ${scope} AND m.id = ?`,
      [...scopeParams, beforeId],
    );
    input.signal?.throwIfAborted();
    if (!anchor.length) return { session, anchorMissing: true, rows: [] };
    pageSql = ' AND (m.timestamp < ? OR (m.timestamp = ? AND m.id < ?))';
    pageParams.push(anchor[0].timestamp, anchor[0].timestamp, beforeId);
  }
  const rows = await query<any[]>(
    `SELECT m.id, m.timestamp, m.role, substr(m.content, ${charOffset + 1}, ${perMsg + 1}) AS content,`
      + ` substr(CAST(m.tool_calls AS TEXT), 1, 4000) AS tool_calls FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id`
      + ` WHERE ${scope}${pageSql} ORDER BY m.timestamp DESC, m.id DESC LIMIT ${messageId ? 1 : limit}`,
    [...scopeParams, ...pageParams],
  );
  input.signal?.throwIfAborted();
  return { session, rows };
}
