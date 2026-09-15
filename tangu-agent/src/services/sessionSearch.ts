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
 *
 * **SQL 本体在 sessionSearchSql.ts,本文件不直连 core/db.js**(2026-09-13):业务侧一律经 `deps().state`
 * ——持库进程走 SqlStateStore,thin worker(云端 Web / 移动端)走 HttpStateStore 经网关代查。此前直连让
 * search_sessions / read_session / 记忆召回的历史段在云端整体抛错。棘轮:test/memorySeamBoundary.test.ts。
 */
import { deps } from '../seams/runtime.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { currentDisplayAgentSlug } from '../seams/runContext.js';

/** Runtime-only scope. Management routes omit it; model arguments must never supply it. */
export interface SessionToolScope { agentSlug: string; }
export function sessionToolScope(agentSlug?: string): SessionToolScope {
  const active = currentDisplayAgentSlug();
  if (agentSlug && active && agentSlug !== active) throw new Error('History scope does not match the active Agent.');
  return { agentSlug: agentSlug || active || DEFAULT_AGENT_SLUG };
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

/** read_session 的入参(工具侧已 clamp;SQL 侧再夹一次,经网关来的请求不可信任)。 */
export interface SessionTranscriptInput {
  sessionId: string;
  userId: string;
  appId: string;
  toolScope: SessionToolScope;
  /** 最多取几条(最新的 limit 条)。 */
  limit: number;
  /** 每条正文取 perMessageChars+1 字,供工具判断是否截断。 */
  perMessageChars: number;
  charOffset: number;
  /** 精确读一条(来自检索命中)。 */
  messageId?: string;
  /** 向前翻页锚点(同会话内更早的消息)。 */
  beforeMessageId?: string;
  signal?: AbortSignal;
}
export interface SessionTranscriptRow {
  id: string;
  timestamp: unknown;
  role: string;
  content: string | null;
  tool_calls: unknown;
}
export interface SessionTranscript {
  /** null = 当前 user/app/Agent 范围内无此会话(含属于他人 / 已删除)。 */
  session: { id: string; title: unknown; summary: unknown } | null;
  /** beforeMessageId 不在该会话内。 */
  anchorMissing?: boolean;
  /** 最新在前(ORDER BY timestamp DESC);工具侧翻回正序展示。 */
  rows: SessionTranscriptRow[];
}

/**
 * 检索/列出会话。返回按 updated_at 降序的会话行;带 query 时给每个「非标题命中」的会话补一条
 * 代表性命中消息(最新的那条)。实现见 sessionSearchSql.ts(SqlStateStore)/ httpStateStore.ts(thin worker)。
 */
export async function searchSessions(input: SessionSearchInput): Promise<SessionHit[]> {
  return deps().state.searchSessions(input);
}
