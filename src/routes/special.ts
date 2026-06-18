/**
 * Special Agent（Historian / Muse）配置 + 工作视图数据 + Muse TODO 操作。handler 自带 authMiddleware。
 *   GET/POST /agent/special/config                     读/写 ~/.tangu/special-agents.json
 *   GET      /agent/special/historian/activity?limit=  Historian 活动流（special_agent_log）
 *   GET      /agent/special/muse/todos?status=         Muse TODO 列表
 *   PATCH    /agent/special/muse/todos/:id { status }  改 TODO 状态
 *   POST     /agent/special/muse/todos/inject { todoIds, sessionId }  注入选中 TODO 到会话并起 run
 *   GET      /agent/special/muse/status                Muse 运行态 + 本窗口预算余量
 *
 * 本地特性：profile.capabilities.hostExec=false（云端）一律 404。
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { query } from '../core/db.js';
import { createRun } from '../services/runStore.js';
import { enqueueRun } from '../services/agentLoop.js';
import { loadSpecialAgentsConfig, saveSpecialAgentsConfig } from '../services/specialAgentsConfig.js';
import { museStatus } from '../services/muse.js';

const router = Router();

function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: 'Special Agents 仅在本地（桌面/TUI）可用' });
    return false;
  }
  return true;
}

router.get('/agent/special/config', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json({ config: loadSpecialAgentsConfig() });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'load config failed' });
  }
});

router.post('/agent/special/config', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    res.json({ config: saveSpecialAgentsConfig(patch) });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'save config failed' });
  }
});

router.get('/agent/special/historian/activity', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
    const rows = await query<any[]>(
      `SELECT id, action, detail, session_ref, created_at FROM special_agent_log
       WHERE user_id = ? AND agent = 'historian' ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [userId],
    );
    res.json({ activity: rows || [] });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'activity failed' });
  }
});

router.get('/agent/special/muse/todos', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const rows = await query<any[]>(
      `SELECT id, title, detail, status, source_session_id, created_at FROM muse_todos
       WHERE user_id = ?${status ? ' AND status = ?' : ''} ORDER BY created_at DESC LIMIT 500`,
      status ? [userId, status] : [userId],
    );
    res.json({ todos: rows || [] });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'todos failed' });
  }
});

router.patch('/agent/special/muse/todos/:id', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const status = String(req.body?.status || '');
    if (!['pending', 'injected', 'done', 'dismissed'].includes(status)) {
      return res.status(400).json({ detail: 'invalid status' });
    }
    await query(
      `UPDATE muse_todos SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
      [status, req.params.id, userId],
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'update todo failed' });
  }
});

// 注入选中 TODO 到目标会话并起一个 run（把 TODO 详情拼成首条消息）。
router.post('/agent/special/muse/todos/inject', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const todoIds: string[] = Array.isArray(req.body?.todoIds) ? req.body.todoIds.filter((x: any) => typeof x === 'string') : [];
    const sessionId = String(req.body?.sessionId || '');
    if (!todoIds.length || !sessionId) return res.status(400).json({ detail: 'todoIds 与 sessionId 必填' });

    // 校验会话归属 + 取模型。
    const sRows = await query<any[]>(`SELECT user_id, model_id FROM chat_sessions WHERE id = ? LIMIT 1`, [sessionId]);
    const s = sRows[0];
    if (!s || s.user_id !== userId) return res.status(404).json({ detail: 'Session not found' });

    // 取选中 TODO（限本人）。
    const placeholders = todoIds.map(() => '?').join(',');
    const todos = await query<any[]>(
      `SELECT id, title, detail FROM muse_todos WHERE user_id = ? AND id IN (${placeholders})`,
      [userId, ...todoIds],
    );
    if (!todos.length) return res.status(404).json({ detail: 'no matching todos' });

    const message =
      '请处理以下来自 Muse 的待办：\n\n' +
      todos.map((t, i) => `${i + 1}. ${t.title}${t.detail ? `\n   ${t.detail}` : ''}`).join('\n\n');

    const profile = deps().profile;
    const modelId = s.model_id || profile.defaultModelId || '';
    const runId = uuidv4();
    const assistantMessageId = uuidv4();
    const userMessageId = uuidv4();
    await createRun({
      id: runId, sessionId, userId, appId: profile.appId, modelId, assistantMessageId,
      input: { message, userMessageId, attachments: [], agentConfig: {} },
    });
    enqueueRun(sessionId, runId);

    await query(
      `UPDATE muse_todos SET status = 'injected', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id IN (${placeholders})`,
      [userId, ...todoIds],
    ).catch(() => {});

    res.json({ ok: true, runId, assistantMessageId, userMessageId });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'inject failed' });
  }
});

router.get('/agent/special/muse/status', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json({ status: museStatus() });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'status failed' });
  }
});

export default router;
