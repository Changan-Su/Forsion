/**
 * 会话导入(2026-11-16):把别处的聊天记录(DeepSeek 网页导出等)写成本引擎里**能接着聊**的普通会话。
 *
 * 路由 `POST /agent/sessions/import`(routes/sessions.ts)与插件宿主 `ctx.tangu.importSessions` 共用这一份。
 * SQLite(本机引擎)/ Postgres(server 挂的同一个包 = 手机 / 网页的云端)都走 core/db 的 query,
 * 所以「各端各导各的」不用写两套。
 *
 * 不变量:
 *   - **追加不覆盖**:会话 id 由 (用户, app, 来源, 外部 id) 定死;同一条再导一次 → `exists`,原会话一字不动
 *     (用户在里面接着聊过的内容不会被旧记录盖掉)。
 *   - 原时间照留:会话 created_at / updated_at、每条消息的 timestamp 都用原记录的,列表里按原时间排,不冒到最上面。
 *   - 不触发后台:导入不建 run,Historian 起标题 / 记忆候选 / Dream 都只认跑过的轮次,所以一条也不会被它们扫到;
 *     proactive_at 留空 → 没有未读点;标题记为手动(title_manual),之后接着聊也不会被 Historian 改名。
 *   - **先写消息、最后才建会话行**:会话行出现之前,列表里看不到、也没人能往里续聊。消息 id 由 (会话 id, 序号) 定死、
 *     `ON CONFLICT (id) DO NOTHING` —— 写到一半断了(失败 / 进程退出)留下的只是没有会话行的消息,谁也看不见;
 *     再导一次会补齐剩下的、再建会话行。**不做补偿删除**:按 session_id 删会连别人此刻写进去的消息一起删(Codex 11-16)。
 *   - 消息 origin = 'import',来源记在会话 agent_config.imported = { source, id }(界面和以后的撤销靠它认)。
 */
import { createHash } from 'node:crypto';
import { query, getDbType } from '../core/db.js';

export const IMPORT_MAX_CONVERSATIONS = 50;
export const IMPORT_MAX_MESSAGES = 20000;
/** 一次请求里所有正文 + 思考的字符总数上限(server 的 JSON 上限 50 MB、本机 25 MB,留足余量)。 */
export const IMPORT_MAX_CHARS = 8_000_000;
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const INSERT_CHUNK = 100;

export interface ImportMessageInput {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | null;
  /** 毫秒;缺省按会话时间往后排 */
  timestamp?: number | null;
  model_id?: string | null;
}

export interface ImportConversationInput {
  external_id: string;
  title?: string | null;
  /** 毫秒 */
  created_at?: number | null;
  updated_at?: number | null;
  messages: ImportMessageInput[];
}

export interface ImportRequest {
  userId: string;
  appId: string;
  source: string;
  /** 建会话时的初始配置(已由路由按 POST /agent/sessions 的口径校验过);导入方再盖上 imported 标记 */
  agentConfig: Record<string, unknown> | null;
  modelId: string | null;
  projectless: boolean;
  conversations: ImportConversationInput[];
}

export type ImportResult =
  | { external_id: string; status: 'created'; session_id: string; messages: number }
  | { external_id: string; status: 'exists'; session_id: string }
  | { external_id: string; status: 'error'; error: string };

/** 校验请求体;不合法返回错误串(路由回 400)。 */
export function validateImportBody(source: unknown, conversations: unknown): string | null {
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) return 'source must match ^[a-z0-9][a-z0-9-]{0,31}$';
  if (!Array.isArray(conversations) || conversations.length === 0) return 'conversations must be a non-empty array';
  if (conversations.length > IMPORT_MAX_CONVERSATIONS) return `at most ${IMPORT_MAX_CONVERSATIONS} conversations per request`;
  let chars = 0;
  const seen = new Set<string>();
  for (const c of conversations as any[]) {
    if (!c || typeof c !== 'object') return 'conversation must be an object';
    if (typeof c.external_id !== 'string' || !c.external_id || c.external_id.length > 200) return 'external_id must be a 1-200 character string';
    if (seen.has(c.external_id)) return `duplicate external_id: ${c.external_id}`;
    seen.add(c.external_id);
    if (c.title != null && typeof c.title !== 'string') return 'title must be a string';
    for (const k of ['created_at', 'updated_at'] as const) {
      if (c[k] != null && !validMs(c[k])) return `${k} must be a millisecond timestamp`;
    }
    if (!Array.isArray(c.messages) || c.messages.length === 0) return 'each conversation needs at least one message';
    if (c.messages.length > IMPORT_MAX_MESSAGES) return `at most ${IMPORT_MAX_MESSAGES} messages per conversation`;
    for (const m of c.messages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'message role must be user or assistant';
      if (typeof m.content !== 'string') return 'message content must be a string';
      if (m.reasoning != null && typeof m.reasoning !== 'string') return 'message reasoning must be a string';
      if (m.timestamp != null && !validMs(m.timestamp)) return 'message timestamp must be a millisecond timestamp';
      if (m.model_id != null && (typeof m.model_id !== 'string' || m.model_id.length > 128)) return 'message model_id must be a string of at most 128 characters';
      chars += m.content.length + (m.reasoning?.length ?? 0);
    }
  }
  if (chars > IMPORT_MAX_CHARS) return `request too large: split it into smaller batches (at most ${IMPORT_MAX_CHARS} characters)`;
  return null;
}

function validMs(v: unknown): boolean {
  // 2000-01-01 之后、当前时间 + 1 天之前:秒级时间戳(10 位)会落在 1970 年附近,在这里就拦下,别默默写成 1970。
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 946_684_800_000 && v <= Date.now() + 86_400_000;
}

/** 导入会话的 id:同一用户、同一来源的同一条外部记录永远是同一个 id(v4 形状的 sha256 截取,VARCHAR(36) 装得下)。 */
export function importedSessionId(userId: string, appId: string, source: string, externalId: string): string {
  return asUuid(createHash('sha256').update(`forsion-import\0${userId}\0${appId}\0${source}\0${externalId}`).digest('hex'));
}

/** 导入消息的 id:由会话 id 与序号定死,断了重导时同一条落回同一行(ON CONFLICT DO NOTHING)。 */
export function importedMessageId(sessionId: string, index: number, fingerprint = ''): string {
  return asUuid(createHash('sha256').update(`forsion-import-msg\0${sessionId}\0${fingerprint}\0${index}`).digest('hex'));
}

/** 这一份对话内容的指纹(角色 + 正文 + 思考 + 时间,逐条):同一份导出断了重导落回同一批 id;
 *  换了一份内容不同的导出,id 也跟着变,不会把旧残留当成「已经写过」(Codex 11-16 第二轮 #4)。 */
export function conversationFingerprint(messages: ImportMessageInput[], stamps: number[]): string {
  const h = createHash('sha256');
  messages.forEach((m, i) => h.update(`${m.role}\0${m.content}\0${m.reasoning ?? ''}\0${m.model_id ?? ''}\0${stamps[i]}\n`));
  return h.digest('hex').slice(0, 16);
}

function asUuid(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** TIMESTAMP 列的写法:与 CURRENT_TIMESTAMP 落库的样子一致(UTC、空格分隔、到秒),SQLite 里按字符串排序也对得上。 */
function sqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 消息时间:有原时间用原时间;缺的接在前一条后面 1 秒,保证同一会话里严格递增(压缩 / 分支都按 timestamp 切)。
 *  一个时间都没有的对话从「现在往前 n 秒」排起,最后一条不晚于现在 —— 排到未来的话,之后接着聊的新消息会插进旧历史中间(Codex 11-16)。 */
export function settleTimestamps(c: ImportConversationInput, now = Date.now()): number[] {
  const first = c.created_at ?? c.messages.find((m) => m.timestamp != null)?.timestamp;
  // 只有「最后更新」:让历史在那一刻收尾(往回排),别从它往后排到未来(Codex 11-16 第二轮)
  const start = first ?? (c.updated_at != null ? Math.min(c.updated_at, now) : now) - (c.messages.length - 1) * 1000;
  const out: number[] = [];
  let prev = start - 1;
  for (const m of c.messages) {
    let t = m.timestamp ?? (out.length === 0 ? start : prev + 1000);
    if (t <= prev) t = prev + 1;
    out.push(t);
    prev = t;
  }
  return out;
}

export async function importConversations(req: ImportRequest): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  for (const c of req.conversations) {
    const sessionId = importedSessionId(req.userId, req.appId, req.source, c.external_id);
    try {
      const existing = await query<any[]>(`SELECT user_id FROM chat_sessions WHERE id = ? LIMIT 1`, [sessionId]);
      if (existing[0]) {
        results.push(existing[0].user_id === req.userId
          ? { external_id: c.external_id, status: 'exists', session_id: sessionId }
          : { external_id: c.external_id, status: 'error', error: 'id collision' });
        continue;
      }
      const stamps = settleTimestamps(c);
      const createdAt = Math.min(c.created_at ?? stamps[0], stamps[0]);
      const updatedAt = Math.max(c.updated_at ?? 0, stamps[stamps.length - 1]);
      const title = (c.title && c.title.trim() ? c.title.trim() : firstLine(c.messages) || 'Imported chat').slice(0, 200);
      const cfg = { ...(req.agentConfig || {}), imported: { source: req.source, id: c.external_id } };
      const fp = conversationFingerprint(c.messages, stamps);
      // 会话行还没建 = 只有之前断掉的导入留下的残留(谁也看不见、没人能往里写):换了内容的那批先清掉,别混进这一份。
      // 同一份内容的残留 id 一样,不删,下面 DO NOTHING 直接复用。会话行一旦存在就绝不删(上面已按 exists 返回)。
      // 残留按块从第 0 条写起:第 0 条的 id 对得上 = 同一份内容的残留(DO NOTHING 复用);对不上 = 换过内容,整批清掉。
      const leftovers = await query<any[]>(`SELECT id FROM chat_messages WHERE session_id = ? LIMIT 1`, [sessionId]);
      if (leftovers[0]) {
        const same = await query<any[]>(`SELECT 1 FROM chat_messages WHERE id = ? LIMIT 1`, [importedMessageId(sessionId, 0, fp)]);
        if (!same[0]) {
          await query(
            `DELETE FROM chat_messages WHERE session_id = ? AND origin = 'import' AND NOT EXISTS (SELECT 1 FROM chat_sessions WHERE id = ?)`,
            [sessionId, sessionId],
          );
        }
      }
      await insertMessages(sessionId, c.messages, stamps, agentSlugOf(req.agentConfig), fp);
      await query(
        `INSERT INTO chat_sessions (id, user_id, app_id, title, title_manual, model_id, agent_config, projectless, kind, last_read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        [sessionId, req.userId, req.appId, title, true, req.modelId, JSON.stringify(cfg), req.projectless,
         updatedAt, sqlTime(createdAt), sqlTime(updatedAt)],
      );
      results.push({ external_id: c.external_id, status: 'created', session_id: sessionId, messages: c.messages.length });
    } catch (e: any) {
      results.push({ external_id: c.external_id, status: 'error', error: String(e?.message || e).slice(0, 300) });
    }
  }
  return results;
}

/** 会话挂在哪个 Agent 名下:回答记上它的 slug,界面上的说话人才是那个 Agent(与正常跑出来的回答同口径)。 */
function agentSlugOf(cfg: Record<string, unknown> | null): string | null {
  const v = cfg?.agentSlug;
  return typeof v === 'string' && v && v.length <= 64 ? v : null;
}

async function insertMessages(sessionId: string, messages: ImportMessageInput[], stamps: number[], agentSlug: string | null, fingerprint: string): Promise<void> {
  const pg = getDbType() !== 'sqlite';
  for (let i = 0; i < messages.length; i += INSERT_CHUNK) {
    const slice = messages.slice(i, i + INSERT_CHUNK);
    const params: unknown[] = [];
    const rows = slice.map((m, j) => {
      params.push(importedMessageId(sessionId, i + j, fingerprint), sessionId, m.role, stripNul(m.content, pg), stamps[i + j],
        m.model_id || null, m.reasoning ? stripNul(m.reasoning, pg) : null, m.role === 'assistant' ? agentSlug : null, 'import');
      return '(?, ?, ?, ?, ?, ?, ?, ?, ?)';
    });
    await query(
      `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, reasoning, agent_slug, origin) VALUES ${rows.join(', ')} ON CONFLICT (id) DO NOTHING`,
      params,
    );
  }
}

/** Postgres 的 TEXT 不收 \u0000(整条 INSERT 会失败);导出文件里偶尔带。SQLite 原样收,照留。 */
function stripNul(s: string, pg: boolean): string {
  return pg && s.includes('\u0000') ? s.replace(/\u0000/g, '') : s;
}

function firstLine(messages: ImportMessageInput[]): string {
  const u = messages.find((m) => m.role === 'user' && m.content.trim());
  return u ? u.content.trim().split('\n')[0].slice(0, 60) : '';
}
