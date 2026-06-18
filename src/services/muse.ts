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
import { loadSpecialAgentsConfig, DEFAULT_MUSE_PROMPT, isWithinActiveHours, type MuseConfig } from './specialAgentsConfig.js';

let timer: ReturnType<typeof setInterval> | null = null;
let windowStartMs = 0;
let restartsThisWindow = 0;
let lastCycleAt = 0;
let lastError: string | null = null;
let lastRunning = false;
let currentSessionId: string | null = null;

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
  const hint = (await folderHint(cfg.allowedFolders)) + (await recentSessionTitles(userId));
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
        '开始这一轮思考：通读你掌握的用户信息（记忆、日志、近期会话主题、授权文件夹），' +
        '找出当前最值得为用户做的 1-3 件事，用 add_muse_todo 记录（珍惜额度）。完成后简要说明你的判断依据。',
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
    if (!cfg.enabled || !cfg.modelId) { lastRunning = false; return; }
    if (!isWithinActiveHours(cfg, nowHour())) return;
    rollWindow(cfg);

    const userId = museUserId();
    const sid = currentSessionId || (await getMuseSessionId(userId));
    if (sid && (await isRunning(sid))) { lastRunning = true; return; }
    lastRunning = false;

    if (restartsThisWindow >= cfg.maxRestartsPerWindow) return; // 本窗口预算用尽
    restartsThisWindow += 1;
    await startCycle(cfg);
  } catch (e: any) {
    lastError = e?.message || String(e);
  }
}

/** 启动 Muse supervisor（幂等）。间隔取配置的 supervisorPollMinutes（首启读一次；改配置下个 tick 生效）。 */
export function startMuseSupervisor(): void {
  if (timer) return;
  if (!isLocal()) return;
  let pollMin = 5;
  try { pollMin = loadSpecialAgentsConfig().muse.supervisorPollMinutes; } catch { /* 默认 */ }
  timer = setInterval(() => { void tick(); }, Math.max(1, pollMin) * 60_000);
  (timer as any).unref?.();
  // 首次延迟一个轮询周期再跑（避免开机即抢资源）；不立即 tick。
}

export function stopMuseSupervisor(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export interface MuseStatus {
  enabled: boolean;
  hasModel: boolean;
  running: boolean;
  restartsThisWindow: number;
  maxRestartsPerWindow: number;
  todosThisWindow?: number;
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
