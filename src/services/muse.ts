/**
 * Muse（后台常驻 Special Agent）—— 一直自动思考「现在能为用户做点什么」，唯一写权限是 add_muse_todo。
 *
 * 运行形态：每个周期 = 在隔离的 kind='muse' 会话里起一个 run（经 agentLoop），用 **planMode（只读）+
 * add_muse_todo** 实现「读全部 + 只写 TODO」；读权限含注入的用户记忆 + read_log/read_file（host，cwd/
 * 授权文件夹）+ 注入的近期会话标题。z=maxIterationsPerCycle 即 run 的 maxIterations。
 *
 * 自重启=定时巡检拉起（每 supervisorPollMinutes 检测；没在跑且本窗口未超 maxRestartsPerWindow 即拉起）。
 * 受 activeHours（设备本地时）约束。仅本地形态（hostExec profile）；未启用/无模型/非本地 → 全 no-op。
 */
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'node:fs';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { createRun } from './runStore.js';
import { enqueueRun } from './agentLoop.js';
import { loadSpecialAgentsConfig, DEFAULT_MUSE_PROMPT, isWithinActiveHours, buildTodoDedupHint, type MuseConfig } from './specialAgentsConfig.js';

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

async function getMuseSessionId(userId: string): Promise<string | null> {
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
      const names = entries.slice(0, 20).map((e) => e.name + (e.isDirectory() ? '/' : '')).join('、');
      lines.push(`- ${f}（${names || '空'}）`);
    } catch {
      lines.push(`- ${f}（无法读取）`);
    }
  }
  return `\n\n你被授权读取以下本地文件夹，可用 read_file/list_files（绝对路径）探索：\n${lines.join('\n')}`;
}

async function recentSessionTitles(userId: string): Promise<string> {
  try {
    const rows = await query<any[]>(
      `SELECT title FROM chat_sessions WHERE user_id = ? AND kind = 'user' AND archived = FALSE
       ORDER BY updated_at DESC LIMIT 15`,
      [userId],
    );
    const titles = (rows || []).map((r) => String(r.title || '').trim()).filter(Boolean);
    return titles.length ? `\n\n用户近期会话主题：${titles.join('；')}` : '';
  } catch {
    return '';
  }
}

async function startCycle(cfg: MuseConfig): Promise<void> {
  const userId = museUserId();
  const sessionId = await ensureMuseSession(userId, cfg.modelId);
  const hint = (await folderHint(cfg.allowedFolders)) + (await recentSessionTitles(userId)) + (await existingTodoHint(userId));
  const system =
    `${cfg.prompt || DEFAULT_MUSE_PROMPT}\n\n` +
    `约束：本时段最多新增 ${cfg.maxTodosPerWindow} 条 TODO，请珍惜额度，只提交真正高价值、可执行的建议。` +
    `你只能通过 add_muse_todo 写入；其余一律只读。` + hint;
  const runId = uuidv4();
  await createRun({
    id: runId,
    sessionId,
    userId,
    appId: deps().profile.appId,
    modelId: cfg.modelId,
    assistantMessageId: uuidv4(),
    input: {
      message:
        '开始这一轮思考：先用 read_log 查看近期日志，再结合注入的记忆、近期会话主题与授权文件夹，' +
        '找出当前最值得为用户做的 1-3 件事。务必避开下方「你已提过的 TODO」，只用 add_muse_todo 记录真正新的高价值待办（珍惜额度）。完成后简要说明你的判断依据。',
      userMessageId: uuidv4(),
      attachments: [],
      agentConfig: {
        muse: true,
        planMode: true,
        execMode: 'host',
        cwd: cfg.allowedFolders[0] || undefined,
        approvalMode: 'full-auto',
        maxIterations: cfg.maxIterationsPerCycle,
        systemPrompt: system,
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
    const cfg = loadSpecialAgentsConfig().muse;
    if (!cfg.enabled) { lastRunning = false; return; }
    if (!cfg.modelId) { lastRunning = false; log('已启用但未选模型,跳过'); return; }
    if (!isWithinActiveHours(cfg, nowHour())) { log(`不在运行时段(当前 ${nowHour()} 时),跳过`); return; }

    const userId = museUserId();
    // 后台让位：用户有进行中的 run → 不与之抢模型账号/速率，本轮跳过（下次巡检再来）。
    if (await anyUserRunActive()) { lastRunning = false; log('用户有进行中的 run，本轮让位'); return; }
    // 节奏按变化：自上一周期以来无新用户消息 → 空跑无意义，跳过（不占自重启预算）。
    if (!(await userActivitySince(userId, lastCycleAt))) { lastRunning = false; log('自上一周期以来无新活动，跳过'); return; }

    rollWindow(cfg);
    const sid = currentSessionId || (await getMuseSessionId(userId));
    if (sid && (await isRunning(sid))) { lastRunning = true; return; }
    lastRunning = false;

    if (restartsThisWindow >= cfg.maxRestartsPerWindow) { log(`本窗口预算用尽(${restartsThisWindow}/${cfg.maxRestartsPerWindow})`); return; }
    restartsThisWindow += 1;
    log(`启动第 ${restartsThisWindow}/${cfg.maxRestartsPerWindow} 个思考周期(模型 ${cfg.modelId})`);
    await startCycle(cfg);
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

export function museStatus(): MuseStatus {
  let cfg;
  try { cfg = loadSpecialAgentsConfig().muse; } catch { cfg = null; }
  return {
    enabled: !!cfg?.enabled,
    hasModel: !!cfg?.modelId,
    running: lastRunning,
    restartsThisWindow,
    maxRestartsPerWindow: cfg?.maxRestartsPerWindow ?? 0,
    lastCycleAt: lastCycleAt || null,
    lastError,
    sessionId: currentSessionId,
  };
}
