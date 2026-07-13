/**
 * Muse（后台常驻 Special Agent）—— 一直自动思考「现在能为用户做点什么」。
 *
 * 身份 = 文件夹系统 agent `~/.tangu/agents/muse/`（config.toml developer_instructions + SOUL.md 人格 +
 * 自己的 MEMORY.md/LOG，经 agentConfig.agentSlug 激活）：跨周期持久记忆，用户可像普通 agent 一样编辑其
 * 人格与指令。每周期的**动态**上下文（TODO 预算、用户记忆快照、跨 agent 活动摘要、近期会话标题、授权
 * 文件夹、TODO 去重提示）注入 kickoff 消息。
 *
 * 运行形态：每个周期 = 在隔离的 kind='muse' 会话里起一个 run（经 agentLoop），planMode（只读）下拥有
 * 恰好两个写权限：add_muse_todo（对用户的唯一输出）+ remember（写自己的 MEMORY.md 做自我校准；用户对
 * TODO 的处理会以 [feedback] 行进它的 LOG，见 routes/special.ts）。z=maxIterationsPerCycle 即 run 的
 * maxIterations。
 *
 * 自重启=定时巡检拉起（每 supervisorPollMinutes 检测；没在跑且本窗口未超 maxRestartsPerWindow 即拉起）。
 * 受 activeHours（设备本地时）约束。仅本地形态（hostExec profile）；未启用/无模型/非本地 → 全 no-op。
 */
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'node:fs';
import { query, getOlderThanSql } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { createRun } from './runStore.js';
import { enqueueRun } from './agentLoop.js';
import { loadSpecialAgentsConfig, legacyMusePrompt, isWithinActiveHours, buildTodoDedupHint, resolveBackgroundModelId, type MuseConfig } from './specialAgentsConfig.js';
import { MUSE_AGENT_SLUG, ensureMuseAgent, listAgents, resolveMemorySlug } from '../agents/agentRegistry.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { readActivityLines } from './userActivity.js';
import { loadTriggers, evaluateTriggers, markTriggersFired, buildTriggerKickoff, type MuseTrigger } from './museTriggers.js';
import { launchAutomationTriggers, launchDueSchedules } from './automation.js';

let timer: ReturnType<typeof setInterval> | null = null;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let windowStartMs = 0;
let restartsThisWindow = 0;
let lastCycleAt = 0;
let lastError: string | null = null;
let lastRunning = false;
let currentSessionId: string | null = null;

function log(msg: string): void {
  try { deps().host.log(`[muse] ${msg}`); } catch { console.log(`[muse] ${msg}`); }
}
function isLocal(): boolean {
  try { return !!deps().profile.capabilities.hostExec; } catch { return false; }
}
function museUserId(): string {
  return process.env.TANGU_USER_ID || 'local';
}
function nowHour(): number {
  return new Date().getHours();
}

export async function getMuseSessionId(userId: string): Promise<string | null> {
  const rows = await query<any[]>(
    `SELECT id FROM chat_sessions WHERE user_id = ? AND kind = 'muse' ORDER BY created_at ASC LIMIT 1`,
    [userId],
  );
  return rows[0]?.id || null;
}

async function ensureMuseSession(userId: string, modelId: string): Promise<string> {
  const existing = await getMuseSessionId(userId);
  if (existing) return existing;
  const id = uuidv4();
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, ?, 'Muse', ?, 'muse')`,
    [id, userId, deps().profile.appId, modelId],
  );
  return id;
}

async function isRunning(sessionId: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM agent_runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    [sessionId],
  );
  return !!rows.length;
}

/** 本 Muse 会话在最近 windowHours 小时内累计消耗的 token（滚动窗口，直接从 agent_runs 求和 →
 *  跨进程重启不丢；单 run 失控另由 TANGU_MAX_RUN_COST 兜底，此处只算「一段时间反复唤醒」的累计）。 */
export async function tokensInWindow(sessionId: string, windowHours: number): Promise<number> {
  // NOT(older than) = created_at 落在窗口内；created_at 有默认值不为空，故取反等价于 >=。方言经 getOlderThanSql。
  const within = `NOT (${getOlderThanSql('created_at', Math.round(windowHours * 60))})`;
  const rows = await query<any[]>(
    `SELECT COALESCE(SUM(tokens_total), 0) AS t FROM agent_runs WHERE session_id = ? AND ${within}`,
    [sessionId],
  );
  return Number(rows[0]?.t || 0);
}

/** 是否有任何**用户**会话的 run 正在排队/运行——后台 Muse 据此让位，避免与用户抢同一模型账号/速率。 */
async function anyUserRunActive(): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM agent_runs r JOIN chat_sessions s ON s.id = r.session_id
     WHERE r.status IN ('queued', 'running') AND s.kind = 'user' LIMIT 1`,
  );
  return !!rows.length;
}

/** 自 sinceMs（epoch ms）以来该用户的 user 会话是否有新消息。sinceMs=0（冷启动/重启）→ 视为有活动、放行。 */
async function userActivitySince(userId: string, sinceMs: number): Promise<boolean> {
  if (!sinceMs) return true;
  const rows = await query<any[]>(
    `SELECT 1 FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
     WHERE s.user_id = ? AND s.kind = 'user' AND m.timestamp > ? LIMIT 1`,
    [userId, sinceMs],
  );
  return !!rows.length;
}

/** 取该用户近期 TODO（pending + 已处理/驳回）拼成去重提示，注入 Muse 系统提示。失败 → 空串。 */
async function existingTodoHint(userId: string): Promise<string> {
  try {
    const rows = await query<any[]>(
      `SELECT title, status FROM muse_todos WHERE user_id = ? ORDER BY created_at DESC LIMIT 40`,
      [userId],
    );
    return buildTodoDedupHint(rows || []);
  } catch {
    return '';
  }
}

/** 授权文件夹的浅列出(注入提示，让 Muse 知道可用 read_file/list_files 探索的路径)。 */
async function folderHint(folders: string[]): Promise<string> {
  if (!folders.length) return '';
  const lines: string[] = [];
  for (const f of folders.slice(0, 10)) {
    try {
      const entries = await fs.readdir(f, { withFileTypes: true });
      const names = entries.slice(0, 20).map((e) => e.name + (e.isDirectory() ? '/' : '')).join(', ');
      lines.push(`- ${f} (${names || 'empty'})`);
    } catch {
      lines.push(`- ${f} (unreadable)`);
    }
  }
  return `\n\nYou are authorized to read the following local folders; explore them with read_file/list_dir (absolute paths):\n${lines.join('\n')}`;
}

async function recentSessionTitles(userId: string): Promise<string> {
  try {
    const rows = await query<any[]>(
      `SELECT title FROM chat_sessions WHERE user_id = ? AND kind = 'user' AND archived = FALSE
       ORDER BY updated_at DESC LIMIT 15`,
      [userId],
    );
    const titles = (rows || []).map((r) => String(r.title || '').trim()).filter(Boolean);
    return titles.length ? `\n\nUser's recent conversation topics: ${titles.join('; ')}` : '';
  } catch {
    return '';
  }
}

/** 用户长期记忆快照(默认 agent 的 MEMORY.md)。Muse 绑定自己的记忆域后,注入 run 的「长期记忆」
 *  是 Muse 自己的,故用户画像须在此显式带入(runWithAgentSlug 临时切域读取)。 */
async function userMemoryHint(userId: string): Promise<string> {
  try {
    const m = await runWithAgentSlug(DEFAULT_AGENT_SLUG, () => deps().brain.memory.getMemory(userId));
    const content = String(m?.content || '').trim().slice(0, 3000);
    return content ? `\n\n[User's long-term memory]\n${content}` : '';
  } catch {
    return '';
  }
}

/** 本地日期(含今天)倒推 n 天的 YYYY-MM-DD 列表(新→旧)。 */
function lastDates(n: number): string[] {
  const out: string[] = [];
  const p = (x: number): string => String(x).padStart(2, '0');
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  return out;
}

/** 纯拼装:各记忆域 LOG 尾部截断(单域 ≤1200 字)+ 总量帽(≤4000 字)。抽出便于单测。 */
export function buildActivityDigest(sections: Array<{ scope: string; text: string }>): string {
  const parts: string[] = [];
  let total = 0;
  for (const s of sections) {
    const t = s.text.trim().slice(-1200);
    if (!t) continue;
    if (total + t.length > 4000) break;
    total += t.length;
    parts.push(`--- agent:${s.scope} ---\n${t}`);
  }
  return parts.length
    ? `\n\n[Recent activity across the user's agents (from their daily logs)]\n${parts.join('\n')}`
    : '';
}

/** 跨 agent 近期活动摘要:遍历各 agent 的记忆域(resolveMemorySlug 去重、跳过 muse 自己),
 *  临时切域读近 2 天 LOG。Historian 维护的用户日志与各 agent 的 log_event 都在这里被 Muse 看见。 */
async function recentActivityHint(userId: string): Promise<string> {
  try {
    const defs = await listAgents();
    const scopes: string[] = [];
    for (const d of defs) {
      const scope = resolveMemorySlug(d);
      if (scope !== MUSE_AGENT_SLUG && !scopes.includes(scope)) scopes.push(scope);
    }
    const dates = lastDates(2);
    const sections: Array<{ scope: string; text: string }> = [];
    for (const scope of scopes.slice(0, 20)) {
      let text = '';
      for (const date of dates) {
        try {
          const l = await runWithAgentSlug(scope, () => deps().brain.memory.getLog(userId, date));
          if (l?.content) text += l.content + '\n';
        } catch { /* 单域读失败不阻断 */ }
      }
      if (text.trim()) sections.push({ scope, text });
    }
    return buildActivityDigest(sections);
  } catch {
    return '';
  }
}

/** 用户应用内活动尾部(数据源见 userActivity.ts;桌面埋点+agent.edit 双写)。失败 → 空串。 */
async function activityTailHint(): Promise<string> {
  try {
    const lines = await readActivityLines({ hours: 12, limit: 60 });
    if (!lines.length) return '';
    const text = lines.join('\n').slice(-1500);
    return (
      '\n\n[Recent in-app user activity (last 12h; one event per line, oldest first)]\n' +
      text +
      '\n(Query more or older activity with the read_activity tool.)'
    );
  } catch {
    return '';
  }
}

async function startCycle(cfg: MuseConfig, extraKickoff = ''): Promise<void> {
  const userId = museUserId();
  const sessionId = await ensureMuseSession(userId, cfg.modelId);
  // 动态上下文全部进 kickoff 消息(每周期新鲜数据);静态身份(developer_instructions + SOUL + Muse 自己
  // 的长期记忆)由 agentSlug 激活注入 system——不再内联 systemPrompt,否则会覆盖文件夹里的用户编辑。
  const hint =
    (await userMemoryHint(userId)) +
    (await recentActivityHint(userId)) +
    (await activityTailHint()) +
    (await recentSessionTitles(userId)) +
    (await folderHint(cfg.allowedFolders)) +
    (await existingTodoHint(userId));
  const message =
    'Start this round of thinking: first use read_log to review your own recent cycles and the [feedback] entries showing how the user handled your previous todos. ' +
    'Then combine your long-term memory with the context below to find the 1-3 most worthwhile things to do for the user right now. ' +
    `Avoid the "TODOs you have already proposed" below; use add_muse_todo only for genuinely new, high-value todos (at most ${cfg.maxTodosPerWindow} this period — spend the quota sparingly). ` +
    'You may use remember to record durable insights about the user (what they value, accept, or dismiss). When done, briefly explain your reasoning.' +
    extraKickoff +
    hint;
  const runId = uuidv4();
  await createRun({
    id: runId,
    sessionId,
    userId,
    appId: deps().profile.appId,
    modelId: cfg.modelId,
    assistantMessageId: uuidv4(),
    input: {
      message,
      userMessageId: uuidv4(),
      attachments: [],
      agentConfig: {
        muse: true,
        planMode: true,
        execMode: 'host',
        agentSlug: MUSE_AGENT_SLUG,
        cwd: cfg.allowedFolders[0] || undefined,
        approvalMode: 'full-auto',
        maxIterations: cfg.maxIterationsPerCycle,
      },
    },
  });
  currentSessionId = sessionId;
  lastCycleAt = Date.now();
  lastRunning = true;
  enqueueRun(sessionId, runId);
}

function rollWindow(cfg: MuseConfig): void {
  const span = cfg.restartWindowHours * 3600_000;
  if (!windowStartMs || Date.now() - windowStartMs >= span) {
    windowStartMs = Date.now();
    restartsThisWindow = 0;
  }
}

async function tick(): Promise<void> {
  try {
    if (!isLocal()) return;
    // ── 盯任务规则评估(零 token 代码判定)。刻意放在 muse.enabled/activeHours 闸**之前**:
    // 带 agentSlug 的规则属于任意 agent 的自动化,关掉 Muse 不应连它们一起灭。
    let museFired: MuseTrigger[] = [];
    try {
      const triggers = await loadTriggers();
      if (triggers.length) {
        const activityLines = await readActivityLines({ hours: 24, limit: 500 });
        const fired = await evaluateTriggers(triggers, { activityLines });
        const agentFired = fired.filter((t) => t.agentSlug && t.agentSlug !== MUSE_AGENT_SLUG);
        museFired = fired.filter((t) => !agentFired.includes(t));
        if (agentFired.length) {
          log(`agent 自动化命中 ${agentFired.length} 条:${agentFired.map((t) => t.id).join(', ')}`);
          // launcher 自带让位/防重入/模型守卫;只对**实际起跑**的规则烧 cooldown(与 Muse 老路同语义)。
          const launched = await launchAutomationTriggers(agentFired);
          if (launched.length) await markTriggersFired(launched);
        }
      }
    } catch (e: any) {
      log(`盯任务评估失败:${e?.message || e}`);
    }

    // ── Agent 日程到期评估(agents/<slug>/SCHEDULE.db 的 auto 条目;同在 muse.enabled 闸之前)。
    try {
      await launchDueSchedules();
    } catch (e: any) {
      log(`日程评估失败:${e?.message || e}`);
    }

    const cfg = loadSpecialAgentsConfig().muse;
    if (!cfg.enabled) { lastRunning = false; return; }
    // 模型解析:用户显式配置 > admin 后台默认槽 > 对话默认(未选模型=跟随云端,admin 改动下轮生效)。
    cfg.modelId = await resolveBackgroundModelId(cfg.modelId);
    if (!cfg.modelId) { lastRunning = false; log('已启用但无可用模型(本地未选且云端无后台默认),跳过'); return; }
    // 播种/自愈 Muse 系统 agent 文件夹(幂等;首次创建时一次性迁移旧自定义 prompt)。
    await ensureMuseAgent(legacyMusePrompt()).catch((e: any) => log(`播种 muse agent 失败:${e?.message || e}`));
    if (!isWithinActiveHours(cfg, nowHour())) { log(`不在运行时段(当前 ${nowHour()} 时),跳过`); return; }

    const userId = museUserId();
    // 后台让位：用户有进行中的 run → 不与之抢模型账号/速率，本轮跳过（下次巡检再来）。
    if (await anyUserRunActive()) { lastRunning = false; log('用户有进行中的 run，本轮让位'); return; }
    // museFired 命中 → 本轮必起周期(豁免下面的"无新活动"跳过,
    // 但不豁免 isRunning/token/restarts 预算闸——防规则失控烧穿额度)。
    // 节奏按变化：自上一周期以来无新用户消息 → 空跑无意义，跳过（不占自重启预算）。
    if (!museFired.length && !(await userActivitySince(userId, lastCycleAt))) { lastRunning = false; log('自上一周期以来无新活动，跳过'); return; }
    if (museFired.length) log(`盯任务命中 ${museFired.length} 条:${museFired.map((t) => t.id).join(', ')}`);

    rollWindow(cfg);
    const sid = currentSessionId || (await getMuseSessionId(userId));
    if (sid && (await isRunning(sid))) { lastRunning = true; return; }
    lastRunning = false;

    // token 预算：本 Muse 会话最近 tokenBudgetWindowHours 小时累计 token 超上限 → 本轮不起新周期。
    // 挡的是「后台反复唤醒把一段时间的额度烧穿」；单趟失控由 TANGU_MAX_RUN_COST 兜底，两层不重叠。
    if (cfg.maxTokensPerWindow > 0 && sid) {
      const spent = await tokensInWindow(sid, cfg.tokenBudgetWindowHours);
      if (spent >= cfg.maxTokensPerWindow) {
        log(`token 预算用尽(近 ${cfg.tokenBudgetWindowHours}h 已用 ${spent}/${cfg.maxTokensPerWindow}),本轮跳过`);
        return;
      }
    }

    if (restartsThisWindow >= cfg.maxRestartsPerWindow) { log(`本窗口预算用尽(${restartsThisWindow}/${cfg.maxRestartsPerWindow})`); return; }
    restartsThisWindow += 1;
    log(`启动第 ${restartsThisWindow}/${cfg.maxRestartsPerWindow} 个思考周期(模型 ${cfg.modelId})`);
    await startCycle(cfg, buildTriggerKickoff(museFired));
    // lastFiredAt 只在周期真正启动后写回:被上面任何闸挡住 → 下轮重试,不白烧 cooldown。
    if (museFired.length) await markTriggersFired(museFired.map((t) => t.id));
  } catch (e: any) {
    lastError = e?.message || String(e);
    log(`tick 失败:${lastError}`);
  }
}

/** 启动 Muse supervisor（幂等）。间隔取配置的 supervisorPollMinutes；首次 ~15s 后即跑(不必等满一个周期)。 */
export function startMuseSupervisor(): void {
  if (timer) return;
  if (!isLocal()) return;
  let pollMin = 5;
  try { pollMin = loadSpecialAgentsConfig().muse.supervisorPollMinutes; } catch { /* 默认 */ }
  log(`supervisor 启动(每 ${pollMin} 分钟巡检;15s 后首次)`);
  timer = setInterval(() => { void tick(); }, Math.max(1, pollMin) * 60_000);
  (timer as any).unref?.();
  // 首次延迟 15s 即跑(开机不抢资源、但开启后很快就能起来,不必等满一个 poll 周期)。
  kickTimer = setTimeout(() => { void tick(); }, 15_000);
  (kickTimer as any).unref?.();
}

/** 配置变更(如刚启用 Muse)后催一次 tick——免得等满一个巡检周期。 */
export function kickMuse(): void {
  if (!timer) return; // supervisor 未起则不催(boot 时会起)
  if (kickTimer) clearTimeout(kickTimer);
  kickTimer = setTimeout(() => { void tick(); }, 1500);
  (kickTimer as any).unref?.();
}

export function stopMuseSupervisor(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
}

export interface MuseStatus {
  enabled: boolean;
  hasModel: boolean;
  running: boolean;
  restartsThisWindow: number;
  maxRestartsPerWindow: number;
  lastCycleAt: number | null;
  lastError: string | null;
  sessionId: string | null;
}

export async function museStatus(): Promise<MuseStatus> {
  let cfg;
  try { cfg = loadSpecialAgentsConfig().muse; } catch { cfg = null; }
  // sessionId/running 从 DB 实查(进程内 flag 重启后漂移;工作视图的「当前思考」也靠 sessionId 复原)。
  let sessionId = currentSessionId;
  let running = lastRunning;
  try {
    sessionId = sessionId || (await getMuseSessionId(museUserId()));
    running = sessionId ? await isRunning(sessionId) : false;
  } catch { /* DB 不可用 → 回退进程内快照 */ }
  return {
    enabled: !!cfg?.enabled,
    hasModel: !!cfg?.modelId,
    running,
    restartsThisWindow,
    maxRestartsPerWindow: cfg?.maxRestartsPerWindow ?? 0,
    lastCycleAt: lastCycleAt || null,
    lastError,
    sessionId,
  };
}
