/**
 * 本地 Historian（Special Agent）—— 按「轮」触发，区别于云端 historian.ts 的空闲扫描。
 *
 * 一应一和 = 1 轮（= 1 个 done run）。每个用户会话 run 完成后（agentLoop done 钩子）：
 *   - 每 everyRounds 轮（周期合一,标题与 LOG/memory 同一节奏）：总结并更新会话标题 +
 *     判断是否更新用户 LOG/memory（经 brain.memory），有则写入；
 *   - 首轮（roundN===1 且 firstRoundTrigger）必触发。
 *
 * 两种工作模式（cfg.mode）：
 *   - independent（默认）：Historian 自己结构化判断并写 title/LOG/memory（memory=读-改-写整文覆盖）。
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
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { loadSpecialAgentsConfig, DEFAULT_HISTORIAN_PROMPT, type HistorianConfig } from './specialAgentsConfig.js';
import { enterRunContext } from '../seams/runContext.js';
import { getAgent, resolveMemorySlug } from '../agents/agentRegistry.js';
import { branchSession } from './sessionBranch.js';
import { createRun } from './runStore.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';

const MAX_TRANSCRIPT_CHARS = 8000;
const CHARGE_USER = false;
const MIN_NEW_CHARS = 120; // 自上次维护以来的新对话字符数地板;不足视为琐碎轮,跳过整次判断

/**
 * 构造 Historian 的结构化判断 system prompt:一次调用、输出 JSON,title/log/memory 各自独立判断。
 * customPrompt = 用户可配的「判断哲学」(留空用默认);代码强制 JSON 输出格式 + 仅含到期字段。
 * 关键:LOG(当天流水:发生了什么)与 memory(长期稳定事实/偏好,跨会话有用、绝非流水账)是**两类不同内容**,
 * 不得相同;memory 要克制,多数对话应为空。
 */
function buildJudgeSystem(customPrompt: string, wantTitle: boolean, wantLog: boolean, wantMemory: boolean, curMemory: string): string {
  const fields: string[] = [];
  if (wantTitle) fields.push('"title": a phrase of ≤16 characters in the user\'s language summarizing this conversation\'s topic, used as the session title (always provide it)');
  if (wantLog) fields.push('"log": if this conversation has an event/progress/output "worth noting for the day", write one short sentence in the user\'s language; otherwise give an empty string ""');
  if (wantMemory) {
    fields.push(
      '"memory": **full overwrite** — based on the [Current Long-Term Memory] below and this conversation, output the **complete updated long-term memory in full** ' +
      '(you may add entries, revise, or delete outdated/corrected entries; keep old entries that still hold). Only provide it when there is a real change; if nothing changed, give an empty string "". ' +
      'Memory is long-term stable information about the user themselves (identity/preferences/goals/important facts); keep it concise and itemized, and **do not put the day\'s running log into it** (that is the log).',
    );
  }
  return [
    (customPrompt && customPrompt.trim()) || DEFAULT_HISTORIAN_PROMPT,
    wantMemory ? `\n[Current Long-Term Memory]\n${curMemory.trim() || '(empty)'}` : '',
    '\nRead the conversation below and judge; output **a single JSON object** only, with the following fields:',
    '- ' + fields.join('\n- '),
    'Example: {"title":"Gradient visualization","log":"Finished first draft of donk_intro.docx","memory":"- Learning linear algebra and multivariable calculus\\n- Prefers concise, direct answers"}',
    'Give an empty string for fields that need no update. Output JSON only — no code fences, no extra text.',
  ].filter(Boolean).join('\n');
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

/** 单次轻量补全（系统提示 + transcript）。失败返回 ''(并打日志说明原因)。记 usage（默认不扣配额）。 */
async function complete(label: string, modelId: string, system: string, transcript: string, userId: string, maxTokens: number): Promise<string> {
  try {
    const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(modelId);
    const payload = await deps().brain.llm.buildProviderPayload({
      model, apiModelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: transcript }] as ChatMessage[],
      projectSource: '', temperature: 0.3, maxTokens, stream: true,
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
    return out;
  } catch (e: any) {
    log(`${label} 模型调用失败(model=${modelId}): ${e?.message || e}`);
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
  if (!cfg.enabled || !cfg.modelId) return;

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
      // memory 是「读-改-写」:把现有记忆喂给模型,让它产出更新后的完整记忆(增量或修订)。
      const curMem = judgeMemory
        ? String((await deps().brain.memory.getMemory(userId).catch(() => ({ content: '' })))?.content || '')
        : '';

      // 一次结构化判断:title / log / memory 各自独立(到期才要、不需要则空)。
      const sys = buildJudgeSystem(cfg.prompt, titleDue, judgeLog, judgeMemory, curMem);
      const raw = await complete('判断', cfg.modelId, sys, transcript, userId, 1200);
      const j = parseJudgement(raw);
      if (!j) {
        log(`判断输出无法解析为 JSON: "${raw.slice(0, 80)}"`); // 不 return:辅助讨论仍应发起
      } else {
        const title = String(j.title || '').trim().replace(/^["'《「]+|["'》」]+$/g, '').slice(0, 60);
        const logText = String(j.log || '').trim();
        const memoryDoc = String(j.memory || '').trim();
        const okShort = (s: string) => !!s && s.toUpperCase() !== 'NOTHING' && s.length >= 2 && s.length <= 400;
        log(`判断: title="${title}" log="${logText.slice(0, 30)}" memoryΔ=${memoryDoc ? `${curMem.length}→${memoryDoc.length}` : '无'}`);

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
        if (judgeMemory && memoryDoc && memoryDoc.toUpperCase() !== 'NOTHING' && memoryDoc !== curMem.trim()) {
          // memory = 整体覆盖(读-改-写)。防异常缩水:旧记忆较多而新内容骤降 → 疑似截断,弃用。
          const suspiciousShrink = curMem.trim().length > 200 && memoryDoc.length < curMem.trim().length * 0.4;
          const setMem = deps().brain.memory.setMemory;
          if (suspiciousShrink) {
            log(`记忆疑似异常缩水(${curMem.trim().length}→${memoryDoc.length}),跳过覆盖`);
          } else if (setMem) {
            try {
              await setMem(userId, memoryDoc.slice(0, 20000));
              await logActivity(userId, 'memory_updated', memoryDoc.slice(0, 300), sessionId);
              log('已更新 memory(整体覆盖)');
            } catch (e: any) { log(`写 memory 失败(服务端可能未部署 PUT /brain/memory): ${e?.message || e}`); }
          } else {
            log('当前 brain 不支持 setMemory,跳过记忆覆盖(需更新服务端)');
          }
        }
      }
    }

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
