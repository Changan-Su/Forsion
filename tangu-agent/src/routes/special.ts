/**
 * Special Agent（Historian / Muse）配置 + 工作视图数据 + Muse TODO 操作。handler 自带 authMiddleware。
 *   GET/POST /agent/special/config                     读/写 ~/.tangu/special-agents.json
 *   GET      /agent/special/historian/activity?limit=  Historian 活动流（special_agent_log）
 *   GET      /agent/special/muse/todos?status=         Muse TODO 列表
 *   PATCH    /agent/special/muse/todos/:id { status }  改 TODO 状态
 *   POST     /agent/special/muse/todos/inject { todoIds, sessionId }  注入选中 TODO 到会话并起 run
 *   GET      /agent/special/muse/status                Muse 运行态 + 本窗口预算余量
 *   GET      /agent/special/muse/triggers              盯任务规则列表(muse_watch 工具/构建器写入)
 *   POST     /agent/special/muse/triggers              upsert 规则(带 id 改/无 id 建;桌面「自动化」构建器)
 *   DELETE   /agent/special/muse/triggers/:id          删除一条盯任务规则
 *   GET      /agent/special/automation/sessions        agent 自动化的常驻会话列表(?triggerId= 过滤)
 *   GET      /agent/special/automation/runs?sessionId= 某会话的历次运行(muse 会话与自动化会话通用)
 *   GET      /agent/special/schedule                    全 agent 日程聚合(SCHEDULE.db;Calendar/自动化 Space)
 *   POST     /agent/special/schedule/:slug/entries      upsert 日程条目(带 id 改/无 id 建)
 *   DELETE   /agent/special/schedule/:slug/entries/:id  删除一条日程条目
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
import { loadSpecialAgentsConfig, saveSpecialAgentsConfig, DEFAULT_HISTORIAN_PROMPT, legacyMusePrompt } from '../services/specialAgentsConfig.js';
import { museStatus, kickMuse } from '../services/muse.js';
import { loadTriggers, removeTrigger, validateTriggerInput, upsertTrigger } from '../services/museTriggers.js';
import { listAutomationSessions } from '../services/automation.js';
import { loadSchedule, entriesOf, validateEntryInput, upsertEntry, removeEntry } from '../services/agentSchedule.js';
import { MUSE_AGENT_SLUG, ensureMuseAgent, getAgent, listAgents, isValidSlug } from '../agents/agentRegistry.js';
import { runWithAgentSlug } from '../seams/runContext.js';

const router = Router();

function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: 'Special Agents 仅在本地（桌面/TUI）可用' });
    return false;
  }
  return true;
}

/** 用户对 TODO 的处理写进 Muse 自己的 LOG(英文——下周期 read_log 喂给模型)——反馈闭环。绝不抛。 */
async function appendMuseFeedback(userId: string, line: string): Promise<void> {
  try {
    await runWithAgentSlug(MUSE_AGENT_SLUG, () => deps().brain.memory.appendLogEntry(userId, line));
  } catch { /* 反馈写失败不阻断主流程 */ }
}

router.get('/agent/special/config', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json({
      config: loadSpecialAgentsConfig(),
      // 默认提示词随配置下发,供前端预填进「可修改框」(留空=用默认)。
      // Muse 的人格/指令已迁入 ~/.tangu/agents/muse/(在 Agent 名册编辑),不再有 musePrompt。
      defaults: { historianPrompt: DEFAULT_HISTORIAN_PROMPT },
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'load config failed' });
  }
});

router.post('/agent/special/config', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    // 旧自定义 muse prompt 必须在保存前捕获:保存落盘的是 normalize 后的段(已不含 prompt 键)。
    const legacy = legacyMusePrompt();
    const config = saveSpecialAgentsConfig(patch);
    // 刚启用 Muse → 立即播种其系统 agent 文件夹(名册马上可见)并催一次巡检,免得等满一个周期。
    // modelId 空不再挡:未选模型=跟随 admin 后台默认槽,可用性由 tick 内 resolveBackgroundModelId 判定。
    if (config.muse.enabled) {
      void ensureMuseAgent(legacy).catch(() => {});
      kickMuse();
    }
    res.json({ config });
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
    const rows = await query<any[]>(
      `SELECT title FROM muse_todos WHERE id = ? AND user_id = ? LIMIT 1`,
      [req.params.id, userId],
    );
    await query(
      `UPDATE muse_todos SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
      [status, req.params.id, userId],
    );
    // 反馈闭环:完成/驳回写进 Muse 的 LOG,下周期它 read_log 即见,据此校准后续提议。
    const title = String(rows?.[0]?.title || '').trim();
    if (title && (status === 'done' || status === 'dismissed')) {
      void appendMuseFeedback(userId, `[feedback] todo "${title}" marked ${status} by user`);
    }
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

    // 校验会话归属 + 取模型 + 取会话 agent_config(注入 run 以会话自身的 agent/群聊身份跑,而非默认 agent)。
    const sRows = await query<any[]>(`SELECT user_id, model_id, agent_config FROM chat_sessions WHERE id = ? LIMIT 1`, [sessionId]);
    const s = sRows[0];
    if (!s || s.user_id !== userId) return res.status(404).json({ detail: 'Session not found' });
    let sessionAgentConfig: any = {};
    try {
      const raw = s.agent_config;
      const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (parsed && typeof parsed === 'object') sessionAgentConfig = parsed;
    } catch { /* 坏 JSON → 空配置,与旧行为一致 */ }

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
      input: { message, userMessageId, attachments: [], agentConfig: sessionAgentConfig },
    });
    enqueueRun(sessionId, runId);

    await query(
      `UPDATE muse_todos SET status = 'injected', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id IN (${placeholders})`,
      [userId, ...todoIds],
    ).catch(() => {});
    // 反馈闭环:注入即「被采纳」,写进 Muse 的 LOG。
    void appendMuseFeedback(userId, `[feedback] todos injected into a session by user: ${todos.map((t) => `"${String(t.title || '').trim()}"`).join('; ')}`);

    res.json({ ok: true, runId, assistantMessageId, userMessageId });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'inject failed' });
  }
});

router.get('/agent/special/muse/status', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json({ status: await museStatus() });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'status failed' });
  }
});

// 盯任务规则(muse_watch 工具写入;面板只读列表+删除)。
router.get('/agent/special/muse/triggers', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json({ triggers: await loadTriggers() });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'triggers failed' });
  }
});

router.delete('/agent/special/muse/triggers/:id', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const ok = await removeTrigger(String(req.params.id || ''));
    if (!ok) return res.status(404).json({ detail: 'trigger not found' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete trigger failed' });
  }
});

// upsert 规则(桌面「自动化」构建器;校验与 muse_watch 工具共用)。HTTP 无 cwd → path 需绝对路径(~ 展开可用)。
router.post('/agent/special/muse/triggers', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const body = req.body || {};
    const v = validateTriggerInput(body);
    if (!v.ok) return res.status(400).json({ detail: v.error });
    if (v.value.agentSlug && !(await getAgent(v.value.agentSlug))) {
      return res.status(400).json({ detail: `agent "${v.value.agentSlug}" 不存在` });
    }
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined;
    const r = await upsertTrigger(v.value, id);
    if (!r.ok) return res.status(id ? 404 : 400).json({ detail: r.error });
    kickMuse(); // 新/改规则尽快被下一次巡检评估
    res.json({ trigger: r.trigger, created: r.created });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'save trigger failed' });
  }
});

// agent 自动化常驻会话列表(右栏「触发记录」定位 sessionId;triggerId 可选过滤)。
router.get('/agent/special/automation/sessions', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const triggerId = typeof req.query.triggerId === 'string' && req.query.triggerId ? req.query.triggerId : undefined;
    res.json({ sessions: await listAutomationSessions(triggerId) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'automation sessions failed' });
  }
});

// ── Agent 日程(agents/<slug>/SCHEDULE.db;manage_schedule 工具同源) ──────────

// 全 agent 日程聚合(桌面 Calendar 合成只读源 + 自动化 Space「Agent 日程」组;只含有文件的 agent)。
router.get('/agent/special/schedule', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const schedules: { slug: string; name: string; db: unknown; entries: unknown[] }[] = [];
    for (const a of await listAgents()) {
      const db = await loadSchedule(a.slug);
      if (db) schedules.push({ slug: a.slug, name: a.name, db, entries: entriesOf(db) });
    }
    res.json({ schedules });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'schedule failed' });
  }
});

// upsert 日程条目(带 id 改/无 id 建;校验与 manage_schedule 工具共用,muse 拒 auto)。
router.post('/agent/special/schedule/:slug/entries', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const slug = String(req.params.slug || '');
    const def = isValidSlug(slug) ? await getAgent(slug) : null;
    if (!def) return res.status(404).json({ detail: `agent "${slug}" 不存在` });
    const body = req.body || {};
    const v = validateEntryInput(body, { slug });
    if (!v.ok) return res.status(400).json({ detail: v.error });
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined;
    const r = await upsertEntry(slug, v.value, id, def.name);
    if (!r.ok) return res.status(id ? 404 : 400).json({ detail: r.error });
    kickMuse(); // auto 条目尽快被下一次巡检评估
    res.json({ entry: r.entry, created: r.created });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'save schedule entry failed' });
  }
});

router.delete('/agent/special/schedule/:slug/entries/:id', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const slug = String(req.params.slug || '');
    if (!isValidSlug(slug)) return res.status(404).json({ detail: 'agent not found' });
    const ok = await removeEntry(slug, String(req.params.id || ''));
    if (!ok) return res.status(404).json({ detail: 'entry not found' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete schedule entry failed' });
  }
});

// 某会话的历次运行(muse 会话与自动化会话通用;只回自动化相关 kind,防任意会话被枚举 run 元数据)。
router.get('/agent/special/automation/runs', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const sessionId = String(req.query.sessionId || '');
    if (!sessionId) return res.status(400).json({ detail: 'sessionId required' });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const own = await query<any[]>(
      `SELECT 1 FROM chat_sessions WHERE id = ? AND kind IN ('muse', 'automation') LIMIT 1`,
      [sessionId],
    );
    if (!own.length) return res.status(404).json({ detail: 'session not found' });
    const rows = await query<any[]>(
      `SELECT id, status, tokens_total, error, created_at, updated_at FROM agent_runs
       WHERE session_id = ? ORDER BY created_at DESC LIMIT ${limit}`,
      [sessionId],
    );
    res.json({ runs: rows || [] });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'automation runs failed' });
  }
});

export default router;
