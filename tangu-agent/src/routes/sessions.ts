/**
 * 会话 CRUD + 历史消息 + 会话级 agent 配置(桌面/多端客户端用;handler 自带 authMiddleware)。
 *   GET    /agent/sessions?archived=&limit=        列出本人本 app 的会话(updated_at 降序)
 *   POST   /agent/sessions { title?, model_id?, emoji? }
 *   PATCH  /agent/sessions/:id { title?, archived?, model_id?, emoji? }
 *   DELETE /agent/sessions/:id                     显式级联(messages/runs/steps/events——standalone 无 FK CASCADE)
 *   GET    /agent/sessions/:id/messages?limit=&before=
 *   POST   /agent/sessions/:id/messages/delete { ids }  按 id 截断消息(编辑重发 / 重新生成前清掉该点及之后)
 *   GET    /agent/sessions/:id/config              读 agent_config(enabledSkillIds/execMode/approvalMode/…)
 *   PUT    /agent/sessions/:id/config              整体替换 agent_config
 *   POST   /agent/sessions/:id/aside { question, quote?, thread?, model_id? }  旁聊 /btw(SSE,不落库)
 */
import { Router, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { query } from '../core/db.js';
import { resolveProfile } from '../seams/appProfile.js';
import { compactSession, getLatestSummary, rowCoverage, type Checkpoint } from '../services/compaction.js';
import { resolveCompactionSettings, globalCompactionLayer, updateGlobalCompaction, normalizeCompactionLayer, DEFAULT_COMPACTION_SETTINGS } from '../services/compactionSettings.js';
import { estimateTokensRough } from '../services/contextBudget.js';
import { deps } from '../seams/runtime.js';
import { bumpHistoryRevision } from '../services/historyRevision.js';
import { sessionHasActiveRun } from '../services/agentLoop.js';
import { getAgent } from '../agents/agentRegistry.js';
import { branchSession } from '../services/sessionBranch.js';
import { listCheckpoints, restoreCodeSince, removeSessionCheckpoints } from '../services/checkpoints.js';
import { searchSessions, splitTerms, dayArg, fmtDate } from '../services/sessionSearch.js';
import { isValidSlug } from '../agents/agentRegistry.js';
import { isDelegateActive } from '../services/delegateTranscript.js';
import { ensureMemberSession, memberRunConfig } from '../services/teamRuns.js';
import { recoverTeamOutputs } from '../services/teamOutputs.js';
import { withKeyLock } from '../core/keyLock.js';
import { answerAside, normalizeAsideInput } from '../services/aside.js';
import { normalizeClientTag } from './runs.js';

const router = Router();

export const SESSION_COLS = 'id, title, summary, model_id, archived, emoji, agent_config, project_path, project_name, projectless, created_at, updated_at';

/** preset 合法值:缺省/null(= work)、'coding'、'chat'。写接口对非法值 400,不静默折成 work(creview 09-07 E5)。 */
export function validPreset(v: unknown): boolean {
  return v == null || v === 'coding' || v === 'chat';
}

/** 轨道身份类会话事实(建会话写一次、跑过一轮即锁):preset(既有)+ 私聊(Agent / 外部引擎)+ 独立团队。
 *  运行模式键(groupChat / groupAgents)刻意不在此列 —— 它们要在会话中途可进可退。新增一项必须四处同改:
 *  POST 校验、PUT 校验 + 消息数门、本锁、引擎侧(agentLoop 的 pickSessionFacts/bindSessionFacts「存值为准」)。 */
export const LOCKED_SESSION_FACT_KEYS = ['preset', 'soloAgentSlug', 'soloEngineId', 'teamSlug'] as const;
const SOLO_ENGINE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** 会话事实校验:非法返回错误串(写接口 400,不静默折成合法值),合法返回 null。三个轨道身份键互斥。 */
export function validSessionFacts(cfg: Record<string, any> | null | undefined): string | null {
  if (!cfg || typeof cfg !== 'object') return null;
  if (!validPreset(cfg.preset)) return 'invalid preset';
  for (const k of ['soloAgentSlug', 'teamSlug'] as const) {
    if (cfg[k] != null && (typeof cfg[k] !== 'string' || !isValidSlug(cfg[k]))) return `invalid ${k}`;
  }
  if (cfg.soloEngineId != null && (typeof cfg.soloEngineId !== 'string' || !SOLO_ENGINE_ID_RE.test(cfg.soloEngineId))) return 'invalid soloEngineId';
  const set = [cfg.soloAgentSlug, cfg.soloEngineId, cfg.teamSlug].filter((v) => v != null).length;
  if (set > 1) return 'soloAgentSlug / soloEngineId / teamSlug are mutually exclusive';
  return null;
}

/** 空白会话锁的服务端不变量(creview 09-07 E4/F3,泛化到全部锁定键):会话一旦有消息,存值里**已有的**锁定键不可被整对象写接口
 *  改掉 —— 客户端加载窗口里从 {} 起步的 PUT、漏传、或写别的值都改不了;空白会话与不含该键的老会话照旧整体替换(逐键判断)。 */
export function applySessionFactLock(stored: unknown, cfg: Record<string, unknown>, messageCount: number): Record<string, unknown> {
  if (!stored || typeof stored !== 'object' || messageCount <= 0) return cfg;
  let out = cfg;
  for (const k of LOCKED_SESSION_FACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(stored, k)) continue;
    if (out === cfg) out = { ...cfg };
    out[k] = (stored as any)[k];
  }
  return out;
}
/** 旧名(preset 单键时代)保留给既有调用方/测试;语义 = applySessionFactLock。 */
export const applyPresetLock = applySessionFactLock;

function hasLockedFactKey(stored: unknown): boolean {
  return !!stored && typeof stored === 'object' && LOCKED_SESSION_FACT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(stored, k));
}

function parseMaybeJson(v: any): any {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

export function rowToSession(r: any): any {
  return { ...r, agent_config: parseMaybeJson(r.agent_config), projectless: !!r.projectless };
}

/** 取本人会话行(含 app 归属校验);不存在/非本人 → null。 */
async function getOwnSession(sessionId: string, userId: string): Promise<any | null> {
  const rows = await query<any[]>(
    `SELECT ${SESSION_COLS}, user_id, app_id FROM chat_sessions WHERE id = ? LIMIT 1`,
    [sessionId],
  );
  const s = rows[0];
  if (!s || s.user_id !== userId) return null;
  return s;
}

router.get('/agent/sessions', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const profile = resolveProfile(req.query.app_id ? String(req.query.app_id) : undefined);
    if (!profile) return res.status(400).json({ detail: `unknown app_id: ${req.query.app_id}` });
    const archived = req.query.archived === 'true';
    const limit = Math.floor(Math.min(Math.max(1, Number(req.query.limit) || 200), 500)); // floor:非整数插进 LIMIT 会成非法 SQL
    await recoverTeamOutputs(req.params.id, userId);
    // kind = 'user' 排除 Special Agent（historian/muse）工作会话——它们隔离不进会话列表。
    const rows = await query<any[]>(
      `SELECT ${SESSION_COLS} FROM chat_sessions
       WHERE user_id = ? AND app_id = ? AND archived = ? AND kind = 'user'
       ORDER BY updated_at DESC LIMIT ${limit}`,
      [userId, profile.appId, archived],
    );
    res.json({ sessions: rows.map(rowToSession) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list sessions failed' });
  }
});

router.post('/agent/sessions', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { title, model_id, emoji, app_id, project_path, project_name, projectless, agent_config } = req.body || {};
    const profile = resolveProfile(app_id);
    if (!profile) return res.status(400).json({ detail: `unknown app_id: ${app_id}` });
    // 初始 agent_config 与建会话同一条 INSERT(原子):客户端不必再补一次 PUT——补 PUT 失败会留下没有 preset/execMode 的
    // chat 会话,重载后被当 work 初始化(creview 09-07 F2)。老客户端不传 → null,行为不变。
    const initCfg = agent_config && typeof agent_config === 'object' && !Array.isArray(agent_config) ? agent_config : null;
    const factErr = validSessionFacts(initCfg);
    if (factErr) return res.status(400).json({ detail: factErr });
    const id = uuidv4();
    await query(
      `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, emoji, project_path, project_name, projectless, agent_config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, profile.appId,
       typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'New Chat',
       typeof model_id === 'string' && model_id ? model_id : profile.defaultModelId || null,
       typeof emoji === 'string' && emoji ? emoji.slice(0, 16) : null,
       typeof project_path === 'string' && project_path ? project_path.slice(0, 1000) : null,
       typeof project_name === 'string' && project_name ? project_name.slice(0, 255) : null,
       projectless === true,
       initCfg ? JSON.stringify(initCfg) : null],
    );
    const rows = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ?`, [id]);
    res.json({ session: rowToSession(rows[0]) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'create session failed' });
  }
});

// 从某条消息(含)处分支出新会话:继承到该点为止的历史(区别于 POST /agent/sessions 的空会话)。
// message_id 为分支点(通常是某条 AI 回复);title 可选(缺省取源会话标题)。
router.post('/agent/sessions/:id/branch', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const messageId = typeof req.body?.message_id === 'string' ? req.body.message_id : '';
    if (!messageId) return res.status(400).json({ detail: 'message_id required' });
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    const r = await branchSession({ sourceSessionId: req.params.id, userId, appId: s.app_id, messageId, title });
    if (!r) return res.status(404).json({ detail: 'branch source/message not found' });
    const rows = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ?`, [r.id]);
    res.json({ session: rowToSession(rows[0]), copied: r.copied });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'branch session failed' });
  }
});

// 某会话名下的 Background Session(@讨论 / Historian 辅助讨论等 kind≠'user' 的隐藏子会话,
// 经 parent_session_id 指回来源会话)。右栏「子聊天」轮询;各自带最新 run(id+status)供面板
// 订阅/回放——已结束的 run 由面板 SSE 重放全程。后台会话在主 run 结束后才出现是常态
//(Historian 辅助讨论),无法靠主 run 的实时 'subchat' 事件,故此持久端点是统一事实来源。
router.get('/agent/sessions/:id/background', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    // ?kind=teamwork:团队成员的工作会话(Team Desk 复原用;一人一条,按 agent_config.agentSlug 归属)。不传 = 所有隐藏子会话,最近 100 条。
    const kind = typeof req.query.kind === 'string' && /^[a-z]{1,16}$/.test(req.query.kind) ? req.query.kind : null;
    const rows = await query<any[]>(
      `SELECT id, kind, title, created_at, agent_config FROM chat_sessions
       WHERE parent_session_id = ? AND user_id = ? AND kind != 'user'${kind ? ' AND kind = ?' : ''}
       ORDER BY created_at DESC LIMIT 100`,
      kind ? [req.params.id, userId, kind] : [req.params.id, userId],
    );
    const background: any[] = [];
    for (const s of rows) {
      const r = await query<any[]>(
        `SELECT id, status FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
        [s.id],
      );
      let agentSlug: string | null = null;
      try { const c = typeof s.agent_config === 'string' ? JSON.parse(s.agent_config) : s.agent_config; agentSlug = typeof c?.agentSlug === 'string' ? c.agentSlug : null; } catch { /* 畸形配置按无归属 */ }
      background.push({
        sessionId: s.id, kind: s.kind, title: s.title, createdAt: s.created_at, agentSlug,
        runId: r[0]?.id || null, runStatus: isDelegateActive(s.id) ? 'running' : r[0]?.status || null,
      });
    }
    res.json({ background });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list background sessions failed' });
  }
});

// Hidden child sessions can be opened without promoting them into the main session list.
router.post('/agent/sessions/:id/team-members/:slug', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const parent = await getOwnSession(req.params.id, req.user!.userId);
    if (!parent) return res.status(404).json({ detail: 'Session not found' });
    const cfg = parseMaybeJson(parent.agent_config) || {};
    const slug = req.params.slug;
    const inline = (cfg.groupTempAgents || []).find((a: any) => a.slug === slug);
    if (!cfg.groupChat || (!cfg.groupAgents?.includes(slug) && !inline)) return res.status(404).json({ detail: 'Team member not found' });
    const member = inline || await getAgent(slug);
    if (!member) return res.status(404).json({ detail: 'Agent not found' });
    const a = {
      teamSessionId: parent.id, userId: req.user!.userId, appId: parent.app_id, modelId: parent.model_id,
      member, inlineDef: !!inline, teamRunId: '', delta: '', cycle: 0, roster: (cfg.groupAgents || []).join(', '),
      execMode: cfg.execMode || 'host', cwd: cfg.cwd || parent.project_path || undefined, extraRoots: cfg.extraRoots,
      wsProject: cfg.workspaceProject, approvalMode: cfg.approvalMode, signal: new AbortController().signal,
    };
    const id = await ensureMemberSession(a);
    let session = await getOwnSession(id, req.user!.userId);
    // Only initialize a new carrier. Never overwrite a running member's scope or user overrides.
    if (!parseMaybeJson(session.agent_config)?.execMode) {
      await query('UPDATE chat_sessions SET agent_config = ? WHERE id = ?', [JSON.stringify(memberRunConfig(a)), id]);
      session = await getOwnSession(id, req.user!.userId);
    }
    res.json({ session: rowToSession(session) });
  } catch (e: any) { res.status(500).json({ detail: e?.message || 'Open team member failed' }); }
});

router.get('/agent/sessions/:id/detail', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const session = await getOwnSession(req.params.id, req.user!.userId);
    if (!session) return res.status(404).json({ detail: 'Session not found' });
    res.json({ session: { ...rowToSession(session), delegate_running: isDelegateActive(session.id) } });
  } catch (e: any) { res.status(500).json({ detail: e?.message || 'load session failed' }); }
});

router.patch('/agent/sessions/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const { title, archived, model_id, emoji, project_path, project_name, projectless } = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    if (typeof title === 'string') { sets.push('title = ?'); params.push(title.trim().slice(0, 200)); }
    if (typeof archived === 'boolean') { sets.push('archived = ?'); params.push(archived); }
    if (typeof model_id === 'string') { sets.push('model_id = ?'); params.push(model_id || null); }
    if (typeof emoji === 'string' || emoji === null) { sets.push('emoji = ?'); params.push(emoji ? String(emoji).slice(0, 16) : null); }
    if (typeof project_path === 'string' || project_path === null) { sets.push('project_path = ?'); params.push(project_path ? String(project_path).slice(0, 1000) : null); }
    if (typeof project_name === 'string' || project_name === null) { sets.push('project_name = ?'); params.push(project_name ? String(project_name).slice(0, 255) : null); }
    if (typeof projectless === 'boolean') { sets.push('projectless = ?'); params.push(projectless); }
    if (!sets.length) return res.status(400).json({ detail: 'nothing to update' });
    // `updated_at` 是会话列表的消息活动时间,不是通用行修改时间。改名、归档、换模型/项目
    // 都不能把项目顶到最近活动首位;它只由消息落库路径刷新。
    params.push(req.params.id);
    await query(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
    const rows = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ?`, [req.params.id]);
    res.json({ session: rowToSession(rows[0]) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'update session failed' });
  }
});

router.delete('/agent/sessions/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const sid = req.params.id;
    // 显式级联(standalone schema 无外键 CASCADE;顺序:叶 → 根)。
    await query(`DELETE FROM agent_run_events WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id = ?)`, [sid]);
    await query(`DELETE FROM agent_steps WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id = ?)`, [sid]);
    await query(`DELETE FROM agent_runs WHERE session_id = ?`, [sid]);
    await query(`DELETE FROM chat_messages WHERE session_id = ?`, [sid]);
    await query(`DELETE FROM chat_sessions WHERE id = ?`, [sid]);
    bumpHistoryRevision(sid); // 在飞的后台摘要落库前会复核版本 → 丢弃
    await removeSessionCheckpoints(sid); // 代码快照跟着走,否则 home 无界增长
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete session failed' });
  }
});

router.get('/agent/sessions/:id/messages', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const limit = Math.floor(Math.min(Math.max(1, Number(req.query.limit) || 200), 500)); // floor:非整数插进 LIMIT 会成非法 SQL
    const before = Number(req.query.before) || 0;
    const rows = await query<any[]>(
      `SELECT id, role, content, reasoning, tool_calls, tool_results, attachments, display_files, agent_slug, timestamp, model_id, is_error
       FROM chat_messages WHERE session_id = ?${before ? ' AND timestamp < ?' : ''}
       ORDER BY timestamp DESC LIMIT ${limit}`,
      before ? [req.params.id, before] : [req.params.id],
    );
    rows.reverse(); // 时间正序
    res.json({
      messages: rows.map((r) => ({
        ...r,
        tool_calls: parseMaybeJson(r.tool_calls),
        tool_results: parseMaybeJson(r.tool_results),
        attachments: parseMaybeJson(r.attachments),
        display_files: parseMaybeJson(r.display_files),
      })),
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list messages failed' });
  }
});

// 按精确 id 列表删除会话内消息：编辑重发 / 重新生成时，客户端先把「截断点及之后」的消息 id 传来清掉，
// 再发起新 run。服务端每轮从 DB 全量重建上下文(hydrateHistory)——不先截断，旧轮次会污染新生成。
// 用客户端给的精确 id(而非 timestamp 区间)删除，避免同毫秒时间戳的边界歧义。前端在「无在飞 run」时才触发。
router.post('/agent/sessions/:id/messages/delete', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const sid = req.params.id;
    const ids: string[] = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((x: any) => typeof x === 'string' && x).slice(0, 1000)
      : [];
    if (!ids.length) return res.json({ ok: true, deleted: 0 });
    // 在飞/排队 run 时拒绝:跨端共享同一会话时,删消息会让在跑的 run hydrate 出残缺历史 → 污染/重复轮次。
    const inflight = await query<any[]>(
      `SELECT 1 FROM agent_runs WHERE session_id = ? AND status IN ('queued','running') LIMIT 1`,
      [sid],
    );
    if (inflight.length || isDelegateActive(req.params.id)) return res.status(409).json({ detail: 'run in progress' });
    const placeholders = ids.map(() => '?').join(',');
    // 删前取被删消息的最早时间戳:若落在某压缩检查点覆盖区内,该检查点摘要会继续叙述已删轮次 → 连带失效。
    const tsRows = await query<any[]>(
      `SELECT MIN(timestamp) AS mn FROM chat_messages WHERE session_id = ? AND id IN (${placeholders})`,
      [sid, ...ids],
    );
    const minTs = Number(tsRows[0]?.mn) || 0;
    await query(
      `DELETE FROM chat_messages WHERE session_id = ? AND id IN (${placeholders})`,
      [sid, ...ids],
    );
    // 失效覆盖到被删区间的压缩检查点(消息已删,摘要不能再吞失败,故吞错保响应)。
    if (minTs) {
      await query(`DELETE FROM session_summaries WHERE session_id = ? AND through_timestamp >= ?`, [sid, minTs]).catch(() => {});
    }
    bumpHistoryRevision(sid); // 正在跑的后台摘要(run 收尾后的惰性检查点)落库前复核版本 → 基于旧快照的结果作废
    res.json({ ok: true, deleted: ids.length });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete messages failed' });
  }
});

router.get('/agent/sessions/:id/config', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    res.json({ agent_config: parseMaybeJson(s.agent_config) || {} });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'get config failed' });
  }
});

/** 从「按 e.id 降序」的 usage 事件里取最近一条**主循环**的(C-5:带 phase 的是后台调用,
 *  prompt 是压缩/子代理/脑暴自己的上下文)。PG 给 jsonb 对象、SQLite 给 JSON 字符串,故统一过
 *  parseMaybeJson;窗口内全是后台事件 → {} → contextTokens 0(与「没有事件」同义)。 */
export function pickMainLoopUsage(rows: Array<{ payload?: any }> | undefined): any {
  return mainLoopUsageIn(rows || []) ?? {};
}

/** 同一判别的「找没找到」版:分页要靠 undefined 决定继不继续往回翻(`{}` 分不开「找到一条空
 *  payload」与「一条主循环 usage 都没有」)。 */
function mainLoopUsageIn(rows: Array<{ payload?: any }>): any | undefined {
  for (const r of rows) {
    const p = parseMaybeJson(r?.payload);
    if (p && typeof p === 'object' && p.phase == null) return p;
  }
  return undefined;
}

/** 一页 usage 事件(按 e.id 降序);cursor=null 取最新一页,否则取 id < cursor 的下一页。 */
export type UsagePageFetcher = (cursor: number | null) => Promise<Array<{ id?: any; payload?: any }>>;

/**
 * 向前(时间倒序)翻页找最近一条**主循环** usage。
 * 固定 20 条窗口不行:一次 delegate 就能产出 20+ 条后台 usage,窗口内全是后台事件时本接口会
 * 谎报 contextTokens=0,尽管更早明明有有效的主循环记录(Codex 评审三轮 #7)。
 * 游标用 `e.id <`(而非 OFFSET):翻页期间有新事件写入也不会错位重复。
 * ponytail: 上限 10 页 × 20 条 = 200 行 —— 够覆盖已知生产者上限(delegate 24 轮 + 脑暴席位),
 * 再深的就如实回落 0,不为极端情形做无界扫描。
 */
export async function findMainLoopUsage(
  fetchPage: UsagePageFetcher,
  opts?: { pageSize?: number; maxPages?: number },
): Promise<any> {
  const pageSize = opts?.pageSize ?? 20;
  const maxPages = opts?.maxPages ?? 10;
  let cursor: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage(cursor);
    if (!rows?.length) break;
    const hit = mainLoopUsageIn(rows);
    if (hit) return hit;
    if (rows.length < pageSize) break; // 最后一页,不用再翻
    const nextCursor = Number(rows[rows.length - 1]?.id);
    if (!Number.isFinite(nextCursor)) break; // 后端没给 id:退回单页行为,绝不死循环
    cursor = nextCursor;
  }
  return {};
}

/** 该会话最近一条主循环 usage 事件的 payload(没有 → {})。 */
function lastMainLoopUsage(sessionId: string): Promise<any> {
  return findMainLoopUsage(async (cursor) => query<any[]>(
    `SELECT e.id, e.payload FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id
     WHERE r.session_id = ? AND e.type = 'usage'${cursor === null ? '' : ' AND e.id < ?'}
     ORDER BY e.id DESC LIMIT 20`,
    cursor === null ? [sessionId] : [sessionId, cursor],
  ));
}

const compactedContextTokens = (summary: string, lastUsage: any): number =>
  estimateTokensRough(summary) + Math.round(((Number(lastUsage?.systemBytes) || 0) + (Number(lastUsage?.toolsBytes) || 0)) / 4);
/**
 * 会话「当前上下文占用」:缺省 = 最近一条主循环 usage 的 prompt(实测)。例外:检查点已经**整行覆盖到最后一行**
 * ——只有手动 /compact 会这样(run 内压缩留着最近一段、惰性检查点只管 hydrate 窗口之外),且其后还没跑过新 run——
 * 那条 usage 是压缩前的,下个 run 回放的只剩 摘要 + 固定头(系统提示 + 工具定义,取上次实测的字节数),改报这个粗估。
 * 别把判据放宽成「检查点比 usage 新」:惰性检查点也满足,而它之后整个窗口照样回放,粗估会把 30 万报成 1 万。
 * ponytail: 手动压缩后紧跟一个没产生 usage 的失败 run(配额拒收)→ 多出的行让判据落空,退回压缩前的实测值,下一次成功调用自愈。
 */
export function sessionContextTokens(lastUsage: any, cp: Checkpoint | null, lastRow: { id: string; timestamp?: number | null } | undefined): number {
  if (!cp || !lastRow || rowCoverage(lastRow, cp) !== 'covered') return Number(lastUsage?.prompt) || 0;
  return compactedContextTokens(cp.summary, lastUsage);
}

// 本会话累计 token 消耗（跨 run 求和），供客户端「本会话 token」显示。
// contextTokens = 最近一次 usage 事件的 prompt（当前上下文占用）：客户端只在流式期间收到 usage 事件，
// 重载/重开会话后没有它，上下文圈只能显示 0%（连「该不该压缩」都判断不了）。事件本就落库，这里回放最后一条主循环的（见 pickMainLoopUsage）。
router.get('/agent/sessions/:id/usage', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const rows = await query<any[]>(
      `SELECT COALESCE(SUM(tokens_total), 0) AS total FROM agent_runs WHERE session_id = ?`,
      [req.params.id],
    );
    // e.id 单调递增（PG BIGSERIAL / SQLite AUTOINCREMENT），跨 run 取真正的最后一条。
    // 每页 20 条再在 JS 里挑主循环那条(不写 SQL 的 JSON 谓词——PG jsonb 与 SQLite text 两套语法);
    // 整页都是后台事件就按游标继续往回翻(见 findMainLoopUsage 的上限说明)。
    const last = await lastMainLoopUsage(req.params.id);
    // 手动 /compact 不产生 usage:不看检查点的话,重开应用后环又回到压缩前那个数(09-20)。thin worker 没有本地库 → 查不到就照旧。
    const lastRow = (await query<any[]>(`SELECT id, timestamp FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`, [req.params.id]).catch(() => []))[0];
    res.json({ tokensTotal: Number(rows[0]?.total) || 0, contextTokens: sessionContextTokens(last, await getLatestSummary(req.params.id), lastRow) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'usage failed' });
  }
});

// 手动压缩上下文（slash / 按钮触发）：生成并持久化一个总结检查点，后续 run 起步即精简。
// ── 时间线骨架:会话内各 run 的事件序列(不含正文),供「设置→高级→导出日志」与
//    scripts/stall-timeline.mjs 归属「秒数去哪了」(2026-09-06 取证:本机 52% 墙钟在等首帧)。
//    token/reasoning/tool_stream 连续同类折叠成一段(首末时刻+条数);其余事件只留定位字段
//    (工具名/耗时/阶段/用量/首帧毫秒)。最近 40 个 run,单会话导出可控。──
export function timelineFields(type: string, p: any): Record<string, unknown> {
  switch (type) {
    case 'tool_call': return { name: p?.name };
    case 'tool_result': return { name: p?.name, elapsedMs: p?.elapsedMs, isError: !!p?.isError, outputChars: p?.outputChars };
    // context_info 的窗口 / 触发线与压缩事件的结果字段一并透传:09-19 那份反馈包(prompt 顶到 387k、零压缩事件)
    // 答不了「引擎当时认的窗口是多少、线在哪」,只能回生产后台反推。非这几类 status 上它们是 undefined,res.json 丢掉。
    case 'status': return {
      phase: p?.phase ?? p?.state, stage: p?.stage, bytes: p?.bytes, uploadMs: p?.uploadMs, attempt: p?.attempt, waitMs: p?.waitMs, iteration: p?.iteration,
      ctxWindow: p?.ctxWindow, ctxWindowSource: p?.ctxWindowSource, compactAt: p?.compactAt, compactionEnabled: p?.compactionEnabled,
      reason: p?.reason, persisted: p?.persisted, fallback: p?.fallback, summarized: p?.summarized, beforeTokens: p?.beforeTokens, afterTokens: p?.afterTokens,
    };
    // phase 分辨「后台调用(compaction/historian/brainstorm/muse-judge/delegate)」与主循环调用(无 phase);
    // 缺了它导出的时间线两者混在一起,stall-timeline.mjs 也分不开。主循环侧 undefined,res.json 直接丢掉,不占体积。
    // A4/C-2 的仪器字段一并透传:cacheReported 分「上游没报缓存」与「真 0 命中」,systemBytes/toolsBytes
    // 是固定头的两块体量,headHash 串起 cache_probe,reasoningTokens 是推理分账 —— 少任何一个,
    // 导出的时间线都撑不起「缓存为什么没命中 / output 花在哪」这两问(Codex 评审三轮 #6)。
    // 主循环没报时这些键是 undefined,res.json 直接丢掉,不占导出体积。
    case 'usage': return {
      prompt: p?.prompt, completion: p?.completion, cached: p?.cached, phase: p?.phase,
      ttftMs: p?.ttftMs, uploadMs: p?.uploadMs, llmMs: p?.llmMs, requestBytes: p?.requestBytes, iteration: p?.iteration,
      cacheReported: p?.cacheReported, systemBytes: p?.systemBytes, toolsBytes: p?.toolsBytes,
      headHash: p?.headHash, reasoningTokens: p?.reasoningTokens,
    };
    // ponytail: 只带定位字段,不带 segments —— 逐段 hash/bytes 一次迭代九条,导出日志用不上;
    // 要逐段对比走 scripts/cache-hit-report.mjs,它直接读 agent_run_events。
    case 'cache_probe': return { probeSeq: p?.probeSeq, headHash: p?.headHash, changedSegments: p?.changedSegments, headHashSameAsAgentModel: p?.headHashSameAsAgentModel };
    case 'error': return { error: String(p?.error ?? '').slice(0, 200), aborted: !!p?.aborted };
    // 为什么问(escalate / mode / custom-ask)、引擎当时生效的档、团队转发的是哪位成员 —— 09-21 那份反馈只剩工具名,
    // 分不清「成员没跟上完全通行」和「越界写」。三者都不含路径 / 参数,可以进导出。
    case 'approval_request': return { name: p?.name, reason: p?.reason?.kind, mode: p?.reason?.mode, agent: p?.agentSlug };
    case 'approval_result': return { action: p?.action };
    default: return {};
  }
}
function timelineIso(v: any): string {
  if (v instanceof Date) return v.toISOString();
  const s = String(v ?? '');
  // SQLite CURRENT_TIMESTAMP 是无时区标记的 UTC;PG 侧已是 Date。带时区的原样解析。
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}
router.get('/agent/sessions/:id/timeline', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const s = await getOwnSession(req.params.id, req.user!.userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const runs = await query<any[]>(
      `SELECT id, status, model_id, error, created_at FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 40`,
      [req.params.id],
    );
    runs.reverse(); // 时间正序
    const out: any[] = [];
    for (const r of runs) {
      // 流式帧只取时刻不取正文(payload 置 NULL):一个长 run 几万条 token 行,正文既没用又占传输。
      const rows = await query<any[]>(
        `SELECT seq, type, CASE WHEN type IN ('token','reasoning','tool_stream') THEN NULL ELSE payload END AS payload, created_at
         FROM agent_run_events WHERE run_id = ? ORDER BY seq`,
        [r.id],
      );
      const events: any[] = [];
      for (const row of rows) {
        const t = timelineIso(row.created_at);
        const last = events[events.length - 1];
        if (row.type === 'token' || row.type === 'reasoning' || row.type === 'tool_stream') {
          if (last && last.type === row.type && last.n) { last.tEnd = t; last.n++; continue; }
          events.push({ seq: row.seq, type: row.type, t, tEnd: t, n: 1 });
          continue;
        }
        events.push({ seq: row.seq, type: row.type, t, ...timelineFields(row.type, parseMaybeJson(row.payload)) });
      }
      out.push({ id: r.id, status: r.status, model_id: r.model_id, error: r.error || null, created_at: timelineIso(r.created_at), events });
    }
    res.json({ runs: out });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'timeline failed' });
  }
});

router.post('/agent/sessions/:id/compact', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const modelId = (typeof req.body?.model_id === 'string' && req.body.model_id) || s.model_id || '';
    if (!modelId) return res.status(400).json({ detail: '需要 model_id 才能压缩（会话未设模型）' });
    // 在途 run 正往 chat_messages 落段、也可能正落自己的检查点:手动压缩不与它并发(TUI 同款拒绝)
    if (sessionHasActiveRun(req.params.id) || isDelegateActive(req.params.id)) return res.status(409).json({ detail: 'Session has an active run; compact after it finishes' });
    // instructions = /compact <focus>:一次性的 Additional focus(pi 同款),不落配置
    const focus = typeof req.body?.instructions === 'string' ? req.body.instructions.trim().slice(0, 2000) : '';
    // 旋钮与自动压缩同一契约:会话 agent_config.compaction > 该会话 Agent 的 [compaction] > config.json > 缺省
    let sessionCfg: any = (s as any).agent_config;
    if (typeof sessionCfg === 'string') { try { sessionCfg = JSON.parse(sessionCfg); } catch { sessionCfg = null; } }
    const agentSlug = typeof sessionCfg?.agentSlug === 'string' ? sessionCfg.agentSlug : '';
    const def = agentSlug ? await getAgent(agentSlug).catch(() => null) : null;
    const r = await compactSession(req.params.id, modelId, (s as any).app_id || 'tangu', undefined, {
      focus: focus || undefined,
      settings: resolveCompactionSettings(sessionCfg?.compaction, def?.compaction, globalCompactionLayer()),
    });
    if (!r.ok) return res.json({ ok: false, reason: r.reason });
    // 压缩后的上下文占用(粗估,见 sessionContextTokens):客户端的进度环读的是「最近一条主循环 usage」,手动压缩不产生
    // usage → 不给这个数,环会停在压缩前的值上,看起来像「压不下去」,直到下一条消息才自愈。重开应用走 /usage,同一个函数。
    const lastUsage = await lastMainLoopUsage(req.params.id).catch(() => ({}));
    res.json({ ok: true, summarizedCount: r.summarizedCount, throughTimestamp: r.throughTimestamp, contextTokens: compactedContextTokens(r.summary || '', lastUsage) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'compact failed' });
  }
});

// 旁聊(/btw):带着本会话上下文问一句题外话(services/aside.ts)。SSE:delta* → done | error。
// 不落库、不进 run 队列 —— 主 run 在飞也能问,且互不打断;客户端断开即中止上游请求。
router.post('/agent/sessions/:id/aside', authMiddleware, async (req: AuthRequest, res) => {
  const s = await getOwnSession(req.params.id, req.user!.userId).catch(() => null);
  if (!s) return res.status(404).json({ detail: 'Session not found' });
  const input = normalizeAsideInput(req.body);
  if (!input) return res.status(400).json({ detail: 'question required' });
  const modelId = (typeof req.body?.model_id === 'string' && req.body.model_id) || s.model_id || resolveProfile(s.app_id)?.defaultModelId || '';
  if (!modelId) return res.status(400).json({ detail: 'model_id required' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': open\n\n');
  const ac = new AbortController();
  // res 的 close 才是「连接没了」;req 的 close 在读完请求体时就会触发。
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const write = (event: object): void => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    (res as any).flush?.();
  };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n'); }, 15_000);
  try {
    const answer = await answerAside({
      sessionId: s.id, modelId, appId: s.app_id, client: normalizeClientTag(req.body?.client),
      input, signal: ac.signal, onToken: (text) => write({ type: 'delta', text }),
    });
    write({ type: 'done', ...answer, modelId });
  } catch (e: any) {
    if (!ac.signal.aborted) write({ type: 'error', error: e?.message || 'side question failed' });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

/**
 * 全局压缩旋钮(config.json `compaction` 段)的读写口,供设置页用:
 *   GET /agent/compaction → { settings(全局层,只含已设字段), defaults, writable }
 *   PUT /agent/compaction { thresholdPercent: 30 } → { settings };某键给 null = 删掉交还缺省
 * 对下一个 run 生效(run 开头现读,不用重启)。⚠️ 写的是本进程的 config.json → 云端 worker(hostExec=false)
 * 一律 404,与 modelOverrides / providers 同门:那里一个进程服务所有用户。
 */
export function applyCompactionUpdate(body: any, hostExec: boolean): { code: number; body: any } {
  if (!hostExec) return { code: 404, body: { detail: 'Compaction settings are only available on a local engine (desktop / TUI)' } };
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) return { code: 400, body: { detail: 'compaction fields required' } };
  try {
    return { code: 200, body: { settings: updateGlobalCompaction(body) } };
  } catch (e: any) {
    return { code: 400, body: { detail: e?.message || 'invalid compaction settings' } };
  }
}
router.get('/agent/compaction', authMiddleware, (_req, res) => {
  res.json({ settings: normalizeCompactionLayer(globalCompactionLayer()), defaults: DEFAULT_COMPACTION_SETTINGS, writable: deps().profile.capabilities.hostExec });
});
router.put('/agent/compaction', authMiddleware, (req, res) => {
  const r = applyCompactionUpdate(req.body, deps().profile.capabilities.hostExec);
  res.status(r.code).json(r.body);
});

// 会话内容级检索(P3):标题/摘要/**消息正文**。与模型侧 search_sessions 共用
// services/sessionSearch 的同一条 SQL —— 两边各写一份就会出现「界面搜得到、模型搜不到」。
// 与工具的唯一差别:不排除当前会话(用户就可能在找手上这段),且回传结构化命中(带 messageId 供跳转)。
router.get('/agent/sessions/search', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const profile = resolveProfile(req.query.app_id ? String(req.query.app_id) : undefined);
    if (!profile) return res.status(400).json({ detail: `unknown app_id: ${req.query.app_id}` });
    for (const k of ['before', 'after'] as const) {
      if (String(req.query[k] ?? '').trim() && !dayArg(req.query[k])) {
        return res.status(400).json({ detail: `${k} must be a YYYY-MM-DD date` });
      }
    }
    const hits = await searchSessions({
      userId,
      appId: profile.appId,
      terms: splitTerms(String(req.query.q ?? '')),
      limit: Math.floor(Math.min(Math.max(1, Number(req.query.limit) || 20), 50)),
      before: dayArg(req.query.before),
      after: dayArg(req.query.after),
    });
    res.json({
      hits: hits.map((h) => ({
        id: h.id,
        title: String(h.title ?? ''),
        summary: String(h.summary ?? ''),
        archived: h.archived === true || h.archived === 1 || h.archived === '1',
        updatedAt: fmtDate(h.updated_at),
        ...(h.hit ? { hit: h.hit } : {}),
      })),
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'search sessions failed' });
  }
});

// 代码检查点(rewind):列出本会话的写工具快照 / 把代码恢复到某时刻。
// 对话侧回退复用 messages/delete;两者由客户端按用户选的档位分别调用(仅代码/仅对话/两者)。
router.get('/agent/sessions/:id/checkpoints', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const s = await getOwnSession(req.params.id, req.user!.userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    res.json({ checkpoints: await listCheckpoints(req.params.id) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list checkpoints failed' });
  }
});

router.post('/agent/sessions/:id/checkpoints/restore', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const s = await getOwnSession(req.params.id, req.user!.userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const at = Number(req.body?.at);
    if (!Number.isFinite(at) || at <= 0) return res.status(400).json({ detail: 'at (ms timestamp) is required' });
    // 与 messages/delete 同款闸:在飞 run 正在改文件,恢复会与它对写。
    const inflight = await query<any[]>(
      `SELECT 1 FROM agent_runs WHERE session_id = ? AND status IN ('queued','running') LIMIT 1`,
      [req.params.id],
    );
    if (inflight.length || isDelegateActive(req.params.id)) return res.status(409).json({ detail: 'run in progress' });
    res.json(await restoreCodeSince(req.params.id, at));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'restore checkpoint failed' });
  }
});

/** PATCH 体并进存值:null = 删这个键,其余逐键覆盖;没提到的键原样保留。 */
export function mergeConfigPatch(stored: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
}

/** 会话配置两个写口共用一条路径:PUT = 整对象替换(老客户端 / 新会话初始配置),PATCH = 只带要改的键、并进存值。
 *  客户端拿本地缓存整对象写回,会把别的窗口改过的、或同窗口先发后到的旧值一起盖回去 —— 审批档是引擎审批时现读的存值,
 *  被盖回去 = 悄悄放宽,所以桌面各 setter 走 PATCH。同会话的两种写都按会话串行:读存值 → 合并 → 落库之间不许别的写插进来。 */
async function writeSessionConfig(req: AuthRequest, res: Response, body: Record<string, any>, merge: boolean): Promise<void> {
  const id = req.params.id;
  await withKeyLock(`session:config:${id}`, async () => {
    const s = await getOwnSession(id, req.user!.userId);
    if (!s) return void res.status(404).json({ detail: 'Session not found' });
    const factErr = validSessionFacts(body);
    if (factErr) return void res.status(400).json({ detail: factErr });
    const stored = parseMaybeJson(s.agent_config);
    const msgCount = hasLockedFactKey(stored)
      ? Number((await query<any[]>(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`, [id]))[0]?.n || 0)
      : 0;
    // 轨道身份键要改(存值里有、请求里不同)时,活动 run 期间一律 409:首轮 run 刚提交、用户消息还没落库(COUNT=0)那一瞬,
    // 锁按消息数是不生效的,而 dispatchRun 可能已按旧身份分了流(creview 09-16 P1)。
    // 漏传身份键不算「改」(锁会补回);只有请求里显式带了不同的值才算(PATCH 的 null = 删,也算)。
    const identityChange = hasLockedFactKey(stored) && LOCKED_SESSION_FACT_KEYS.some((k) => k !== 'preset'
      && Object.prototype.hasOwnProperty.call(stored, k) && (stored as any)[k] != null
      && Object.prototype.hasOwnProperty.call(body, k) && (body as any)[k] !== (stored as any)[k]);
    if (identityChange) {
      const active = await query<any[]>(`SELECT 1 FROM agent_runs WHERE session_id = ? AND status IN ('queued','running') LIMIT 1`, [id]);
      if (active.length) return void res.status(409).json({ detail: 'session identity is locked while a run is active' });
    }
    const cfg = applySessionFactLock(stored, merge ? mergeConfigPatch(stored, body) : body, msgCount);
    // 锁合并之后再校验一次:请求体单看合法(只带 soloEngineId),合并回存值的 soloAgentSlug 就成了双身份 —— 这种写整条拒绝(creview 09-16 P0)。
    const mergedErr = validSessionFacts(cfg);
    if (mergedErr) return void res.status(400).json({ detail: mergedErr });
    // 配置变化不是消息活动:点击会话后的懒加载/补全也可能写配置,绝不能因此刷新列表排序。
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = ?`, [JSON.stringify(cfg), id]);
    res.json({ agent_config: cfg });
  });
}

router.put('/agent/sessions/:id/config', authMiddleware, async (req: AuthRequest, res) => {
  try {
    await writeSessionConfig(req, res, req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}, false);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'put config failed' });
  }
});

router.patch('/agent/sessions/:id/config', authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ detail: 'config patch must be an object' });
    await writeSessionConfig(req, res, req.body, true);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'patch config failed' });
  }
});

export default router;
