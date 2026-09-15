/**
 * Muse（后台常驻 Special Agent）—— 一直自动思考「现在能为用户做点什么」。
 *
 * 身份 = 文件夹系统 agent `~/.tangu/agents/muse/`（config.toml developer_instructions + SOUL.md 人格 +
 * 自己的 MEMORY.md/LOG，经 agentConfig.agentSlug 激活）：跨周期持久记忆，用户可像普通 agent 一样编辑其
 * 人格与指令。每周期的**动态**上下文（用户记忆快照、跨 agent 活动摘要、活动尾、近期会话标题、授权
 * 文件夹、TODO 去重提示、本次触发原因）经 `input.ephemeralHint` 走尾部 user 通道注入：**不落库、不回放**
 * （2026-09-14：它是 5k 字符的时点摘要，落库后每个后续周期都要重发 N 份陈旧副本，缓存与窗口双输）。
 * 落库的 kickoff 只剩一段同配置下逐字不变的短指令 —— 会话内回放于是是稳定前缀。
 * 会话按消息数轮换（见 MUSE_SESSION_MAX_MESSAGES），运行态（lastCycleAt）落 ~/.tangu/muse-state.json（引擎自有状态域，**不在** Muse 可写的 agent 目录里）。
 *
 * 运行形态（2026-09-10 权限档改版）：每个周期 = 在隔离的 kind='muse' 会话里起一个 run（经 agentLoop）。
 * Muse 不再跑只读 planMode,而是像普通 agent 一样按**权限档**工作(cfg.mode,与普通 agent 的审批档对齐):
 *   ask   → approvalMode 'auto-edit' + approvalDeferral 'queue':Library/自己目录内自由;越界写/跑命令排进
 *           pending_approvals,用户批准后由引擎按原参数代执行(services/pendingApprovals.ts);
 *   agent → 同上,但先由默认 agent 代用户裁决一次(否决才排队);
 *   auto  → 'full-auto',allowedFolders 并入可写根。
 *   三档都把自己的 Space 目录(agents/muse/Space,自建 Forsion 插件)并入可写根:Space 由 Muse 自己迭代,不该逐次审批。
 * 工作区 = 自己的 Library(~/.tangu/agents/muse/Library;桌面 Agent Space 直接浏览),每日工作日志由本文件在
 * 周期结束时**机械**追加到 Library/Journal/<date>.md(不靠模型自觉)。对用户的出口 = add_muse_todo(顺手进收件箱)
 * + 收件箱回执;用户对 TODO / 待批的处理以 [feedback] / [approval] 行进它的 LOG(下周期 read_log 即见)。
 *
 * 触发(全内置):心跳 heartbeatMinutes(缺省 120 分钟,到点必起、安静也记一笔;比巡检细时巡检跟着缩)+ 自己 SCHEDULE.db 的到期 auto 条目
 * (自触发 / Track,回灌本周期而非 automation 会话)+ 盯任务规则命中(museFired)。
 * 自重启=定时巡检拉起（每 supervisorPollMinutes 检测；没在跑且本窗口未超 maxRestartsPerWindow 即拉起）。
 * 受 activeHours（设备本地时）约束。仅本地形态（hostExec profile）；未启用/无模型/非本地 → 全 no-op。
 */
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { query, getOlderThanSql } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { createRun, setRunTerminalListener } from './runStore.js';
import { enqueueRun } from './agentLoop.js';
import { loadSpecialAgentsConfig, legacyMusePrompt, isWithinActiveHours, buildTodoDedupHint, resolveBackgroundModelId, type MuseConfig } from './specialAgentsConfig.js';
import { MUSE_AGENT_SLUG, ensureMuseAgent, getAgent, listAgents, resolveMemorySlug } from '../agents/agentRegistry.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { DEFAULT_AGENT_SLUG, agentsDir, checkpointsDir, tanguHome } from '../core/tanguHome.js';
import { backgroundClientTag } from '../core/version.js';
import { displayText } from '../core/displayText.js';

import { loadSchedule, entriesOf, dueEntries, markEntryFired, type ScheduleEntry } from './agentSchedule.js';
import { countPendingApprovals } from './pendingApprovals.js';
import { sendInboxMessage, MUSE_SENDER_ID } from '../tools/builtin/inboxSend.js';
import { readActivityLines } from './userActivity.js';
import { loadTriggers, evaluateTriggers, markTriggersFired, disableTriggers, disableTriggersWithReasons, buildTriggerKickoff, type MuseTrigger, type EventCursor, type DbLike } from './museTriggers.js';
import { loadCursors, setCursors, pruneCursors } from './dbCursors.js';
import { readDbOrNull } from './amadeusDb.js';
import { amadeusVaultPath } from '../tools/builtin/amadeus.js';
import { launchAutomationTriggers, launchDueSchedules, advanceSelfCursors } from './automation.js';
import { drainAutomation } from './automationDrain.js';

let timer: ReturnType<typeof setTimeout> | null = null;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let windowStartMs = 0;
let restartsThisWindow = 0;
let lastCycleAt = 0;
let lastError: string | null = null;
let lastRunning = false;
let currentSessionId: string | null = null;
/** 上一周期的 run:终态后写一行 Journal(靠 run 终态 → kickMuse → tick 起始 flushJournal)。进程重启即丢(该周期无日志行,可接受)。 */
/** Space 目录内容戳(周期收尾刷新;桌面按它变了才重载 Muse 的插件)。0 = 尚未计算。 */
let spaceStamp = 0;
let pendingJournal: { runId: string; sessionId: string; trigger: string; mode: string; startedAt: number } | null = null;

/** Muse 的工作区 = 自己的 Library(桌面 Agent Space 浏览的就是它)。 */
export function museLibraryDir(): string {
  return path.join(agentsDir(), MUSE_AGENT_SLUG, 'Library');
}
/** Muse 自建 Space(2026-09-11)= 一个 Forsion 桌面插件目录(manifest.json + main.js),桌面主进程按 agents/<slug>/Space/ 读取、
 *  id 固定 agent-<slug>。Muse Space 主区渲染它注册的 home 视图;空目录 = 空白态。 */
export function museSpaceDir(): string {
  return path.join(agentsDir(), MUSE_AGENT_SLUG, 'Space');
}
export function museJournalPath(date = localDate()): string {
  return path.join(museLibraryDir(), 'Journal', `${date}.md`);
}

/** Muse 的运行态落盘,住**引擎自有状态域** ~/.tangu/(与 special-agents.json 这份 Muse 配置同级)。
 *  刻意**不**放 agents/muse/:那是 Muse 自己的可写根(fsPolicy.writableRoots),调度控制态放在模型
 *  能写的地方,Muse 或一次提示注入把 lastCycleAt 写成远未来,下次启动读回后心跳条件长期不成立 =
 *  把自己永久停掉(Codex 评审 #2)。位置只挡住 write 工具的可写根,run_bash 那条路另算:文件名同时在
 *  hostSandboxProtection 的 deny 名单里,两道闸都钉。同理**不做**旧位置(agents/muse/state.json)回读迁移 —— 回读就
 *  把这条攻击面原样搬回来;升级后最多多跑一个周期。
 *  今天只有 lastCycleAt:只住内存时**每次启动 app 都会在 15s 后必跑一个周期**(§3.4),开机频繁的用户
 *  等于把心跳配置架空。ponytail: 直接整文件读写、坏文件当没跑过(退回今天的行为),不上原子写/版本号
 *  —— 单写者、丢了最多多跑一个周期。要再存别的运行态就往这个对象里加字段。 */
export function museStateFile(): string {
  return path.join(tanguHome(), 'muse-state.json');
}
export async function readLastCycleAt(): Promise<number> {
  try {
    const raw = JSON.parse(await fs.readFile(museStateFile(), 'utf8'));
    const v = Number(raw?.lastCycleAt);
    // 晚于当前时刻的值只可能来自篡改或时钟回拨 → 当没跑过。宁可多跑一个周期,也不让一个坏值把 Muse 停死。
    return Number.isFinite(v) && v > 0 && v <= Date.now() ? v : 0;
  } catch { return 0; }
}
export async function writeLastCycleAt(ms: number): Promise<void> {
  try {
    await fs.mkdir(path.dirname(museStateFile()), { recursive: true });
    await fs.writeFile(museStateFile(), JSON.stringify({ lastCycleAt: ms }), 'utf8');
  } catch (e: any) { log(`写 muse-state.json 失败:${e?.message || e}`); }
}
/** 进程内只读一次(tick 与 museStatus 都等它:桌面每 4s 轮询 status,比首个 tick 早 15 秒)。 */
let stateLoad: Promise<void> | null = null;
function loadMuseState(): Promise<void> {
  if (!stateLoad) stateLoad = readLastCycleAt().then((v) => { if (v > lastCycleAt) lastCycleAt = v; });
  return stateLoad;
}
export function localDate(d = new Date()): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localTime(d = new Date()): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 周期 run 的 agentConfig(纯函数,按权限档合成;单测钉三档)。
 *  agentThinking = muse 这个文件夹 agent 自己 config.toml 里的思考档(startCycle 读进来):
 *  用户显式设过就尊重他的,没设才用后台缺省。 */
export function museAgentConfig(cfg: MuseConfig, agentThinking?: string): Record<string, unknown> {
  const base = {
    muse: true,
    planMode: false,
    execMode: 'host',
    agentSlug: MUSE_AGENT_SLUG,
    cwd: museLibraryDir(),
    // D3(09-14):后台周期缺省思考·低 —— 「找 1-3 件值得做的事」是判断题不是推演题,medium 只是多烧推理 token。
    // ⚠️ agentActivation 只在 agentConfig **没有**该字段时才用 def 的值,所以这里必须自己先合一次,
    // 否则硬写 'low' = 静默压过用户在 config.toml 里的 model_reasoning_effort。
    thinkingLevel: agentThinking || 'low',
    maxIterations: cfg.maxIterationsPerCycle,
    maxIterationsSource: 'muse', // 收尾提示 / context_info 点名来源:Muse 每周期轮数,不是会话 /loop
    automationOrigin: MUSE_AGENT_SLUG, // 活动行 o=muse:自己写的 agent.edit 不唤醒盯自己的规则
  };
  if (cfg.mode === 'auto') return { ...base, approvalMode: 'full-auto', extraRoots: [museSpaceDir(), ...cfg.allowedFolders.slice(0, 8)] };
  return { ...base, approvalMode: 'auto-edit', approvalDeferral: cfg.mode === 'agent' ? 'agent' : 'queue', extraRoots: [museSpaceDir()] };
}

/** Journal 行(纯函数,单测钉格式)。note 折成单行、截 120 字。 */
export function formatJournalLine(x: { time: string; mode: string; trigger: string; tokens: number; files: number; status: string; note: string }): string {
  const note = displayText(x.note, 120);
  return `- ${x.time} · ${x.mode} · ${displayText(x.trigger, 80)} · tokens ${x.tokens} · files ${x.files} · ${x.status}${note ? ` · ${note}` : ''}`;
}

async function ensureMuseDirs(): Promise<void> {
  await fs.mkdir(path.join(museLibraryDir(), 'Journal'), { recursive: true });
  await fs.mkdir(museSpaceDir(), { recursive: true });
}

/** 追加一行到当日 Journal(文件不存在先写标题)。绝不抛。 */
export async function appendMuseJournal(line: string, date = localDate()): Promise<void> {
  try {
    await ensureMuseDirs();
    const p = museJournalPath(date);
    let exists = true;
    try { await fs.access(p); } catch { exists = false; }
    await fs.appendFile(p, (exists ? '' : `# ${date}\n\n`) + line + '\n', 'utf8');
  } catch (e: any) {
    log(`写 Journal 失败:${e?.message || e}`);
  }
}

/** 检查点 manifest 里本 run 真写过的文件数(run_bash 不在内,与 checkpoints.ts 同口径)。 */
async function filesTouched(sessionId: string, runId: string): Promise<number> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(checkpointsDir(), sessionId, runId, 'manifest.json'), 'utf8'));
    return Array.isArray(m?.entries) ? m.entries.filter((e: any) => !e?.skipped).length : 0;
  } catch { return 0; }
}

/** Space 目录的「内容戳」= 目录内文件的最大 mtime(至多看 200 个条目;跳过点文件与 node_modules)。目录不存在 → 0。
 *  刻意不监听文件:Muse 一个周期里 manifest.json 与 main.js 是两次工具调用,中途求值必是半成品;周期收尾统一刷新一次。 */
export async function spaceDirStamp(dir = museSpaceDir()): Promise<number> {
  let max = 0;
  let seen = 0;
  const walk = async (d: string): Promise<void> => {
    let ents: import('node:fs').Dirent[] = [];
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (seen++ >= 200) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.isFile()) continue;
      try { max = Math.max(max, Math.floor((await fs.stat(p)).mtimeMs)); } catch { /* 刚被删 → 忽略 */ }
    }
  };
  await walk(dir);
  return max;
}

/** 上一周期若已终态 → 写 Journal 行(tick 起始调;run 终态会 kickMuse)。 */
async function flushJournal(): Promise<void> {
  const pj = pendingJournal;
  if (!pj) return;
  try {
    const rows = await query<any[]>(`SELECT status, tokens_total, assistant_message_id FROM agent_runs WHERE id = ? LIMIT 1`, [pj.runId]);
    const run = rows?.[0];
    if (!run || run.status === 'queued' || run.status === 'running') return;
    pendingJournal = null;
    let note = '';
    if (run.assistant_message_id) {
      const m = await query<any[]>(`SELECT content FROM chat_messages WHERE id = ? LIMIT 1`, [run.assistant_message_id]).catch(() => []);
      note = String(m?.[0]?.content || '');
    }
    await appendMuseJournal(formatJournalLine({
      time: localTime(new Date(pj.startedAt)), mode: pj.mode, trigger: pj.trigger,
      tokens: Number(run.tokens_total) || 0, files: await filesTouched(pj.sessionId, pj.runId),
      status: String(run.status), note,
    }), localDate(new Date(pj.startedAt)));
    spaceStamp = await spaceDirStamp().catch(() => spaceStamp); // 周期收尾:Space 变了桌面才重载插件
  } catch (e: any) {
    log(`flushJournal 失败:${e?.message || e}`);
  }
}

/** digest 档:进入新的一天后,把前一天的 Journal 作为日报投递一次(标记文件防重发;urgent=走通道)。 */
async function sendDailyDigestIfDue(cfg: MuseConfig, userId: string): Promise<void> {
  if (cfg.notify !== 'digest') return;
  try {
    const y = localDate(new Date(Date.now() - 86_400_000));
    const marker = path.join(museLibraryDir(), 'Journal', '.digest-sent');
    let sent = '';
    try { sent = (await fs.readFile(marker, 'utf8')).trim(); } catch { /* 首次 */ }
    if (sent >= y) return;
    let body = '';
    try { body = await fs.readFile(museJournalPath(y), 'utf8'); } catch { /* 那天没跑 → 不标记,明天再看(空日不发) */ }
    if (!body.trim()) return;
    const r = await sendInboxMessage(userId, { title: `Muse · ${y}`, body: body.slice(0, 4000), senderId: MUSE_SENDER_ID, urgent: true });
    if (r.ok) await fs.writeFile(marker, y, 'utf8'); // 频控/落库失败不标记,下个 tick 重试
  } catch (e: any) {
    log(`日报投递失败:${e?.message || e}`);
  }
}

/** Muse 自己 SCHEDULE.db 的到期 auto 条目(自触发 / Track)。 */
export async function museDueSchedules(now = new Date()): Promise<ScheduleEntry[]> {
  const db = await loadSchedule(MUSE_AGENT_SLUG);
  const due = db ? dueEntries(entriesOf(db), now) : [];
  // 批准 TODO 建的条目(description = `todo <id>`)只在那条 TODO 真是 injected 时放行:批准路由「先落条目、后改状态」,
  // 两步之间的孤儿条目要等重试把状态改成 injected 才生效;TODO 被忽略了也就不跑。查不到 = 一条都不放(Codex 09-11 P1)。
  const ids = due.map((e) => MUSE_TODO_ENTRY.exec(e.description)?.[1]).filter((x): x is string => !!x);
  if (!ids.length) return due;
  let live = new Set<string>();
  try {
    const rows = await query<any[]>(`SELECT id FROM muse_todos WHERE status = 'injected' AND id IN (${ids.map(() => '?').join(',')})`, ids);
    live = new Set((rows || []).map((r) => String(r.id)));
  } catch { /* fail closed */ }
  return due.filter((e) => { const m = MUSE_TODO_ENTRY.exec(e.description); return !m || live.has(m[1]); });
}
const MUSE_TODO_ENTRY = /^todo ([A-Za-z0-9_-]{1,64})$/;

function scheduleKickoff(due: ScheduleEntry[]): string {
  if (!due.length) return '';
  return (
    '\n\n[Your scheduled tasks that are due now — you set these yourself (manage_schedule); handle each, and update or remove the entry when it no longer applies]\n' +
    due.map((e) => `- ${e.name}${e.repeat ? ` (every ${e.repeat})` : ''}: ${e.prompt || e.name}${e.description ? ` — context: ${e.description.slice(0, 300)}` : ''}`).join('\n')
  );
}

function tierKickoff(cfg: MuseConfig): string {
  const lib = museLibraryDir();
  const common = `Your workspace is your Library (${lib}): keep drafts, notes, plugin drafts and your daily journal (Journal/<date>.md) there — the user can browse it in the app. `;
  if (cfg.mode === 'auto') {
    return common + 'Permission tier: auto — you have full autonomy inside the authorized folders; every file edit is checkpointed so the user can rewind, but still avoid destructive or external actions.';
  }
  if (cfg.mode === 'agent') {
    return common + 'Permission tier: agent — writes inside your Library are free; writing anywhere else or running shell commands is first judged by the user\'s default agent on their behalf, and queued for the user if declined. Never retry a deferred action in this cycle.';
  }
  return common + 'Permission tier: ask — writes inside your Library are free; writing anywhere else or running shell commands is queued for the user\'s approval (the outcome shows up in your log next cycle as an [approval] entry). Never retry a deferred action in this cycle.';
}

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

/** 轮换阈值:一个 Muse 会话攒够这么多条消息就换新的(2026-09-14 C1a)。
 *  从前取**最老**的那行永久复用 → 会话只涨不换,每个周期都在回放几十条陈旧周期,25/38 个周期在第 0 轮就撞压缩线。
 *  ponytail: 按**条数**而不是字节 —— 条数一眼可算、无需估 token。若 live 台架仍见第 0 轮压缩(工具结果嵌在
 *  assistant 行里、单条很肥),对策是把这个常数调小,不是改判据。 */
export const MUSE_SESSION_MAX_MESSAGES = 30;

/** 纯函数(单测钉):这个会话该退休了吗。 */
export function shouldRotateMuseSession(messageCount: number): boolean {
  return messageCount >= MUSE_SESSION_MAX_MESSAGES;
}

/** 当前活动的 Muse 会话 = **最新**的那行(轮换后老会话留在库里只作历史,不再写入)。
 *  museStatus / tick 都经本函数取,桌面 MuseView 读的是 museStatus().sessionId —— 「活动指针」只此一处。 */
export async function getMuseSessionId(userId: string): Promise<string | null> {
  const rows = await query<any[]>(
    `SELECT id FROM chat_sessions WHERE user_id = ? AND kind = 'muse' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0]?.id || null;
}

async function messageCount(sessionId: string): Promise<number> {
  const rows = await query<any[]>(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`, [sessionId]);
  return Number(rows?.[0]?.n) || 0; // PG 回字符串、SQLite 回数字
}

/** 活动会话;不存在或已攒满 → 开一个新的(标题恒 'Muse':kind='muse' 不进会话列表,重名不可见)。export 供单测钉轮换边界。 */
export async function ensureMuseSession(userId: string, modelId: string): Promise<string> {
  const existing = await getMuseSessionId(userId);
  if (existing && !shouldRotateMuseSession(await messageCount(existing).catch(() => 0))) return existing;
  const id = uuidv4();
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, ?, 'Muse', ?, 'muse')`,
    [id, userId, deps().profile.appId, modelId],
  );
  if (existing) log(`会话 ${existing} 已满 ${MUSE_SESSION_MAX_MESSAGES} 条,轮换到 ${id}`);
  return id;
}

async function isRunning(sessionId: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM agent_runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    [sessionId],
  );
  return !!rows.length;
}

/** 毛 prompt 上限 = maxTokensPerWindow × 本因子。09-11 实测毛量/计费量 ≈ 3.4–6.7 倍,取 6:典型周期下
 *  仍是计费闸先到(行为不变),只有「命中率变好 → 计费掉下去 → 周期变多」时毛量闸才接手。
 *  ponytail: 不给它单独的配置项 —— 用户只该拨一个预算旋钮(maxTokensPerWindow),这条跟着它按比例走。 */
const GROSS_TOKENS_FACTOR = 6;

/** 该用户**全部** Muse 会话最近 windowHours 小时内的两个量:
 *    billable = Σ 逐次 LLM 调用的 (prompt − cached) + completion —— 成本口径,对应 maxTokensPerWindow;
 *    gross    = Σ prompt —— 毛量口径(缓存命中照算),对应 grossCap:命中率越好 billable 越小、周期越多,
 *               毛量却照涨(每次仍要把整份上下文送上去),只按计费量封顶挡不住「一段时间反复唤醒」。
 *  按 kind='muse' AND user_id 计而不是单个会话:09-14 起会话会轮换,只算活动会话 = 换一次会话预算清零。
 *  取自 agent_run_events 的 usage 事件(每次调用落库,删会话才清;跨进程重启不丢)。不用 agent_runs.tokens_total:
 *  它把每轮重发、命中前缀缓存的 prompt 全额累加。09-11 live 台架两次实测:10 轮周期毛量 ~31 万(计费 ~4.6 万)、
 *  9 轮周期 20.9 万(计费 6.1 万);且它只在 done/超额时写,失败·中止的 run 记 0。
 *  窗口按事件时间(花钱的时刻)。单 run 失控另由 TANGU_MAX_RUN_COST 兜底,此处只算「一段时间反复唤醒」的累计。
 *  ponytail: 缓存读并非免费(约标价 1/10);要计它就在 billableTokens 里给 cached 加权。 */
export async function tokensInWindow(userId: string, windowHours: number): Promise<{ billable: number; gross: number }> {
  // NOT(older than) = 落在窗口内;created_at 有默认值不为空。方言经 getOlderThanSql(限定列名原样内插)。
  const within = `NOT (${getOlderThanSql('e.created_at', Math.round(windowHours * 60))})`;
  const rows = await query<any[]>(
    `SELECT e.payload FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id
     JOIN chat_sessions s ON s.id = r.session_id
     WHERE s.kind = 'muse' AND s.user_id = ? AND e.type = 'usage' AND ${within}`,
    [userId],
  );
  return rows.reduce(
    (acc, row) => {
      const u = usageOf(row.payload);
      acc.billable += billableTokens(u);
      acc.gross += num(u?.prompt);
      return acc;
    },
    { billable: 0, gross: 0 },
  );
}

/** payload 在 PG 回对象、SQLite 回 JSON 串;坏行 → null(按 0 计)。 */
function usageOf(payload: any): any {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch { return null; }
}
function num(v: any): number {
  return Math.max(0, Number(v) || 0);
}

/** 单条 usage 事件的计费 token:缓存命中的 prompt 不计(Anthropic 的 prompt 已含 cache_write,照计)。
 *  只看 prompt/cached/completion 三个字段 —— completion 已含推理 token,另加 reasoningTokens 就是重复计。 */
function billableTokens(u: any): number {
  return Math.max(0, num(u?.prompt) - num(u?.cached)) + num(u?.completion);
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

/** Muse 自建 Space 的契约(每周期钉一次;绝对路径老用户的 config.toml 里没有)。写法交给 forsion-plugin 技能,这里只钉边界。 */
function spaceKickoff(): string {
  return `Your Space: the desktop's "Muse" Space renders the view you register from the Forsion plugin at ${museSpaceDir()} ` +
    '(manifest.json + a bare main.js setup body — load the "forsion-plugin" skill before writing it). Register the main view as registerView({ id: "home", ... }); ' +
    'plain JS, no build step, no CDN, no capabilities; bundle subfolders are inert there. It starts empty — build it and keep improving it across cycles. ' +
    'It is reloaded after your cycle ends; a load failure reaches you as a [feedback] entry mentioning the Space.';
}

/**
 * 周期消息拆两半(纯函数,单测钉)。C1b(2026-09-14):
 *   message       = **落库**的短指令。同一份配置下逐字不变 → 会话内每个后续周期回放的都是同一段前缀,
 *                   可缓存;权限档 / Space 契约 / TODO 配额这些「本周期必须知道的规矩」留在这里。
 *   ephemeralHint = 本周期的时点简报(触发原因、待批数、安静提示、各类摘要),经 input.ephemeralHint
 *                   走尾部 user 通道(与 /skill、@ 提及同一条),**不落 chat_messages、不进历史回放**。
 *                   从前它落库:5k 字符 × 每个后续周期重发一份陈旧副本,既占窗口又打断前缀缓存。
 * 顺序与从前一字不差(quiet → pending → 触发 → 各摘要),模型看到的拼接结果不变。
 */
export function buildCycleMessages(
  cfg: MuseConfig,
  dyn: { extraKickoff?: string; hint?: string; pending?: number; quietSince?: boolean },
): { message: string; ephemeralHint: string } {
  const message =
    'Start this round: first use read_log to review your own recent cycles, the [feedback] entries showing how the user handled your previous todos, and any [approval] entries about actions you deferred earlier. ' +
    'Then combine your long-term memory with the context below to find the 1-3 most worthwhile things to do for the user right now — and do them where your permission tier allows. ' +
    tierKickoff(cfg) + ' ' +
    `Avoid the "TODOs you have already proposed" below; use add_muse_todo only for genuinely new, high-value todos (at most ${cfg.maxTodosPerWindow} this period — spend the quota sparingly). ` +
    'Use manage_schedule to plan your own follow-ups (auto=true entries wake you up when due; remove them when done). ' +
    spaceKickoff() + ' ' +
    (cfg.escalateTo ? `For work that needs a stronger model, delegate to the agent "${cfg.escalateTo}". ` : '') +
    (cfg.notify === 'digest' ? 'Notification policy is digest: do not message the user per item; write what matters into your journal, a daily digest is sent for you. ' : '') +
    'You may use remember to record durable insights about the user (what they value, accept, or dismiss). When done, briefly say what you did and what you deferred.';
  const ephemeralHint =
    (dyn.quietSince ? '\n\n(No new user messages since your last cycle — this is a heartbeat; maintenance, preparation or simply "nothing to do" are all fine answers.)' : '') +
    (dyn.pending ? `\n\n(${dyn.pending} of your earlier actions are still waiting for the user's approval — do not re-request them.)` : '') +
    (dyn.extraKickoff || '') +
    (dyn.hint || '');
  return { message, ephemeralHint: ephemeralHint.replace(/^\n+/, '') };
}

async function startCycle(cfg: MuseConfig, extraKickoff = '', trigger = 'heartbeat', quietSince = false): Promise<void> {
  const userId = museUserId();
  const sessionId = await ensureMuseSession(userId, cfg.modelId);
  await ensureMuseDirs().catch(() => {});
  // 动态上下文全部走 ephemeralHint(每周期新鲜数据,不落库);静态身份(developer_instructions + SOUL + Muse 自己
  // 的长期记忆)由 agentSlug 激活注入 system——不再内联 systemPrompt,否则会覆盖文件夹里的用户编辑。
  const hint =
    (await userMemoryHint(userId)) +
    (await recentActivityHint(userId)) +
    (await activityTailHint()) +
    (await recentSessionTitles(userId)) +
    (await folderHint(cfg.allowedFolders)) +
    (await existingTodoHint(userId));
  const pending = await countPendingApprovals(userId).catch(() => 0);
  const { message, ephemeralHint } = buildCycleMessages(cfg, { extraKickoff, hint, pending, quietSince });
  const agentThinking = (await getAgent(MUSE_AGENT_SLUG).catch(() => null))?.thinkingLevel;
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
      // 本周期简报:agentLoop 把它拼到给模型的最后一条 user 消息上,不写 chat_messages、不进回放(契约 C-3)。
      // 它仍会随 input 落在 agent_runs.input 里(排障可查),但模型侧每周期只见一份最新的。
      ephemeralHint,
      userMessageId: uuidv4(),
      attachments: [],
      client: backgroundClientTag('muse'), // 后台用量归因(api_usage_logs.client),与用户 run 可分
      background: 'muse', // 引擎内部来源标记(路由组装 input 时不透传此键):agentLoop 只对它放行 approvalDeferral
      agentConfig: museAgentConfig(cfg, agentThinking),
    },
  });
  currentSessionId = sessionId;
  lastCycleAt = Date.now();
  void writeLastCycleAt(lastCycleAt); // 落盘:进程重启后不再「开机 15s 必跑一个周期」
  lastRunning = true;
  pendingJournal = { runId, sessionId, trigger, mode: cfg.mode, startedAt: lastCycleAt };
  enqueueRun(sessionId, runId);
}

function rollWindow(cfg: MuseConfig): void {
  const span = cfg.restartWindowHours * 3600_000;
  if (!windowStartMs || Date.now() - windowStartMs >= span) {
    windowStartMs = Date.now();
    restartsThisWindow = 0;
  }
}

let ticking = false;
/** drain 期间到达的 kick 不能丢(桌面写完表踢一下 → 单发闸吃掉 = 退化成等满 5 分钟):记一笔,tick 结束后自唤醒一次。 */
let pendingKick = false;
/** 规则 id → **不停用**的暂时性状态位(库不符 / 表暂时读不到 / where 列按名解析不到);每 tick 整份替换。
 *  面板经 GET /agent/special/muse/triggers 的 `notice` 字段读它 —— 从前这些情况一律静默,
 *  规则显示「已启用」却一次都不评估,用户零信号(H3)。 */
let automationNotices: Record<string, string> = {};
export function getAutomationNotices(): Record<string, string> { return automationNotices; }

async function tick(): Promise<void> {
  // interval 与 kickMuse 的 setTimeout 会重叠(tick 内多处 await);重入=重复评估/重复起 run。
  if (ticking) { pendingKick = true; return; }
  ticking = true;
  try {
    if (!isLocal()) return;
    await loadMuseState(); // lastCycleAt 落盘值(只读一次):重启后心跳接着上次算,不再开机就跑
    await flushJournal(); // 上一周期若已收尾 → 记一行(run 终态会 kickMuse,所以通常紧跟着周期结束)
    // ── 盯任务规则评估(零 token 代码判定)。刻意放在 muse.enabled/activeHours 闸**之前**:
    // 带 agentSlug 的规则属于任意 agent 的自动化,关掉 Muse 不应连它们一起灭。
    // 评估 → 分流 → 起跑 → 提交游标 → (有 db 写入就)重评估,整段在 automationDrain 里循环到无命中/封顶。
    let museFired: MuseTrigger[] = [];
    let trigCursors: Record<string, EventCursor> = {};
    try {
      const triggers = await loadTriggers();
      if (triggers.length) {
        const activityLines = await readActivityLines({ hours: 24, limit: 500 });
        // db_changed 的快照游标单独存文件(不进 triggers.json——那是全表规模的派生数据)。
        const hasDb = triggers.some((t) => t.cond?.type === 'db_changed');
        const r = await drainAutomation({
          loadTriggers,
          loadCursors,
          setCursors,
          evaluate: evaluateTriggers,
          launch: launchAutomationTriggers,
          advanceSelfCursors,
          markTriggersFired,
          disableTriggers,
          disableTriggersWithReasons,
          activityLines,
          currentVault: amadeusVaultPath(),
          // 缺 → null(表没了,静默);坏 → 抛(评估侧按规则留痕、不推游标)。折成 null 会让坏表长得像空表。
          readDbFile: async (rel: string): Promise<DbLike | null> => readDbOrNull(rel).then((db) => db as DbLike | null),
          log,
        });
        museFired = r.museFired;
        trigCursors = r.trigCursors;
        // H3:**暂时性**状态位只住内存(每 tick 整份替换),不写 triggers.json —— 那是每 5 分钟一次整文件落盘,
        // 而这些状态本来就只在「引擎还活着」的语境下有意义。GET /muse/triggers 合并进 notice 字段给面板。
        automationNotices = r.notices;
        // ⚠️ 名册必须**重读**:tick 起始那份快照是 drain 之前的,期间用户删掉的规则在快照里还活着 ——
        // 按它 prune 等于把已删规则的游标留着,id 复用时下一条规则捡到上一条的基线(满表误触发)。
        if (hasDb) await loadTriggers().then((alive) => pruneCursors(alive.map((t) => t.id))).catch(() => {});
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
    await sendDailyDigestIfDue(cfg, userId);
    // 后台让位：用户有进行中的 run → 不与之抢模型账号/速率，本轮跳过（下次巡检再来）。
    if (await anyUserRunActive()) { lastRunning = false; log('用户有进行中的 run，本轮让位'); return; }
    // 起周期的三种理由(任一即可;都不豁免 isRunning/token/restarts 预算闸——防失控烧穿额度):
    //   ① 盯任务规则命中(museFired)② 自己 SCHEDULE.db 的到期条目(自触发/Track)③ 心跳到点(heartbeatHours,0=关)。
    // 2026-09-10 前的「无新用户消息就跳过」降为提示(quietSince 注入 kickoff):用户要的是「默认每 2 小时醒一次」,
    // 安静周期也要在 Journal 里留一笔,而不是静默消失。
    let dueMuse: ScheduleEntry[] = [];
    try { dueMuse = await museDueSchedules(); } catch (e: any) { log(`读自己的日程失败:${e?.message || e}`); }
    const heartbeatDue = cfg.heartbeatMinutes > 0 && Date.now() - lastCycleAt >= cfg.heartbeatMinutes * 60_000;
    if (!museFired.length && !dueMuse.length && !heartbeatDue) { lastRunning = false; return; }
    if (museFired.length) log(`盯任务命中 ${museFired.length} 条:${museFired.map((t) => t.id).join(', ')}`);
    if (dueMuse.length) log(`自己的日程到期 ${dueMuse.length} 条:${dueMuse.map((e) => e.name).join(', ')}`);
    const quietSince = !(await userActivitySince(userId, lastCycleAt));
    const trigger = museFired.length ? `rule:${museFired.map((t) => t.id).join('+')}`
      : dueMuse.length ? `schedule:${dueMuse.map((e) => e.name).join('+').slice(0, 60)}` : 'heartbeat';

    rollWindow(cfg);
    const sid = currentSessionId || (await getMuseSessionId(userId));
    if (sid && (await isRunning(sid))) { lastRunning = true; return; }
    lastRunning = false;

    // token 预算(两道,近 tokenBudgetWindowHours 小时、该用户全部 Muse 会话):任一超限本轮不起新周期。
    //   ① maxTokensPerWindow —— **计费**量(缓存命中不计),成本闸,用户可配;
    //   ② 毛 prompt 闸 —— 缓存命中越好 ① 掉得越快、周期越多,毛量却照涨(每次仍送整份上下文)。
    // 挡的是「后台反复唤醒把一段时间的额度烧穿」;单趟失控由 TANGU_MAX_RUN_COST 兜底,层层不重叠。
    let spent = { billable: 0, gross: 0 };
    const grossCap = cfg.maxTokensPerWindow * GROSS_TOKENS_FACTOR;
    if (cfg.maxTokensPerWindow > 0) {
      spent = await tokensInWindow(userId, cfg.tokenBudgetWindowHours);
      if (spent.billable >= cfg.maxTokensPerWindow) {
        log(`token 预算用尽(近 ${cfg.tokenBudgetWindowHours}h 计费 ${spent.billable}/${cfg.maxTokensPerWindow},未缓存 prompt+completion),本轮跳过`);
        return;
      }
      if (spent.gross >= grossCap) {
        log(`毛 prompt 预算用尽(近 ${cfg.tokenBudgetWindowHours}h 毛量 ${spent.gross}/${grossCap}),本轮跳过`);
        return;
      }
    }

    if (restartsThisWindow >= cfg.maxRestartsPerWindow) { log(`本窗口预算用尽(${restartsThisWindow}/${cfg.maxRestartsPerWindow})`); return; }
    restartsThisWindow += 1;
    log(`启动第 ${restartsThisWindow}/${cfg.maxRestartsPerWindow} 个思考周期(模型 ${cfg.modelId},档位 ${cfg.mode},触发 ${trigger},计费 ${spent.billable}/${cfg.maxTokensPerWindow},毛量 ${spent.gross}/${grossCap})`);
    await startCycle(cfg, buildTriggerKickoff(museFired) + scheduleKickoff(dueMuse), trigger, quietSince);
    // lastFiredAt / lastRun 只在周期真正启动后写回:被上面任何闸挡住 → 下轮重试,不白烧 cooldown。
    if (museFired.length) await markTriggersFired(museFired.map((t) => t.id), undefined, trigCursors);
    for (const e of dueMuse) await markEntryFired(MUSE_AGENT_SLUG, e.id).catch((err: any) => log(`日程 ${e.id} 写回 lastRun 失败:${err?.message || err}`));
  } catch (e: any) {
    lastError = e?.message || String(e);
    log(`tick 失败:${lastError}`);
  } finally {
    ticking = false;
    if (pendingKick) { pendingKick = false; kickMuse(); }
  }
}

/** 启动 Muse supervisor（幂等）。间隔取配置的 supervisorPollMinutes；首次 ~15s 后即跑(不必等满一个周期)。 */
/** 巡检间隔(毫秒)= min(supervisorPollMinutes, heartbeatMinutes>0 ? heartbeatMinutes : ∞),下限 1 分钟:
 *  心跳比巡检细时巡检跟着缩,否则「心跳 3 分钟」实际每 5 分钟才醒一次。纯函数,单测钉。 */
export function pollIntervalMs(pollMinutes: number, heartbeatMinutes: number): number {
  const hb = heartbeatMinutes > 0 ? heartbeatMinutes : Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(pollMinutes, hb)) * 60_000;
}
function nextPollMs(): number {
  try { const m = loadSpecialAgentsConfig().muse; return pollIntervalMs(m.supervisorPollMinutes, m.heartbeatMinutes); } catch { return 5 * 60_000; }
}

export function startMuseSupervisor(): void {
  if (timer) return;
  if (!isLocal()) return;
  // setTimeout 链而非 setInterval:每轮重读配置,用户把心跳改细/改粗下一轮就生效(改配置的路由还会 kickMuse 催一次)。
  const arm = (): void => {
    timer = setTimeout(() => { void tick().finally(arm); }, nextPollMs());
    (timer as any).unref?.();
  };
  log(`supervisor 启动(巡检 ${nextPollMs() / 60_000} 分钟;15s 后首次)`);
  arm();
  // run 终态 → 催一次评估:event_seen 盯 run.done 的规则不用等满一个巡检周期。
  setRunTerminalListener(() => kickMuse());
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
  if (timer) { clearTimeout(timer); timer = null; }
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
  /** 权限档 / 心跳 / 待批数 / Library 路径(桌面 MuseView 与 Agent Space 用)。 */
  mode: 'ask' | 'agent' | 'auto';
  heartbeatMinutes: number;
  pendingApprovals: number;
  libraryDir: string;
  /** 自建 Space:插件目录 + 内容戳(桌面 agentSpaceSync 按戳变化重载 agent-muse 插件;0=目录空/不存在)。 */
  spaceDir: string;
  spaceStamp: number;
}

export async function museStatus(): Promise<MuseStatus> {
  await loadMuseState(); // 桌面每 4s 轮询,比首个 tick(15s)早:没有这句,启动头 15 秒 lastCycleAt 一律显示「从未」
  let cfg;
  try { cfg = loadSpecialAgentsConfig().muse; } catch { cfg = null; }
  // sessionId/running 从 DB 实查(进程内 flag 重启后漂移;工作视图的「当前思考」也靠 sessionId 复原)。
  let sessionId = currentSessionId;
  let running = lastRunning;
  try {
    sessionId = sessionId || (await getMuseSessionId(museUserId()));
    running = sessionId ? await isRunning(sessionId) : false;
  } catch { /* DB 不可用 → 回退进程内快照 */ }
  let pendingApprovals = 0;
  try { pendingApprovals = await countPendingApprovals(museUserId()); } catch { /* 表未建/DB 不可用 */ }
  if (!spaceStamp) spaceStamp = await spaceDirStamp().catch(() => 0); // 引擎刚起还没跑过周期 → 按磁盘现状算一次
  return {
    enabled: !!cfg?.enabled,
    hasModel: !!cfg?.modelId,
    running,
    restartsThisWindow,
    maxRestartsPerWindow: cfg?.maxRestartsPerWindow ?? 0,
    lastCycleAt: lastCycleAt || null,
    lastError,
    sessionId,
    mode: cfg?.mode ?? 'ask',
    heartbeatMinutes: cfg?.heartbeatMinutes ?? 120,
    pendingApprovals,
    libraryDir: museLibraryDir(),
    spaceDir: museSpaceDir(),
    spaceStamp,
  };
}

