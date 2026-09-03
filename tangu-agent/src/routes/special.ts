/**
 * Special Agent（Historian / Muse）配置 + 工作视图数据 + Muse TODO 操作。handler 自带 authMiddleware。
 *   GET/POST /agent/special/config                     读/写 ~/.tangu/special-agents.json
 *   GET      /agent/special/historian/activity?limit=  Historian 活动流（special_agent_log）
 *   GET      /agent/special/muse/todos?status=         Muse TODO 列表
 *   PATCH    /agent/special/muse/todos/:id { status }  改 TODO 状态
 *   POST     /agent/special/muse/todos/inject { todoIds, sessionId }  注入选中 TODO 到会话并起 run
 *   GET      /agent/special/muse/status                Muse 运行态 + 本窗口预算余量
 *   GET      /agent/special/muse/triggers              自动化规则列表(manage_automation 工具/构建器写入;附 nextRunAt)
 *   POST     /agent/special/automation/triggers/:id/fire  立即执行(origin=manual 试跑 / button 按钮点击,不动 lastFiredAt)
 *   POST     /agent/special/automation/kick            唤醒巡检(桌面写完 .db 后踢一下,db_changed 从 5min 降到 ~2s)
 *   GET      /agent/special/automation/actions          tool_call 动作目录(白名单+automationSafe)
 *   GET      /agent/special/automation/executions       动作链执行账本(?triggerId=&limit=)
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
import { museStatus, kickMuse, getAutomationNotices } from '../services/muse.js';
import { loadTriggers, removeTrigger, validateTriggerInput, upsertTrigger, nextRunAt, isPluginTriggerId, precheckWatchCols, needsWatchColPrecheck, type DbLike } from '../services/museTriggers.js';
import { readDbOrNull } from '../services/amadeusDb.js';
import { dropCursors } from '../services/dbCursors.js';
import { amadeusVaultPath } from '../tools/builtin/amadeus.js';
import { listAutomationSessions, fireTrigger, listExecutions, isAutomationTool, launchUnattendedRun, automationMessage } from '../services/automation.js';
import { resolveTools, declaredApproval } from '../tools/toolRegistry.js';
import type { ToolContext } from '../tools/toolTypes.js';
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

// 盯任务规则(manage_automation 工具写入;面板列表+删除)。nextRunAt 服务端权威计算(时区/补发语义都在引擎)。
router.get('/agent/special/muse/triggers', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const list = await loadTriggers();
    // notice = 引擎侧**不停用**的暂时性状态位(库不符 / 表暂时读不到 / where 列按名解析不到);
    // 与 disabledReason 互补:那条是「已经停了,为什么」,这条是「还开着,但为什么不动」(H3)。
    const notices = getAutomationNotices();
    res.json({ triggers: list.map((t) => ({ ...t, nextRunAt: nextRunAt(t), ...(notices[t.id] ? { notice: notices[t.id] } : {}) })) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'triggers failed' });
  }
});

router.delete('/agent/special/muse/triggers/:id', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const id = String(req.params.id || '');
    const ok = await removeTrigger(id);
    if (!ok) return res.status(404).json({ detail: 'trigger not found' });
    await dropCursors([id]).catch(() => {}); // 派生游标随规则一起走,否则 id 复用会捡到别人的快照
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete trigger failed' });
  }
});

// upsert 规则(桌面「自动化」构建器;校验与 manage_automation 工具共用)。HTTP 无 cwd → path 需绝对路径(~ 展开可用)。
// tool_call 步骤只在这条 UI 通道放行(allowToolCall:保存即人工预批);agent 经工具只能建 notify/agent_run。
// 插件种子规则(id `plugin:<插件id>:<key>`,宿主 ctx.automation.ensure 下发):**先读 id 再校验**——
// 插件规则 allowToolCall:false 且拒 agent_run(引擎侧兜底,不只靠宿主);id 不存在时按该 id 幂等创建(allowPluginCreate 只在这条路由开)。
router.post('/agent/special/muse/triggers', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const body = req.body || {};
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined;
    const isPlugin = !!id && isPluginTriggerId(id);
    // 调用来源(H1):'user'=面板开关/构建器保存/manage_automation 这类**显式**操作;
    // 'plugin-ensure'=插件 ctx.automation.ensure 的幂等重放(每次 setup 全量重发)。
    // 只影响停用簿记(见 upsertTrigger 的 blockedEnable):重放不许开回 engine/user 关掉的规则。
    // 插件传不了这个字段 —— ensure 的 payload 由 pluginAutomation.buildPluginTriggerUpsert 整个重建,
    // 插件给的 rule 对象里多余的键一进一出即蒸发。
    const actor = body.actor === 'plugin-ensure' ? 'plugin-ensure' : body.actor === 'user' ? 'user' : undefined;
    const v = validateTriggerInput(body, { allowToolCall: !isPlugin, vaultPath: amadeusVaultPath() });
    if (!v.ok) return res.status(400).json({ detail: v.error });
    if (v.value.agentSlug && !(await getAgent(v.value.agentSlug))) {
      return res.status(400).json({ detail: `agent "${v.value.agentSlug}" 不存在` });
    }
    if (isPlugin && (v.value.agentSlug || v.value.actions?.some((a) => a.type === 'agent_run'))) {
      return res.status(400).json({ detail: '插件规则不能起 agent run(只许 notify / db_row_add / db_row_edit)' });
    }
    for (const a of v.value.actions || []) {
      if (a.type === 'agent_run' && !(await getAgent(a.agentSlug))) {
        return res.status(400).json({ detail: `agent "${a.agentSlug}" 不存在` });
      }
      if (a.type === 'tool_call' && !isAutomationTool(a.tool)) {
        return res.status(400).json({ detail: `工具 "${a.tool}" 不可作自动化动作(不在白名单且未声明 automationSafe)` });
      }
    }
    // 监听列不能是公式/引用/投影列:它们的值不落盘,游标恒空 → 规则一次都不会触发(桌面构建器已经过滤,
    // 这是引擎侧的对等闸,兜住手改/插件/别的客户端)。
    // ⚠️ H2(2026-09-02):预检**只挂在「让规则更活跃」的那几条路上** —— 新建 / cond 实质变化 / 本次要置为 enabled:true。
    // 从前对**每一次** POST 都跑,而面板启停就是整量 upsert:一条监听列后来被改成公式列的规则,连「关掉」都被 400 挡回,
    // 用户无法停用它。更糟的是 pluginStore 禁用插件时逐条 upsert 成 enabled:false 走同一条路由,而那边的待停用重放
    // **刻意不封顶**(关不掉 = 用户以为停了、引擎里照跑),400 会让它无限重试成风暴。
    // **关规则永远不许被预检挡住。**
    // 判据单源在 museTriggers.needsWatchColPrecheck(那里有断言;内联一份 = 两处会漂)。
    const prev = id ? (await loadTriggers()).find((x) => x.id === id) : undefined;
    if (needsWatchColPrecheck(prev, v.value)) {
      const badCol = await precheckWatchCols(v.value.cond, (rel) => readDbOrNull(rel) as Promise<DbLike | null>, amadeusVaultPath());
      if (badCol) return res.status(400).json({ detail: badCol });
    }
    // ⚠️ 游标作废(cond 换了 / 停用→启用)的**唯一真源在 upsertTrigger**,且跑在 saveTriggers **之前**。
    // 这里从前还有一份「保存后再 dropCursors」的双保险 —— 顺序是反的(规则先上线、游标后清,中间任何一次
    // evaluate 都会把积压打出去),而且它兜不住换表那类身份变化(drain 的 setCursors 会把删掉的键合并写回)。
    // 真正与时序无关的防线是读端 museTriggers.cursorMismatch(游标自证 path/event/vault/cols)。
    const r = await upsertTrigger(v.value, id, { allowPluginCreate: isPlugin, actor });
    if (!r.ok) return res.status(id && !isPlugin ? 404 : 400).json({ detail: r.error });
    kickMuse(); // 新/改规则尽快被下一次巡检评估
    res.json({ trigger: r.trigger, created: r.created });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'save trigger failed' });
  }
});

// 立即执行动作链(同一执行器,不动 lastFiredAt/enabled)。两种来源,闸不同:
//   origin='manual'(默认,面板试跑)—— 任意规则,**允许对已停用规则跑**(调试用);
//   origin='button'(Amadeus 按钮块点击)—— 只许 cond.type==='manual' 且 enabled 的规则。
// button 的两道闸是信任模型的一部分:笔记里的按钮只存 triggerId,若能点任意规则,按钮块就成了
// 「笔记内容可远程调用任意已存在自动化」的 RPC 面;限定 manual 类=只能点用户为按钮专门建的那种。
// 旧式 agentSlug 规则=直接起一次无人值守 run;Muse 唤醒类无独立动作,不支持。
router.post('/agent/special/automation/triggers/:id/fire', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const id = String(req.params.id || '');
    const origin = req.body?.origin === 'button' ? 'button' : 'manual';
    const t = (await loadTriggers()).find((x) => x.id === id);
    if (!t) return res.status(404).json({ detail: 'trigger not found' });
    if (origin === 'button') {
      if (t.cond?.type !== 'manual') return res.status(400).json({ detail: '按钮只能触发「手动」类型的自动化' });
      if (!t.enabled) return res.status(409).json({ detail: '该自动化已停用' });
    }
    if (t.actions?.length) {
      // ⚠️ 必须走 fireTrigger(= runActions + advanceSelfCursors):直接 runActions 会丢掉 touched,
      // 「写自己盯的那张表」的规则点一次试跑,下一 tick 会把试跑写的行当成真事件再跑一遍整条链(M5)。
      const r = await fireTrigger(t, origin);
      // busy=上一次点击还在跑(单飞);409 让前端显示「正在执行」而不是伪装成失败。
      if (r.status === 'busy') return res.status(409).json({ detail: '上一次执行还没结束', status: 'busy' });
      return res.json({ ok: r.status === 'done', execId: r.execId, status: r.status, steps: r.steps });
    }
    if (t.agentSlug && t.agentSlug !== MUSE_AGENT_SLUG) {
      const ok = await launchUnattendedRun({ agentSlug: t.agentSlug, triggerKey: t.id, title: t.desc, message: automationMessage(t) });
      return res.json({ ok, status: ok ? 'launched' : 'busy' });
    }
    return res.status(400).json({ detail: 'Muse 唤醒类规则没有独立动作,不支持试跑' });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'fire failed' });
  }
});

/**
 * 唤醒巡检 —— 桌面写完一张 `.db` 后踢一下,让 db_changed 从「最多等 5 分钟」变成「约 2 秒」。
 * 刻意不收任何业务 payload:唤醒之后仍由引擎自己重读磁盘做权威判定,绝不信客户端传来的行内容
 * (否则「谁能发这个请求」就变成了「谁能伪造表格变化」)。调用方自己节流。
 */
router.post('/agent/special/automation/kick', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  kickMuse();
  res.json({ ok: true });
});

// 动作目录:tool_call 步骤选择器的数据源(白名单内置 + automationSafe 插件工具;参数 JSON schema 供表单生成)。
router.get('/agent/special/automation/actions', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const ctx: ToolContext = { userId: 'local', sessionId: 'catalog', appId: deps().profile.appId, execMode: 'host' };
    const tools = [];
    for (const [name, t] of resolveTools(deps().profile, ctx)) {
      if (!isAutomationTool(name)) continue;
      tools.push({
        name,
        description: String(t.definition?.function?.description || '').split('\n')[0].slice(0, 200),
        parameters: t.definition?.function?.parameters || { type: 'object', properties: {} },
        dangerous: name === 'run_bash' || declaredApproval(name) === 'command',
      });
    }
    res.json({ tools });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'actions catalog failed' });
  }
});

// 执行账本(动作链规则的「触发记录」;agent run 类记录仍走 automation/runs)。
router.get('/agent/special/automation/executions', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const triggerId = typeof req.query.triggerId === 'string' && req.query.triggerId ? req.query.triggerId : undefined;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json({ executions: await listExecutions(triggerId, limit) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'executions failed' });
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
