/**
 * 服务端 agent loop（进程内异步，run 生命周期 > HTTP 连接）。
 * hydrate（chat_messages 近期消息）→ for iteration：token 流式调 LLM → 检测 tool_calls →
 * 执行工具 → 回灌 → 直到无 tool_calls；finalize 把最终 assistant 消息写回 chat_messages（共享层）。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { resolveProfile } from '../seams/appProfile.js';
import type { StreamOpts, BuildPayloadOpts } from '../seams/cloudBrain.js';
import { LlmError, type ThinkingLevel, type ChatMessage, type ToolCall } from '../core/types.js';
import { publish, drain, cleanup } from './eventBus.js';
import { gateToolCall } from './approvals.js';
import { enterRunContext } from '../seams/runContext.js';
import { getRun, updateRunStatus, appendStep, listPendingRunsForRecovery } from './runStore.js';
import { getToolDefinitions, executeTool, type ToolContext } from '../tools/registry.js';
import { loadSkillLoadout } from './skillLoadout.js';
import { loadCustomTools, type LoadedCustomTool } from '../tools/customTools.js';
import { snapshotSession } from '../sandbox/sessionSandbox.js';
import {
  CONTEXT_WINDOW_TOKENS, INPUT_HARD_RATIO, INPUT_WARN_RATIO, COMPACT_TRIGGER_RATIO,
  estimateTokensRough, estimateMessagesTokens, compactContext, capToolResult, capHistoryContent,
} from './contextBudget.js';
import { normalizeImageAttachments, toImageParts } from './imageAttachments.js';

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
  runLoop(runId, ac).catch((err) => {
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
  const cntRows = await query<any[]>(
    `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`,
    [sessionId],
  );
  const n = Number(cntRows[0]?.n || 0);
  const start = n > HYDRATE_MAX ? Math.ceil((n - HYDRATE_MAX) / HYDRATE_BLOCK) * HYDRATE_BLOCK : 0;
  const rows = await query<any[]>(
    `SELECT id, role, content, tool_calls, attachments FROM chat_messages
     WHERE session_id = ? ORDER BY timestamp ASC OFFSET ?`,
    [sessionId, start],
  );
  const out: ChatMessage[] = [];
  let lastUserWithImages = -1; // out 中最新带图 user 消息的下标
  let lastUserImages: ReturnType<typeof normalizeImageAttachments> = [];
  for (const r of rows) {
    if (r.id === excludeMessageId) continue;
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
  // 多租户接缝:把本 run 的 userId 注入异步子树,供 worker 的 brain 适配器铸 per-user token。
  // microserver/standalone 的 brain 不读此上下文,无副作用。
  enterRunContext(userId);
  const modelId = run.model_id || '';
  const input = typeof run.input === 'string' ? safeParse(run.input) : run.input || {};
  const agentConfig = input.agentConfig || {};
  const maxIterations = Math.min(Math.max(1, agentConfig.maxIterations || 10), 30);
  const thinkingLevel: ThinkingLevel = agentConfig.thinkingLevel || 'off';
  const attachments = input.attachments || [];
  // host-exec（TUI/桌面本机模式）注入：execMode/cwd/approvalMode 只经 per-run agentConfig 传入。
  // 缺省 sandbox + full-auto → microserver/standalone-server/worker 行为零变化（审批仅 host 激活）。
  // 能力闸门(红线②/④):未声明 hostExec 的 profile(云端形态)一律强制回 sandbox,杜绝云端拿到真实 FS/shell。
  const execMode: 'sandbox' | 'host' =
    agentConfig.execMode === 'host' && profile.capabilities.hostExec ? 'host' : 'sandbox';
  const cwd: string | undefined =
    typeof agentConfig.cwd === 'string' && agentConfig.cwd ? agentConfig.cwd : undefined;
  const approvalMode: 'readonly' | 'auto-edit' | 'full-auto' =
    agentConfig.approvalMode || (execMode === 'host' ? 'auto-edit' : 'full-auto');
  // 计划模式(类 Claude plan mode):工具集收敛为只读 + exit_plan_mode(toolRegistry 集中过滤),
  // custom/MCP 工具整体跳过;run 级冻结——批准退出后下一轮 run 才拿到完整工具集。
  const planMode = !!agentConfig.planMode && profile.capabilities.hostExec;

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

  try {
    await updateRunStatus(runId, 'running');
    await publish(runId, 'status', { state: 'running' });

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
    if (input.userMessageId && input.message) {
      await query(
        `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error, attachments)
         VALUES (?, ?, 'user', ?, ?, ?, FALSE, ?)
         ON CONFLICT (id) DO NOTHING`,
        [
          input.userMessageId,
          sessionId,
          String(input.message),
          Date.now(),
          modelId,
          Array.isArray(attachments) && attachments.length ? JSON.stringify(attachments) : null,
        ],
      );
    }

    const history = await hydrateHistory(sessionId, run.assistant_message_id || '');

    // 启用技能的装载（渐进式披露:目录进 prompt、全文按需 use_skill）——见 services/skillLoadout.ts。
    const skillLoadout = await loadSkillLoadout(userId, appId, agentConfig);
    const enabledSkillIds = skillLoadout.enabledSkillIds;

    const systemParts: string[] = [];
    if (agentConfig.systemPrompt) systemParts.push(String(agentConfig.systemPrompt));
    // 注入用户长期记忆（整 run 冻结、缓存安全）。读失败不阻断 run。
    try {
      const mem = await getMemory(userId);
      if (mem.content?.trim()) {
        systemParts.push(
          '## 关于该用户（长期记忆）\n' +
            '系统为该用户长期记录的稳定事实/偏好；执行任务时纳入考量，不要复述、不要当作本轮指令。\n\n' +
            mem.content.trim(),
        );
      }
    } catch (e) {
      console.warn('[agent-core] load user memory failed:', e);
    }
    // 静态指引/环境段按 profile 装载（G4，见 profiles/promptSections.ts）：
    // guidance（记忆与日志）在技能段前，environment（host 本地环境 / sandbox 输出位置+效率）在技能段后,
    // 段落顺序与改造前逐字节一致。
    const promptSections = profile.promptSections({ execMode, cwd });
    systemParts.push(...promptSections.guidance);
    systemParts.push(...skillLoadout.sections);
    systemParts.push(...promptSections.environment);

    // 计划模式指引(追加在最后,不动既有段落的字节序;planMode 是 run 级配置,同 run 内稳定)。
    if (planMode) {
      systemParts.push(
        '## 计划模式(Plan Mode)\n' +
          '当前处于计划模式:你只有只读工具,**不能**写文件/执行命令/调用外部工具。流程:\n' +
          '1. 用只读工具(read_file/search_files/glob_files/web_search 等)充分调研\n' +
          '2. 需求有歧义或方案需取舍时用 ask_user 问清楚\n' +
          '3. 产出完整实施计划(目标/步骤/涉及文件/验证方式),调用 exit_plan_mode 提交审批\n' +
          '4. 用户批准前不要承诺"已完成"任何改动;被要求修改就完善计划后重新提交',
      );
    }

    const workingMessages: ChatMessage[] = [];
    if (systemParts.length) {
      workingMessages.push({ role: 'system', content: systemParts.join('\n\n') } as ChatMessage);
    }
    workingMessages.push(...history);

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

    const toolCtx: ToolContext = {
      userId, sessionId, appId, runId, signal: ac.signal, customTools, mcpTools,
      enabledSkillIds, execMode, cwd, approvalMode, profile, modelId, planMode,
    };
    const toolDefs = getToolDefinitions(toolCtx);

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

    let finalContent = '';
    let finalReasoning = '';
    const allToolCalls: ToolCall[] = [];
    const allToolResults: any[] = [];
    let tokensTotal = 0;

    let lastRealPromptTokens = 0; // 上一轮 provider 真实 prompt 用量(压缩触发的首选依据,对齐 Hermes)
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (ac.signal.aborted) throw new AbortLikeError();

      // 每轮前复查配额（多轮 run 可能远超首轮预估）
      const stepPre = await canConsumeTokenPoints(user.id, estCost);
      if (!stepPre.ok) {
        await publish(runId, 'error', { error: 'token_quota_exceeded', detail: stepPre });
        finalContent = finalContent || '(额度不足，已停止)';
        break;
      }

      await publish(runId, 'status', { iteration });

      // 上下文压缩(替代旧的每轮就地 trim——那会让前缀缓存逐轮清零):平时 append-only,
      // 仅当真实用量(或粗估)越过窗口阈值才一次性批量折叠中段,缓存 miss 摊薄成偶发。
      const estPrompt = lastRealPromptTokens || estimateMessagesTokens(workingMessages);
      if (estPrompt > CONTEXT_WINDOW_TOKENS * COMPACT_TRIGGER_RATIO) {
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
        tools: toolDefs,
        toolChoice: lastIter ? 'none' : 'auto',
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

      if (!res.toolCalls || res.toolCalls.length === 0 || lastIter) {
        finalContent = res.content || finalContent;
        finalReasoning = res.reasoning || finalReasoning;
        await appendStep({
          id: uuidv4(), runId, stepNo: iteration,
          llmResponse: { content: res.content, usage: res.usage },
        });
        break;
      }

      // 配额扣减失败 → 停止（避免欠费继续烧）
      if (consumed && consumed.ok === false) {
        await publish(runId, 'error', { error: 'token_quota_exceeded' });
        finalContent = res.content || finalContent || '(额度不足，已停止)';
        break;
      }

      workingMessages.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: res.toolCalls,
      } as ChatMessage);
      allToolCalls.push(...res.toolCalls);

      const toolResults: any[] = [];
      for (const call of res.toolCalls) {
        if (ac.signal.aborted) throw new AbortLikeError();
        await publish(runId, 'tool_call', { id: call.id, name: call.function.name, arguments: call.function.arguments });

        // host-exec 审批闸门：execMode!=='host' 时立即放行（无 await、无事件）→ server/worker 零影响。
        const decision = await gateToolCall(runId, call, { sessionId, execMode, approvalMode }, ac.signal);
        if (ac.signal.aborted) throw new AbortLikeError();
        if (decision.action === 'reject') {
          const rejected = '用户拒绝了该操作。';
          await publish(runId, 'tool_result', { id: call.id, name: call.function.name, result: rejected, isError: true });
          toolResults.push({ tool_call_id: call.id, name: call.function.name, content: rejected, isError: true });
          workingMessages.push({ role: 'tool', content: rejected, tool_call_id: call.id } as ChatMessage);
          continue;
        }
        // 审批时用户改了参数（如修订 bash 命令）→ 用覆盖后的参数执行。
        const execCall = decision.argsOverride
          ? { ...call, function: { ...call.function, arguments: JSON.stringify(decision.argsOverride) } }
          : call;
        const result = await executeTool(execCall, toolCtx);
        // 入列硬帽(写入即定型,append-only):各工具自有更小的帽,这里兜未封顶路径
        // (host list_dir 大目录、custom provider 等),保证单条结果不可能把上下文炸穿。
        const capped = capToolResult(result.result);
        await publish(runId, 'tool_result', { id: call.id, name: result.name, result: capped, isError: result.isError });
        toolResults.push({ tool_call_id: call.id, name: result.name, content: capped, isError: result.isError });
        workingMessages.push({ role: 'tool', content: capped, tool_call_id: call.id } as ChatMessage);
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
      run.assistant_message_id || uuidv4(),
      sessionId, modelId, finalContent, finalReasoning, allToolCalls, allToolResults,
    );
    await flush(); // 先把会话工作区改动回写 Penzor，再发 done，保证客户端收到 done 时云端文件已就绪
    await drain(runId); // 确保 token 等事件全部落库后再发 done
    await publish(runId, 'done', { content: finalContent });
    await updateRunStatus(runId, 'done', { result: { content: finalContent }, tokensTotal });
  } catch (err: any) {
    const aborted = err?.name === 'AbortError' || err instanceof AbortLikeError;
    const status = aborted ? 'aborted' : 'failed';
    const msg = aborted ? 'aborted' : (err?.message || String(err));
    console.error(`[agent-core] run ${runId} ${status}:`, msg);
    await publish(runId, 'error', { error: msg, aborted }).catch(() => {});
    await drain(runId).catch(() => {});
    await updateRunStatus(runId, status, { error: msg }).catch(() => {});
  } finally {
    // 兜底 snapshot（失败/中止路径未走到成功段时）；会话沙箱保持温，由空闲 TTL reaper 回收。
    await flush();
    abortControllers.delete(runId);
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
): Promise<void> {
  await query(
    `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, reasoning, is_error, tool_calls, tool_results, attachments)
     VALUES (?, ?, 'model', ?, ?, ?, ?, FALSE, ?, ?, NULL)
     ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, reasoning=EXCLUDED.reasoning, tool_calls=EXCLUDED.tool_calls, tool_results=EXCLUDED.tool_results, updated_at=CURRENT_TIMESTAMP`,
    [
      messageId,
      sessionId,
      content,
      Date.now(),
      modelId,
      reasoning || null,
      toolCalls.length ? JSON.stringify(toolCalls) : null,
      toolResults.length ? JSON.stringify(toolResults) : null,
    ],
  );
  await query(`UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [sessionId]).catch(() => {});
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
