/**
 * Agent 自动化 launcher —— 两类到期任务共用一条无人值守管道:
 *   ① muse_watch 规则带 agentSlug(命中不唤 Muse,triggerKey=规则 id);
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
import type { MuseTrigger } from './museTriggers.js';
import { loadSchedule, entriesOf, dueEntries, markEntryFired, type ScheduleEntry } from './agentSchedule.js';

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

function automationMessage(t: MuseTrigger): string {
  const c = t.cond;
  const cond =
    c.type === 'file_chars_gte' ? `file ${c.path} reached ${c.n}+ non-whitespace chars`
    : c.type === 'event_seen' ? `new activity matched "${c.match}"`
    : `daily at ${c.time}`;
  return (
    `[Automation] Watch rule "${t.desc}" fired (${cond}). ` +
    'You are running unattended — do not ask the user questions; finish the task and summarize what you did.\n\n' +
    `Task: ${t.prompt || t.desc}`
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
async function launchUnattendedRun(spec: UnattendedSpec): Promise<boolean> {
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
      },
    },
  });
  enqueueRun(sessionId, runId);
  log(`${spec.triggerKey} → agent "${spec.agentSlug}" 无人值守运行已启动(模型 ${modelId})`);
  return true;
}

/**
 * 启动一批命中的 agent 规则,返回**实际起跑**的规则 id(调用方只对这些 markTriggersFired——
 * 让位/在跑/无模型/agent 缺失都不烧 cooldown,下轮重试)。
 */
export async function launchAutomationTriggers(fired: MuseTrigger[]): Promise<string[]> {
  const launched: string[] = [];
  if (!fired.length) return launched;
  try {
    if (await anyUserRunActive()) { log('用户有进行中的 run,本轮让位'); return launched; }
  } catch { return launched; }
  for (const t of fired) {
    try {
      const ok = await launchUnattendedRun({
        agentSlug: String(t.agentSlug || ''),
        triggerKey: t.id,
        title: String(t.desc),
        message: automationMessage(t),
      });
      if (ok) launched.push(t.id);
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
    'You are running unattended — do not ask the user questions; finish the task and summarize what you did.\n\n' +
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
