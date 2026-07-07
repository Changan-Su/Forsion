/**
 * 服务端 agent loop（进程内异步，run 生命周期 > HTTP 连接）。
 * hydrate（chat_messages 近期消息）→ for iteration：token 流式调 LLM → 检测 tool_calls →
 * 执行工具 → 回灌 → 直到无 tool_calls；finalize 把最终 assistant 消息写回 chat_messages（共享层）。
 */
import { v4 as uuidv4 } from 'uuid';
import { deps } from '../seams/runtime.js';
import { resolveProfile } from '../seams/appProfile.js';
import type { StreamOpts, BuildPayloadOpts } from '../seams/cloudBrain.js';
import { LlmError, type ThinkingLevel, type ChatMessage, type ToolCall } from '../core/types.js';
import { publish, drain, cleanup } from './eventBus.js';
import { gateToolCall, requestApproval, type ApprovalDecision } from './approvals.js';
import { runHooks, type HookRunContext, type HookVerdict } from '../hooks/index.js';
import { enterRunContext, currentDisplayAgentSlug, setRunCwd } from '../seams/runContext.js';
import path from 'node:path';
import { agentsDir, readUserMd } from '../core/tanguHome.js';
import { getRun, updateRunStatus, appendStep, listPendingRunsForRecovery } from './runStore.js';
import { getToolDefinitions, executeTool, getToolCapabilities, type ToolContext } from '../tools/registry.js';
import type { DisplayFileItem } from '../tools/toolTypes.js';
import { loadSkillLoadout } from './skillLoadout.js';
import { loadCustomTools, type LoadedCustomTool } from '../tools/customTools.js';
import { snapshotSession } from '../sandbox/sessionSandbox.js';
import { listFilesLocal } from '../tools/fileWorkspace.js';
import {
  CONTEXT_WINDOW_TOKENS, INPUT_HARD_RATIO, INPUT_WARN_RATIO, COMPACT_TRIGGER_RATIO, FORCE_COMPACT_RATIO,
  estimateTokensRough, estimateMessagesTokens, compactContext, capToolResult, capHistoryContent, pinMessage,
} from './contextBudget.js';
import { getLatestSummary, compactSession, foldWorkingWithSummary } from './compaction.js';
import { getAgent } from '../agents/agentRegistry.js';
import { applyAgentActivation } from './agentActivation.js';
import { onUserRunDone } from './localHistorian.js';
import { normalizeImageAttachments, toImageParts } from './imageAttachments.js';
import { looksLikeToolCallText } from '../llm/textToolCalls.js';
import { runCostCeiling, isOverRunCost } from './runBudget.js';
import { runGroupChat } from './groupChat.js';
import { listPluginMetas } from '../plugins/registry.js';
import { isPluginEnabledSync } from '../plugins/settingsStore.js';
import { runAgentFilesSync } from './agentFileSync.js';

// ── 注入依赖的 lazy 别名:保持下方调用点不变(接缝装配后才会真正取到 deps)──
const resolveModelAndKey = (modelId: string) => deps().brain.llm.resolveModelAndKey(modelId);
const buildProviderPayload = (opts: BuildPayloadOpts) => deps().brain.llm.buildProviderPayload(opts);
const streamProviderCompletion = (opts: StreamOpts) => deps().brain.llm.streamProviderCompletion(opts);
const canConsumeTokenPoints = (userId: string, amount: number) => deps().billing.canConsumeTokenPoints(userId, amount);
const consumeTokenPoints = (userId: string, amount: number) => deps().billing.consumeTokenPoints(userId, amount);
const calculateCost = (modelId: string, tin: number, tout: number, model?: any, cached?: number) =>
  deps().billing.calculateCost(modelId, tin, tout, model, cached);
const logApiUsage = (...args: any[]) => (deps().billing.logApiUsage as any)(...args);
const getUserById = (id: string) => deps().brain.users.getUserById(id);
const getMemory = (userId: string) => deps().brain.memory.getMemory(userId);

const abortControllers = new Map<string, AbortController>();

// 运行时转向(steer，类 Codex):用户在 run 跑动期间发来的消息按 runId 暂存，在「迭代边界」注入到
// 当前 run（而非另起新 run，也不是等整个 run 跑完）。仅「活跃 run」(已注册 AbortController = 已进循环)
// 接受注入；排队中的 run 还没 AC → 拒收（前端回退起新 run）。
interface SteerMsg { id: string; content: string; attachments?: any[] }
const steerQueue = new Map<string, SteerMsg[]>();

/** 入队一条转向消息；run 非活跃返回 false（前端据此回退 startRun）。 */
export function enqueueSteer(runId: string, msg: SteerMsg): boolean {
  if (!abortControllers.has(runId)) return false;
  const q = steerQueue.get(runId);
  if (q) q.push(msg);
  else steerQueue.set(runId, [msg]);
  return true;
}
function drainSteer(runId: string): SteerMsg[] {
  const q = steerQueue.get(runId);
  if (!q || !q.length) return [];
  steerQueue.delete(runId);
  return q;
}

// 同会话 run 串行化：每个 session 同一时刻至多一个活跃 run，其余 FIFO 排队，活跃 run 跑完
// （含 abort/失败）后由 advanceQueue 起下一个。保证共享的会话级 kernel/工作区不被并发 run
// 交错写坏，同时不丢用户消息、上下文连贯。
// TODO(multi-instance): 这三个 map 是进程内单例，隐含「一个 session 由单实例独占」。
// 水平扩展需 session 亲和路由 + Redis（见 eventBus.ts 的 pub/sub 接缝注释）。
const sessionActive = new Map<string, string>(); // sessionId -> 活跃 runId
const sessionQueue = new Map<string, string[]>(); // sessionId -> 排队 runId（FIFO）
const runSession = new Map<string, string>(); // runId -> sessionId（abort/清理反查）

/** 入队一个 run：空闲则立刻起，否则排队等当前 run 跑完。同步 check-and-set（set 前无 await），单线程下无竞态。 */
export function enqueueRun(sessionId: string, runId: string): void {
  runSession.set(runId, sessionId);
  if (!sessionActive.has(sessionId)) {
    sessionActive.set(sessionId, runId);
    startRun(runId);
  } else {
    const q = sessionQueue.get(sessionId);
    if (q) q.push(runId);
    else sessionQueue.set(sessionId, [runId]);
    // 让已连接的 SSE 客户端看到「排队中」（onStatus 能收任意 status）；fire-and-forget。
    void publish(runId, 'status', { state: 'queued' });
  }
}

/** 非阻塞启动一个 run（不 await）。AbortController 同步注册，保证早到的 abort 也生效。仅由 enqueueRun/advanceQueue 调用。 */
export function startRun(runId: string): void {
  const ac = new AbortController();
  abortControllers.set(runId, ac);
  dispatchRun(runId, ac).catch((err) => {
    console.error(`[agent-core] runLoop crashed run=${runId}:`, err);
    // 兜底：runLoop 在进入 try/finally 之前就抛（如 getRun 抛 DB 错）时，finally 不会跑，
    // 仍需清理并推进队列，否则该 session 永久卡住。用 active===runId 守卫避免与 finally 双重推进。
    const sid = runSession.get(runId);
    abortControllers.delete(runId);
    runSession.delete(runId);
    if (sid && sessionActive.get(sid) === runId) advanceQueue(sid);
  });
}

/** 当前 run 结束后推进同会话队列：起下一个排队 run（无则清掉 active 标记）。 */
function advanceQueue(sessionId: string): void {
  sessionActive.delete(sessionId);
  const q = sessionQueue.get(sessionId);
  if (!q || !q.length) {
    sessionQueue.delete(sessionId);
    return;
  }
  const next = q.shift()!;
  if (!q.length) sessionQueue.delete(sessionId);
  sessionActive.set(sessionId, next);
  startRun(next);
}

/**
 * 分流:有 engineId 且本形态支持(hostExec)且引擎已注册 → 委托外部 agent 引擎(ACP);否则走 Tangu 自有 loop。
 * 双取 run(此处 + runLoop 内)是有意为之:保持 runLoop 签名与缺失处理不变,getRun 为索引点查,成本可忽略。
 */
async function dispatchRun(runId: string, ac: AbortController): Promise<void> {
  try {
    const run = await getRun(runId);
    if (run) {
      const input = typeof run.input === 'string' ? safeParse(run.input) : run.input || {};
      const engineId: string | undefined = input?.agentConfig?.engineId;
      const profile = resolveProfile((run as any).app_id) ?? deps().profile;
      const engines = deps().engines;
      // 红线:未声明 hostExec 的 profile(云端形态)→ engines 不注入/为空 → 一律回落 runLoop。
      if (engineId && profile.capabilities.hostExec && engines?.has(engineId)) {
        return await externalEngineLoop(runId, ac, run, engineId);
      }
    }
  } catch (e) {
    console.warn(`[agent-core] dispatchRun 回退 runLoop run=${runId}:`, (e as any)?.message || e);
  }
  return runLoop(runId, ac);
}

/**
 * 外部引擎 run:把整个 turn 委托给 deps().engines(ACP 客户端),复用 eventBus/审批/落库/队列接缝。
 * 镜像 runLoop 的 finalize/catch/finally(见本文件末);不做 flush(外部 agent 直接在 host cwd 操作,
 * 非 Tangu 会话沙箱)、不接 steer(ACP 无对应语义)。
 */
async function externalEngineLoop(runId: string, ac: AbortController, run: any, engineId: string): Promise<void> {
  const sessionId = run.session_id;
  const userId = run.user_id;
  const modelId = run.model_id || '';
  const assistantId = run.assistant_message_id;
  const input = typeof run.input === 'string' ? safeParse(run.input) : run.input || {};
  const agentConfig = input.agentConfig || {};
  const engines = deps().engines!;
  let finalContent = '';
  try {
    enterRunContext(userId, runId);
    await updateRunStatus(runId, 'running');
    await publish(runId, 'status', { state: 'running' });
    const result = await engines.run({
      engineId,
      runId,
      sessionId,
      userId,
      modelId,
      engineModelId: agentConfig.engineModelId,
      message: String(input.message || ''),
      attachments: input.attachments || [],
      cwd: typeof agentConfig.cwd === 'string' && agentConfig.cwd ? agentConfig.cwd : undefined,
      signal: ac.signal,
      publish: (type: string, payload: any) => {
        void publish(runId, type, payload);
      },
      requestApproval: (preview: string, toolCall: ToolCall): Promise<ApprovalDecision> =>
        requestApproval(runId, toolCall, preview, ac.signal),
    });
    finalContent = result.content || '';
    await finalizeAssistantMessage(
      assistantId, sessionId, modelId, finalContent, result.reasoning || '', result.toolCalls || [], result.toolResults || [],
    );
    await drain(runId);
    await publish(runId, 'done', { content: finalContent });
    await updateRunStatus(runId, 'done', { result: { content: finalContent } });
    // 外部引擎 run 完成同样触发 Historian。此路径没做 agent 激活 → 不传 slug,
    // 由 onUserRunDone 从会话 agent_config 兜底解析并折叠记忆域。
    void onUserRunDone(sessionId, userId);
  } catch (err: any) {
    const aborted = err?.name === 'AbortError' || ac.signal.aborted;
    const status = aborted ? 'aborted' : 'failed';
    const msg = aborted ? 'aborted' : err?.message || String(err);
    console.error(`[agent-core] external engine run ${runId} ${status}:`, msg);
    if (finalContent.trim()) {
      await finalizeAssistantMessage(assistantId, sessionId, modelId, finalContent, '', [], []).catch(() => {});
    }
    await publish(runId, 'error', { error: msg, aborted, content: finalContent }).catch(() => {});
    await drain(runId).catch(() => {});
    await updateRunStatus(runId, status, { error: msg }).catch(() => {});
  } finally {
    abortControllers.delete(runId);
    runSession.delete(runId);
    advanceQueue(sessionId);
    setTimeout(() => cleanup(runId), 30_000);
  }
}

/** 请求中止某个 run。活跃 run 走 AbortController（finally 会推进队列）；排队中的 run 直接移出队列并标终态。 */
export function abortRun(runId: string): void {
  const ac = abortControllers.get(runId);
  if (ac) {
    ac.abort();
    return;
  }
  // 非活跃 → 可能在排队：移出队列并终结。否则它会被 promote 跑起来，破坏 admin 的「abort 该 session 所有在飞 run」。
  const sid = runSession.get(runId);
  if (!sid) return;
  const q = sessionQueue.get(sid);
  if (q) {
    const i = q.indexOf(runId);
    if (i >= 0) q.splice(i, 1);
    if (!q.length) sessionQueue.delete(sid);
  }
  void terminalizeQueuedAbort(runId);
}

/** 排队中被取消的 run：标 aborted + 补一条终态事件，让 SSE/刷新能看到结束。 */
async function terminalizeQueuedAbort(runId: string): Promise<void> {
  runSession.delete(runId);
  try {
    await updateRunStatus(runId, 'aborted', { error: 'aborted' });
    await publish(runId, 'error', { error: 'aborted', aborted: true });
    await drain(runId);
  } catch (e) {
    console.warn('[agent-core] terminalizeQueuedAbort failed:', e);
  } finally {
    setTimeout(() => cleanup(runId), 30_000);
  }
}

/** 进程重启自愈：把 DB 里仍 queued/running 的 run 按 session 分组、created_at 顺序重新入队。
 *  必须在 failStaleRuns() 之后调用（避免捡到即将被标 failed 的陈旧行）。返回重入队数量。 */
export async function recoverQueuedRuns(): Promise<number> {
  const rows = await listPendingRunsForRecovery();
  for (const r of rows) enqueueRun(r.session_id, r.id);
  return rows.length;
}

/** 中止所有在飞 run(dispose/卸载用)。各 run 的 finally 会自行清理 + 推进队列。 */
export function abortAllRuns(): void {
  for (const ac of abortControllers.values()) ac.abort();
}

/** 本进程在飞 run 数(/health 上报用,worker 模式供 Forsion 调度面板展示)。 */
export function activeRunCount(): number {
  return abortControllers.size;
}

const HYDRATE_MAX = 50;
const HYDRATE_BLOCK = 10; // 窗口起点按块对齐:跨 run 前缀仅每 ~5 个 run 移动一次,而非逐 run 滑动(缓存友好)

/**
 * 载入近期会话历史(时间正序),跳过空内容的 assistant 行避免 provider 拒绝。
 *  - 窗口起点按 HYDRATE_BLOCK 对齐(替代逐条滑动的 LIMIT 50——那会让长会话每个新 run 前缀必断);
 *  - 单条超长内容确定性截断(防被巨型消息毒化的会话永久不可用;同一条消息每次截出相同字节);
 *  - 仅**最新带图的 user 消息**把 content 重建成 [text, image_url...] parts(对齐 Hermes 的
 *    strip_historical_media:旧图不重发,避免多 MB base64 每轮搭车),loop 不再单独注入附件。
 */
async function hydrateHistory(sessionId: string, excludeMessageId: string): Promise<ChatMessage[]> {
  const n = await deps().state.countSessionMessages(sessionId);
  const start = n > HYDRATE_MAX ? Math.ceil((n - HYDRATE_MAX) / HYDRATE_BLOCK) * HYDRATE_BLOCK : 0;
  // 显式 LIMIT(=窗口剩余条数)而非裸 OFFSET:SQLite 不允许无 LIMIT 的 OFFSET(PG 允许);
  // 取 [start, n) 区间,n/start 已知,两方言皆合法。
  const rows = await deps().state.listSessionMessagesWindow(sessionId, Math.max(0, n - start), start);
  // 压缩检查点：见 session_summaries 则丢弃 through_timestamp 及之前的消息，开头注入一条摘要。
  // fail-safe：无检查点 / 读失败 / 行缺 timestamp(worker) → through=0，行为与未压缩完全一致。
  const checkpoint = await getLatestSummary(sessionId);
  const through = checkpoint?.throughTimestamp || 0;
  const out: ChatMessage[] = [];
  let lastUserWithImages = -1; // out 中最新带图 user 消息的下标
  let lastUserImages: ReturnType<typeof normalizeImageAttachments> = [];
  for (const r of rows) {
    if (r.id === excludeMessageId) continue;
    if (through > 0 && (Number(r.timestamp) || 0) <= through) continue;
    const role = r.role === 'model' ? 'assistant' : r.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const content = r.content || '';
    // 跳过空内容的 assistant 行（历史里以 tool_calls 收尾的轮次，无文本；空 assistant 会被部分 provider 拒绝）
    if (role === 'assistant' && !content.trim()) continue;
    out.push({ role, content: capHistoryContent(content) } as ChatMessage);
    if (role === 'user' && r.attachments) {
      const imgs = normalizeImageAttachments(r.attachments);
      if (imgs.length) {
        lastUserWithImages = out.length - 1;
        lastUserImages = imgs;
      }
    }
  }
  if (lastUserWithImages >= 0) {
    const m = out[lastUserWithImages] as any;
    m.content = toImageParts(m.content, lastUserImages);
  }
  // 图片物化在前(用 out 内下标)、摘要 unshift 在后,避免下标错位。
  if (checkpoint && through > 0) {
    out.unshift({ role: 'system', content: '## Compacted Summary of Earlier Conversation\n' + checkpoint.summary } as ChatMessage);
  }
  return out;
}

async function runLoop(runId: string, ac: AbortController): Promise<void> {
  const run = await getRun(runId);
  if (!run) {
    // run 行不存在（被删/异常）：仍要推进队列，否则该 session 永久卡住（这条早返回不走 finally）。
    const sid = runSession.get(runId);
    abortControllers.delete(runId);
    runSession.delete(runId);
    if (sid) advanceQueue(sid);
    return;
  }

  const sessionId = run.session_id;
  const userId = run.user_id;
  // 接缝①(G1):本 run 的 profile 按行内 app_id 解析;不匹配(如升级前遗留行)回退本进程 profile。
  const profile = resolveProfile((run as any).app_id) ?? deps().profile;
  const appId = profile.appId;
  // 多租户接缝:把本 run 的 {userId, runId} 注入异步子树,供 worker 的 brain/state 适配器取 per-dispatch token。
  // microserver/standalone 的 brain/state 不读此上下文,无副作用。
  enterRunContext(userId, runId);
  const modelId = run.model_id || '';
  const input = typeof run.input === 'string' ? safeParse(run.input) : run.input || {};
  const agentConfig = input.agentConfig || {};
  // standalone/desktop host 的 Agent 文件必须先与云端镜像对齐，再从本地激活。headless worker 没有
  // 桌面设置页去触发 /agent/sync；若跳过此步，云端人格虽可经 brain.agents 兜底加载，Library/ 却仍为空。
  // 同步器按 manifest mtime 幂等，未变化时只做清单比较；失败软降级，不阻断对话。
  const agentFiles = deps().brain.agentFiles;
  if (profile.capabilities.hostExec && agentConfig.agentSlug && agentFiles) {
    await runAgentFilesSync(agentFiles, userId, { onlySlug: String(agentConfig.agentSlug) }).catch((e: any) => {
      console.warn('[agent-core] pre-run agent files sync failed:', e?.message || e);
    });
  }
  // Normal Agent 激活:会话 agent_config.agentSlug → 合并 agent 定义里「会话未显式覆盖」的字段。
  // 本地形态读 ~/.tangu/agents;云端 worker 本地目录为空 → applyAgentActivation 经 brain.agents 兜底水合。
  // 不存在/读失败不阻断 run。模型覆盖由客户端在激活时写入会话 model_id。
  // 会话身份兜底/固化(在人格激活之前):run 未带 agentSlug → 从会话存的 agent_config 补
  // (老客户端/其他发起入口);run 带了而会话没存 → 把 slug 写回会话(只补这一个键,不动其余)。
  // 否则「会话生效的 agent」只活在前端易变状态里:前后轮可能换人、Historian 辅助讨论等
  // 后台消费方也解析不到正确的讨论对象。
  try {
    const rawStored = await deps().state.getAgentConfig(sessionId);
    const stored = rawStored ? (typeof rawStored === 'string' ? JSON.parse(rawStored) : rawStored) : null;
    if (!agentConfig.agentSlug && stored?.agentSlug) {
      agentConfig.agentSlug = stored.agentSlug;
    } else if (agentConfig.agentSlug && stored?.agentSlug !== agentConfig.agentSlug) {
      // 写穿(不只补空):run 带的 slug 是前端「此刻生效」的真值(显式选择都会同步 PUT),
      // 存值缺失或不一致(如曾被竞速污染成默认 agent)都以 run 为准纠偏。
      await deps().state.setAgentConfig(
        sessionId,
        JSON.stringify({ ...(stored || {}), agentSlug: agentConfig.agentSlug }),
      );
    }
  } catch { /* 兜底失败不阻断 run */ }

  const { activeAgentSlug, memScopeSlug } = await applyAgentActivation(
    agentConfig,
    userId,
    getAgent,
    deps().brain.agents,
  );
  // 把激活的 agent slug 穿透进 run 上下文:本地记忆层(remember/log_event/Historian)据此落到
  // ~/.tangu/agents/<slug>/;未选/无效 slug → 默认 agent。enterWith 覆盖整个异步子树。
  // memScopeSlug=共用默认时落 DEFAULT,否则该 agent 自己——保证「每个 agent 只写自己的(或显式共用默认的)」。
  enterRunContext(userId, runId, memScopeSlug, activeAgentSlug);
  // 默认 90(原 20):重试型模型/多步任务很容易把少量轮数耗光被迫收尾;可经会话级 agentConfig.maxIterations
  // (桌面/TUI 的 /loop 指令)调节,安全上限 200 防失控。
  const maxIterations = Math.min(Math.max(1, agentConfig.maxIterations || 90), 200);
  // 文本工具调用「无法解析」的纠正重试预算:模型把工具调用当正文吐(原生 tool_calls 空、
  // 文本兜底也没解出来)时,回灌一次纠正提示让它改用原生函数调用,而非静默收尾。
  const MAX_TOOLCALL_RECOVERY = 2;
  let toolCallRecoveryUsed = 0;
  const thinkingLevel: ThinkingLevel = agentConfig.thinkingLevel || 'off';
  const attachments = input.attachments || [];
  // host-exec（TUI/桌面本机模式）注入：execMode/cwd/approvalMode 只经 per-run agentConfig 传入。
  // 缺省 sandbox + full-auto → microserver/standalone-server/worker 行为零变化（审批仅 host 激活）。
  // 能力闸门(红线②/④):未声明 hostExec 的 profile(云端形态)一律强制回 sandbox,杜绝云端拿到真实 FS/shell。
  const execMode: 'sandbox' | 'host' =
    agentConfig.execMode === 'host' && profile.capabilities.hostExec ? 'host' : 'sandbox';
  const cwd: string | undefined =
    typeof agentConfig.cwd === 'string' && agentConfig.cwd ? agentConfig.cwd : undefined;
  setRunCwd(cwd); // 项目级技能 <cwd>/.forsion/skills 扫描据此(host 才有 cwd)
  const approvalMode: 'readonly' | 'auto-edit' | 'full-auto' =
    agentConfig.approvalMode || (execMode === 'host' ? 'auto-edit' : 'full-auto');
  // 计划模式(类 Claude plan mode):工具集收敛为只读 + exit_plan_mode(toolRegistry 集中过滤),
  // custom/MCP 工具整体跳过;run 级冻结——批准退出后下一轮 run 才拿到完整工具集。
  const planMode = !!agentConfig.planMode && profile.capabilities.hostExec;

  // —— Lifecycle Hooks 派发上下文（host-only；云端因 hostExec:false 在 runHooks 顶部即空判定，绝不 spawn）——
  const hookCtx = (): HookRunContext => ({ profile, execMode, cwd, sessionId, runId, agentSlug: activeAgentSlug, signal: ac.signal });
  const hookParseArgs = (s: string): any => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
  /** 把 hook 的 additionalContext / systemMessage 拼成一段可注入文本（无则空串）。 */
  const hookContextText = (v: HookVerdict): string =>
    [...v.additionalContext, ...v.systemMessages.map((m) => `⚠ ${m}`)].join('\n\n').trim();

  // 会话级沙箱：工作区/容器/kernel 按 (user, session) 跨消息常驻（懒 hydrate、空闲 TTL 回收）。
  // 文件工具与 run_python 都在本地操作（首次触发懒 hydrate），run 末按 sha256 diff 选择性回写 Penzor，
  // 沙箱保持温——避免每条消息全量 hydrate/snapshot 打远程 OSS（cn-beijing 单次往返 ~1-2s）。
  const sessKey = { userId, appId, sessionId };
  let flushed = false;
  const flush = async () => {
    if (flushed) return;
    flushed = true;
    try {
      const changed = await snapshotSession(sessKey);
      if (changed.length) console.log(`[agent-core] run=${runId} snapshot ${changed.length} file(s) → workspace`);
    } catch (e) {
      console.warn('[agent-core] session snapshot failed:', e);
    }
  };

  // 累加器提到 try 外:abort/失败时 catch 仍能看见,用于把「已停止」的部分助手轮次落库(否则整轮丢失,
  // 用户聊天记录里凭空消失,后续 run 也读不到)。运行时转向(steer)也复用它们做迭代边界的回合切分。
  let finalContent = '';
  let finalReasoning = '';
  /** 把一段正文追加进终稿(空段 no-op)。finalize 只写 finalContent —— 中间迭代的 preamble
   *  正文(模型「先说话、再调工具」)必须经此累积,否则落库时只剩末轮收尾词,已流式给用户
   *  看过的话会凭空消失(实例:正文被一句 "NOTHING" 顶掉)。 */
  const appendFinal = (text: string): void => {
    const t = String(text || '').trim();
    if (!t) return;
    finalContent = finalContent.trim() ? `${finalContent.trimEnd()}\n\n${t}` : t;
  };
  const allToolCalls: ToolCall[] = [];
  const allToolResults: any[] = [];
  // agent 在对话区展示给用户的文件(display_file/generate_image/表情包);函数级声明,使 catch(中止)路径也能持久化。
  const pendingDisplayFiles: DisplayFileItem[] = [];
  // 当前正在累积的助手消息 id;steer 注入时 finalize 当前段、改用新 id 续接下一段(见迭代循环)。
  let currentAssistantId = run.assistant_message_id || uuidv4();

  try {
    await updateRunStatus(runId, 'running');
    await publish(runId, 'status', { state: 'running' });

    // 群聊模式(Group Chat):≥2 个 Normal Agent 轮流发言 —— 走独立编排,不进下方单 agent 装载。
    // gate 在 capabilities.groupChat(host baseline 恒 true;云端 app 经 manifest opt-in)—— 纯编排无 host
    // 访问,内部 agent 仍按 execMode=sandbox 过滤工具,不破 hostExec 红线。云端参与者用 inline groupTempAgents
    // (getAgent 本地文件在云端拿不到,优雅降级)。在 try 内 return → runLoop 的 finally 仍跑(flush +
    // advanceQueue + cleanup),runGroupChat 自管终态(done/failed/aborted),不碰会话队列。
    if (agentConfig.groupChat && profile.capabilities.groupChat) {
      await runGroupChat({
        runId, sessionId, userId, appId, modelId, execMode, cwd, profile, agentConfig,
        message: input.message ? String(input.message) : '',
        userMessageId: input.userMessageId,
        attachments,
        signal: ac.signal,
      });
      // 群聊 run 也按轮触发 Historian(标题/LOG 维护)——原先此分支提前 return,群聊会话永远没有标题维护。
      // Historian 内部只数 done run 且有实质增量地板,失败/中止场景自然无害。
      void onUserRunDone(sessionId, userId, memScopeSlug);
      return;
    }

    const { model, apiKey, baseUrl, apiModelId } = await resolveModelAndKey(modelId);

    // 入站预算闸门(Hermes 式窗口相对预算;2026-06-10 的 77 万 token 事故防线):
    // 估算超窗口 50% 直接失败(消息不落库,会话不被毒化),超 25% 放行但发警告事件。
    if (input.message) {
      const inputTokens = estimateTokensRough(String(input.message));
      if (inputTokens > CONTEXT_WINDOW_TOKENS * INPUT_HARD_RATIO) {
        const msg =
          `输入过大:约 ${inputTokens.toLocaleString()} tokens,超过上下文窗口(${CONTEXT_WINDOW_TOKENS.toLocaleString()})的 ${Math.round(INPUT_HARD_RATIO * 100)}%。` +
          '请把大段材料保存为文件后让 agent 用工具读取,不要整段粘贴。';
        await publish(runId, 'error', { error: 'input_too_large', detail: msg });
        await drain(runId);
        await updateRunStatus(runId, 'failed', { error: 'input_too_large' });
        return;
      }
      if (inputTokens > CONTEXT_WINDOW_TOKENS * INPUT_WARN_RATIO) {
        await publish(runId, 'status', {
          warning: 'large_input',
          estTokens: inputTokens,
          detail: `输入约 ${inputTokens.toLocaleString()} tokens(窗口的 ${Math.round((inputTokens / CONTEXT_WINDOW_TOKENS) * 100)}%),每轮迭代都会全量重发,建议改用文件。`,
        });
      }
    }

    // user 消息在此（run 真正开始时）才落库——而非 POST 时——保证排队 run 的 user 消息时间戳
    // 排在上一个 run 的 assistant 之后，hydrate/显示顺序才正确。幂等（ON CONFLICT DO NOTHING）。
    // 纯附件消息（文本为空,如微信发图）也必须落库——否则附件随消息一起蒸发,模型永远看不到图。
    if (input.userMessageId && (input.message || attachments.length)) {
      await deps().state.insertUserMessage({
        id: input.userMessageId,
        sessionId,
        content: String(input.message || ''),
        modelId,
        attachments: Array.isArray(attachments) && attachments.length ? attachments : null,
      });
    }

    const history = await hydrateHistory(sessionId, run.assistant_message_id || '');

    // 启用技能的装载（渐进式披露:目录进 prompt、全文按需 use_skill）——见 services/skillLoadout.ts。
    const skillLoadout = await loadSkillLoadout(userId, appId, agentConfig);
    const enabledSkillIds = skillLoadout.enabledSkillIds;

    const systemParts: string[] = [];
    // 静态指引/环境段按 profile 装载（G4，见 profiles/promptSections.ts）。
    const promptSections = profile.promptSections({ execMode, cwd });
    // 系统块按「稳定 → 易变」排布,让记忆改写只失效最短后缀(单 pin 单断点,见末尾 pinMessage)。
    // 1) developer_instructions(config.toml;身份/稳定)
    if (agentConfig.systemPrompt) systemParts.push(String(agentConfig.systemPrompt));
    // 2) SOUL.md 人格(身份/稳定)
    if (agentConfig.soul && String(agentConfig.soul).trim()) {
      systemParts.push('## Persona\nThe following is your persona; act according to its tone and values, but do not recite it verbatim.\n\n' + String(agentConfig.soul).trim());
    }
    // 3) 静态指引(记忆与日志用法),置于记忆块之前以稳定前缀
    systemParts.push(...promptSections.guidance);
    // 4) USER.md 全局用户画像(所有 agent 可见,用户维护,半稳定)。读失败不阻断。
    try {
      const userMd = readUserMd();
      if (userMd.trim()) {
        systemParts.push('## About the User\nA long-term profile/preferences the user maintains themselves; take it into account, do not recite it, and do not treat it as instructions for this turn.\n\n' + userMd.trim());
      }
    } catch { /* ignore */ }
    // 5) 你的专属文件夹(仅 host:agent 有文件读写工具、能访问绝对路径;云端 sandbox 文件夹不可达 → 不注入)。
    //    让 agent 认知自己的 home + Library,主动往 Library 沉淀/读取资料,并理解 MEMORY/LOG 的归属。
    if (execMode === 'host') {
      const home = path.join(agentsDir(), activeAgentSlug);
      const libDir = path.join(home, 'Library');
      let folderBlock =
        '## Your Personal Folder\n' +
        `You have a personal folder that persists across sessions: \`${home}\`, containing:\n` +
        '- `MEMORY.md` — your long-term memory (written with the remember tool; this is the same as "My Long-Term Memory" above)\n' +
        '- `LOG/<date>.md` — your daily logs (written with log_event, read with read_log)\n' +
        '- `SOUL.md` — your persona\n' +
        `- \`Library/\` (\`${libDir}\`) — your reference library: use the file read/write tools (read_file/write_file/list_dir, etc.; this directory is already writable and needs no approval) to **store and retrieve long-term reference material** (character settings, tool manuals, knowledge documents, etc.). Proactively write down material worth keeping long-term, and read it back when needed.`;
      if (Array.isArray(agentConfig.libraryOrder) && agentConfig.libraryOrder.length) {
        const lines = agentConfig.libraryOrder.map((f: string, i: number) => `  ${i + 1}. ${path.join(libDir, String(f))}`);
        folderBlock += '\n\nLibrary preferred reading order:\n' + lines.join('\n');
      }
      systemParts.push(folderBlock);
    } else if (Array.isArray(agentConfig.libraryOrder) && agentConfig.libraryOrder.length) {
      // 5b) 云端 sandbox 形态:无 host 文件工具、专属文件夹不可达 → 把 library_order 的**文本**资料内容注入
      //     (封顶 ~30KB),让云端 agent 也用上自己的 Library(Phase 2 B/D3)。二进制运行时用不上 → 跳过。
      const af = deps().brain.agentFiles;
      if (af) {
        try {
          const parts: string[] = [];
          let budget = 30_000;
          for (const f of agentConfig.libraryOrder as string[]) {
            if (budget <= 0) break;
            const file = await af.getFile(userId, activeAgentSlug, `Library/${String(f)}`).catch(() => null);
            if (!file || file.deleted || file.isBinary || !file.content) continue;
            const body = file.content.slice(0, budget);
            budget -= body.length;
            parts.push(`### ${f}\n${body}`);
          }
          if (parts.length) systemParts.push('## Your Library (reference)\nLong-term reference material you maintain; use it as context.\n\n' + parts.join('\n\n'));
        } catch (e) { console.warn('[agent-core] cloud library inject failed:', e); }
      }
    }
    // 6) 本 agent 自己的长期记忆(经 ALS 作用域读 ~/.tangu/agents/<slug>/MEMORY.md;最易变,放最后)。读失败不阻断。
    try {
      const mem = await getMemory(userId);
      if (mem.content?.trim()) {
        systemParts.push('## My Long-Term Memory\nThis is the memory you have accumulated across sessions (experiences / what you know about the user); take it into account, do not recite it.\n\n' + mem.content.trim());
      }
    } catch (e) {
      console.warn('[agent-core] load agent memory failed:', e);
    }
    // 7/8) 技能目录 + 环境段(environment 在技能段后,保留原相对次序)
    systemParts.push(...skillLoadout.sections);
    systemParts.push(...promptSections.environment);

    // 8b) host:注入工作区(cwd)顶层文件清单,让 agent 主动认知现有文件(修「工作区文件意识弱」)。
    //     ephemeral——随系统块每 run 重建,绝不落库。sandbox/云端不在此预拉(保留懒 hydrate),靠环境段提示按需 list_files。
    if (execMode === 'host') {
      try {
        const listing = await listFilesLocal(cwd || process.cwd(), '/');
        if (listing && listing !== '(empty directory)') {
          const lines = listing.split('\n');
          const shown = lines.slice(0, 60).join('\n') + (lines.length > 60 ? `\n… (+${lines.length - 60} more)` : '');
          systemParts.push(`## Files in the Working Directory\nTop-level contents of \`${cwd || process.cwd()}\` right now (use list_dir/read_file to go deeper):\n\n${shown}`);
        }
      } catch { /* 列目录失败不阻断 run */ }
    }

    // 9) 插件:已启用且带 promptSection 的插件注入各自系统提示片段(如表情包清单)。放在环境段后,
    //    随插件内容(如表情库)变化只失效最短后缀。读失败不阻断 run。
    for (const p of listPluginMetas()) {
      if (!p.promptSection || !isPluginEnabledSync(p.id)) continue;
      try {
        const sec = await p.promptSection({ slug: activeAgentSlug, userId, execMode });
        if (sec && sec.trim()) systemParts.push(sec.trim());
      } catch (e) { console.warn(`[agent-core] plugin ${p.id} promptSection failed:`, e); }
    }

    // —— SessionStart / UserPromptSubmit hooks：把 additionalContext 注入系统提示（host-only；云端 no-op）——
    // 首轮(history 无助手消息)视作 SessionStart；每个 run(=一次用户提交)都触发 UserPromptSubmit（否决在 routes/runs.ts）。
    {
      const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
      const promptText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
      if (!history.some((m) => m.role === 'assistant')) {
        const sv = await runHooks('SessionStart', { source: 'startup', session_id: sessionId, run_id: runId, cwd, agent_slug: activeAgentSlug }, hookCtx());
        const t = hookContextText(sv);
        if (t) systemParts.push(t);
      }
      const uv = await runHooks('UserPromptSubmit', { prompt: promptText, session_id: sessionId, run_id: runId, cwd, agent_slug: activeAgentSlug }, hookCtx());
      if (uv.block) {
        // 否决本次提交：不跑模型，直接以 hook 原因收尾（同一次触发即含否决+注入，避免在路由层重复触发同一 hook）。
        const reason = `⛔ Hook 拦截了本次提交：${uv.blockReason || 'UserPromptSubmit hook 阻止'}`;
        await finalizeAssistantMessage(currentAssistantId, sessionId, modelId, reason, '', [], [], []);
        await drain(runId);
        await publish(runId, 'done', { content: reason });
        await updateRunStatus(runId, 'done', { result: { content: reason } });
        void onUserRunDone(sessionId, userId, memScopeSlug);
        return;
      }
      const ut = hookContextText(uv);
      if (ut) systemParts.push(ut);
    }

    // 计划模式指引(追加在最后,不动既有段落的字节序;planMode 是 run 级配置,同 run 内稳定)。
    if (planMode) {
      systemParts.push(
        '## Plan Mode\n' +
          'You are currently in plan mode: you have only read-only tools and **cannot** write files / run commands / call external tools. Process:\n' +
          '1. Research thoroughly using read-only tools (read_file/search_files/glob_files/browser_search/web_search, etc.)\n' +
          '2. When requirements are ambiguous or trade-offs are needed, use ask_user to clarify\n' +
          '3. Produce a complete implementation plan (goals/steps/files involved/how to verify), then call exit_plan_mode to submit for approval\n' +
          '4. Do not claim any change is "done" before the user approves; if asked to revise, refine the plan and resubmit',
      );
    }

    const workingMessages: ChatMessage[] = [];
    if (systemParts.length) {
      // 注入的上下文块(系统提示/记忆/技能/环境)锚定:compactContext 永不折叠它(借 Codex reference-context;
      // 把「靠位置保护」升级为「显式 pin」,日后消息排序变化也不丢注入上下文)。
      workingMessages.push(pinMessage({ role: 'system', content: systemParts.join('\n\n') } as ChatMessage));
    }
    // 开发者「显示 system prompt」:把本 run 组装好的系统提示原样作事件发出(仅 agentConfig.debugSystemPrompt)。
    // 纯只读文本,无 host 访问 → cloud/standalone/desktop 同一路径安全;前缀缓存不受影响(不改 workingMessages)。
    if (agentConfig.debugSystemPrompt && systemParts.length) {
      await publish(runId, 'system_prompt', { content: systemParts.join('\n\n') });
    }
    workingMessages.push(...history);

    // /skill 点名技能(参考 Hermes 的「指针+按需加载」):强指令拼到**尾部 user 消息**,正文由模型
    // 按需 use_skill 取回、作为工具结果落对话尾部。不进 system → /skill 轮不改 system 前缀字节,前缀
    // 缓存照常命中(旧做法把正文塞 system,/skill 轮整段前缀 miss)。同图片回流的「尾部追加」策略。
    if (skillLoadout.requested.length) {
      const directive =
        '## Designated Skills for This Turn (must use)\n' +
        'The user has named the following skills for this message via /skill. Before answering, **first** call `use_skill` (passing its id) for each one to obtain the full instructions, then act accordingly; other skills can still be loaded on demand via use_skill:\n' +
        skillLoadout.requested
          .map((s) => `- ${s.name} (id: \`${s.id}\`)${s.description ? ` — ${s.description}` : ''}`)
          .join('\n');
      for (let i = workingMessages.length - 1; i >= 0; i--) {
        const m = workingMessages[i];
        if (m.role !== 'user') continue;
        if (typeof m.content === 'string') {
          workingMessages[i] = { ...m, content: m.content ? `${m.content}\n\n${directive}` : directive };
        } else if (Array.isArray(m.content)) {
          workingMessages[i] = { ...m, content: [...m.content, { type: 'text', text: directive }] } as ChatMessage;
        }
        break;
      }
    }

    // @ 提及的 agent(单聊):用户 @ 了别的 Normal Agent → 提示主 agent 用 delegate(agentSlug=…) 把相关
    // 子任务交给它们(子代理用该 agent 人格跑),再综合回复。仅 host(delegate 可见)注入;同尾部 user 指令策略。
    const mentionSlugs: string[] = Array.isArray(agentConfig.mentionedAgentSlugs)
      ? agentConfig.mentionedAgentSlugs.map(String)
      : [];
    if (mentionSlugs.length && profile.capabilities.hostExec) {
      const mentioned = (await Promise.all(mentionSlugs.map((s) => getAgent(s).catch(() => null))))
        .filter(Boolean) as Array<{ slug: string; name: string; description?: string }>;
      if (mentioned.length) {
        const directive =
          '## Mentioned Agents for This Turn\n' +
          'The user @-mentioned the following agents for this message. When their expertise fits the request, involve them and then synthesize the result into your reply. Two ways, pick per the task:\n' +
          '- `delegate` with the matching `agentSlug` — a quick one-shot subtask (the subagent runs with that agent\'s persona and returns a single report). Use for fetch/search/analysis you just need an answer to.\n' +
          '- `start_discussion` with `peer` = the matching slug — a genuine back-and-forth deliberation (a fork of you debates them over rounds until they vote to end; collect it with `wait_discussion`). Use when the question benefits from real discussion/disagreement.\n' +
          'Mentioned agents:\n' +
          mentioned.map((a) => `- ${a.name} (slug: \`${a.slug}\`)${a.description ? ` — ${a.description}` : ''}`).join('\n');
        for (let i = workingMessages.length - 1; i >= 0; i--) {
          const m = workingMessages[i];
          if (m.role !== 'user') continue;
          if (typeof m.content === 'string') {
            workingMessages[i] = { ...m, content: m.content ? `${m.content}\n\n${directive}` : directive };
          } else if (Array.isArray(m.content)) {
            workingMessages[i] = { ...m, content: [...m.content, { type: 'text', text: directive }] } as ChatMessage;
          }
          break;
        }
      }
    }

    // 运行时转向的「回合切分」:把当前累积的助手段 A 落库 → 持久化注入的用户消息 U(们) → 清空累加器、
    // 铸新 assistantId(段 B)→ 发 turn_boundary 让前端关闭 A、插入 U 气泡、开 B 流。在迭代边界调用,
    // 即「一个 loop 结束即注入」。A 无正文且无工具调用(刚开跑就转向)则不落库,空段交前端丢弃。
    const applySteering = async (msgs: SteerMsg[]): Promise<void> => {
      const finalizedId = currentAssistantId;
      const finalizedContent = finalContent;
      if (finalContent.trim() || allToolCalls.length) {
        await finalizeAssistantMessage(finalizedId, sessionId, modelId, finalContent, finalReasoning, allToolCalls, allToolResults, pendingDisplayFiles.splice(0));
      }
      for (const m of msgs) {
        await deps().state.insertUserMessage({
          id: m.id, sessionId, content: m.content, modelId,
          attachments: Array.isArray(m.attachments) && m.attachments.length ? m.attachments : null,
        });
        workingMessages.push({ role: 'user', content: m.content } as ChatMessage);
      }
      finalContent = '';
      finalReasoning = '';
      allToolCalls.length = 0;
      allToolResults.length = 0;
      currentAssistantId = uuidv4();
      await publish(runId, 'turn_boundary', {
        finalizedAssistantId: finalizedId,
        finalizedContent,
        userMessages: msgs.map((m) => ({ id: m.id, content: m.content })),
        newAssistantId: currentAssistantId,
      });
    };

    // 自定义工具（HTTP/JS）：从 custom_tools 表 + 启用技能自带工具加载，喂给 LLM 并在云端执行。
    // 计划模式下整体跳过(外部副作用不可知,不属于只读集)。
    let customTools: Map<string, LoadedCustomTool> | undefined;
    if (!planMode) {
      try {
        const loaded = await loadCustomTools(appId, agentConfig);
        if (loaded.length) {
          customTools = new Map(loaded.map((t) => [t.name, t]));
          console.log(`[agent-core] run=${runId} custom tools: ${loaded.map((t) => `${t.name}(${t.executor})`).join(', ')}`);
        }
      } catch (e) {
        console.warn('[agent-core] loadCustomTools failed:', e);
      }
    }

    // MCP 工具(deps().mcp 仅 standalone/TUI 装配):run 开始取一次快照、run 内冻结——
    // server 集/工具集变更只对之后的 run 生效,杜绝 run 中途 defs 漂移打爆前缀缓存。
    // agent_config.enabledMcpServers(string[],缺省=全部已连接 server)做会话级过滤。
    let mcpTools: Map<string, import('../mcp/toolBridge.js').LoadedMcpTool> | undefined;
    if (deps().mcp && !planMode) {
      const enabledMcp = Array.isArray(agentConfig.enabledMcpServers) ? agentConfig.enabledMcpServers : undefined;
      const snapshot = deps().mcp!.toolsForRun(enabledMcp);
      if (snapshot.size) {
        mcpTools = snapshot;
        console.log(`[agent-core] run=${runId} mcp tools: ${[...snapshot.keys()].join(', ')}`);
      }
    }

    // view_image 等工具产出的图片回流:工具把 data URL 交回这里,本轮工具跑完后物化成一条
    // user 图像消息追加到对话尾部(尾部追加 → 不动前缀,缓存安全;复用 toImageParts)。
    const pendingToolImages: { url: string }[] = [];
    const MAX_TOOL_IMAGES_PER_ROUND = 8;
    // display_file / generate_image / 表情包:工具要展示给**用户**的文件。即时 publish 让桌面内联渲染;
    // 累积到下一次 finalize 时随 assistant 消息落库(刷新会话仍在)。不回灌模型上下文、不计费。
    // (pendingDisplayFiles 在函数级声明 → 中止/失败 catch 路径也能持久化。)
    const MAX_DISPLAY_FILES_PER_RUN = 40;
    const toolCtx: ToolContext = {
      userId, sessionId, appId, runId, signal: ac.signal, customTools, mcpTools,
      enabledSkillIds, execMode, cwd, approvalMode, profile, modelId, planMode,
      imageModelId: typeof agentConfig.imageModelId === 'string' ? agentConfig.imageModelId : undefined,
      muse: !!agentConfig.muse,
      // 激活的 agent 定义 slug → start_discussion 的「分身」据此取主 agent 人设(memScopeSlug 可能是共用默认,不可混用)。
      agentSlug: activeAgentSlug,
      collectImage: (img) => {
        if (img && typeof img.url === 'string' && img.url && pendingToolImages.length < MAX_TOOL_IMAGES_PER_ROUND) {
          pendingToolImages.push({ url: img.url });
        }
      },
      displayFile: (item) => {
        if (item && typeof item.name === 'string' && (item.path || item.dataUrl) && pendingDisplayFiles.length < MAX_DISPLAY_FILES_PER_RUN) {
          pendingDisplayFiles.push(item);
          void publish(runId, 'display_file', item); // 即时扇出给在线桌面端
        }
      },
    };
    const toolDefs = getToolDefinitions(toolCtx);

    type ExecutedToolCall = {
      toolResult: any;
      toolMessage: ChatMessage;
    };
    const MAX_PARALLEL_TOOL_CALLS = Math.max(1, Number(process.env.TANGU_TOOL_PARALLELISM) || 4);
    const canRunToolInParallel = (call: ToolCall): boolean => {
      const caps = getToolCapabilities(call.function.name, toolCtx);
      return caps.parallel === true && caps.sideEffect !== 'write' && caps.sideEffect !== 'system' && caps.sideEffect !== 'browser';
    };
    const artifactPathFromText = (text: string, explicit?: string): string | undefined => {
      if (explicit) return explicit;
      const jsonish = text.match(/"screenshot_path"\s*:\s*"([^"]+)"/) || text.match(/"artifactPath"\s*:\s*"([^"]+)"/);
      if (jsonish?.[1]) return jsonish[1];
      const line = text.split('\n').find((l) => /(?:saved|wrote|path|文件|输出).*\/[^ \n]+/i.test(l));
      return line?.match(/(\/[^\s"'<>]+)/)?.[1];
    };
    // 拒绝/拦截时的统一工具结果（用户审批 reject 与 PreToolUse hook block 共用）。
    const mkRejected = async (call: ToolCall, startedAt: number, parallelGroup: string | undefined, msg: string): Promise<ExecutedToolCall> => {
      const elapsedMs = Date.now() - startedAt;
      await publish(runId, 'tool_result', {
        id: call.id, name: call.function.name, result: msg, isError: true, startedAt, elapsedMs, outputChars: msg.length, parallelGroup,
      });
      return {
        toolResult: { tool_call_id: call.id, name: call.function.name, content: msg, isError: true, startedAt, elapsedMs, outputChars: msg.length, parallelGroup },
        toolMessage: { role: 'tool', content: msg, tool_call_id: call.id } as ChatMessage,
      };
    };
    const executeOneToolCall = async (call: ToolCall, parallelGroup?: string): Promise<ExecutedToolCall> => {
      if (ac.signal.aborted) throw new AbortLikeError();
      const startedAt = Date.now();
      const basePayload = {
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        startedAt,
        parallelGroup,
      };
      await publish(runId, 'tool_call', basePayload);

      // —— PreToolUse hook：拦截 / 改写参数 / 注入上下文（host-only；云端在 runHooks 顶部即空判定）——
      const preV = await runHooks('PreToolUse', {
        tool_name: call.function.name, tool_input: hookParseArgs(call.function.arguments),
        session_id: sessionId, run_id: runId, cwd, agent_slug: activeAgentSlug,
      }, hookCtx());
      if (ac.signal.aborted) throw new AbortLikeError();
      if (preV.block) {
        return mkRejected(call, startedAt, parallelGroup, `⛔ Hook 拦截：${preV.blockReason || 'PreToolUse hook 阻止了该操作'}`);
      }
      // hook 改写参数 → 用改写后的 call 走审批与执行（审批基于改写后的内容，更安全）。
      const effCall = preV.updatedInput
        ? { ...call, function: { ...call.function, arguments: JSON.stringify(preV.updatedInput) } }
        : call;
      const preCtxText = hookContextText(preV); // PreToolUse 注入的上下文 → 拼进本工具结果尾部（保序）

      // host-exec 审批闸门：execMode!=='host' 时立即放行（无 await、无事件）→ server/worker 零影响。
      const decision = await gateToolCall(runId, effCall, { sessionId, execMode, approvalMode, cwd, profile }, ac.signal);
      if (ac.signal.aborted) throw new AbortLikeError();
      if (decision.action === 'reject') {
        return mkRejected(call, startedAt, parallelGroup, '用户拒绝了该操作。');
      }
      // 审批时用户改了参数（如修订 bash 命令）→ 用覆盖后的参数执行。
      const execCall = decision.argsOverride
        ? { ...effCall, function: { ...effCall.function, arguments: JSON.stringify(decision.argsOverride) } }
        : effCall;
      const result = await executeTool(execCall, toolCtx);
      // 入列硬帽(写入即定型,append-only):各工具自有更小的帽,这里兜未封顶路径
      // (host list_dir 大目录、custom provider 等),保证单条结果不可能把上下文炸穿。
      const capped = capToolResult(result.result);
      const elapsedMs = Date.now() - startedAt;
      const artifactPath = artifactPathFromText(capped, result.artifactPath);
      const payload = {
        id: call.id,
        name: result.name,
        result: capped,
        isError: result.isError,
        startedAt,
        elapsedMs,
        outputChars: capped.length,
        parallelGroup,
        artifactPath,
        metadata: result.metadata,
      };
      await publish(runId, 'tool_result', payload);

      // —— PostToolUse hook：跑格式化/lint/审计、把反馈或上下文喂回模型（host-only；云端 no-op）——
      const postV = await runHooks('PostToolUse', {
        tool_name: result.name, tool_input: hookParseArgs(execCall.function.arguments),
        tool_response: capped, is_error: result.isError,
        session_id: sessionId, run_id: runId, cwd, agent_slug: activeAgentSlug,
      }, hookCtx());
      // Pre/Post 注入上下文 + PostToolUse block 反馈 → 追加到本工具结果消息尾部
      // （追加进 tool 消息本身，保持 tool 消息与 assistant tool_calls 的相邻性，不破坏消息序）。
      const hookExtra = [
        preCtxText,
        hookContextText(postV),
        postV.block ? `⛔ Hook 反馈：${postV.blockReason || 'PostToolUse hook 阻止'}` : '',
      ].filter(Boolean).join('\n\n');
      const toolMsgContent = hookExtra ? `${capped}\n\n${hookExtra}` : capped;
      return {
        toolResult: {
          tool_call_id: call.id,
          name: result.name,
          content: capped,
          isError: result.isError,
          startedAt,
          elapsedMs,
          outputChars: capped.length,
          parallelGroup,
          artifactPath,
          metadata: result.metadata,
        },
        toolMessage: { role: 'tool', content: toolMsgContent, tool_call_id: call.id } as ChatMessage,
      };
    };
    const executeToolCallsInOrder = async (calls: ToolCall[]): Promise<any[]> => {
      const toolResults: any[] = [];
      for (let i = 0; i < calls.length;) {
        if (!canRunToolInParallel(calls[i])) {
          const single = await executeOneToolCall(calls[i]);
          toolResults.push(single.toolResult);
          workingMessages.push(single.toolMessage);
          i += 1;
          continue;
        }
        const batch: ToolCall[] = [];
        while (i + batch.length < calls.length && batch.length < MAX_PARALLEL_TOOL_CALLS && canRunToolInParallel(calls[i + batch.length])) {
          batch.push(calls[i + batch.length]);
        }
        const parallelGroup = batch.length > 1 ? uuidv4() : undefined;
        const executed = batch.length > 1
          ? await Promise.all(batch.map((call) => executeOneToolCall(call, parallelGroup)))
          : [await executeOneToolCall(batch[0])];
        for (const item of executed) {
          toolResults.push(item.toolResult);
          workingMessages.push(item.toolMessage);
        }
        i += batch.length;
      }
      return toolResults;
    };

    const user = await getUserById(userId);
    if (!user) throw new LlmError(404, 'User not found');

    const estCost = await calculateCost(modelId, JSON.stringify(workingMessages).length / 4, 500);
    const pre = await canConsumeTokenPoints(user.id, estCost);
    if (!pre.ok) {
      await publish(runId, 'error', { error: 'token_quota_exceeded', detail: pre });
      await drain(runId);
      await updateRunStatus(runId, 'failed', { error: 'token_quota_exceeded' });
      return;
    }

    let usedTools = false; // 本 run 是否真的执行过工具(循环耗尽提示的前提:没用工具的纯聊天/单轮 run 不该报"耗尽")
    let tokensTotal = 0;
    let costTotal = 0; // 本 run 累计扣费点数(每-run 成本上限护栏用)
    const runCostLimit = runCostCeiling(); // TANGU_MAX_RUN_COST，<=0 关闭

    let lastRealPromptTokens = 0; // 上一轮 provider 真实 prompt 用量(压缩触发的首选依据,对齐 Hermes)
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (ac.signal.aborted) throw new AbortLikeError();
      // 迭代边界注入运行时转向消息(在压缩 / 模型调用之前 → 新 U 参与上下文与折叠 tail 计算)。
      const steered = drainSteer(runId);
      if (steered.length) await applySteering(steered);

      // 每轮前复查配额（多轮 run 可能远超首轮预估）
      const stepPre = await canConsumeTokenPoints(user.id, estCost);
      if (!stepPre.ok) {
        await publish(runId, 'error', { error: 'token_quota_exceeded', detail: stepPre });
        finalContent = finalContent || '(额度不足，已停止)';
        break;
      }

      await publish(runId, 'status', { iteration });

      // 上下文压缩(替代旧的每轮就地 trim——那会让前缀缓存逐轮清零):平时 append-only。
      //   ≥95%(FORCE_COMPACT_RATIO):满载兜底——持久化一个总结检查点(下个 run 起步即精简)+ 把当前
      //     run 的内存数组按摘要折叠(立刻把本轮压下去)。总结失败则退回机械折叠。
      //   ≥50%(COMPACT_TRIGGER_RATIO):机械批量折叠中段(运行内、不落库),缓存 miss 摊薄成偶发。
      const estPrompt = lastRealPromptTokens || estimateMessagesTokens(workingMessages);
      // —— PreCompact hook：压缩将触发时先问 hook（continue:false → 跳过本次压缩；host-only，云端 no-op）——
      let skipCompact = false;
      if (modelId && estPrompt > CONTEXT_WINDOW_TOKENS * COMPACT_TRIGGER_RATIO) {
        const pcV = await runHooks('PreCompact', { source: 'auto', session_id: sessionId, run_id: runId, cwd, agent_slug: activeAgentSlug }, hookCtx());
        skipCompact = !!pcV.stop;
      }
      if (!skipCompact && modelId && estPrompt > CONTEXT_WINDOW_TOKENS * FORCE_COMPACT_RATIO) {
        void publish(runId, 'status', { phase: 'compacting', forced: true, iteration });
        const cr = await compactSession(sessionId, modelId);
        if (cr.ok && cr.summary) {
          foldWorkingWithSummary(workingMessages, cr.summary);
          lastRealPromptTokens = 0;
          void publish(runId, 'status', { phase: 'compacted', forced: true, iteration });
        } else {
          const r = compactContext(workingMessages);
          if (r.changed) lastRealPromptTokens = 0;
          void publish(runId, 'status', { phase: 'compacted', forced: true, fallback: true, iteration });
        }
      } else if (estPrompt > CONTEXT_WINDOW_TOKENS * COMPACT_TRIGGER_RATIO) {
        const r = compactContext(workingMessages);
        if (r.changed) {
          lastRealPromptTokens = 0; // 折叠后旧用量失效,下轮重新以真实值为准
          console.warn(
            `[agent-core] run=${runId} 上下文压缩:省 ${r.savedChars.toLocaleString()} 字符;` +
              `压缩前最大消息: ${r.breakdown.map((b) => `#${b.index}(${b.role},${b.chars.toLocaleString()}字符)`).join(' ')}`,
          );
          void publish(runId, 'status', { phase: 'compacted', savedChars: r.savedChars, iteration });
        }
      }

      // 最后一轮强制不再调工具，逼模型产出最终文本（避免以 tool_calls 收尾、finalContent 为空）
      // attachments 恒传空:图片已由 hydrateHistory 物化进最新 user 消息的 parts(每轮字节一致,
      // 缓存稳定且多轮可见;旧链路只在第 0 轮注入,前缀分叉还会让模型第 1 轮起丢图)。
      const lastIter = iteration === maxIterations - 1;
      const payload = await buildProviderPayload({
        model,
        apiModelId,
        messages: workingMessages,
        projectSource: appId,
        temperature: 0.7,
        // 最后一轮不发 tools(而非 toolChoice:'none'):部分思考模式渠道(DeepSeek 等)
        // 会以 "Thinking mode does not support this tool_choice" 拒绝显式 tool_choice。
        tools: lastIter ? undefined : toolDefs,
        toolChoice: lastIter ? undefined : 'auto',
        attachments: [],
        thinkingLevel,
        stream: true,
        cacheKey: sessionId, // OpenAI prompt_cache_key:同会话粘同机,提升自动前缀缓存命中(P2)
      });

      let lastGenChars = 0; // 工具调用参数生成进度节流（每 ~600 字符播一次"生成中"）
      const res = await streamProviderCompletion({
        apiKey,
        baseUrl,
        payload,
        provider: (model as any)?.provider, // anthropic → 原生 /v1/messages(in-process 面;httpBrain 面由 brain-api 解析)
        signal: ac.signal,
        onToken: (d) => { void publish(runId, 'token', { delta: d }); },
        onReasoning: (d) => { void publish(runId, 'reasoning', { delta: d }); },
        onToolCallDelta: (info) => {
          // Stream the raw arg delta so the client can render a live "writing
          // file" preview (it reassembles per tool-call id and extracts path/content).
          if (info.argsDelta) {
            void publish(runId, 'tool_stream', { id: info.id, name: info.name, delta: info.argsDelta });
          }
          // Keep the throttled generic "生成中…(N 字符)" status for the status bar.
          if (info.argsLen - lastGenChars >= 600) {
            lastGenChars = info.argsLen;
            void publish(runId, 'status', { phase: 'generating', iteration, tool: info.name, chars: info.argsLen });
          }
        },
      });

      lastRealPromptTokens = res.usage.prompt_tokens || 0;
      const cachedTokens = res.usage.cached_tokens || 0;
      const cost = await calculateCost(modelId, res.usage.prompt_tokens, res.usage.completion_tokens, undefined, cachedTokens);
      tokensTotal += (res.usage.prompt_tokens || 0) + (res.usage.completion_tokens || 0);
      // 把本轮 usage 播给订阅者（TUI 状态栏的实时 token / 预算用;cached=缓存命中量,命中率=cached/prompt）。
      void publish(runId, 'usage', {
        prompt: res.usage.prompt_tokens || 0,
        completion: res.usage.completion_tokens || 0,
        cached: cachedTokens,
        total: tokensTotal,
        cost,
        iteration,
      });
      const consumed = await consumeTokenPoints(user.id, cost).catch(() => ({ ok: true } as any));
      await logApiUsage(
        user.username, modelId, model.name, model.provider,
        res.usage.prompt_tokens, res.usage.completion_tokens, true, undefined, appId, cost,
        cachedTokens,
      ).catch(() => {});

      // 每-run 累计成本硬上限(多轮累计失控的护栏;入站闸门只挡单条入站)。越限即终止本 run，
      // 与 input_too_large 同款 publish→drain→failed→return(finally 仍会 flush + 推进队列)。
      costTotal += cost;
      if (isOverRunCost(costTotal, runCostLimit)) {
        const detail = `本 run 累计成本约 ${costTotal.toFixed(2)} 点，超过上限 ${runCostLimit} 点，已停止。可调 TANGU_MAX_RUN_COST（0 关闭）。`;
        await publish(runId, 'error', { error: 'run_cost_exceeded', detail });
        await drain(runId);
        await updateRunStatus(runId, 'failed', { error: 'run_cost_exceeded', tokensTotal });
        return;
      }

      if (!res.toolCalls || res.toolCalls.length === 0 || lastIter) {
        // 安全网:模型把工具调用当正文吐(原生 tool_calls 空且文本兜底没解出来),但正文带工具
        // 调用标记 —— 别静默收尾。回灌一次纠正提示让它改用原生函数调用重试(预算内、非最后一轮)。
        // 这能兜住「兜底解析器认不出的新网关格式」,把硬停转成自愈,正常完成(无标记)零影响。
        if (
          !lastIter &&
          (!res.toolCalls || res.toolCalls.length === 0) &&
          !(consumed && consumed.ok === false) && // 额度已不足就别再起一轮纠正重试(下轮 :404 会收尾)
          toolCallRecoveryUsed < MAX_TOOLCALL_RECOVERY &&
          looksLikeToolCallText(res.content)
        ) {
          toolCallRecoveryUsed++;
          workingMessages.push({ role: 'assistant', content: res.content || '' } as ChatMessage);
          workingMessages.push({
            role: 'user',
            content:
              '⚠️ 系统提示:你上一条消息里的工具调用用了无法被解析的文本格式(如 <invoke …> / ' +
              '<｜tool▁call▁begin｜> 标记),并未被实际执行。请改用本平台的原生函数调用机制重新发起这次' +
              '工具调用 —— 不要把这些标记当作正文输出。',
          } as ChatMessage);
          void publish(runId, 'status', { phase: 'toolcall_format_recovery', iteration });
          await appendStep({
            id: uuidv4(), runId, stepNo: iteration,
            llmResponse: { content: res.content, usage: res.usage },
          });
          continue;
        }
        // 收尾:本轮正文追加进终稿(此前各中间迭代的 preamble 已累积在 finalContent 里);
        // 本轮为空(整条都是工具标记被剔空)时保留已累积值,仍为空则给一条可读提示,避免最终消息全空白。
        appendFinal(res.content || '');
        finalReasoning = res.reasoning || finalReasoning;
        // 运行时转向:模型本想收尾,但用户在这一轮里发了消息 → 续跑而非结束(最后一轮仍须收尾)。先把刚
        // 产出的最终文本作为助手轮并入上下文(只灌本轮文本——preamble 已在 workingMessages 里,
        // 全量灌 finalContent 会在模型上下文里重复),再切回合注入 U,continue 让下一迭代带着 U 继续。
        const steeredAtFinish = drainSteer(runId);
        if (steeredAtFinish.length && !lastIter) {
          if (res.content) workingMessages.push({ role: 'assistant', content: res.content } as ChatMessage);
          await applySteering(steeredAtFinish);
          continue;
        }
        // —— Stop hook：run 自然收尾即触发（host-only；云端 no-op）。decision:block+reason → 复用 steer 机制
        //    强制续跑（非末轮），否则纯 side-effect（通知/webhook/日志）。——
        const stopV = await runHooks('Stop', {
          session_id: sessionId, run_id: runId, cwd, agent_slug: activeAgentSlug, stop_reason: 'end_turn',
        }, hookCtx());
        if (stopV.block && stopV.blockReason && !lastIter) {
          if (res.content) workingMessages.push({ role: 'assistant', content: res.content } as ChatMessage);
          await applySteering([{ id: uuidv4(), content: stopV.blockReason }]);
          continue;
        }
        if (!finalContent.trim() && !finalReasoning.trim()) {
          finalContent = looksLikeToolCallText(res.content)
            ? '(本轮达到最大工具调用次数或工具调用格式异常,已停止。发送"继续"可让我接着操作。)'
            : finalContent;
        }
        // 循环耗尽提示:仅当 ① 顶到 lastIter ② 本 run 确实在调工具(usedTools,排除纯聊天/maxIterations=1 这类
        // 一上来就 lastIter 却没用过工具的情况)③ 没走工具调用格式异常兜底(否则与那条提示重复)三者同时成立才追加。
        // 注:极少数"恰好在最后一轮自然收尾"会误报,故措辞为"可能尚未完成";完全消歧需不强制 toolChoice='none',成本更高,暂不做。
        if (lastIter && usedTools && !looksLikeToolCallText(res.content)) {
          const notice = `⚠️ 已达到本会话的最大循环轮数(${maxIterations} 轮)并停止,任务可能尚未完成。发送「继续」可接着操作,或用 \`/loop <轮数>\` 调整上限。`;
          finalContent = finalContent.trim() ? `${finalContent.trimEnd()}\n\n> ${notice}` : notice;
          void publish(runId, 'status', { phase: 'loop_exhausted', iteration, maxIterations });
        }
        await appendStep({
          id: uuidv4(), runId, stepNo: iteration,
          llmResponse: { content: res.content, usage: res.usage },
        });
        break;
      }

      // 配额扣减失败 → 停止（避免欠费继续烧）
      if (consumed && consumed.ok === false) {
        await publish(runId, 'error', { error: 'token_quota_exceeded' });
        appendFinal(res.content || '');
        if (!finalContent.trim()) finalContent = '(额度不足，已停止)';
        break;
      }

      // 中间迭代的 preamble 正文累积进终稿(工具标记样式的杂文除外,那是待纠正的假工具调用)。
      if (res.content && !looksLikeToolCallText(res.content)) appendFinal(res.content);

      workingMessages.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: res.toolCalls,
      } as ChatMessage);
      allToolCalls.push(...res.toolCalls);
      usedTools = true; // 到达本行说明这一轮在调工具并继续循环;若后续顶到 lastIter 即为真·循环耗尽

      const toolResults = await executeToolCallsInOrder(res.toolCalls);
      // 工具(view_image)读到的图片 → 物化成一条 user 图像消息追加到尾部,下一轮模型即可"看见"。
      // 仅 in-memory(不落库):本 run 内多轮可见即可,避免历史每轮重发多 MB base64(对齐附件物化纪律)。
      if (pendingToolImages.length) {
        const imgs = pendingToolImages.splice(0);
        workingMessages.push({
          role: 'user',
          content: toImageParts('(The images read by the tools above are shown below; analyze them accordingly)', imgs),
        } as ChatMessage);
      }
      allToolResults.push(...toolResults);

      await appendStep({
        id: uuidv4(), runId, stepNo: iteration,
        llmResponse: { content: res.content, usage: res.usage },
        toolCalls: res.toolCalls,
        toolResults,
      });
    }

    await finalizeAssistantMessage(
      currentAssistantId,
      sessionId, modelId, finalContent, finalReasoning, allToolCalls, allToolResults, pendingDisplayFiles.splice(0),
    );
    await flush(); // 先把会话工作区改动回写 Penzor，再发 done，保证客户端收到 done 时云端文件已就绪
    await drain(runId); // 确保 token 等事件全部落库后再发 done
    await publish(runId, 'done', { content: finalContent });
    await updateRunStatus(runId, 'done', { result: { content: finalContent }, tokensTotal });
    // 本地 Historian（Special Agent）：本「轮」完成 → 按 X/Y 轮触发标题/记忆维护。
    // fire-and-forget，绝不阻断/影响 run；非本地形态或未启用时内部 no-op。
    // 传 memScopeSlug(记忆域,shareDefaultMemory 已折叠)而非 activeAgentSlug:Historian 读写的
    // MEMORY/LOG 必须与 run 内 remember/log_event 落同一文件夹,否则共用默认记忆的 agent 会被写歪。
    void onUserRunDone(sessionId, userId, memScopeSlug);
  } catch (err: any) {
    const aborted = err?.name === 'AbortError' || err instanceof AbortLikeError;
    const status = aborted ? 'aborted' : 'failed';
    const msg = aborted ? 'aborted' : (err?.message || String(err));
    console.error(`[agent-core] run ${runId} ${status}:`, msg);
    // 落库「已停止/失败」时已累积的部分助手轮次:有正文或工具调用就持久化 → 留在聊天记录、且作为上下文
    // 喂给后续 run(否则被中断的这一轮凭空消失,用户与后续 agent 都读不到)。幂等 upsert,失败不二次抛。
    if (finalContent.trim() || allToolCalls.length) {
      await finalizeAssistantMessage(
        currentAssistantId, sessionId, modelId, finalContent, finalReasoning, allToolCalls, allToolResults, pendingDisplayFiles.splice(0),
      ).catch((e) => console.warn('[agent-core] persist partial on abort failed:', e));
    }
    // content 带上部分正文 → 在线前端把这条流式消息原地收尾为「已停止」,不丢已输出内容。
    await publish(runId, 'error', { error: msg, aborted, content: finalContent }).catch(() => {});
    // —— Stop hook：失败/中止路径也触发（host-only；纯 side-effect 通知，不影响错误处理，无续跑）。——
    void runHooks('Stop', {
      session_id: sessionId, run_id: runId, cwd, agent_slug: activeAgentSlug, stop_reason: aborted ? 'aborted' : 'error',
    }, hookCtx()).catch(() => {});
    await drain(runId).catch(() => {});
    await updateRunStatus(runId, status, { error: msg }).catch(() => {});
  } finally {
    // 兜底 snapshot（失败/中止路径未走到成功段时）；会话沙箱保持温，由空闲 TTL reaper 回收。
    await flush();
    abortControllers.delete(runId);
    steerQueue.delete(runId); // 丢弃尚未注入的转向消息(run 已终结)
    runSession.delete(runId);
    advanceQueue(sessionId); // 推进同会话队列：起下一个排队 run（正常完成/失败/中止都经此）
    setTimeout(() => cleanup(runId), 30_000);
  }
}

async function finalizeAssistantMessage(
  messageId: string,
  sessionId: string,
  modelId: string,
  content: string,
  reasoning: string,
  toolCalls: ToolCall[],
  toolResults: any[],
  displayFiles?: DisplayFileItem[],
): Promise<void> {
  await deps().state.finalizeAssistantMessage({
    messageId, sessionId, modelId, content, reasoning, toolCalls, toolResults, displayFiles,
    agentSlug: currentDisplayAgentSlug(),
  });
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

class AbortLikeError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}
