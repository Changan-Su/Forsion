/**
 * Muse（后台常驻 Special Agent）—— 一直自动思考「现在能为用户做点什么」。
 *
 * 身份 = 文件夹系统 agent `~/.tangu/agents/muse/`（config.toml developer_instructions + SOUL.md 人格 +
 * 自己的 MEMORY.md/LOG，经 agentConfig.agentSlug 激活）：跨周期持久记忆，用户可像普通 agent 一样编辑其
 * 人格与指令。每周期的**动态**上下文（用户记忆快照、跨 agent 活动摘要、活动尾、近期会话标题、授权
 * 文件夹、TODO 去重提示、本次触发原因）经 `input.ephemeralHint` 走尾部 user 通道注入：**不落库、不回放**
 * （2026-09-14：它是 5k 字符的时点摘要，落库后每个后续周期都要重发 N 份陈旧副本，缓存与窗口双输）。
 * 落库的 kickoff 只剩一段同配置下逐字不变的短指令 —— 会话内回放于是是稳定前缀。
 * **每个周期一个新会话**（见 MUSE_SESSION_MAX_MESSAGES），运行态（lastCycleAt）落 ~/.tangu/muse-state.json（引擎自有状态域，**不在** Muse 可写的 agent 目录里）。
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

import { loadSchedule, entriesOf, dueEntries, markEntryFired, ensureEntry, validateEntryInput, type ScheduleEntry } from './agentSchedule.js';
import { L } from '../tui/i18n.js';
import { countPendingApprovals } from './pendingApprovals.js';
import { sendInboxMessage, MUSE_SENDER_ID } from '../tools/builtin/inboxSend.js';
import { readActivityLines, readUserActivityStamps, activityRhythm, activitySince, parseActivityTs, type ActivityRhythm } from './userActivity.js';
import { notRemoteTaintedSql } from './remoteTaint.js';
import { museStateFile, readLastCycleAt, readMuseSessionId, patchMuseState, getMuseSleep, setMuseSleep, type MuseSleep } from './museState.js';
import { loadTriggers, evaluateTriggers, markTriggersFired, disableTriggers, disableTriggersWithReasons, buildTriggerKickoff, type MuseTrigger, type EventCursor, type DbLike } from './museTriggers.js';
import { loadCursors, setCursors, pruneCursors } from './dbCursors.js';
import { readDbOrNull } from './amadeusDb.js';
import { amadeusVaultPath } from '../tools/builtin/amadeus.js';
import { launchAutomationTriggers, launchDueSchedules, advanceSelfCursors } from './automation.js';
import { drainAutomation } from './automationDrain.js';
import { remoteLocked } from './remoteLock.js'; // P1-K2
import { noteRemoteEntriesCarried } from './remoteCreated.js'; // P1-K2

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

/** Muse 的运行态落盘(muse-state.json:lastCycleAt + set_next_wake 定的休眠)——实现与安全边界见 museState.ts。
 *  lastCycleAt 只住内存时**每次启动 app 都会在 15s 后必跑一个周期**(§3.4),开机频繁的用户等于把心跳配置架空。 */
export { museStateFile, readLastCycleAt };
export async function writeLastCycleAt(ms: number, sessionId?: string): Promise<void> {
  try { await patchMuseState({ lastCycleAt: ms, ...(sessionId ? { sessionId } : {}) }); } catch (e: any) { log(`写 muse-state.json 失败:${e?.message || e}`); }
}
/** 进程内只读一次(tick 与 museStatus 都等它:桌面每 4s 轮询 status,比首个 tick 早 15 秒)。 */
let stateLoad: Promise<void> | null = null;
function loadMuseState(): Promise<void> {
  if (!stateLoad) {
    stateLoad = (async () => {
      const v = await readLastCycleAt();
      if (v > lastCycleAt) lastCycleAt = v;
      // 活动会话指针(每个周期一个新会话):盘上记的那个还在库里才认,否则回落到按 created_at 查
      const sid = await readMuseSessionId();
      if (sid && !currentSessionId) {
        const ok = await query<any[]>(`SELECT 1 FROM chat_sessions WHERE id = ? AND kind = 'muse' LIMIT 1`, [sid]).catch(() => []);
        if (ok?.length && !currentSessionId) currentSessionId = sid;
      }
    })();
  }
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
    // 后台周期缺省思考·中(09-19 用户拍板,全端档位缺省统一为中;此前 D3 09-14 定的是低,理由是「找 1-3 件值得做的事是判断题,
    // medium 只是多烧推理 token」)。代价要知道:周期受 maxTokensPerWindow 的 5 小时预算约束,推理 token 计入其中 → 同样预算下
    // 能起的周期变少;想省就在 Muse 的详情页把思考档调回低。
    // ⚠️ agentActivation 只在 agentConfig **没有**该字段时才用 def 的值,所以这里必须自己先合一次,
    // 否则硬写缺省值 = 静默压过用户在 config.toml 里的 model_reasoning_effort。
    thinkingLevel: agentThinking || 'medium',
    maxIterations: cfg.maxIterationsPerCycle,
    maxIterationsSource: 'muse', // 收尾提示 / context_info 点名来源:Muse 每周期轮数,不是会话 /loop
    automationOrigin: MUSE_AGENT_SLUG, // 活动行 o=muse:自己写的 agent.edit 不唤醒盯自己的规则
  };
  if (cfg.mode === 'auto') return { ...base, approvalMode: 'full-auto', extraRoots: [museSpaceDir(), ...cfg.allowedFolders.slice(0, 8)] };
  return { ...base, approvalMode: 'auto-edit', approvalDeferral: cfg.mode === 'agent' ? 'agent' : 'queue', extraRoots: [museSpaceDir()] };
}

/** Journal 行(纯函数,单测钉格式)。note 折成单行、截 120 字。 */
export function formatJournalLine(x: { time: string; mode: string; trigger: string; tokens: number; files: number; status: string; note: string; sleep?: string }): string {
  const note = displayText(x.note, 120);
  const sleep = x.sleep ? ` · sleep → ${displayText(x.sleep, 140)}` : '';
  return `- ${x.time} · ${x.mode} · ${displayText(x.trigger, 80)} · tokens ${x.tokens} · files ${x.files} · ${x.status}${sleep}${note ? ` · ${note}` : ''}`;
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
    // 这个周期里定的休眠(setAt 落在周期开始之后)记进同一行:用户翻 Journal 能看到「为什么这几个钟头没动静」。
    const slept = await getMuseSleep().catch(() => null);
    const sleep = slept && slept.setAt >= pj.startedAt ? `${localTime(new Date(slept.until))} (${slept.reason})` : '';
    await appendMuseJournal(formatJournalLine({
      time: localTime(new Date(pj.startedAt)), mode: pj.mode, trigger: pj.trigger,
      tokens: Number(run.tokens_total) || 0, files: await filesTouched(pj.sessionId, pj.runId),
      status: String(run.status), note, sleep,
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

// ── 每周装备巡检(10-04 用户定「让 Muse 检查最近的工具和技能调用,看能不能降本增效」)────────────────────────
// 一条播种进 Muse 自己 SCHEDULE.db 的周期条目:到期时走既有的「自己的日程 → 本周期 kickoff」管道,没有新机制。
// Muse 只出建议(一条 add_muse_todo),不改任何 agent:收不收由各 agent 自己经 manage_harness kind:"equip" 决定,
// 用户在收件箱卡片上点「新会话执行 / 交给 Muse / 忽略」。条目用户可在 Muse 的日程里改期或删掉 —— 删掉就不再巡检。
const LOADOUT_REVIEW_NAME = { zh: '每周装备巡检', en: 'Weekly loadout review' };
/** 条目的 prompt(模型读,英文)。同时是幂等匹配的依据之一。 */
export const LOADOUT_REVIEW_PROMPT =
  'Weekly loadout review (keep this weekly entry; do not remove it). Call review_loadout with days 30. It reports, per agent, which always-loaded tools and listed skills went unused in the user\'s own sessions, and which of them it suggests shelving this time. ' +
  'If it says there is not enough data, or nothing stands out (under about 3 KB of unused definitions for an agent is not worth a todo), end this item quietly: no todo, no message. ' +
  'Otherwise file exactly ONE add_muse_todo in the user\'s language. The user reads it as a suggestion; if they accept, its detail is handed verbatim to an agent as the task to carry out. So write the detail as that task: ' +
  '(1) open with one sentence for the user: nothing has been changed yet, running this task shelves the equipment listed below, and shelving only moves a definition to the load-on-demand catalog (the tool or skill still works); ' +
  '(2) per agent, exactly the tools and skills on that agent\'s "Suggested … this time" lines in the report, with its run counts as evidence. Add no other item, even one the report mentions elsewhere, and leave out agents marked as not judgeable; ' +
  '(3) end with the "Steps for whoever runs this task" paragraph that review_loadout prints at the bottom of its report, kept intact with both of its branches (do not write your own steps). ' +
  'In this cycle you only file the todo: do not change any agent\'s notes, settings or files yourself, and do not copy that restriction into the todo (whoever runs the task is meant to act). Never suggest removing a capability.';
const LOADOUT_REVIEW_MARKER = '.seeded-loadout-review-v1';

/** 把「每周装备巡检」条目播种进 Muse 的日程:**只播一次**(标记文件在 Muse 的文件夹里)—— 用户删掉条目后不再补种。
 *  锚点 = 今天(本地):第一次巡检在下一个放行的巡检周期就跑(库里本来就有历史用量),之后每 7 天一次。 */
export async function seedLoadoutReviewOnce(now = new Date()): Promise<boolean> {
  const marker = path.join(agentsDir(), MUSE_AGENT_SLUG, LOADOUT_REVIEW_MARKER);
  try { await fs.access(marker); return false; } catch { /* 还没播过 */ }
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const v = validateEntryInput({
    name: L(LOADOUT_REVIEW_NAME.zh, LOADOUT_REVIEW_NAME.en), date, repeat: '7d', auto: true, prompt: LOADOUT_REVIEW_PROMPT,
    description: L('看各 Agent 最近 30 天的工具 / 技能用量,有值得收起的就提一条建议;不想要可以直接删掉这条。', 'Checks each agent\'s tool and skill usage over the last 30 days and files one suggestion when something is worth shelving. Delete this entry to stop it.'),
  }, { slug: MUSE_AGENT_SLUG });
  if (!v.ok) throw new Error(v.error);
  const names = new Set(Object.values(LOADOUT_REVIEW_NAME));
  const r = await ensureEntry(MUSE_AGENT_SLUG, v.value, (e) => names.has(e.name) || e.prompt === LOADOUT_REVIEW_PROMPT, 'Muse');
  if (!r.ok) throw new Error(r.error);
  await fs.writeFile(marker, now.toISOString(), 'utf-8');
  return r.created;
}

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
  // 「Space 目录免审」必须写进档位句本身:09-27 实机 Muse 只读到「Library 免审、别处排队」,把 Space 当成「Library 外」
  // 等批准(实际 extraRoots 三档都放行),于是只敢改文案。
  if (cfg.mode === 'auto') {
    return common + 'Permission tier: auto — you have full autonomy inside the authorized folders and your Space folder; every file edit is checkpointed so the user can rewind, but still avoid destructive or external actions.';
  }
  if (cfg.mode === 'agent') {
    return common + 'Permission tier: agent — writes inside your Library and your Space folder are free; writing anywhere else or running shell commands is first judged by the user\'s default agent on their behalf, and queued for the user if declined. Never retry a deferred action in this cycle.';
  }
  return common + 'Permission tier: ask — writes inside your Library and your Space folder are free; writing anywhere else or running shell commands is queued for the user\'s approval (the outcome shows up in your log next cycle as an [approval] entry). Never retry a deferred action in this cycle.';
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

/** 轮换阈值 = 1:会话里一有消息就换 → **每个周期一个新会话**(2026-09-27;09-14 C1a 定的是攒满 30 条)。
 *  30 条时每个周期都把之前所有周期的对话连工具结果整段回放:实机开局上下文从 ~2.3 万 token 一路涨到 17–20 万,
 *  而心跳间隔 2 小时、提示缓存撑不到下一轮 → 每个周期第一次调用就把这整段按未命中计费(24 个周期平均 ~15 万计费,
 *  八成是在重放昨天的活动日志 / 旧 main.js / 技能全文)。连续性本来就不靠对话历史:kickoff 第一步 read_log
 *  (每周期都有 log_event)、Journal、MEMORY、TODO 去重提示、[feedback]/[approval] 行。空会话(周期没写出消息就失败)照常复用。
 *  ponytail: 留着轮换机制而不是删掉 —— 真要让间隔很近的规则周期共享上下文,把这个数调大即可。
 *  仪器:live 台架 muse 场景的「开局上下文 周期1→周期2」(旧行为 ×2.6,判据 ≤ ×1.5)。 */
export const MUSE_SESSION_MAX_MESSAGES = 1;

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

/** 该用户**任何** Muse 会话里有没有排队/运行中的 run。每个周期一个新会话(09-27)后不能只查「最新那行」:
 *  本地 SQLite 的 created_at 只到秒,同一秒建的两个会话谁算最新不确定,会漏看正在跑的那个 → 重复起周期。
 *  孤儿 running 行由引擎重启时的 failStaleRuns / recoverQueuedRuns 收掉,不会把 Muse 永久卡住(同 anyUserRunActive)。 */
export async function anyMuseRunActive(userId: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM agent_runs r JOIN chat_sessions s ON s.id = r.session_id
     WHERE s.kind = 'muse' AND s.user_id = ? AND r.status IN ('queued', 'running') LIMIT 1`,
    [userId],
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

/** 用户自 sinceMs 起有没有**任何**动作:用户会话的新消息,或应用内活动日志的用户行(引擎后台写的 o= 行不算)。
 *  set_next_wake 的「用户一动就醒」与 kickoff 的安静提示共用。活动行是分钟精度:与 sinceMs 同一分钟的行不算。 */
async function userActiveSince(userId: string, sinceMs: number, minuteLines?: number): Promise<boolean> {
  if (await userActivitySince(userId, sinceMs)) return true;
  if (!sinceMs) return true;
  const days = Math.ceil((Date.now() - sinceMs) / 86_400_000) + 1;
  try { return activitySince(await readUserActivityStamps(Math.min(days, 3)), sinceMs, minuteLines); } catch { return false; }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 作息简报(纯函数,单测钉):按本地小时的活动天数 + 最近一次活动 + 现在几点。给 Muse 判断「该不该睡、睡到几点」。 */
export function buildRhythmHint(r: ActivityRhythm, now: Date, days: number): string {
  const head = `\n\n[User rhythm — from the in-app activity log, last ${days} days]\nLocal time now: ${WEEKDAYS[now.getDay()]} ${localTime(now)}.`;
  if (!r.activeDays || !r.last) return `${head} No user activity recorded in this period.`;
  const last = parseActivityTs(r.last);
  const mins = Math.max(0, Math.round((now.getTime() - last.getTime()) / 60_000));
  const ago = mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  const lastDay = localDate(last) === localDate(now) ? '' : `${WEEKDAYS[last.getDay()]} `;
  const hours = r.hourDays.map((n, h) => `${String(h).padStart(2, '0')}:${n}`).join(' ');
  return `${head} Last user activity: ${lastDay}${localTime(last)} (${ago} ago).\n` +
    `Days with activity by local hour, out of ${r.activeDays} active days: ${hours}`;
}

async function rhythmHint(): Promise<string> {
  try { return buildRhythmHint(activityRhythm(await readUserActivityStamps(14)), new Date(), 14); } catch { return ''; }
}

/**
 * 心跳闸(纯函数,单测钉):没到点 → not_due;到点但 Muse 睡着 → asleep;到点且醒着(或休眠已过期)→ due。
 * 「用户回来了就醒」在调用方每个巡检先判、清掉休眠再进这里;休眠只挡心跳,规则命中 / 到期日程另判,不经这里。
 */
export function heartbeatDecision(x: {
  heartbeatMinutes: number; lastCycleAt: number; now: number; sleep: MuseSleep | null;
}): 'not_due' | 'due' | 'asleep' {
  if (x.heartbeatMinutes <= 0 || x.now - x.lastCycleAt < x.heartbeatMinutes * 60_000) return 'not_due';
  return !x.sleep || x.now >= x.sleep.until ? 'due' : 'asleep';
}

/** 休眠中被规则 / 日程叫醒时的提示:别把这当成一次完整巡视,处理完就收,休眠照旧。 */
function sleepNote(sleep: MuseSleep | null, trigger: string): string {
  if (!sleep || trigger === 'heartbeat') return '';
  const until = new Date(sleep.until);
  return `\n\n(You set yourself to sleep until ${localTime(until)}${localDate(until) === localDate() ? '' : ' tomorrow'} — "${displayText(sleep.reason, 120)}". ` +
    `This cycle was triggered by ${displayText(trigger, 80)}: handle that, keep it short; your sleep stays in effect unless you change it with set_next_wake.)`;
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

/** 最近会话标题。远端驱动过的会话不列(P1 · M1A,G7):手机发第一句就把它截成标题,远端原话会经这里进 Muse 的周期提示词。 */
export async function recentSessionTitles(userId: string): Promise<string> {
  try {
    const rows = await query<any[]>(
      `SELECT s.title FROM chat_sessions s WHERE s.user_id = ? AND s.kind = 'user' AND s.archived = FALSE AND ${notRemoteTaintedSql('s')}
       ORDER BY s.updated_at DESC LIMIT 15`,
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

/** 用户应用内活动尾部(数据源见 userActivity.ts;桌面埋点+agent.edit 双写)。失败 → 空串。
 *  远程 run 写的行(remote=1)readActivityLines 缺省不给(P1 · M1A,G7:文件路径 / agent 名是远端给的串)。 */
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

/** Muse 自建 Space 的契约(每周期钉一次;绝对路径老用户的 config.toml 里没有)。写法交给 forsion-plugin 技能,这里只钉边界。
 *  「文件本身就是 setup 函数体、别包 function setup」必须明说:从前只写「a bare main.js setup body」,09-27 实机 Muse 每一版都
 *  包成 function setup(ctx){…} 却不调用 —— 零注册零报错,Space 从首建起一直空白。
 *  ctx.agent(09-27):Space 从数据渲染,别再每周期把状态 / 时间戳写死重写一遍(实机 1.4.x 全是这种改动);核心契约写在这里,
 *  84KB 的 forsion-plugin 技能只在要更多接口时才加载(实机 23 个周期里 13 次为改文案加载它)。
 *  返回字段与配色变量也得写在这里(09-27 dev 首个 ctx.agent 版 Space):技能不加载,它就只能猜 —— 猜了 status().status
 *  (「当前状态」卡恒空)、猜了宿主没有的 --panel(卡片落到写死的深色兜底,浅色主题下标题深底深字看不见)。
 *  变量表 = styles/base.css :root 与深色块都定义的那几个(--surface / --card 只在笔记作用域里有,插件视图拿不到)。 */
function spaceKickoff(): string {
  return `Your Space: the desktop's "Muse" Space shows the view registered by the Forsion plugin at ${museSpaceDir()} ` +
    '(manifest.json + main.js; load the "forsion-plugin" skill only if you need more of the plugin API than this). ' +
    'main.js runs as the body of setup(ctx), so call ctx.registerView({ id: "home", ... }) at the top level of the file. ' +
    'Do not wrap the file in function setup(ctx) { ... } — nothing calls it, so nothing registers and no error is raised. ' +
    'Render live data instead of hardcoding it — these return Promises (status() can resolve to null): ctx.agent.status() → { running, lastCycleAt, sleepUntil, mode, heartbeatMinutes, pendingApprovals } (times in epoch ms or null); ' +
    'ctx.agent.todos("pending") → [{ id, title, detail, status, createdAt }] (no argument = every status, dismissed included); ' +
    'ctx.agent.schedule() → [{ name, date, repeat, auto, lastRun }]; ctx.agent.library.read(path) → the text of a Library file ' +
    '(e.g. "Journal/<date>.md"; .list() for the tree). ctx.agent.subscribe(cb) returns an unsubscribe function right away (call it in your cleanup); ' +
    'ctx.agent.updateTodo(id, "done" | "dismissed") works only inside a click handler on your Space. ' +
    'Colors come only from the host theme variables var(--bg), var(--bg-card), var(--text), var(--text-muted), var(--border), var(--accent) — ' +
    'no hex values, no other variable names — so light and dark themes both work; your view shares the app\'s page, so prefix every CSS selector with your own root class. ' +
    'Plain JS, no build step, no CDN. It starts empty: build it, then improve what it shows across cycles — never edit it just to refresh status or timestamps. ' +
    'It is reloaded after your cycle ends; a load failure, a missing "home" view, or a later runtime error (with its main.js line) ' +
    'reaches you as a [feedback] entry mentioning the Space.';
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
  dyn: { extraKickoff?: string; hint?: string; pending?: number; quietSince?: boolean; sleepNote?: string },
): { message: string; ephemeralHint: string } {
  const message =
    'Start this round: first use read_log to review your own recent cycles, the [feedback] entries showing how the user handled your previous todos, and any [approval] entries about actions you deferred earlier. ' +
    'Then combine your long-term memory with the context below to find the 1-3 most worthwhile things to do for the user right now — and do them where your permission tier allows. ' +
    tierKickoff(cfg) + ' ' +
    `Avoid the "TODOs you have already proposed" below; use add_muse_todo only for genuinely new, high-value todos (at most ${cfg.maxTodosPerWindow} this period — spend the quota sparingly). ` +
    'Use manage_schedule to plan your own follow-ups (auto=true entries wake you up when due; remove them when done). ' +
    'Pace yourself — every cycle spends the user\'s background budget: when nothing needs you soon (the user is away, or it is outside their usual hours per the user rhythm below), ' +
    'finish briefly and call set_next_wake to sleep until they are likely back; their activity ends the sleep, and your rules and due schedule still wake you meanwhile. ' +
    spaceKickoff() + ' ' +
    (cfg.escalateTo ? `For work that needs a stronger model, delegate to the agent "${cfg.escalateTo}". ` : '') +
    (cfg.notify === 'digest' ? 'Notification policy is digest: do not message the user per item; write what matters into your journal, a daily digest is sent for you. ' : '') +
    'You may use remember to record durable insights about the user (what they value, accept, or dismiss). When done, briefly say what you did and what you deferred.';
  const ephemeralHint =
    (dyn.quietSince ? '\n\n(No new user messages or in-app activity since your last cycle — this is a heartbeat; maintenance, preparation or simply "nothing to do" are all fine answers, and so is set_next_wake.)' : '') +
    (dyn.sleepNote || '') +
    (dyn.pending ? `\n\n(${dyn.pending} of your earlier actions are still waiting for the user's approval — do not re-request them.)` : '') +
    (dyn.extraKickoff || '') +
    (dyn.hint || '');
  return { message, ephemeralHint: ephemeralHint.replace(/^\n+/, '') };
}

async function startCycle(cfg: MuseConfig, extraKickoff = '', trigger = 'heartbeat', quietSince = false): Promise<string> {
  const userId = museUserId();
  const sessionId = await ensureMuseSession(userId, cfg.modelId);
  await ensureMuseDirs().catch(() => {});
  // 动态上下文全部走 ephemeralHint(每周期新鲜数据,不落库);静态身份(developer_instructions + SOUL + Muse 自己
  // 的长期记忆)由 agentSlug 激活注入 system——不再内联 systemPrompt,否则会覆盖文件夹里的用户编辑。
  const hint =
    (await userMemoryHint(userId)) +
    (await recentActivityHint(userId)) +
    (await activityTailHint()) +
    // 电脑历史摘要(Forsion 之外的活动)**不在这里拼**:ephemeralHint 会随 agent_runs.input 永久落库,
    // 由 agentLoop 对 input.background==='muse' 的 run 现算注入(services/computerHistory.ts computerHistoryDigest)。
    (await recentSessionTitles(userId)) +
    (await folderHint(cfg.allowedFolders)) +
    (await existingTodoHint(userId)) +
    (await rhythmHint());
  const pending = await countPendingApprovals(userId).catch(() => 0);
  const sleep = await getMuseSleep().catch(() => null);
  const { message, ephemeralHint } = buildCycleMessages(cfg, { extraKickoff, hint, pending, quietSince, sleepNote: sleepNote(sleep, trigger) });
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
  void writeLastCycleAt(lastCycleAt, sessionId); // 落盘:进程重启后不再「开机 15s 必跑一个周期」;活动会话也记下(重启后 status 指回它)
  lastRunning = true;
  pendingJournal = { runId, sessionId, trigger, mode: cfg.mode, startedAt: lastCycleAt };
  enqueueRun(sessionId, runId);
  return runId;
}

/**
 * 周期起跑之后写回到期条目的 lastRun。**先**在远端批准条目的台账里记下 carrier(P1-K2):lastRun 在起跑时就写了、不代表做完,
 * 急停中止了这个周期时要按 carrier 撤回(独立评审 P2);顺序反了会有「lastRun 已写、carrier 还没记」的窗口,急停落在里面条目就丢。
 */
export async function markMuseEntriesFired(runId: string, due: ScheduleEntry[]): Promise<void> {
  if (!due.length) return;
  await noteRemoteEntriesCarried(MUSE_AGENT_SLUG, due.map((e) => e.id), runId).catch((err: any) => log(`远端批准条目记 carrier 失败:${err?.message || err}`));
  for (const e of due) await markEntryFired(MUSE_AGENT_SLUG, e.id).catch((err: any) => log(`日程 ${e.id} 写回 lastRun 失败:${err?.message || err}`));
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
/** P1-K2:锁定期间整轮暂停的提示只打一次(每个锁定时段一次),解锁后复位。 */
let lockPauseLogged = false;

async function tick(): Promise<void> {
  // interval 与 kickMuse 的 setTimeout 会重叠(tick 内多处 await);重入=重复评估/重复起 run。
  if (ticking) { pendingKick = true; return; }
  ticking = true;
  try {
    if (!isLocal()) return;
    // P1-K2(方案 §6.5):急停锁定了远程访问 → 盯任务规则、Agent 日程、Muse 周期整轮**推迟**(不丢:解锁后下一轮照常评估,
    // 到期条目按 dueEntries 补跑)。急停的语义是「不是我在键盘前发起的一律停」;读不出锁 = 锁定。
    let locked = true;
    try { locked = remoteLocked(); } catch { locked = true; }
    if (locked) {
      if (!lockPauseLogged) { lockPauseLogged = true; log('remote lock on — Muse, watch rules and agent schedules paused until it is unlocked on this computer'); }
      return;
    }
    lockPauseLogged = false;
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
        // 盯任务规则照旧看远程 run 的行(includeRemote):event_seen 只拿用户自己写的 match 串比对、行文不进自动化 run 的提示词,
        // 远端只能影响「什么时候触发」(M1A 报告残余一条)。
        const activityLines = await readActivityLines({ hours: 24, limit: 500, includeRemote: true });
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
    // 每周装备巡检条目(只播一次);放在读自己到期日程之前,同一个巡检周期就能看到它。失败不挡周期,下个巡检再试。
    await seedLoadoutReviewOnce().then((created) => { if (created) log('已播种日程条目:每周装备巡检'); }).catch((e: any) => log(`播种装备巡检条目失败:${e?.message || e}`));
    const userId = museUserId();
    // Muse 自己定的休眠(set_next_wake)只挡心跳:规则命中、到期日程照常起。
    // 睡着时**每个巡检**都看用户回没回来(一次查询 + 读至多三天的活动文件):回来了就清掉休眠,心跳照常判。
    // 放在运行时段闸与让位闸**之前**:用户正聊着天(让位)或在时段外时也要清,否则状态一直挂着「休眠中」、
    // 之后的规则周期还会收到过时的「休眠照旧」提示(Codex 09-24 两轮)。
    let sleep = await getMuseSleep().catch(() => null);
    if (sleep && (await userActiveSince(userId, sleep.setAt, sleep.minuteLines))) {
      log(`用户回来了,提前结束休眠(原定到 ${localTime(new Date(sleep.until))})`);
      await setMuseSleep(null).catch((e: any) => log(`清休眠失败:${e?.message || e}`));
      sleep = null;
    }
    if (!isWithinActiveHours(cfg, nowHour())) { log(`不在运行时段(当前 ${nowHour()} 时),跳过`); return; }

    await sendDailyDigestIfDue(cfg, userId);
    // 后台让位：用户有进行中的 run → 不与之抢模型账号/速率，本轮跳过（下次巡检再来）。
    if (await anyUserRunActive()) { lastRunning = false; log('用户有进行中的 run，本轮让位'); return; }
    // 起周期的三种理由(任一即可;都不豁免 anyMuseRunActive/token/restarts 预算闸——防失控烧穿额度):
    //   ① 盯任务规则命中(museFired)② 自己 SCHEDULE.db 的到期条目(自触发/Track)③ 心跳到点(heartbeatHours,0=关)。
    // 2026-09-10 前的「无新用户消息就跳过」降为提示(quietSince 注入 kickoff):用户要的是「默认每 2 小时醒一次」,
    // 安静周期也要在 Journal 里留一笔,而不是静默消失。
    let dueMuse: ScheduleEntry[] = [];
    try { dueMuse = await museDueSchedules(); } catch (e: any) { log(`读自己的日程失败:${e?.message || e}`); }
    const heartbeatDue = heartbeatDecision({ heartbeatMinutes: cfg.heartbeatMinutes, lastCycleAt, now: Date.now(), sleep }) === 'due';
    if (!museFired.length && !dueMuse.length && !heartbeatDue) { lastRunning = false; return; }
    if (museFired.length) log(`盯任务命中 ${museFired.length} 条:${museFired.map((t) => t.id).join(', ')}`);
    if (dueMuse.length) log(`自己的日程到期 ${dueMuse.length} 条:${dueMuse.map((e) => e.name).join(', ')}`);
    const quietSince = !(await userActiveSince(userId, lastCycleAt));
    const trigger = museFired.length ? `rule:${museFired.map((t) => t.id).join('+')}`
      : dueMuse.length ? `schedule:${dueMuse.map((e) => e.name).join('+').slice(0, 60)}` : 'heartbeat';

    rollWindow(cfg);
    if (await anyMuseRunActive(userId)) { lastRunning = true; return; }
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
    const cycleRunId = await startCycle(cfg, buildTriggerKickoff(museFired) + scheduleKickoff(dueMuse), trigger, quietSince);
    // lastFiredAt / lastRun 只在周期真正启动后写回:被上面任何闸挡住 → 下轮重试,不白烧 cooldown。
    if (museFired.length) await markTriggersFired(museFired.map((t) => t.id), undefined, trigCursors);
    await markMuseEntriesFired(cycleRunId, dueMuse);
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

/** @internal 测试用:跑一轮巡检(P1-K2 锁定测试)。 */
export const __museTickForTests = (): Promise<void> => tick();

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
  /** Muse 自己定的休眠(set_next_wake):心跳暂停到这个时刻(epoch ms);null = 醒着。 */
  sleepUntil: number | null;
  sleepReason: string | null;
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
    running = await anyMuseRunActive(museUserId());
  } catch { /* DB 不可用 → 回退进程内快照 */ }
  let pendingApprovals = 0;
  try { pendingApprovals = await countPendingApprovals(museUserId()); } catch { /* 表未建/DB 不可用 */ }
  if (!spaceStamp) spaceStamp = await spaceDirStamp().catch(() => 0); // 引擎刚起还没跑过周期 → 按磁盘现状算一次
  const sleep = await getMuseSleep().catch(() => null);
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
    sleepUntil: sleep?.until ?? null,
    sleepReason: sleep?.reason ?? null,
  };
}

