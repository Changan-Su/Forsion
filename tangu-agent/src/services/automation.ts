/**
 * Agent 自动化 launcher —— 两类到期任务共用一条无人值守管道:
 *   ① manage_automation 规则(动作链 runActions,或旧式 agentSlug 单 run;triggerKey=规则 id);
 *   ② agents/<slug>/SCHEDULE.db 的 auto 日程条目(triggerKey=`sched:<slug>:<rowId>`)。
 * 每个 triggerKey 一条**常驻 kind='automation' 会话**(首次命中创建),到期 enqueue 一个 run。
 *
 * 每 key 一条常驻会话(而非每次命中新建):防重入=isRunning 一条 SQL;运行历史=该会话的
 * agent_runs(与 Muse 单会话多 run 完全同构,桌面「自动化」Space 右栏统一列 runs);
 * 避开 SQLite/PG 双方言按 agent_config JSON 过滤会话的坑(会话归属在 JS 里比对)。
 *
 * 无人值守护栏(评审定论):
 *   - approvalMode **强制 'full-auto'**——approvals.requestApproval 无超时,后台 run 没有 SSE
 *     订阅者,非 full-auto 必然永久卡 'running' 直到进程重启;不用 planMode(只读白名单废掉意义)。
 *   - maxIterations = min(def.maxIterations ?? 20, 50);单趟成本闸 TANGU_MAX_RUN_COST 自动生效。
 *   - 在跑/无模型/agent 不存在 → 本轮跳过且**不算起跑**(调用方不 mark,下轮重试)。
 *   - 自激回路:watch 规则由 cooldown ≥1h 下限兜底;日程由 repeat ≥1h 下限+每 tick 起跑帽兜底。
 * 由 muse.ts supervisor tick 调用(评估在 muse.enabled 闸之前——关 Muse 不灭 agent 自动化)。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { createRun } from './runStore.js';
import { enqueueRun } from './agentLoop.js';
import { getAgent, listAgents, MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { resolveBackgroundModelId } from './specialAgentsConfig.js';
import { condSummary, disableTrigger, loadTriggers, type MuseTrigger, type ActionSpec, type TriggerContext } from './museTriggers.js';
import { mutateDb, readDb, resolveColumn, coerceCell, dbRowId, cellKey } from './amadeusDb.js';
import { amadeusVaultPath } from '../tools/builtin/amadeus.js';
import { setCursors, type DbCursor } from './dbCursors.js';
import { expandTemplate, expandCells } from './automationTemplate.js';
import { loadSchedule, entriesOf, dueEntries, markEntryFired, type ScheduleEntry } from './agentSchedule.js';
import { executeTool } from '../tools/registry.js';
import { declaredAutomationSafe } from '../tools/toolRegistry.js';
import { sendInboxMessage } from '../tools/builtin/inboxSend.js';
import type { ToolContext } from '../tools/toolTypes.js';

function log(msg: string): void {
  try { deps().host.log(`[automation] ${msg}`); } catch { console.log(`[automation] ${msg}`); }
}
function automationUserId(): string {
  return process.env.TANGU_USER_ID || 'local';
}

/** 双方言容错:pg 的 JSONB 返回对象,SQLite 存 TEXT 返回字符串。 */
function parseAgentConfig(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

export interface AutomationSessionRow {
  id: string;
  title: string;
  triggerId: string | null;
  agentSlug: string | null;
  created_at: string;
  updated_at: string;
}

/** 全部自动化会话(≤MAX_TRIGGERS 条,量小;triggerId 过滤在 JS 里做——见头注释双方言说明)。 */
export async function listAutomationSessions(triggerId?: string): Promise<AutomationSessionRow[]> {
  const rows = await query<any[]>(
    `SELECT id, title, agent_config, created_at, updated_at FROM chat_sessions
     WHERE user_id = ? AND kind = 'automation' ORDER BY updated_at DESC`,
    [automationUserId()],
  );
  const out: AutomationSessionRow[] = [];
  for (const r of rows || []) {
    const cfg = parseAgentConfig(r.agent_config);
    const tid = typeof cfg.automationTriggerId === 'string' ? cfg.automationTriggerId : null;
    if (triggerId && tid !== triggerId) continue;
    out.push({
      id: r.id,
      title: String(r.title || ''),
      triggerId: tid,
      agentSlug: typeof cfg.agentSlug === 'string' ? cfg.agentSlug : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }
  return out;
}

async function ensureAutomationSession(triggerKey: string, agentSlug: string, title: string, modelId: string): Promise<string> {
  const existing = await listAutomationSessions(triggerKey);
  if (existing.length) return existing[0].id;
  const id = uuidv4();
  const agentConfig = JSON.stringify({ agentSlug, automationTriggerId: triggerKey });
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config)
     VALUES (?, ?, ?, ?, ?, 'automation', ?)`,
    [id, automationUserId(), deps().profile.appId, title.slice(0, 80), modelId, agentConfig],
  );
  return id;
}

// 与 muse.ts 的同名私有函数同款 SQL(不从 muse.ts 导出——muse.ts import 本模块,反向即循环依赖)。
async function isRunning(sessionId: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM agent_runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    [sessionId],
  );
  return !!rows.length;
}
async function anyUserRunActive(): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM agent_runs r JOIN chat_sessions s ON s.id = r.session_id
     WHERE r.status IN ('queued', 'running') AND s.kind = 'user' LIMIT 1`,
  );
  return !!rows.length;
}

export function automationMessage(t: MuseTrigger, prompt?: string): string {
  return (
    `[Automation] Watch rule "${t.desc}" fired (${condSummary(t.cond)}). ` +
    'You are running unattended — do not ask the user questions; finish the task, verify the outcome before reporting it done, and summarize what you did.\n\n' +
    `Task: ${prompt || t.prompt || t.desc}`
  );
}

export interface UnattendedSpec {
  agentSlug: string;
  /** 常驻会话的归属键(agent_config.automationTriggerId):watch=规则 id;日程=`sched:<slug>:<rowId>`。 */
  triggerKey: string;
  /** 首次建会话时的标题。 */
  title: string;
  /** 交给 agent 的完整用户消息(含 unattended 指令)。 */
  message: string;
}

/** 启动单个无人值守 run;true=实际起跑(agent 缺失/无模型/在跑 → false,调用方不 mark)。让位闸由批量入口把守。 */
export async function launchUnattendedRun(spec: UnattendedSpec): Promise<boolean> {
  const def = await getAgent(spec.agentSlug);
  if (!def) { log(`${spec.triggerKey} 的 agent "${spec.agentSlug}" 不存在,跳过`); return false; }
  const modelId = def.model || (await resolveBackgroundModelId(''));
  if (!modelId) { log(`${spec.triggerKey} 无可用模型,跳过`); return false; }
  const sessionId = await ensureAutomationSession(spec.triggerKey, spec.agentSlug, spec.title, modelId);
  if (await isRunning(sessionId)) { log(`${spec.triggerKey} 上次运行未结束,本轮跳过`); return false; }
  const runId = uuidv4();
  await createRun({
    id: runId,
    sessionId,
    userId: automationUserId(),
    appId: deps().profile.appId,
    modelId,
    assistantMessageId: uuidv4(),
    input: {
      message: spec.message,
      userMessageId: uuidv4(),
      attachments: [],
      agentConfig: {
        agentSlug: spec.agentSlug,
        execMode: 'host',
        approvalMode: 'full-auto',
        maxIterations: Math.min(def.maxIterations ?? 20, 50),
        automationOrigin: spec.triggerKey, // 活动行 o= 标记 → event_seen 防自激
      },
    },
  });
  enqueueRun(sessionId, runId);
  log(`${spec.triggerKey} → agent "${spec.agentSlug}" 无人值守运行已启动(模型 ${modelId})`);
  return true;
}

// ── 动作链执行器(tool_call 白名单=内置 curated 集 + 插件 capabilities.automationSafe 正向声明)──

const AUTOMATION_TOOL_ALLOWLIST = new Set(['run_bash', 'write_file', 'web_fetch', 'web_search']);

/** 工具是否可作 tool_call 动作(动作目录端点与执行前校验共用)。 */
export function isAutomationTool(name: string): boolean {
  return AUTOMATION_TOOL_ALLOWLIST.has(name) || declaredAutomationSafe(name);
}

export interface ExecStepRecord { type: string; tool?: string; ok: boolean; summary: string }

/**
 * 动作链来源。账本里据此区分谁点的:
 *   auto   —— 巡检命中(定时/事件/文件);
 *   manual —— 面板试跑(允许对已停用规则跑,用来调试);
 *   button —— Amadeus 按钮块点击(明确的用户操作;要求规则存在且启用)。
 */
export type ActionOrigin = 'auto' | 'manual' | 'button';

/**
 * 单飞:同一规则的动作链同一时刻只跑一条。
 * 没有它,双击按钮 / 两个窗口同时点 / HTTP 超时后重试都会重复执行 notify 等**不可回滚的副作用**;
 * 巡检侧的 `isRunning` 只保护 agent_run 那条会话路径,notify/tool_call 链完全没有保护。
 */
const inFlight = new Set<string>();

export interface ExecutionRow {
  id: string;
  trigger_id: string;
  origin: string;
  status: string;
  steps: ExecStepRecord[];
  error: string | null;
  created_at: string;
}

/** 执行账本(桌面「触发记录」栏与试跑结果都读它)。 */
export async function listExecutions(triggerId?: string, limit = 50): Promise<ExecutionRow[]> {
  const lim = Math.min(200, Math.max(1, limit));
  const rows = triggerId
    ? await query<any[]>(
        `SELECT id, trigger_id, origin, status, steps, error, created_at FROM automation_executions
         WHERE user_id = ? AND trigger_id = ? ORDER BY created_at DESC LIMIT ${lim}`,
        [automationUserId(), triggerId],
      )
    : await query<any[]>(
        `SELECT id, trigger_id, origin, status, steps, error, created_at FROM automation_executions
         WHERE user_id = ? ORDER BY created_at DESC LIMIT ${lim}`,
        [automationUserId()],
      );
  return (rows || []).map((r) => {
    let steps: ExecStepRecord[] = [];
    try { steps = JSON.parse(String(r.steps || '[]')); } catch { /* 留空 */ }
    return { id: r.id, trigger_id: r.trigger_id, origin: r.origin, status: r.status, steps, error: r.error ?? null, created_at: r.created_at };
  });
}

/**
 * 顺序执行规则的动作链,失败即停。**开跑即视为已触发**(调用方 mark):notify 等副作用不可重放,
 * 步骤失败后整链重试会重复打扰用户;失败细节进账本,tool_call 目标不可用则停用规则+通知。
 * origin='manual'(试跑)/'button'(按钮点击)走同一条路,只是账本标记不同、调用方不 mark。
 *
 * ⚠️ `agent_run` 步骤只等到「排队成功」,不等 agent 跑完 —— 后续步骤**不能**依赖它的结果,
 * 调用方展示时也别说成「已完成」。
 */
export async function runActions(t: MuseTrigger, origin: ActionOrigin, ctx?: TriggerContext): Promise<{ execId: string; status: 'done' | 'failed' | 'busy'; steps: ExecStepRecord[] }> {
  if (inFlight.has(t.id)) {
    log(`规则 ${t.id} 上一次动作链仍在执行,本次忽略(单飞)`);
    return { execId: '', status: 'busy', steps: [] };
  }
  inFlight.add(t.id);
  try {
    return await runActionsInner(t, origin, ctx);
  } finally {
    inFlight.delete(t.id);
  }
}

async function runActionsInner(t: MuseTrigger, origin: ActionOrigin, tctx?: TriggerContext): Promise<{ execId: string; status: 'done' | 'failed'; steps: ExecStepRecord[] }> {
  const userId = automationUserId();
  const actions: ActionSpec[] = t.actions || [];
  const firstAgent = actions.find((a): a is Extract<ActionSpec, { type: 'agent_run' }> => a.type === 'agent_run');
  const sessionId = await ensureAutomationSession(t.id, firstAgent?.agentSlug || '', String(t.desc), '');
  const steps: ExecStepRecord[] = [];
  const touchedDbs = new Set<string>();
  let error: string | undefined;
  for (const a of actions) {
    try {
      if (a.type === 'notify') {
        // 模板白名单之一:通知文本。展开在 automationTemplate 里做了消毒(块标记打断、单值截断)。
        const title = expandTemplate(a.title, tctx);
        const body = a.body ? expandTemplate(a.body, tctx) : undefined;
        const r = await sendInboxMessage(userId, { title, body, senderId: `automation:${t.id}` });
        steps.push({ type: 'notify', ok: r.ok, summary: r.ok ? `notified: ${title}` : String(r.error || 'failed').slice(0, 300) });
        if (!r.ok) { error = r.error || 'notify failed'; break; }
      } else if (a.type === 'agent_run') {
        const ok = await launchUnattendedRun({ agentSlug: a.agentSlug, triggerKey: t.id, title: String(t.desc), message: automationMessage(t, a.prompt) });
        steps.push({ type: 'agent_run', ok, summary: ok ? `run started (${a.agentSlug})` : `agent "${a.agentSlug}" busy/unavailable` });
        if (!ok) { error = 'agent_run not started'; break; }
      } else if (a.type === 'tool_call') {
        if (!isAutomationTool(a.tool)) {
          // 不可恢复(工具被卸载/未声明 automationSafe):停用规则防每轮空转,通知用户人工处理。
          steps.push({ type: 'tool_call', tool: a.tool, ok: false, summary: `tool "${a.tool}" not available for automation` });
          error = `tool ${a.tool} unavailable`;
          await disableTrigger(t.id);
          await sendInboxMessage(userId, {
            title: `自动化「${t.desc}」已停用`,
            body: `步骤工具 ${a.tool} 不可用(未安装或未声明 automationSafe)。请在自动化面板检查后重新启用。`,
            senderId: `automation:${t.id}`,
          });
          break;
        }
        const ctx: ToolContext = {
          userId, sessionId, appId: deps().profile.appId,
          execMode: 'host', approvalMode: 'full-auto', automationOrigin: t.id,
        };
        const res = await executeTool({ id: uuidv4(), type: 'function', function: { name: a.tool, arguments: JSON.stringify(a.args || {}) } }, ctx);
        const failed = res.isError || String(res.result).startsWith('Error');
        steps.push({ type: 'tool_call', tool: a.tool, ok: !failed, summary: String(res.result).slice(0, 300) });
        if (failed) { error = String(res.result).slice(0, 300); break; }
      } else if (a.type === 'db_row_add' || a.type === 'db_row_edit') {
        const summary = await runDbAction(a, tctx, origin);
        steps.push({ type: a.type, ok: true, summary });
        touchedDbs.add(a.path);
      }
    } catch (e: any) {
      steps.push({ type: a.type, ok: false, summary: String(e?.message || e).slice(0, 300) });
      error = String(e?.message || e).slice(0, 300);
      break;
    }
  }
  // 自激防线:巡检触发的动作改了表 → 把**所有**盯这张表的 db_changed 游标推到写后状态,
  // 这次写入对它们就是隐形的。只推自己那条不够 —— 规则 A 写表、规则 B 盯同一张表照样成环。
  // origin='button'/'manual' 是明确的用户操作,按 Notion 的规矩**允许**继续触发,故不推。
  if (origin === 'auto' && touchedDbs.size) {
    await advanceDbCursors([...touchedDbs]).catch((e: any) => log(`游标推进失败:${e?.message || e}`));
  }

  const status: 'done' | 'failed' = error ? 'failed' : 'done';
  const execId = uuidv4();
  await query(
    `INSERT INTO automation_executions (id, user_id, trigger_id, origin, status, steps, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [execId, userId, t.id, origin, status, JSON.stringify(steps), error || null],
  ).catch((e: any) => log(`执行账本写入失败:${e?.message || e}`));
  // 人读投影:常驻会话里插一条 model 消息(桌面 Detail 的 transcript 白得展示;账本才是真源)。
  const lines = steps.map((s, i) => `${s.ok ? '✓' : '✗'} ${i + 1}. ${s.type}${s.tool ? `(${s.tool})` : ''} — ${s.summary}`);
  await query(
    `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error)
     VALUES (?, ?, 'model', ?, ?, NULL, ?)`,
    [uuidv4(), sessionId, `[Automation${origin === 'manual' ? ' · test-run' : origin === 'button' ? ' · button' : ''}] ${t.desc} (${condSummary(t.cond)})\n${lines.join('\n') || '(no steps)'}`, Date.now(), status === 'failed'],
  ).catch((e: any) => log(`transcript 投影写入失败:${e?.message || e}`));
  await query(`UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [sessionId]).catch(() => {});
  log(`规则 ${t.id} 动作链执行完毕(${origin}):${status}${error ? ` — ${error}` : ''}`);
  return { execId, status, steps };
}


// ── DB 动作(对标 Notion 的 Add page to… / Edit property…)────────────────────────

/**
 * 执行一条 DB 动作。写入走 amadeusDb.mutateDb:**每路径串行 + 写前重读 + 原子落位**
 * (渲染端那一半的护栏是 desktop 的 db:write-cas 比对交换 + 冲突重放,两边合起来才闭合)。
 * 列找不到/类型不符 → 抛错 → 动作链失败即停并进账本。**绝不"报成功但什么都没改"**。
 */
async function runDbAction(
  a: Extract<ActionSpec, { type: 'db_row_add' } | { type: 'db_row_edit' }>,
  tctx: TriggerContext | undefined,
  origin: ActionOrigin,
): Promise<string> {
  const cells = expandCells(a.cells, tctx); // 模板白名单之二:单元格值(路径/rowId 一律不插值)
  let summary = '';
  await mutateDb(a.path, (db) => {
    if (a.type === 'db_row_add') {
      const row = { id: dbRowId(), cells: {} as Record<string, ReturnType<typeof coerceCell>> };
      for (const [key, raw] of Object.entries(cells)) {
        const col = resolveColumn(db, key); // 找不到即抛
        row.cells[col.id] = coerceCell(col, raw);
      }
      db.rows.push(row);
      summary = `added row to ${a.path} (${Object.keys(cells).length} field(s))`;
      return true;
    }
    // edit:目标行 = 显式 rowId,否则触发上下文命中的那一行
    const rowId = a.rowId || tctx?.row?.id;
    if (!rowId) throw new Error('db_row_edit needs rowId (or a trigger that provides the changed row)');
    const row = db.rows.find((r) => r.id === rowId);
    if (!row) throw new Error(`row ${rowId} not found in ${a.path}`);
    for (const [key, raw] of Object.entries(cells)) {
      const col = resolveColumn(db, key);
      row.cells[col.id] = coerceCell(col, raw);
    }
    summary = `edited row ${rowId} in ${a.path} (${Object.keys(cells).length} field(s))`;
    return true;
  });
  return `${summary}${origin === 'auto' ? '' : ` [${origin}]`}`;
}

/**
 * 把盯着这些表的**全部** db_changed 规则的游标推到写后状态 —— 自动化自己造成的改动对自动化隐形。
 * 只推「本规则」不够:规则 A 写表 → 规则 B 盯同一张表 → B 的动作又写回去,照样成环。
 *
 * ⚠️ 边界说清楚:这只覆盖**官方 DB 动作**。full-auto 的 agent_run 若用 run_bash 直接改被盯的
 * .db,这里看不见,那条环只能靠 cooldown 与起跑帽减灾 —— 那是减灾,不是正确语义。
 */
async function advanceDbCursors(paths: string[]): Promise<void> {
  const vault = amadeusVaultPath();
  const list = await loadTriggers();
  const targets = list.filter(
    (t) => t.cond?.type === 'db_changed' && paths.includes(t.cond.path) && (!t.cond.vault || t.cond.vault === vault),
  );
  if (!targets.length) return;
  const patch: Record<string, DbCursor> = {};
  const cache = new Map<string, Awaited<ReturnType<typeof readDb>>['db'] | null>();
  for (const t of targets) {
    const c = t.cond as Extract<typeof t.cond, { type: 'db_changed' }>;
    let db = cache.get(c.path);
    if (db === undefined) {
      db = await readDb(c.path).then((r) => r.db).catch(() => null);
      cache.set(c.path, db);
    }
    if (!db) continue;
    if (c.event === 'row_added') patch[t.id] = { v: 1, rowIds: db.rows.map((r) => r.id) };
    else if (c.columnId) {
      const cells: Record<string, string> = {};
      for (const r of db.rows) cells[r.id] = cellKey(r.cells?.[c.columnId] as any);
      patch[t.id] = { v: 1, cells };
    }
  }
  await setCursors(patch);
}

/**
 * 启动一批命中的规则,返回**应烧 cooldown** 的规则 id:
 *   动作链规则 → runActions 开跑即算(部分失败也 mark,防副作用重放);
 *   旧式 agentSlug 规则 → 实际起跑才算(让位/在跑/无模型不烧 cooldown,下轮重试)。
 */
export async function launchAutomationTriggers(fired: MuseTrigger[], contexts: Record<string, TriggerContext> = {}): Promise<string[]> {
  const launched: string[] = [];
  if (!fired.length) return launched;
  try {
    if (await anyUserRunActive()) { log('用户有进行中的 run,本轮让位'); return launched; }
  } catch { return launched; }
  for (const t of fired) {
    try {
      if (t.actions?.length) {
        const r = await runActions(t, 'auto', contexts[t.id]);
        // busy=上一次还在跑(单飞挡下):不烧 cooldown,下轮重试——否则这次命中被静默吞掉。
        if (r.status !== 'busy') launched.push(t.id);
      } else {
        const ok = await launchUnattendedRun({
          agentSlug: String(t.agentSlug || ''),
          triggerKey: t.id,
          title: String(t.desc),
          message: automationMessage(t),
        });
        if (ok) launched.push(t.id);
      }
    } catch (e: any) {
      log(`规则 ${t.id} 启动失败:${e?.message || e}`);
    }
  }
  return launched;
}

function scheduleMessage(e: ScheduleEntry): string {
  const when = e.repeat ? `${e.date}, repeating every ${e.repeat}` : e.date;
  return (
    `[Automation] Scheduled task "${e.name}" is due (${when}). ` +
    'You are running unattended — do not ask the user questions; finish the task, verify the outcome before reporting it done, and summarize what you did.\n\n' +
    `Task: ${e.prompt || e.name}` +
    (e.description ? `\n\nContext: ${e.description}` : '')
  );
}

/** 每 tick 全局起跑帽:防「一次写入 N 条过期 auto 条目」的补发风暴;未起跑的不 mark,下轮续排。 */
const MAX_SCHEDULE_LAUNCHES_PER_TICK = 3;

/**
 * 评估全部 agent 的到期日程并启动(muse.ts tick 调用,与盯任务评估并列、同在 muse.enabled 闸之前)。
 * markEntryFired 只对**实际起跑**的条目(与 markTriggersFired 同语义)。
 */
export async function launchDueSchedules(now: Date = new Date()): Promise<void> {
  try {
    if (await anyUserRunActive()) { log('用户有进行中的 run,日程本轮让位'); return; }
  } catch { return; }
  let agents;
  try { agents = await listAgents(); } catch { return; }
  let budget = MAX_SCHEDULE_LAUNCHES_PER_TICK;
  for (const a of agents) {
    if (budget <= 0) { log(`本 tick 日程起跑帽(${MAX_SCHEDULE_LAUNCHES_PER_TICK})已满,余下顺延`); break; }
    // Muse 禁 auto 日程(防绕穿其 planMode+add_muse_todo 唯一写权限的安全设计);校验层同拒,这里防御性跳过。
    if (a.slug === MUSE_AGENT_SLUG) continue;
    let due: ScheduleEntry[];
    try {
      const db = await loadSchedule(a.slug);
      if (!db) continue;
      due = dueEntries(entriesOf(db), now);
    } catch { continue; }
    for (const e of due) {
      if (budget <= 0) break;
      try {
        const ok = await launchUnattendedRun({
          agentSlug: a.slug,
          triggerKey: `sched:${a.slug}:${e.id}`,
          title: e.name,
          message: scheduleMessage(e),
        });
        if (ok) {
          budget -= 1;
          await markEntryFired(a.slug, e.id, now);
        }
      } catch (err: any) {
        log(`日程 ${a.slug}:${e.id} 启动失败:${err?.message || err}`);
      }
    }
  }
}
