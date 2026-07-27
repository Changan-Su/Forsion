/**
 * 本地 Historian（Special Agent）—— 按「轮」触发，区别于云端 historian.ts 的空闲扫描。
 *
 * 一应一和 = 1 轮（= 1 个 done run）。每个用户会话 run 完成后（agentLoop done 钩子）：
 *   - 每 everyRounds 轮（周期合一,标题与 LOG/memory 同一节奏）：总结并更新会话标题 +
 *     判断是否更新用户 LOG/memory（经 brain.memory），有则写入；
 *   - 首轮（roundN===1 且 firstRoundTrigger）必触发。
 *
 * 两种工作模式（cfg.mode）：
 *   - independent（默认）：Historian 自己结构化判断并写 title/LOG；memory 走两阶段(借 Codex 记忆
 *     流水线):按轮只**采集候选**(带 No-op 门)进 <agent>/.memory-raw.md,攒够一批才跑**整固**
 *     (与正典 MEMORY 统一去重/合并/淘汰后全文改写,含缩水守卫)——见 maybeConsolidate。
 *   - assist（辅助）：标题仍独立维护；LOG/memory 到点时改为 branch 出隐藏讨论会话（kind='discussion'，
 *     继承最近 30 条），与主 Agent 开一场无主持人的简短群聊（Historian 临时人格先评估，主 Agent 定夺并
 *     自己调 log_event/remember 写入自己的记忆域）。首轮始终 independent。此模式下 memory 为追加式
 *     （remember），整文修订仅 independent 模式做。
 * 配置见 special-agents.json（enabled 默认关、需选 modelId）。活动写 special_agent_log（隔离记录，
 * 驱动 Historian 工作视图），不进用户会话列表。本地特性：仅 host-exec profile 形态启用，云端 no-op。
 *
 * 成本：背景任务、用户未主动发起 → 只记 usage（projectSource='tangu-historian'），默认不扣配额。
 */
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { loadSpecialAgentsConfig, DEFAULT_HISTORIAN_PROMPT, resolveBackgroundModelId, type HistorianConfig } from './specialAgentsConfig.js';
import { enterRunContext, currentAgentSlug } from '../seams/runContext.js';
import { getAgent, resolveMemorySlug } from '../agents/agentRegistry.js';
import { branchSession } from './sessionBranch.js';
import { createRun } from './runStore.js';
import { DEFAULT_AGENT_SLUG, agentsDir } from '../core/tanguHome.js';

const MAX_TRANSCRIPT_CHARS = 8000;
const CHARGE_USER = false;
const MIN_NEW_CHARS = 120; // 自上次维护以来的新对话字符数地板;不足视为琐碎轮,跳过整次判断

// ── raw 层(借 Codex 记忆流水线的两阶段:采集 → 整固)──────────────────────────
// 独立模式不再按轮整文覆盖 MEMORY:judge 只产出「候选条目」追加进 <agent>/.memory-raw.md,
// 攒够 RAW_CONSOLIDATE_MIN 条(或最老候选超 RAW_MAX_AGE_DAYS 天)才跑一次整固——把候选与正典
// MEMORY(含 run 内 remember 写入的条目)统一去重/合并/淘汰后全文改写。整固是 Historian 侧唯一的
// 正典写入点,双写仲裁归一;整文改写频率从「每 everyRounds 轮」降到「每攒一批」,侵蚀风险同步降。
const RAW_FILE = '.memory-raw.md';
const RAW_CONSOLIDATE_MIN = 5;
const RAW_MAX_AGE_DAYS = 7;
const RAW_MAX_PER_ROUND = 5; // 单轮最多采集条数(judge 提示词同步声明此上限)
const CONSOLIDATE_MAX_TOKENS = 8000; // 须容得下整份 20K 字符记忆(中文 ≈1 字/token 也要够大半;截断另有 finishReason 闸)
// 并发/退避护栏(Codex 评审 #2/#6):同 agent 整固互斥(进程内锁,localHistorian 本就 host 单进程);
// 缩水守卫拒绝后按 slug 退避一天,防「合法瘦身永远被拒 + 每轮白烧一次模型调用」的活锁。
const consolidatingSlugs = new Set<string>();
const shrinkBackoffUntil = new Map<string, number>();
const SHRINK_BACKOFF_MS = 86_400_000;

/** 测试用:清空整固互斥/退避状态(模块级,跨用例会串)。 */
export function resetHistorianConsolidationState(): void {
  consolidatingSlugs.clear();
  shrinkBackoffUntil.clear();
}

/**
 * 构造 Historian 的结构化判断 system prompt:一次调用、输出 JSON,title/log/memory 各自独立判断。
 * customPrompt = 用户可配的「判断哲学」(留空用默认);代码强制 JSON 输出格式 + 仅含到期字段。
 * 关键:LOG(当天流水:发生了什么)与 memory(长期稳定事实/偏好,跨会话有用、绝非流水账)是**两类不同内容**,
 * 不得相同;memory 要克制,多数对话应为空。
 */
function buildJudgeSystem(customPrompt: string, wantTitle: boolean, wantLog: boolean, wantMemory: boolean): string {
  const fields: string[] = [];
  if (wantTitle) fields.push('"title": a phrase of ≤16 characters in the user\'s language summarizing this conversation\'s topic, used as the session title (always provide it)');
  if (wantLog) fields.push('"log": if this conversation has an event/progress/output "worth noting for the day", write one short sentence in the user\'s language; otherwise give an empty string ""');
  if (wantMemory) {
    fields.push(
      '"memory_candidates": an array of NEW long-term memory candidates observed in this conversation (usually empty). ' +
      'Gate each entry: include it ONLY if a future conversation would plausibly go better because of it. Qualifying: stable user facts/preferences the user stated or enforced, ' +
      'high-leverage procedural knowledge (exact paths/commands/workflows proven to work), landmines to avoid. ' +
      'Never include: one-off requests, temporary or task-status facts, summaries of what happened (that is the log), or restated common knowledge. ' +
      'One short self-contained sentence per entry, in the user\'s language; replace any token/key/password with [REDACTED]. ' +
      'At most 5 entries — pick the highest-value ones. When in doubt, leave it out — an empty array is the normal outcome.',
    );
  }
  return [
    (customPrompt && customPrompt.trim()) || DEFAULT_HISTORIAN_PROMPT,
    '\nRead the conversation below and judge; output **a single JSON object** only, with the following fields:',
    '- ' + fields.join('\n- '),
    `Example: {"title":"Gradient visualization","log":"Finished first draft of donk_intro.docx"${wantMemory ? ',"memory_candidates":["Prefers concise, direct answers"]' : ''}}`,
    'Give an empty string (or empty array) for fields that need no update. Output JSON only — no code fences, no extra text.',
  ].filter(Boolean).join('\n');
}

/** 机械脱敏兜底(提示词也要求,双保险):常见 token/key 形状一律替换。
 *  hex 阈值取 48:不误伤 40 位 git SHA(记忆里常见且有用),仍盖住 64 位 hex 密钥。 */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{48,}\b/g, '[REDACTED]');
}

// ── raw 层文件 IO(host-only,与该 agent 的 MEMORY.md 同文件夹)────────────────
// 兜底链与 localMemoryBrain 的域解析一致(currentAgentSlug() || DEFAULT):保证 raw 文件
// 与 getMemory/setMemory 落同一个 agent 文件夹,不分叉。
function rawPath(slug?: string): string {
  return join(agentsDir(), slug || currentAgentSlug() || DEFAULT_AGENT_SLUG, RAW_FILE);
}

const RAW_LINE_RE = /^- \[(\d{4}-\d{2}-\d{2})[^\]]*\] (.+)$/;

export function parseRawLines(content: string): { date: string; text: string; line: string }[] {
  const out: { date: string; text: string; line: string }[] = [];
  for (const line of String(content || '').split('\n')) {
    const m = RAW_LINE_RE.exec(line.trim());
    if (m) out.push({ date: m[1], text: m[2], line: line.trim() });
  }
  return out;
}

function readRaw(slug?: string): { date: string; text: string; line: string }[] {
  try { return parseRawLines(readFileSync(rawPath(slug), 'utf8')); } catch { return []; }
}

function appendRawCandidates(slug: string | undefined, sessionId: string, cands: string[]): number {
  if (!cands.length) return 0;
  const p = rawPath(slug);
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* ignore */ }
  const today = new Date().toISOString().slice(0, 10);
  const lines = cands.map((c) => `- [${today} s:${sessionId.slice(0, 8)}] ${c}`).join('\n') + '\n';
  appendFileSync(p, lines, 'utf8');
  return cands.length;
}

/** 整固成功后移除已消费的行(期间新追加的行原样保留)。 */
function removeRawLines(slug: string | undefined, consumed: Set<string>): void {
  const p = rawPath(slug);
  try {
    const kept = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() && !consumed.has(l.trim()));
    writeFileSync(p, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  } catch { /* ignore */ }
}

const CONSOLIDATION_PROMPT =
  'You are the Historian consolidating an agent\'s long-term memory document.\n' +
  'You get [Current Memory] (the canonical document; other writers may have appended entries directly) and [New Candidates] ' +
  '(raw observations captured from recent conversations; may contain duplicates and noise).\n' +
  'Rewrite the complete memory document:\n' +
  '- Integrate candidates that add durable value; keep existing entries that still hold.\n' +
  '- Deduplicate: each fact appears once, in its best wording (merge candidates against each other AND against current memory).\n' +
  '- On contradiction, the newer statement wins. Candidates are listed oldest first, each prefixed with its capture date; ' +
  'current-memory entries are undated and may be newer OR older than a candidate — judge recency from the dates and content, ' +
  'and when truly ambiguous keep the current-memory version.\n' +
  '- Drop candidates that are one-off, temporary, or task-status facts rather than stable facts/preferences/goals or hard-won procedural knowledge.\n' +
  '- Keep it concise and itemized (markdown bullets). Never invent facts. Never store secrets — replace with [REDACTED].\n' +
  'Output ONLY the full updated memory text — no code fences, no commentary. If no change is warranted, output exactly: NOCHANGE';

/** 到期判定 + 整固执行。绝不抛;失败(模型/读写/截断)一律不消费 raw,下轮自然重试。 */
async function maybeConsolidate(userId: string, slug: string | undefined, modelId: string, sessionRef: string): Promise<void> {
  const key = slug || currentAgentSlug() || DEFAULT_AGENT_SLUG;
  if (consolidatingSlugs.has(key)) return; // 同 agent 整固互斥(Codex #2):并行到点轮直接让行
  if ((shrinkBackoffUntil.get(key) || 0) > Date.now()) return; // 缩水拒绝后的退避期(Codex #6)
  consolidatingSlugs.add(key);
  try {
    const raw = readRaw(slug);
    if (!raw.length) return;
    const oldest = raw[0]?.date || '';
    const stale = oldest && (Date.now() - new Date(`${oldest}T00:00:00`).getTime()) / 86_400_000 > RAW_MAX_AGE_DAYS;
    if (raw.length < RAW_CONSOLIDATE_MIN && !stale) return;

    // 正典读取必须成功(Codex #1):瞬时读失败若被吞成空文档,缩水守卫会失效,
    // 整固产出会把真记忆整个盖掉——宁可跳过本轮。
    let curMem: string;
    try {
      curMem = String((await deps().brain.memory.getMemory(userId))?.content || '').trim();
    } catch (e: any) {
      log(`整固前读正典失败,跳过本轮: ${e?.message || e}`);
      return;
    }
    const input =
      `[Current Memory]\n${curMem || '(empty)'}\n\n[New Candidates]\n${raw.map((r) => `- [${r.date}] ${r.text}`).join('\n')}`;
    const res = await complete('整固', modelId, CONSOLIDATION_PROMPT, input, userId, CONSOLIDATE_MAX_TOKENS);
    const out = res.content.trim();
    if (!out) return; // 模型失败:raw 保留,下轮重试
    if (res.finishReason === 'length') {
      // 截断的「全文改写」= 必然缺尾(Codex #3),40% 守卫拦不住中度侵蚀 → 直接弃用。
      log(`整固产出被 token 上限截断(${out.length} 字),弃用本轮`);
      return;
    }

    const consumed = new Set(raw.map((r) => r.line));
    if (out.toUpperCase() === 'NOCHANGE') {
      // 候选被裁定无并入价值:消费掉,防止同一批反复触发整固。
      removeRawLines(slug, consumed);
      await logActivity(userId, 'memory_consolidated', `${raw.length} 条候选,无需变更`, sessionRef);
      log(`整固完成:${raw.length} 条候选,无需变更`);
      return;
    }
    // 防异常缩水(沿用原守卫):旧记忆较多而产出骤降 → 疑似丢失,弃用且不消费 raw。
    // 合法瘦身也可能触发 → 记退避,别每轮白烧模型调用(livelock 上限=每天一次)。
    if (curMem.length > 200 && out.length < curMem.length * 0.4) {
      shrinkBackoffUntil.set(key, Date.now() + SHRINK_BACKOFF_MS);
      log(`整固产出疑似异常缩水(${curMem.length}→${out.length}),跳过并退避一天`);
      return;
    }
    const setMem = deps().brain.memory.setMemory;
    if (!setMem) { log('当前 brain 不支持 setMemory,跳过整固落盘'); return; }
    // 写前复核(Codex #2 的 remember 竞态):整固期间正典若被别人改过(remember/另一路),
    // 快照已过期,盖写会吞掉别人的追加 → 放弃本轮,raw 保留下轮带新快照重来。
    try {
      const recheck = String((await deps().brain.memory.getMemory(userId))?.content || '').trim();
      if (recheck !== curMem) { log('整固期间正典被并发修改,放弃本轮盖写'); return; }
    } catch { return; }
    await setMem(userId, redactSecrets(out).slice(0, 20000));
    removeRawLines(slug, consumed);
    await logActivity(userId, 'memory_updated', `整固 ${raw.length} 条候选(${curMem.length}→${out.length} 字)`, sessionRef);
    log(`整固完成:${raw.length} 条候选并入,${curMem.length}→${out.length} 字`);
  } catch (e: any) {
    log(`整固异常: ${e?.message || e}`);
  } finally {
    consolidatingSlugs.delete(key);
  }
}

/** 从模型输出里提取首个 JSON 对象(容忍代码围栏 / 前后噪声)。失败 → null。 */
function parseJudgement(raw: string): { title?: string; log?: string; memory?: string } | null {
  let s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 纯判定:第 roundN 轮是否触发(首轮可强制 + 每 every 轮)。roundN<1 不触发。 */
export function isRoundDue(roundN: number, every: number, firstRoundTrigger: boolean): boolean {
  if (roundN < 1) return false;
  if (roundN === 1 && firstRoundTrigger) return true;
  return every > 0 && roundN % every === 0;
}

/**
 * 自本会话上次 Historian 动作（special_agent_log）以来，新对话内容是否够「实质」。
 * 无历史动作 = 该会话首次维护 → 放行。两列均为 SQL TIMESTAMP（同域可比，方言安全）。查询失败 → 放行（不阻断既有行为）。
 */
async function enoughNewSinceLastAction(sessionId: string): Promise<boolean> {
  try {
    const last = await query<any[]>(
      `SELECT created_at FROM special_agent_log WHERE session_ref = ? AND agent = 'historian'
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );
    const since = last[0]?.created_at;
    if (!since) return true; // 本会话尚未维护过 → 放行
    const rows = await query<any[]>(
      `SELECT content FROM chat_messages WHERE session_id = ? AND created_at > ? AND role IN ('user', 'model', 'assistant')`,
      [sessionId, since],
    );
    const chars = (rows || []).reduce((s, r) => s + String(r.content || '').trim().length, 0);
    return chars >= MIN_NEW_CHARS;
  } catch {
    return true;
  }
}

async function recentTranscript(sessionId: string, limit = 30): Promise<string> {
  const rows = await query<any[]>(
    `SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [sessionId, limit],
  );
  rows.reverse();
  const lines: string[] = [];
  for (const m of rows) {
    const role = m.role === 'model' ? 'assistant' : m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = String(m.content || '').trim();
    if (content) lines.push(`${role === 'user' ? '用户' : 'AI'}：${content}`);
  }
  let s = lines.join('\n');
  if (s.length > MAX_TRANSCRIPT_CHARS) s = s.slice(-MAX_TRANSCRIPT_CHARS);
  return s;
}

/** 单次轻量补全（系统提示 + transcript）。失败返回 content=''(并打日志说明原因)。记 usage（默认不扣配额）。
 *  finishReason 透传给调用方——整固「全文改写」被截断必须可检测(Codex #3)。 */
async function complete(label: string, modelId: string, system: string, transcript: string, userId: string, maxTokens: number): Promise<{ content: string; finishReason?: string }> {
  try {
    const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(modelId);
    const payload = await deps().brain.llm.buildProviderPayload({
      model, apiModelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: transcript }] as ChatMessage[],
      projectSource: '', // 不叠项目层提示词
      usageSource: 'tangu', // 记账归进 Tangu 桶(本地特性,恒 tangu;否则云端兜底记 tangu-brain)
      temperature: 0.3, maxTokens, stream: true,
      provider: (model as any)?.provider,
    } as any);
    const res = await deps().brain.llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider });
    try {
      const cost = await deps().billing.calculateCost(modelId, res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0);
      const u = await deps().brain.users.getUserById(userId);
      await (deps().billing.logApiUsage as any)(
        u?.username || userId, modelId, model.name, model.provider,
        res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0, true, undefined, 'tangu-historian', cost,
      );
      if (CHARGE_USER) await deps().billing.consumeTokenPoints(userId, cost).catch(() => {});
    } catch { /* 记账失败不阻断 */ }
    const out = String(res?.content || '').trim();
    if (!out) log(`${label} 模型返回空内容(model=${modelId})`);
    return { content: out, finishReason: (res as any)?.finishReason };
  } catch (e: any) {
    log(`${label} 模型调用失败(model=${modelId}): ${e?.message || e}`);
    return { content: '' };
  }
}

async function logActivity(userId: string, action: string, detail: string, sessionRef: string): Promise<void> {
  try {
    await query(
      `INSERT INTO special_agent_log (id, user_id, agent, action, detail, session_ref) VALUES (?, ?, 'historian', ?, ?, ?)`,
      [uuidv4(), userId, action, detail.slice(0, 1000), sessionRef],
    );
  } catch (e: any) {
    log(`写 special_agent_log 失败(${action}): ${e?.message || e}`);
  }
}

function log(msg: string): void {
  try { deps().host.log(`[historian] ${msg}`); } catch { console.log(`[historian] ${msg}`); }
}
/** 是否本地形态(host-exec profile)。云端 baseline 无 hostExec → Historian 整体 no-op。 */
function isLocal(): boolean {
  try { return !!deps().profile.capabilities.hostExec; } catch { return false; }
}

/**
 * run 完成钩子：判断并执行标题/记忆更新。fire-and-forget（agentLoop void 调用），绝不抛。
 * 仅处理 kind='user' 的会话；Historian 自身不产生 run，无递归风险。
 * memScopeSlug = 记忆域 slug（runLoop 已折叠 shareDefaultMemory），Historian 的 MEMORY/LOG
 * 读写必须与 run 内 remember/log_event 落同一文件夹。
 */
export async function onUserRunDone(sessionId: string, userId: string, memScopeSlug?: string): Promise<void> {
  if (!isLocal()) return;
  // 解析本 run 的记忆域:优先传入的 memScopeSlug;否则(外部引擎等未做激活的路径)从会话 agent_config.agentSlug
  // 兜底读——那存的是 active slug,须经 resolveMemorySlug 折叠 shareDefaultMemory 才与 run 内记忆读写同域。
  // 重注入 Historian 自己的异步上下文 → deps().brain.memory(动态本地库)读写落到该 agent 的文件夹(fire-and-forget
  // 不保证继承原 run 的 ALS,故显式重设;云端 isLocal=false 已 return)。
  let effectiveSlug = memScopeSlug;
  if (!effectiveSlug) {
    try {
      const r = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ? LIMIT 1`, [sessionId]);
      const raw = r[0]?.agent_config;
      const cfg0 = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (cfg0?.agentSlug) {
        const def = await getAgent(String(cfg0.agentSlug)).catch(() => null);
        if (def) effectiveSlug = resolveMemorySlug(def);
      }
    } catch { /* ignore */ }
  }
  if (effectiveSlug) enterRunContext(userId, undefined, effectiveSlug);
  let cfg;
  try { cfg = loadSpecialAgentsConfig().historian; } catch { return; }
  if (!cfg.enabled) return;
  // 模型解析:用户显式配置 > admin 后台默认槽 > 对话默认(未选模型=跟随云端)。
  cfg.modelId = await resolveBackgroundModelId(cfg.modelId).catch(() => '');
  if (!cfg.modelId) return;

  try {
    // 仅用户会话；并发安全：roundN 由 done run 计数推出（幂等）。app_id/model_id/agent_config 供辅助模式讨论用。
    const skRows = await query<any[]>(
      `SELECT kind, title, app_id, model_id, agent_config FROM chat_sessions WHERE id = ? LIMIT 1`,
      [sessionId],
    );
    const sk = skRows[0];
    if (!sk || (sk.kind && sk.kind !== 'user')) return;

    // 注意:不能用 `COUNT(*)::int`(PG cast)——standalone 是 SQLite,`::` 会报 unrecognized token。
    const cntRows = await query<any[]>(
      `SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ? AND status = 'done'`,
      [sessionId],
    );
    const roundN = Number(cntRows[0]?.n) || 0;
    if (roundN < 1) return;

    // 周期合一:标题 + LOG/memory 同一节奏(每 everyRounds 轮),用户设几轮就是几轮,节奏可预期。
    const due = isRoundDue(roundN, cfg.everyRounds, cfg.firstRoundTrigger);
    if (!due) return;
    const titleDue = due;
    const memoryDue = due;
    const logDue = due;

    // 实质增量地板:自上次维护以来新增内容太少 → 跳过整次判断(避免琐碎轮重复总结 / 反复重写记忆侵蚀)。
    if (!(await enoughNewSinceLastAction(sessionId))) { log(`第 ${roundN} 轮到点但自上次维护无实质新增,跳过`); return; }

    // 辅助模式(assist):LOG/memory 不由 Historian 写,分支(branch)出后台群聊讨论交主 Agent 定夺;
    // 标题仍由 Historian 独立维护(主 Agent 没有改标题的工具,标题也非记忆资产)。
    // 首轮(roundN===1)始终走独立模式:首轮要立即出标题+初始日志,也没有可供讨论的积累。
    const assistMode = cfg.mode === 'assist' && roundN > 1;
    const judgeLog = logDue && !assistMode;
    const judgeMemory = memoryDue && !assistMode;
    log(`第 ${roundN} 轮触发(${assistMode ? '辅助模式,' : ''}模型 ${cfg.modelId})`);

    const transcript = await recentTranscript(sessionId);
    if (!transcript.trim()) { log('无可用对话内容,跳过'); return; }

    if (titleDue || judgeLog || judgeMemory) {
      // 一次结构化判断:title / log / memory_candidates 各自独立(到期才要、不需要则空)。
      // 采集刻意不看现有记忆(与 Codex Phase 1 同构:采集盲写、去重归整固),省下每轮 ~20K 字输入。
      const sys = buildJudgeSystem(cfg.prompt, titleDue, judgeLog, judgeMemory);
      const raw = (await complete('判断', cfg.modelId, sys, transcript, userId, 1200)).content;
      const j = parseJudgement(raw);
      if (!j) {
        log(`判断输出无法解析为 JSON: "${raw.slice(0, 80)}"`); // 不 return:辅助讨论仍应发起
      } else {
        const title = String(j.title || '').trim().replace(/^["'《「]+|["'》」]+$/g, '').slice(0, 60);
        const logText = String(j.log || '').trim();
        // 候选条目:数组为正道;旧格式/半服从模型给了 memory 字符串 → 按行拆成多条候选兜底
        // (整文是 bullet 列表;当一条塞进行式 raw 会丢首行之外的全部内容——Codex #5)。
        const rawCands: unknown[] = Array.isArray((j as any).memory_candidates)
          ? (j as any).memory_candidates
          : (typeof (j as any).memory === 'string' && (j as any).memory.trim()
              ? (j as any).memory.split('\n').map((s: string) => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
              : []);
        const candidates = rawCands
          .map((c) => redactSecrets(String(c ?? '').replace(/\s*[\r\n]+\s*/g, '; ').trim()).slice(0, 300))
          .filter((c) => c.length >= 4 && c.toUpperCase() !== 'NOTHING')
          .slice(0, RAW_MAX_PER_ROUND);
        const okShort = (s: string) => !!s && s.toUpperCase() !== 'NOTHING' && s.length >= 2 && s.length <= 400;
        log(`判断: title="${title}" log="${logText.slice(0, 30)}" 候选=${candidates.length} 条`);

        if (titleDue && okShort(title)) {
          await query(`UPDATE chat_sessions SET title = ? WHERE id = ?`, [title, sessionId]).catch((e: any) => log(`更新标题失败: ${e?.message || e}`));
          await logActivity(userId, 'title_updated', title, sessionId);
          log(`已更新标题: ${title}`);
        }
        if (judgeLog && okShort(logText)) {
          // LOG = 当天流水(append-only)。共享 LOG 经 brain(云端)。
          await deps().brain.memory.appendLogEntry(userId, logText).then(() => log('已写入 LOG')).catch((e: any) => log(`写 LOG 失败: ${e?.message || e}`));
          await logActivity(userId, 'log_appended', logText, sessionId);
        }
        if (judgeMemory && candidates.length) {
          // 采集:候选进 raw 层,正典 MEMORY 只由整固步骤改写(唯一仲裁点)。
          const n = appendRawCandidates(effectiveSlug, sessionId, candidates);
          if (n) {
            await logActivity(userId, 'memory_candidates', candidates.join(' | ').slice(0, 300), sessionId);
            log(`已采集 ${n} 条记忆候选进 raw 层`);
          }
        }
      }
    }

    // 整固到期检查(每个到点轮跑一次;raw 空/未攒够即刻返回,开销一次文件读)。
    if (!assistMode) await maybeConsolidate(userId, effectiveSlug, cfg.modelId, sessionId);

    // 辅助讨论只跟「记忆」周期(设置里的 每 Y 轮):此前挂在 logDue||memoryDue 上,而 logDue 跟随
    // 标题的高频周期(如 标题每2轮+记忆每3轮 → 讨论在 2,3,4,6,8,9… 轮触发),用户观感即「忽隔一轮
    // 忽隔两轮」。改为仅 memoryDue 拉起讨论,LOG 在辅助模式下随记忆周期一并商议,节奏可预期。
    if (assistMode && memoryDue) {
      const discRunId = await startAssistDiscussion({ sessionId, userId, cfg, sk, wantLog: true, wantMemory: true });
      if (discRunId) {
        await logActivity(userId, 'assist_discussion', `与主 Agent 商议${memoryDue ? '日志+记忆' : '日志'}更新(run ${discRunId.slice(0, 8)})`, sessionId);
        log(`辅助讨论已发起 run=${discRunId}`);
      }
    }
  } catch (e: any) {
    log(`onUserRunDone 异常: ${e?.message || e}`);
  }
}

/**
 * 辅助模式讨论:把主会话 branch(最近 30 条,kind='discussion' 不进会话列表)出一个子会话,在其中起
 * 一场 2 人群聊——Historian(临时人格,用 historian 配置的轻量模型)先开口给评估,主 Agent 随后定夺并
 * **自己**调 log_event/remember 写入(群聊逐发言人切 ALS,写入自然落主 Agent 的记忆域)。
 * 无主持人总结(groupNoSummary);sandbox+full-auto → 后台绝不会卡在 host 写审批上。
 * fire-and-forget:返回讨论 runId;分支/建 run 失败 → null(绝不抛)。
 */
async function startAssistDiscussion(opts: {
  sessionId: string;
  userId: string;
  cfg: HistorianConfig;
  /** 主会话行:{title, app_id, model_id, agent_config}。 */
  sk: any;
  wantLog: boolean;
  wantMemory: boolean;
}): Promise<string | null> {
  const { sessionId, userId, cfg, sk } = opts;
  try {
    // 主 Agent 人格 slug(展示身份,来自会话 agent_config;无/无效 → 默认 agent)。
    let activeSlug = DEFAULT_AGENT_SLUG;
    try {
      const raw = sk.agent_config;
      const c = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (c?.agentSlug && (await getAgent(String(c.agentSlug)).catch(() => null))) activeSlug = String(c.agentSlug);
    } catch { /* 默认 agent */ }
    if (activeSlug === DEFAULT_AGENT_SLUG) {
      // 会话没存 agentSlug(老会话/老客户端):按最后一条助手消息的展示身份兜底——
      // 讨论对象必须是真正跟用户聊的那个 agent,不能落到默认 agent 头上。
      try {
        const r = await query<any[]>(
          `SELECT agent_slug FROM chat_messages WHERE session_id = ? AND role IN ('model', 'assistant')
             AND agent_slug IS NOT NULL ORDER BY timestamp DESC LIMIT 1`,
          [sessionId],
        );
        const s2 = r[0]?.agent_slug ? String(r[0].agent_slug) : '';
        if (s2 && s2 !== DEFAULT_AGENT_SLUG && (await getAgent(s2).catch(() => null))) activeSlug = s2;
      } catch { /* 默认 agent */ }
    }
    const mainDef = await getAgent(activeSlug);
    if (!mainDef) return null;

    // 分支点 = 主会话最新消息(branch 继承到此为止的最近 30 条)。
    const last = await query<any[]>(
      `SELECT id FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`,
      [sessionId],
    );
    if (!last[0]?.id) return null;

    const appId = String(sk.app_id || deps().profile.appId);
    const branch = await branchSession({
      sourceSessionId: sessionId,
      userId,
      appId,
      messageId: String(last[0].id),
      title: `记忆维护:${String(sk.title || '').slice(0, 40) || sessionId.slice(0, 8)}`,
      kind: 'discussion',
      lastN: 30,
      parentSessionId: sessionId, // Background Session 父链接:子聊天面板经 /background 端点持久列出
    });
    if (!branch) return null;

    // 当前记忆/今日日志随开场白注入,主 Agent 据此判断「是否已记过/是否值得记」。
    // 此刻 ALS 已是本会话的记忆域(onUserRunDone 顶部 enterRunContext),直接读即为主 Agent 的文件。
    const mem = String((await deps().brain.memory.getMemory(userId).catch(() => ({ content: '' })))?.content || '').trim();
    const todayLog = String((await deps().brain.memory.getLog(userId).catch(() => ({ content: '' } as any)))?.content || '').trim();

    const topics = [opts.wantLog ? 'the daily LOG' : '', opts.wantMemory ? 'the long-term MEMORY' : ''].filter(Boolean).join(' and ');
    const histSlug = `historian-${uuidv4().slice(0, 8)}`;
    const histDef = {
      slug: histSlug,
      name: 'Historian',
      description: 'Background historian — assesses whether the conversation warrants log/memory updates',
      model: cfg.modelId, // 评估用 historian 配置的轻量模型;主 Agent 用会话模型
      systemPrompt:
        `${(cfg.prompt && cfg.prompt.trim()) || DEFAULT_HISTORIAN_PROMPT}\n\n## Assist Mode\n` +
        `In this short discussion you are the advisor, not the writer. Assess whether the conversation shown in the context warrants updating ${topics}, ` +
        'and open the discussion with your concrete judgment — if an update is warranted, propose the exact wording. ' +
        `You must NOT call remember or log_event yourself: ${mainDef.name} owns its memory and makes the final call. Be brief.`,
    };

    const message =
      `[Historian assist] Decide together whether ${topics} should be updated for this conversation (see the context above). ` +
      `Historian speaks first with its assessment; then ${mainDef.name} makes the final call and, if an update is warranted, ` +
      'performs it ITSELF by calling log_event (one short sentence for what happened today) and/or remember (only long-term stable facts/preferences about the user — be restrained). ' +
      'Do not do any other work. Keep it brief — one round is usually enough.\n\n' +
      `[Current long-term MEMORY]\n${(mem || '(empty)').slice(0, 3000)}\n\n` +
      `[Today's LOG so far]\n${(todayLog || '(empty)').slice(-1500)}`;

    const runId = uuidv4();
    await createRun({
      id: runId,
      sessionId: branch.id,
      userId,
      appId,
      modelId: String(sk.model_id || deps().profile.defaultModelId || cfg.modelId),
      assistantMessageId: uuidv4(),
      input: {
        message,
        userMessageId: uuidv4(),
        attachments: [],
        agentConfig: {
          groupChat: true,
          groupAgents: [activeSlug, histSlug],
          groupTempAgents: [histDef],
          priorityAgent: histSlug, // Historian 先开口(评估),主 Agent 随后定夺
          groupMaxRounds: 2, // 简短:评估+定夺各一轮,投票可提前收束
          groupNoSummary: true, // 结论=主 Agent 的工具动作,无需主持人总结
          groupSeedHistory: true, // 参与者看得到 branch 继承来的对话上下文
          execMode: 'sandbox', // 讨论不需要 host FS;sandbox+full-auto → 后台绝不卡审批
          approvalMode: 'full-auto',
        },
      },
    });
    // 动态 import:localHistorian 被 agentLoop 静态引用,反向静态 import 会成环(同 discussion.ts)。
    const { enqueueRun } = await import('./agentLoop.js');
    enqueueRun(branch.id, runId);
    return runId;
  } catch (e: any) {
    log(`辅助讨论发起失败: ${e?.message || e}`);
    return null;
  }
}
