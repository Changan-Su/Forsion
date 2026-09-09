/**
 * 本地 Historian（Special Agent）—— 按「轮」触发，区别于云端 historian.ts 的空闲扫描。
 *
 * 一应一和 = 1 轮（= 1 个 done run）。每个用户会话 run 完成后（agentLoop done 钩子）：
 *   - 每 everyRounds 轮（周期合一,标题/摘要与 LOG/memory 同一节奏）：总结并更新会话标题+会话摘要
 *     (chat_sessions.summary,人读:列表预览 / [[session:]] 引用第一跳) + 判断是否更新用户
 *     LOG/memory（经 brain.memory），有则写入；
 *   - 首轮（roundN===1 且 firstRoundTrigger）必触发。
 *
 * 三种工作模式（cfg.mode）：
 *   - independent（默认）：Historian 自己结构化判断并写 title/summary/LOG；memory 走两阶段(借 Codex
 *     记忆流水线):按轮只**采集候选**(带 No-op 门)进 <agent>/.memory-raw.md,攒够一批才跑**整固**
 *     (由单独启用的 Dream 做来源校验、版本提交与可恢复的整理)——见 maybeConsolidate。
 *   - assist（辅助）：标题/摘要仍独立维护；LOG/memory 到点时改为 branch 出隐藏讨论会话（kind='discussion'，
 *     继承最近 30 条），与主 Agent 开一场无主持人的简短群聊（Historian 临时人格先评估，主 Agent 定夺并
 *     自己调 log_event/remember 写入自己的记忆域）。首轮始终 independent。此模式下 memory 为追加式
 *     （remember），候选整理由每 Agent 的 Dream 设置控制。
 *   - fork（分身判官）：judge 原文改由「尾部分叉补全」产出——agentLoop 主路径 run done 时传入
 *     workingMessages 快照(HistorianForkSeed),用**会话模型**在全量在存上下文尾部追加一条判官指令做
 *     一次补全(cacheKey=sessionId + 同工具面 + 同思考档 → provider 前缀缓存可命中;借 self_brainstorm
 *     的缓存对齐管线,禁工具靠指令+结果侧丢弃)。相比 independent 的「DB 最近 30 条/8000 字」,判断者
 *     看到完整上下文;解析/落地与 independent 完全同路,快照缺席/超窗/失败自动回落 independent。
 * 配置见 special-agents.json（enabled 默认关、需选 modelId）。活动写 special_agent_log（隔离记录，
 * 驱动 Historian 工作视图），不进用户会话列表。本地特性：仅 host-exec profile 形态启用，云端 no-op。
 *
 * 成本：背景任务、用户未主动发起 → 只记 usage（projectSource='tangu-historian'），默认不扣配额。
 */
import { v4 as uuidv4 } from 'uuid';
import { AsyncLocalStorage } from 'node:async_hooks';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { loadSpecialAgentsConfig, DEFAULT_HISTORIAN_PROMPT, resolveBackgroundModelId, type HistorianConfig } from './specialAgentsConfig.js';
import { enterRunContext, currentAgentSlug } from '../seams/runContext.js';
import { getAgent, resolveMemorySlug, isValidSlug } from '../agents/agentRegistry.js';
import { branchSession } from './sessionBranch.js';
import { createRun } from './runStore.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { buildSharedPrefix } from './selfBrainstorm.js';
import { modelContextWindow, estimateMessageTokens } from './contextBudget.js';
import { redactSecrets } from '../core/redact.js';
import { appendHarnessCandidates } from '../agents/harnessStore.js';
import { appendCandidates as appendRawCandidates, readCandidates as readRaw } from './memoryCandidates.js';
import { startMemoryDream } from './memoryDream.js';
export { parseRawLines } from './memoryCandidates.js';
const historianSignal = new AsyncLocalStorage<AbortSignal>();

const MAX_TRANSCRIPT_CHARS = 8000;
const CHARGE_USER = false;
const MIN_NEW_CHARS = 120; // 自上次维护以来的新对话字符数地板;不足视为琐碎轮,跳过整次判断

// Historian collects source-linked candidates. Per-Agent Dream is separately opt-in,
// versioned and bounded; no background whole-document rewrite is allowed here.
const RAW_CONSOLIDATE_MIN = 5;
const RAW_MAX_AGE_DAYS = 7;
const RAW_MAX_PER_ROUND = 5;
const HARNESS_RAW_MAX_PER_ROUND = 3;
// 会话级 Historian 互斥(Codex 评审 08-03 Critical):onUserRunDone 是 fire-and-forget,下一 run 的
// done 可能在上一轮维护(judge/fork/整固)还在飞时到来——everyRounds=1 时必然。并发双跑会重复追加
// LOG/候选、竞态覆盖标题/摘要。锁忙=直接跳过本轮(维护是尽力而为,下个到点轮自然补),绝不能把
// 「锁忙」当 fork 失败再并发启动 independent。
const historianBusySessions = new Set<string>();

/** 测试用:清空整固互斥/退避/会话互斥状态(模块级,跨用例会串)。 */
export function resetHistorianConsolidationState(): void {
  historianBusySessions.clear();
}

/** judge JSON 的字段规格+示例(独立模式 system prompt 与 fork 判官指令共用同一契约)。 */
function judgeFieldSpecs(wantTitle: boolean, wantLog: boolean, wantMemory: boolean, wantSummary: boolean, wantHarness: boolean): { fields: string[]; example: string } {
  const fields: string[] = [];
  if (wantTitle) fields.push('"title": a phrase of ≤16 characters in the user\'s language summarizing this conversation\'s topic, used as the session title (always provide it)');
  if (wantSummary) {
    fields.push(
      '"summary": an updated summary of this session, 1-3 sentences in the user\'s language, written for a human skimming their session list: ' +
      'what it is about, key decisions/outcomes, current state. If a [Previous summary] is provided, revise it to cover the new content ' +
      '(keep still-true parts, drop obsolete ones); give "" if it still fits as-is.',
    );
  }
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
  if (wantHarness) {
    // 反模式清单抄 hermes skill-review 的负面门(环境失败/负面断言/一次性叙事会硬化成日后反噬的拒绝理由)。
    fields.push(
      '"harness_candidates": an array of NEW working-method lessons for the agent\'s own working notes (usually empty). ' +
      'Qualifying: a durable, transferable lesson about HOW this agent should work — a workflow correction the user made, ' +
      'a delegation pattern that worked well, a procedural landmine and how to avoid it. ' +
      'Never include: environment/setup hiccups, transient errors, negative claims like "tool X is broken" (they harden into refusals that bite the agent later), ' +
      'one-off task narratives, or facts about the user (those belong in memory_candidates). ' +
      'One short self-contained sentence per entry, in English. At most 3 entries; an empty array is the normal outcome.',
    );
  }
  const example =
    `{"title":"Gradient visualization"${wantSummary ? ',"summary":"Debugging the gradient page; settled on SVG rendering, axis scaling still open."' : ''}` +
    `,"log":"Finished first draft of donk_intro.docx"${wantMemory ? ',"memory_candidates":["Prefers concise, direct answers"]' : ''}${wantHarness ? ',"harness_candidates":[]' : ''}}`;
  return { fields, example };
}

/**
 * 构造 Historian 的结构化判断 system prompt:一次调用、输出 JSON,title/summary/log/memory 各自独立判断。
 * customPrompt = 用户可配的「判断哲学」(留空用默认);代码强制 JSON 输出格式 + 仅含到期字段。
 * 关键:LOG(当天流水:发生了什么)与 memory(长期稳定事实/偏好,跨会话有用、绝非流水账)是**两类不同内容**,
 * 不得相同;memory 要克制,多数对话应为空。
 */
function buildJudgeSystem(customPrompt: string, wantTitle: boolean, wantLog: boolean, wantMemory: boolean, wantSummary: boolean, wantHarness: boolean): string {
  const { fields, example } = judgeFieldSpecs(wantTitle, wantLog, wantMemory, wantSummary, wantHarness);
  return [
    (customPrompt && customPrompt.trim()) || DEFAULT_HISTORIAN_PROMPT,
    '\nRead the conversation below and judge; output **a single JSON object** only, with the following fields:',
    '- ' + fields.join('\n- '),
    `Example: ${example}`,
    'Give an empty string (or empty array) for fields that need no update. Output JSON only — no code fences, no extra text.',
  ].filter(Boolean).join('\n');
}

/** fork 判官的追加指令(user 消息,分叉尾部):上下文=上方完整对话,无需另拼 transcript。 */
function buildForkJudgeMessage(customPrompt: string, wantTitle: boolean, wantLog: boolean, wantMemory: boolean, wantSummary: boolean, wantHarness: boolean, prevSummary: string): string {
  const { fields, example } = judgeFieldSpecs(wantTitle, wantLog, wantMemory, wantSummary, wantHarness);
  return [
    '## Historian fork (tail-fork judge)',
    'You are a tail-fork of the assistant above, acting as the background Historian for this conversation. ' +
    'Ignore any pending tool activity; any tool call you emit will be DISCARDED — reply with the JSON object only.',
    (customPrompt && customPrompt.trim()) || DEFAULT_HISTORIAN_PROMPT,
    'Judge the FULL conversation above and output **a single JSON object** with the following fields:',
    '- ' + fields.join('\n- '),
    prevSummary ? `[Previous summary]\n${prevSummary}` : '',
    `Example: ${example}`,
    'Give an empty string (or empty array) for fields that need no update. Output JSON only — no code fences, no extra text.',
  ].filter(Boolean).join('\n');
}

export { redactSecrets }; // 实现已挪 core/redact.ts(harnessStore 共用,免拖依赖树);此处 re-export 保住旧引用面

/** Candidate collection stays cheap; opted-in Dream is scheduled outside the run. */
async function maybeConsolidate(userId: string, slug: string | undefined, modelId: string, _sessionRef: string): Promise<void> {
  historianSignal.getStore()?.throwIfAborted();
  const key = slug || currentAgentSlug() || DEFAULT_AGENT_SLUG;
  const raw = readRaw(key);
  if (!raw.length) return;
  const oldest = Math.min(...raw.map((r) => Date.parse(`${r.date}T00:00:00Z`)).filter(Number.isFinite));
  if (raw.length < RAW_CONSOLIDATE_MIN && Date.now() - oldest <= RAW_MAX_AGE_DAYS * 86_400_000) return;
  startMemoryDream(userId, key, { automatic: true, modelId });
}

/** 从模型输出里提取首个 JSON 对象(容忍代码围栏 / 前后噪声)。失败 → null。 */
function parseJudgement(raw: string): { title?: string; summary?: string; log?: string; memory?: string } | null {
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

async function recentTranscript(sessionId: string, limit = 30): Promise<{ text: string; anchorMessageId?: string }> {
  const rows = await query<any[]>(
    `SELECT id, role, content FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [sessionId, limit],
  );
  const anchorMessageId = rows[0]?.id ? String(rows[0].id) : undefined;
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
  return { text: s, anchorMessageId };
}

/** 单次轻量补全（系统提示 + transcript）。失败返回 content=''(并打日志说明原因)。记 usage（默认不扣配额）。
 *  finishReason 透传给调用方——整固「全文改写」被截断必须可检测(Codex #3)。 */
async function complete(label: string, modelId: string, system: string, transcript: string, userId: string, maxTokens: number): Promise<{ content: string; finishReason?: string }> {
  try {
    const signal = historianSignal.getStore();
    signal?.throwIfAborted();
    const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(modelId);
    signal?.throwIfAborted();
    const payload = await deps().brain.llm.buildProviderPayload({
      model, apiModelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: transcript }] as ChatMessage[],
      projectSource: '', // 不叠项目层提示词
      usageSource: 'tangu', // 记账归进 Tangu 桶(本地特性,恒 tangu;否则云端兜底记 tangu-brain)
      temperature: 0.3, maxTokens, stream: true, signal,
      provider: (model as any)?.provider,
    } as any);
    historianSignal.getStore()?.throwIfAborted();
    const res = await deps().brain.llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal: historianSignal.getStore() });
    historianSignal.getStore()?.throwIfAborted();
    await recordJudgeUsage(userId, modelId, model, res);
    historianSignal.getStore()?.throwIfAborted();
    const out = String(res?.content || '').trim();
    if (!out) log(`${label} 模型返回空内容(model=${modelId})`);
    return { content: out, finishReason: (res as any)?.finishReason };
  } catch (e: any) {
    log(`${label} 模型调用失败(model=${modelId}): ${e?.message || e}`);
    return { content: '' };
  }
}

/** Historian 侧模型调用统一记账(usage 归 tangu-historian,默认不扣配额)。绝不抛。 */
async function recordJudgeUsage(userId: string, modelId: string, model: any, res: any): Promise<void> {
  try {
    const cost = await deps().billing.calculateCost(modelId, res?.usage?.prompt_tokens || 0, res?.usage?.completion_tokens || 0);
    const u = await deps().brain.users.getUserById(userId);
    await (deps().billing.logApiUsage as any)(
      u?.username || userId, modelId, model.name, model.provider,
      res?.usage?.prompt_tokens || 0, res?.usage?.completion_tokens || 0, true, undefined, 'tangu-historian', cost,
    );
    if (CHARGE_USER) await deps().billing.consumeTokenPoints(userId, cost).catch(() => {});
  } catch { /* 记账失败不阻断 */ }
}

// ── fork 判官(mode='fork'):尾部分叉一次补全,借 self_brainstorm 的缓存对齐管线 ───────────────
const FORK_JUDGE_MAX_TOKENS = 1600;
const FORK_CONTEXT_HEADROOM = 0.75; // 与 self_brainstorm 同款护栏:前缀估算超模型窗口此比例即回落
// fork 无自己的互斥:onUserRunDone 顶部的 historianBusySessions 会话锁已保证同会话单飞。

/** agentLoop 主路径 run done 时传入的快照接缝(群聊/外部引擎/hook 否决路径不传 → 回落 independent)。 */
export interface HistorianForkSeed {
  /** workingMessages 惰性快照(逐消息浅拷贝,含收尾正文;非 fork 模式零拷贝开销)。 */
  getMessages: () => ChatMessage[];
  /** 本 run 的工具 schema:参与 provider 前缀缓存,fork 请求必须带同款,禁执行靠指令+结果侧丢弃。 */
  tools: unknown[];
  thinkingLevel?: string;
  /** 会话模型:fork 必须用它——换模型则前缀缓存不共享,「同人格顺手判断」也不成立。 */
  modelId: string;
}

/** 一次 fork 判官补全。超窗/失败/空产出/截断 → 返回 ''(调用方回落 independent 判断)。 */
async function forkJudge(
  sessionId: string, userId: string, appId: string, seed: HistorianForkSeed, judgeMessage: string,
): Promise<string> {
  try {
    const prefix = buildSharedPrefix(seed.getMessages());
    if (!prefix.length) return '';
    const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(seed.modelId);
    const est = prefix.reduce((n, m) => n + estimateMessageTokens(m), 0);
    const win = modelContextWindow(seed.modelId, model);
    if (est > win * FORK_CONTEXT_HEADROOM) {
      log(`fork 判官:上下文超窗(~${est} > ${Math.floor(win * FORK_CONTEXT_HEADROOM)}/${win}),回落独立判断`);
      return '';
    }
    const payload = await deps().brain.llm.buildProviderPayload({
      model, apiModelId,
      // 逐请求深拷贝:构建器会原地改消息(openaiCompat 的 prefix-thinking 注 system),会污染快照(brainstorm 同款教训)。
      messages: structuredClone([...prefix, { role: 'user', content: judgeMessage } as ChatMessage]),
      projectSource: appId,
      usageSource: 'tangu',
      temperature: 0.3,
      // 与父 run 同档:无原生思考的模型档位是注进 system 的文本,档不同=前缀不同。
      thinkingLevel: (seed.thinkingLevel as any) || 'medium',
      tools: seed.tools,
      toolChoice: 'auto',
      attachments: [],
      stream: true,
      maxTokens: FORK_JUDGE_MAX_TOKENS,
      signal: historianSignal.getStore(),
      cacheKey: sessionId, // 与主 loop 同键:同前缀必须同键(delegate 的 per-subId 分键方向相反)
    } as any);
    historianSignal.getStore()?.throwIfAborted();
    const res = await deps().brain.llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal: historianSignal.getStore() });
    historianSignal.getStore()?.throwIfAborted();
    await recordJudgeUsage(userId, seed.modelId, model, res);
    historianSignal.getStore()?.throwIfAborted();
    const out = String(res?.content || '').trim();
    if (!out) {
      log(res?.toolCalls?.length ? 'fork 判官只回了工具调用(已丢弃),回落独立判断' : 'fork 判官返回空内容,回落独立判断');
      return '';
    }
    if ((res as any)?.finishReason === 'length') { log('fork 判官产出被截断,回落独立判断'); return ''; }
    return out;
  } catch (e: any) {
    log(`fork 判官失败,回落独立判断: ${e?.message || e}`);
    return '';
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
export async function onUserRunDone(sessionId: string, userId: string, memScopeSlug?: string, forkSeed?: HistorianForkSeed): Promise<void> {
  if (!isLocal()) return;
  // 会话级互斥:上一轮维护(judge/fork/整固)还在飞 → 整轮跳过(尽力而为,下个到点轮自然补)。
  // 加锁在首个 await 之前,并发 done 只有一个能进。
  if (historianBusySessions.has(sessionId)) { log(`会话 ${sessionId.slice(0, 8)} 上一轮维护尚在进行,跳过本轮`); return; }
  if (historianBusySessions.size >= 2) return; // bounded background work; never queue user turns
  historianBusySessions.add(sessionId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Historian time budget exceeded')), 90_000);
  timer.unref?.();
  try {
    await historianSignal.run(controller.signal, () => runHistorianForSession(sessionId, userId, memScopeSlug, forkSeed));
  } catch (e: any) {
    log(`Historian skipped: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
    historianBusySessions.delete(sessionId);
  }
}

async function runHistorianForSession(sessionId: string, userId: string, memScopeSlug?: string, forkSeed?: HistorianForkSeed): Promise<void> {
  // 解析本 run 的记忆域:优先传入的 memScopeSlug;否则(外部引擎等未做激活的路径)从会话 agent_config.agentSlug
  // 兜底读——那存的是 active slug,须经 resolveMemorySlug 折叠 shareDefaultMemory 才与 run 内记忆读写同域。
  // 重注入 Historian 自己的异步上下文 → deps().brain.memory(动态本地库)读写落到该 agent 的文件夹(fire-and-forget
  // 不保证继承原 run 的 ALS,故显式重设;云端 isLocal=false 已 return)。
  const owner = await query<any[]>(`SELECT kind FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [sessionId, userId]);
  if (!owner[0] || (owner[0].kind && owner[0].kind !== 'user')) return;
  let effectiveSlug = memScopeSlug;
  if (!effectiveSlug) {
    try {
      const r = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ? LIMIT 1`, [sessionId]);
      const raw = r[0]?.agent_config;
      const cfg0 = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (cfg0?.agentSlug) {
        const def = await getAgent(String(cfg0.agentSlug)).catch(() => null);
        if (!def) return;
        effectiveSlug = resolveMemorySlug(def);
      }
    } catch { return; }
  }
  effectiveSlug ||= DEFAULT_AGENT_SLUG;
  if (!isValidSlug(effectiveSlug)) return;
  enterRunContext(userId, undefined, effectiveSlug);
  let cfg;
  try { cfg = loadSpecialAgentsConfig().historian; } catch { return; }
  if (!cfg.enabled) {
    // Explicit memories can still be maintained when transcript collection is off.
    startMemoryDream(userId, effectiveSlug, { automatic: true });
    return;
  }
  // 模型解析:用户显式配置 > admin 后台默认槽 > 对话默认(未选模型=跟随云端)。
  cfg.modelId = await resolveBackgroundModelId(cfg.modelId).catch(() => '');
  if (!cfg.modelId) return;

  try {
    // 仅用户会话；并发安全：roundN 由 done run 计数推出（幂等）。app_id/model_id/agent_config 供辅助模式讨论用。
    const skRows = await query<any[]>(
      `SELECT kind, title, summary, app_id, model_id, agent_config FROM chat_sessions WHERE id = ? LIMIT 1`,
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
    const summaryDue = due; // 摘要与标题同属 Historian 自有资产(非记忆资产):三种模式都由 judge 维护

    // 实质增量地板:自上次维护以来新增内容太少 → 跳过整次判断(避免琐碎轮重复总结 / 反复重写记忆侵蚀)。
    if (!(await enoughNewSinceLastAction(sessionId))) { log(`第 ${roundN} 轮到点但自上次维护无实质新增,跳过`); return; }

    // 辅助模式(assist):LOG/memory 不由 Historian 写,分支(branch)出后台群聊讨论交主 Agent 定夺;
    // 标题仍由 Historian 独立维护(主 Agent 没有改标题的工具,标题也非记忆资产)。
    // 首轮(roundN===1)始终走独立模式:首轮要立即出标题+初始日志,也没有可供讨论的积累。
    // chat 会话不拉辅助讨论:讨论 run 不带 preset,被空白会话锁按存值降成普通 chat 面的 run,讨论提示会以可见消息
    // 出现在用户会话里(creview 09-07 E2)。判据取会话事实 sk.agent_config(hook 否决路径不传 seed,靠 seed 会漏)。
    const sessionPreset = (() => { try { const c = typeof sk.agent_config === 'string' ? JSON.parse(sk.agent_config) : sk.agent_config; return c?.preset; } catch { return undefined; } })();
    const assistMode = cfg.mode === 'assist' && roundN > 1 && sessionPreset !== 'chat';
    // fork 模式:快照缺席(群聊/外部引擎/hook 否决路径不传 seed)→ 自动回落 independent 判断。
    const forkMode = cfg.mode === 'fork' && !!forkSeed;
    const judgeLog = logDue && !assistMode;
    const judgeMemory = memoryDue && !assistMode;
    // 自进化自动档(默认关):judge 额外提名工作笔记候选 → 展示身份 slug 的 .harness-raw.md 收件箱。
    const judgeHarness = due && !assistMode && cfg.harnessCandidates;
    log(`第 ${roundN} 轮触发(${assistMode ? '辅助模式,' : forkMode ? '分身判官,' : ''}模型 ${cfg.modelId})`);

    const transcriptSnapshot = await recentTranscript(sessionId);
    historianSignal.getStore()?.throwIfAborted();
    const transcript = transcriptSnapshot.text;
    if (!transcript.trim()) { log('无可用对话内容,跳过'); return; }

    if (titleDue || judgeLog || judgeMemory) {
      // 一次结构化判断:title / summary / log / memory_candidates 各自独立(到期才要、不需要则空)。
      // 采集刻意不看现有记忆(与 Codex Phase 1 同构:采集盲写、去重归整固),省下每轮 ~20K 字输入。
      const prevSummary = String((sk as any).summary || '').trim().replace(/\s+/g, ' ').slice(0, 600);
      // fork:先试尾部分叉判官(全上下文+缓存对齐,用会话模型);失败/超窗回落下面的 independent 路。
      let raw = forkMode
        ? await forkJudge(
            sessionId, userId, String(sk.app_id || deps().profile.appId), forkSeed!,
            buildForkJudgeMessage(cfg.prompt, titleDue, judgeLog, judgeMemory, summaryDue, judgeHarness, prevSummary),
          )
        : '';
      // fork 产出非空但解析不出 JSON(判官跑偏成长文)= 判官失败,同样回落 independent——
      // 否则本轮标题/摘要/LOG/候选全部凭空丢失(Codex 评审 08-03 Major)。
      if (raw && !parseJudgement(raw)) {
        log(`fork 判官产出无法解析为 JSON: "${raw.slice(0, 80)}",回落独立判断`);
        raw = '';
      }
      if (!raw) {
        const sys = buildJudgeSystem(cfg.prompt, titleDue, judgeLog, judgeMemory, summaryDue, judgeHarness);
        const input = prevSummary ? `${transcript}\n\n[Previous summary]\n${prevSummary}` : transcript;
        raw = (await complete('判断', cfg.modelId, sys, input, userId, 1600)).content;
      }
      historianSignal.getStore()?.throwIfAborted();
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
          historianSignal.getStore()?.throwIfAborted();
          await query(`UPDATE chat_sessions SET title = ? WHERE id = ?`, [title, sessionId]).catch((e: any) => log(`更新标题失败: ${e?.message || e}`));
          await logActivity(userId, 'title_updated', title, sessionId);
          log(`已更新标题: ${title}`);
        }
        // 会话摘要(人读,chat_sessions.summary):空串=模型裁定旧摘要仍适用,不动。
        // 活动日志只在 UPDATE 真成功后写,否则工作视图会报告不存在的更新(Codex 评审 08-03 Minor)。
        const summaryText = String((j as any).summary || '').trim().replace(/\s+/g, ' ').slice(0, 500);
        if (summaryDue && summaryText.length >= 8 && summaryText.toUpperCase() !== 'NOTHING') {
          historianSignal.getStore()?.throwIfAborted();
          const ok = await query(`UPDATE chat_sessions SET summary = ? WHERE id = ?`, [summaryText, sessionId])
            .then(() => true)
            .catch((e: any) => { log(`更新摘要失败: ${e?.message || e}`); return false; });
          if (ok) {
            await logActivity(userId, 'summary_updated', summaryText, sessionId);
            log('已更新会话摘要');
          }
        }
        if (judgeLog && okShort(logText)) {
          // LOG = 当天流水(append-only)。共享 LOG 经 brain(云端)。
          historianSignal.getStore()?.throwIfAborted();
          await deps().brain.memory.appendLogEntry(userId, logText, { signal: historianSignal.getStore() });
          await logActivity(userId, 'log_appended', logText, sessionId);
        }
        historianSignal.getStore()?.throwIfAborted();
        if (judgeMemory && candidates.length) {
          // 采集:候选进 raw 层,正典 MEMORY 只由整固步骤改写(唯一仲裁点)。
          const n = appendRawCandidates(effectiveSlug, sessionId, candidates, { anchorMessageId: transcriptSnapshot.anchorMessageId });
          if (n) {
            await logActivity(userId, 'memory_candidates', candidates.join(' | ').slice(0, 300), sessionId);
            log(`已采集 ${n} 条记忆候选进 raw 层`);
          }
        }
        if (judgeHarness) {
          const rawHc: unknown[] = Array.isArray((j as any).harness_candidates) ? (j as any).harness_candidates : [];
          const hCands = rawHc
            .map((c) => redactSecrets(String(c ?? '').replace(/\s*[\r\n]+\s*/g, '; ').trim()).slice(0, 300))
            .filter((c) => c.length >= 4 && c.toUpperCase() !== 'NOTHING')
            .slice(0, HARNESS_RAW_MAX_PER_ROUND);
          if (hCands.length) {
            // 归桶=展示身份(HARNESS.md 按 agent 本体,不折叠 shareDefaultMemory,与注入槽同源);
            // effectiveSlug/ALS 此刻都是折叠后的记忆域,不可用——从会话 agent_config 取 active slug。
            // 存储值必须过合法性闸(会话配置可塞任意串,'..' 会逃出 agentsDir——Codex P2/P3 评审 Major #1);
            // 非法/已删 agent 的候选直接丢弃,宁可丢也不错桶进默认 agent 的收件箱。
            let displaySlug = DEFAULT_AGENT_SLUG;
            let slugOk = true;
            try {
              const c0 = typeof sk.agent_config === 'string' ? JSON.parse(sk.agent_config) : sk.agent_config;
              const s = c0?.agentSlug ? String(c0.agentSlug) : '';
              if (s && s !== DEFAULT_AGENT_SLUG) {
                if (isValidSlug(s) && (await getAgent(s).catch(() => null))) displaySlug = s;
                else slugOk = false;
              }
            } catch { /* ignore */ }
            if (slugOk) {
              const n = await appendHarnessCandidates(displaySlug, sessionId, hCands).catch((e: any) => {
                log(`写工作笔记候选收件箱失败: ${e?.message || e}`);
                return 0;
              });
              if (n) {
                await logActivity(userId, 'harness_candidates', hCands.join(' | ').slice(0, 300), sessionId);
                log(`已采集 ${n} 条工作笔记候选进收件箱(${displaySlug})`);
              }
            } else {
              log('会话 agent_config.agentSlug 非法或 agent 已删,丢弃本轮工作笔记候选');
            }
          }
        }
      }
    }

    // 整固到期检查(每个到点轮跑一次;raw 空/未攒够即刻返回,开销一次文件读)。
    if (!assistMode) await maybeConsolidate(userId, effectiveSlug, cfg.modelId, sessionId);

    // 辅助讨论只跟「记忆」周期(设置里的 每 Y 轮):此前挂在 logDue||memoryDue 上,而 logDue 跟随
    // 标题的高频周期(如 标题每2轮+记忆每3轮 → 讨论在 2,3,4,6,8,9… 轮触发),用户观感即「忽隔一轮
    // 忽隔两轮」。改为仅 memoryDue 拉起讨论,LOG 在辅助模式下随记忆周期一并商议,节奏可预期。
    historianSignal.getStore()?.throwIfAborted();
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
