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
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { query, getNowSql } from '../core/db.js';
import { resolveProfile } from '../seams/appProfile.js';
import { compactSession } from '../services/compaction.js';
import { branchSession } from '../services/sessionBranch.js';

const router = Router();

const SESSION_COLS = 'id, title, model_id, archived, emoji, agent_config, project_path, project_name, created_at, updated_at';

function parseMaybeJson(v: any): any {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function rowToSession(r: any): any {
  return { ...r, agent_config: parseMaybeJson(r.agent_config) };
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
    const { title, model_id, emoji, app_id, project_path, project_name } = req.body || {};
    const profile = resolveProfile(app_id);
    if (!profile) return res.status(400).json({ detail: `unknown app_id: ${app_id}` });
    const id = uuidv4();
    await query(
      `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, emoji, project_path, project_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, profile.appId,
       typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'New Chat',
       typeof model_id === 'string' && model_id ? model_id : profile.defaultModelId || null,
       typeof emoji === 'string' && emoji ? emoji.slice(0, 16) : null,
       typeof project_path === 'string' && project_path ? project_path.slice(0, 1000) : null,
       typeof project_name === 'string' && project_name ? project_name.slice(0, 255) : null],
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
    const rows = await query<any[]>(
      `SELECT id, kind, title, created_at FROM chat_sessions
       WHERE parent_session_id = ? AND user_id = ? AND kind != 'user'
       ORDER BY created_at DESC LIMIT 10`,
      [req.params.id, userId],
    );
    const background: any[] = [];
    for (const s of rows) {
      const r = await query<any[]>(
        `SELECT id, status FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
        [s.id],
      );
      background.push({
        sessionId: s.id, kind: s.kind, title: s.title, createdAt: s.created_at,
        runId: r[0]?.id || null, runStatus: r[0]?.status || null,
      });
    }
    res.json({ background });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list background sessions failed' });
  }
});

router.patch('/agent/sessions/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const { title, archived, model_id, emoji, project_path, project_name } = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    if (typeof title === 'string') { sets.push('title = ?'); params.push(title.trim().slice(0, 200)); }
    if (typeof archived === 'boolean') { sets.push('archived = ?'); params.push(archived); }
    if (typeof model_id === 'string') { sets.push('model_id = ?'); params.push(model_id || null); }
    if (typeof emoji === 'string' || emoji === null) { sets.push('emoji = ?'); params.push(emoji ? String(emoji).slice(0, 16) : null); }
    if (typeof project_path === 'string' || project_path === null) { sets.push('project_path = ?'); params.push(project_path ? String(project_path).slice(0, 1000) : null); }
    if (typeof project_name === 'string' || project_name === null) { sets.push('project_name = ?'); params.push(project_name ? String(project_name).slice(0, 255) : null); }
    if (!sets.length) return res.status(400).json({ detail: 'nothing to update' });
    sets.push(`updated_at = ${getNowSql()}`);
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
    if (inflight.length) return res.status(409).json({ detail: 'run in progress' });
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

// 本会话累计 token 消耗（跨 run 求和），供客户端「本会话 token」显示。
router.get('/agent/sessions/:id/usage', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const rows = await query<any[]>(
      `SELECT COALESCE(SUM(tokens_total), 0) AS total FROM agent_runs WHERE session_id = ?`,
      [req.params.id],
    );
    res.json({ tokensTotal: Number(rows[0]?.total) || 0 });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'usage failed' });
  }
});

// 手动压缩上下文（slash / 按钮触发）：生成并持久化一个总结检查点，后续 run 起步即精简。
router.post('/agent/sessions/:id/compact', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const modelId = (typeof req.body?.model_id === 'string' && req.body.model_id) || s.model_id || '';
    if (!modelId) return res.status(400).json({ detail: '需要 model_id 才能压缩（会话未设模型）' });
    const r = await compactSession(req.params.id, modelId);
    if (!r.ok) return res.json({ ok: false, reason: r.reason });
    res.json({ ok: true, summarizedCount: r.summarizedCount, throughTimestamp: r.throughTimestamp });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'compact failed' });
  }
});

router.put('/agent/sessions/:id/config', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const s = await getOwnSession(req.params.id, userId);
    if (!s) return res.status(404).json({ detail: 'Session not found' });
    const cfg = req.body && typeof req.body === 'object' ? req.body : {};
    await query(`UPDATE chat_sessions SET agent_config = ?, updated_at = ${getNowSql()} WHERE id = ?`, [
      JSON.stringify(cfg), req.params.id,
    ]);
    res.json({ agent_config: cfg });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'put config failed' });
  }
});

export default router;
