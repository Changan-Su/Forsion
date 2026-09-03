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
 *   - 自激回路:含 LLM 的 watch 规则由 cooldown ≥1h 下限兜底(且评估侧每 tick 只取一行);日程由 repeat ≥1h 下限+每 tick 起跑帽兜底;
 *     db_changed 纯动作链靠三件:① 自写不可见(advanceSelfCursors 按**精确因果合并**推本规则自己的游标,规则永远不被
 *     **自己**的写入触发,别的规则/用户并发写的行照常可见)② drain 封顶 20 轮,到顶**停用最后一轮的规则**(disabledReason)
 *     ③ 整批让位即退出 —— 见 automationDrain.ts。
 *   - 未起跑不 ack:旧式 agentSlug 规则任一 hit 没起跑(在跑/无模型/agent 缺失)→ 该规则整条不进 launched/touched,
 *     游标不推、下轮重来(与动作链 busy 同款);动作链本身仍是「开跑即 mark」(notify 副作用不可重放)。
 * 由 muse.ts supervisor tick 经 automationDrain 调用(评估在 muse.enabled 闸之前——关 Muse 不灭 agent 自动化)。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { createRun } from './runStore.js';
import { enqueueRun } from './agentLoop.js';
import { getAgent, listAgents, MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { resolveBackgroundModelId } from './specialAgentsConfig.js';
import { condSummary, cursorMismatch, disableTrigger, loadTriggers, normalizeVaultRel, replaceKeyPart, sameVault, watchedCols, type MuseTrigger, type ActionSpec, type TriggerContext, type DbLike } from './museTriggers.js';
import { mutateDb, readDbOrNull, type DbFile } from './amadeusDb.js';
import { amadeusVaultPath } from '../tools/builtin/amadeus.js';
import { loadCursors, setCursors, type DbCursor } from './dbCursors.js';
import { expandTemplate } from './automationTemplate.js';
import { applyDbAction, emptyTouch, mergeTouch, type DbTouch } from './automationDbAction.js';
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

export interface ExecStepRecord { type: string; tool?: string; ok: boolean; summary: string; /** skipIfEmpty 命中,本步未写。 */ skipped?: boolean }

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
/** 规则一次执行对各表的精确因果:归一后的 vault 相对路径 → 新增行 id + 改过的格(写后 key)。 */
export type TouchedDbs = Record<string, DbTouch>;

export interface RunActionsResult {
  execId: string;
  status: 'done' | 'failed' | 'busy';
  steps: ExecStepRecord[];
  /** 本次真正写过的表及精确因果(skipped / match 0 行不计);调用方据此**合并**推本规则自己的游标(advanceSelfCursors)。 */
  touched: TouchedDbs;
}

export async function runActions(t: MuseTrigger, origin: ActionOrigin, ctx?: TriggerContext): Promise<RunActionsResult> {
  if (inFlight.has(t.id)) {
    log(`规则 ${t.id} 上一次动作链仍在执行,本次忽略(单飞)`);
    return { execId: '', status: 'busy', steps: [], touched: {} };
  }
  inFlight.add(t.id);
  try {
    return await runActionsInner(t, origin, ctx);
  } finally {
    inFlight.delete(t.id);
  }
}

async function runActionsInner(t: MuseTrigger, origin: ActionOrigin, tctx?: TriggerContext): Promise<RunActionsResult & { status: 'done' | 'failed' }> {
  const userId = automationUserId();
  const actions: ActionSpec[] = t.actions || [];
  const firstAgent = actions.find((a): a is Extract<ActionSpec, { type: 'agent_run' }> => a.type === 'agent_run');
  const sessionId = await ensureAutomationSession(t.id, firstAgent?.agentSlug || '', String(t.desc), '');
  const steps: ExecStepRecord[] = [];
  const touched: TouchedDbs = {};
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
          await disableTrigger(t.id, `步骤工具 ${a.tool} 不可用(未安装或未声明 automationSafe)`);
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
        const r = await applyDbAction(a, tctx, dbActionIo);
        steps.push({ type: a.type, ok: true, summary: `${r.summary}${origin === 'auto' ? '' : ` [${origin}]`}`, ...(r.skipped ? { skipped: true } : {}) });
        if (r.touch.addedIds.length || r.touch.edited.length) {
          const key = normalizeVaultRel(a.path);
          touched[key] = mergeTouch(touched[key] ?? emptyTouch(), r.touch);
        }
        // 投影列翻译落到对侧表的因果也归本规则:少了这一并,盯对侧 backCol 的规则会被自己的投影写再触发一次(回环)
        for (const m of r.mirrors ?? []) touched[m.path] = mergeTouch(touched[m.path] ?? emptyTouch(), m.touch);
      }
    } catch (e: any) {
      steps.push({ type: a.type, ok: false, summary: String(e?.message || e).slice(0, 300) });
      error = String(e?.message || e).slice(0, 300);
      break;
    }
  }
  // 游标不在这里推:写完就推会被 muse 侧稍后的 ack(setCursors 整条替换)盖回评估时快照,自引用规则下一 tick
  // 必再触发(A 报告第 2 条)。改为把 touchedDbs 交给调用方,由 drain 在 ack **之后**推本规则自己的游标。
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
  return { execId, status, steps, touched };
}


// ── DB 动作(对标 Notion 的 Add page to… / Edit property…)────────────────────────

/** 真 io:读走 readDbOrNull(**缺 → null,坏 → 抛**:坏表不能长得像空表),写走 mutateDb(每路径串行 + 跨进程锁 + 原子落位)。逻辑本体在 automationDbAction.ts。 */
const dbActionIo = {
  readDb: (rel: string): Promise<DbLike | null> => readDbOrNull(rel).then((db) => db as DbLike | null),
  mutateDb: (rel: string, fn: (db: DbFile) => boolean | void): Promise<void> => mutateDb(rel, fn),
};

/** advanceSelfCursors 的 io(测试注入;缺省真读盘)。 */
export interface SelfCursorIo {
  loadTriggers: () => Promise<MuseTrigger[]>;
  loadCursors: () => Promise<Record<string, DbCursor>>;
  setCursors: (patch: Record<string, DbCursor>) => Promise<void>;
  currentVault?: string;
}

/**
 * 自写不可见:把**本规则自己**盯的表(且本次真写过的)的 db_changed 游标按**精确因果合并**推进 ——
 * 规则永远不被自己的写入触发;**别的**规则照常看见这次写入(跨规则级联是 ERP 链路的正解,
 * 从前「推所有盯该表规则」的写法让 A 写表 → B 盯同表永远触发不了,§6.1 裁决改掉)。
 * 合并而非整表重读:row_added 游标只 append 本规则新增的行 id;cell_changed 游标只对本规则改过**监听列**的行
 * 更新 cells[rowId]=写后 key。整表重读会把同批别的规则 / 用户并发写进的行也吞进本规则游标(对它隐形丢事件)。
 * 游标不存在(从未播种)→ 跳过,下个 tick 评估会播种(播种本来就消费全表)。
 * 环防线由 drain 的封顶 20 轮(到顶停用)+ 整批让位即退出补齐(automationDrain.ts)。
 *
 * ⚠️ 只覆盖**官方 DB 动作**。full-auto 的 agent_run 若用 run_bash 直接改被盯的 .db,这里看不见,
 * 那条环只能靠 cooldown 与起跑帽减灾 —— 那是减灾,不是正确语义。
 * 必须在 drain 的 ack(setCursors(pending))**之后**调:这里读的是 ack 后的游标再合并,顺序反了合并基底就是旧快照。
 */
export async function advanceSelfCursors(
  touched: Record<string, TouchedDbs>,
  io: SelfCursorIo = { loadTriggers, loadCursors, setCursors, currentVault: amadeusVaultPath() },
): Promise<void> {
  const ids = Object.keys(touched).filter((id) => Object.keys(touched[id] ?? {}).length);
  if (!ids.length) return;
  const list = await io.loadTriggers();
  const cursors = await io.loadCursors();
  const patch: Record<string, DbCursor> = {};
  for (const id of ids) {
    const t = list.find((x) => x.id === id);
    const c = t?.cond;
    if (!c || c.type !== 'db_changed') continue;
    if (io.currentVault && c.vault && !sameVault(c.vault, io.currentVault)) continue; // 归一同 evaluate(H3)
    const own = normalizeVaultRel(c.path);
    const touch = Object.entries(touched[id]).find(([p]) => normalizeVaultRel(p) === own)?.[1];
    if (!touch) continue; // 写的不是自己盯的表 → 无事
    const cur = cursors[id];
    // 游标身份/形状与规则当前 cond 不符(换表、换列、旧版本…)→ 不合并,留给评估侧重新播种;
    // 硬合并会把别的表/别的列的快照当成自己的,下轮整表当成「变了」自触发。
    if (!cur || cursorMismatch(cur, c)) continue;
    // ⚠️ 合并出来的新游标必须原样带上身份三件套(展开 cur):丢一个字段 = 下轮 cursorMismatch 判不符 → 白重播种。
    if (c.event === 'row_added') {
      if (!cur.rowIds) continue;
      const add = touch.addedIds.filter((rid) => !cur.rowIds!.includes(rid));
      if (add.length) patch[id] = { ...cur, rowIds: [...cur.rowIds, ...add] };
    } else {
      if (!cur.cells) continue;
      const cols = watchedCols(c);
      const cells = { ...cur.cells };
      let hit = false;
      for (const e of touch.edited) {
        const slot = cols.indexOf(e.colId);
        if (slot < 0 || !Object.hasOwn(cells, e.rowId)) continue; // 新行归 row_added 管;别的列与游标无关
        cells[e.rowId] = replaceKeyPart(cells[e.rowId], cols.length, slot, e.key); // 多列只换本列那一格,其余列的 key 原样
        hit = true;
      }
      if (hit) patch[id] = { ...cur, cells };
    }
  }
  if (Object.keys(patch).length) await io.setCursors(patch);
}

/**
 * 手动起跑一条规则的动作链(面板试跑 / Amadeus 按钮块)——**必须走这里,不许直接 runActions**。
 *
 * M5(2026-09-02):fire 路由从前拿到 `runActions` 的返回就丢掉了 `touched`,不调 advanceSelfCursors。
 * 于是对一条「写自己盯的那张表」的 db_changed 规则点一次试跑,自写不可见**不成立**:试跑写进去的行
 * 在下一 tick 被评估成真事件,整条动作链**再跑一遍**(含 notify / 写别的表)。「试跑」= 真跑两次。
 * 巡检那条路(drain)一直是对的(ack 之后 advanceSelfCursors),这里补齐同一条语义。
 * busy 不推:什么都没写。
 */
export async function fireTrigger(t: MuseTrigger, origin: ActionOrigin, ctx?: TriggerContext): Promise<RunActionsResult> {
  const r = await runActions(t, origin, ctx);
  if (r.status !== 'busy' && Object.keys(r.touched).length) {
    await advanceSelfCursors({ [t.id]: r.touched }).catch((e: any) => log(`试跑后推自游标失败(${t.id}):${e?.message || e}`));
  }
  return r;
}

/** 一次命中(同一规则多行命中 = 多条 hit,ctx 各自不同;非 db 规则 ctx 为空)。 */
export interface TriggerHit { t: MuseTrigger; ctx?: TriggerContext }

export interface LaunchResult {
  /** 应烧 cooldown / 应 ack 游标的规则 id(去重)。 */
  launched: string[];
  /** 规则 id → 本轮其动作链真写过的表及精确因果(给 advanceSelfCursors 合并);busy / 未起跑的规则不在其中。 */
  touched: Record<string, TouchedDbs>;
}

/**
 * 启动一批命中,返回**应烧 cooldown** 的规则 id 与各自写过的表:
 *   动作链规则 → runActions 开跑即算(部分失败也 mark,防副作用重放);
 *   旧式 agentSlug 规则 → 实际起跑才算(让位/在跑/无模型不烧 cooldown,下轮重试)。
 * 同一规则的 n 个 hit **串行** await(inFlight 单飞锁按规则 id;并行会让第 2 个起全部 busy)。
 * 任一 hit 没跑成 —— 动作链返回 busy(被 fire 端点的用户点击占住)/ agentSlug 规则 launchUnattendedRun 返回 false
 * (常驻会话在跑、无模型、agent 缺失)→ 该规则本轮**整条不 ack、不推自游标**、下轮重来,并 log:
 * 接受已跑 hit 的副作用重复;S0 禁止的是丢行(推了自游标 = 没跑的行被当成已消费)。
 * (评估侧对含 LLM 的规则每 tick 只给一行,这里是第二道兜底。)
 */
/** 窄注入口(缺省 = 真 runActions)。`busy` 只在「fire 路由的用户点击正占着单飞锁」时发生 ——
 *  单测里造不出确定性的并发,而 M6 要守的恰恰是那条路径;测 mimic 等于不测(本仓假绿母题)。 */
export interface LaunchIo { runActions: typeof runActions }

export async function launchAutomationTriggers(hits: TriggerHit[], io: LaunchIo = { runActions }): Promise<LaunchResult> {
  const launched: string[] = [];
  const touched: Record<string, TouchedDbs> = {};
  if (!hits.length) return { launched, touched };
  try {
    if (await anyUserRunActive()) { log('用户有进行中的 run,本轮让位'); return { launched, touched }; }
  } catch { return { launched, touched }; }
  const busy = new Set<string>();
  const ran = new Set<string>();
  for (const { t, ctx } of hits) {
    if (busy.has(t.id)) continue; // 同规则前一个 hit 已 busy:余下不跑,整条留到下轮
    try {
      if (t.actions?.length) {
        const r = await io.runActions(t, 'auto', ctx);
        if (r.status === 'busy') {
          busy.add(t.id);
          log(`规则 ${t.id} 本轮有命中被单飞挡下,整条不 ack,下轮重来`);
          continue;
        }
        ran.add(t.id);
        for (const [p, touch] of Object.entries(r.touched)) {
          const acc = (touched[t.id] ??= {});
          acc[p] = mergeTouch(acc[p] ?? emptyTouch(), touch);
        }
      } else {
        const ok = await launchUnattendedRun({
          agentSlug: String(t.agentSlug || ''),
          triggerKey: t.id,
          title: String(t.desc),
          message: automationMessage(t),
        });
        if (ok) ran.add(t.id);
        else {
          // 没起跑的 hit(在跑/无模型/agent 缺失)= 这行没被处理:整条不 ack,否则游标把它当成已消费(N-1 行被吞)。
          busy.add(t.id);
          log(`规则 ${t.id} 本轮有命中未起跑,整条不 ack,下轮重来`);
        }
      }
    } catch (e: any) {
      log(`规则 ${t.id} 启动失败:${e?.message || e}`);
    }
  }
  for (const id of ran) {
    // busy = 这条规则本轮有 hit 没跑成 → **不 ack 待处理游标**(整条留到下轮重来)。
    // ⚠️ M6(2026-09-02):从前这里连 `touched[id]` 一起删。那是两件事被连坐 —— 已跑成的那几个 hit
    // **真的写了表**,自写因果丢掉 = advanceSelfCursors 不推本规则自己的游标 = 下一 tick 把自己刚写的行
    // 当成外部事件再触发一次(纯动作链无冷却时就是自激)。「不 ack」与「合并自写因果」互不相干:
    // 前者管「没处理的行别当已消费」,后者管「处理过的写入别当别人的改动」,两者都要。
    if (busy.has(id)) continue;
    launched.push(id);
  }
  return { launched, touched };
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
