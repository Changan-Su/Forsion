/**
 * 服务端 agent loop（进程内异步，run 生命周期 > HTTP 连接）。
 * hydrate（chat_messages 近期消息）→ for iteration：token 流式调 LLM → 检测 tool_calls →
 * 执行工具 → 回灌 → 直到无 tool_calls；finalize 把最终 assistant 消息写回 chat_messages（共享层）。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import type { StreamOpts, BuildPayloadOpts } from '../seams/cloudBrain.js';
import { LlmError, type ThinkingLevel, type ChatMessage, type ToolCall } from '../core/types.js';
import { publish, drain, cleanup } from './eventBus.js';
import { gateToolCall } from './approvals.js';
import { enterRunContext } from '../seams/runContext.js';
import { getRun, updateRunStatus, appendStep, listPendingRunsForRecovery } from './runStore.js';
import { getToolDefinitions, executeTool, type ToolContext } from '../tools/registry.js';
import { materializeSkill } from '../tools/fileWorkspace.js';
import { loadCustomTools, type LoadedCustomTool } from '../tools/customTools.js';
import { snapshotSession } from '../sandbox/sessionSandbox.js';

// ── 注入依赖的 lazy 别名:保持下方调用点不变(接缝装配后才会真正取到 deps)──
const resolveModelAndKey = (modelId: string) => deps().brain.llm.resolveModelAndKey(modelId);
const buildProviderPayload = (opts: BuildPayloadOpts) => deps().brain.llm.buildProviderPayload(opts);
const streamProviderCompletion = (opts: StreamOpts) => deps().brain.llm.streamProviderCompletion(opts);
const canConsumeTokenPoints = (userId: string, amount: number) => deps().billing.canConsumeTokenPoints(userId, amount);
const consumeTokenPoints = (userId: string, amount: number) => deps().billing.consumeTokenPoints(userId, amount);
const calculateCost = (modelId: string, tin: number, tout: number, model?: any) => deps().billing.calculateCost(modelId, tin, tout, model);
const logApiUsage = (...args: any[]) => (deps().billing.logApiUsage as any)(...args);
const getUserById = (id: string) => deps().brain.users.getUserById(id);
const getMemory = (userId: string) => deps().brain.memory.getMemory(userId);
const getSkill = (id: string) => deps().brain.assets.getSkill(id);

// appId 来自 AppProfile(接缝①):microserver='ai-studio',standalone='tangu'。lazy 取(装配后)。
const appId = () => deps().profile.appId;
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

/** 载入近期会话历史（最近 50 条，时间正序），跳过空内容的 assistant 行避免 provider 拒绝。 */
async function hydrateHistory(sessionId: string, excludeMessageId: string): Promise<ChatMessage[]> {
  const rows = await query<any[]>(
    `SELECT id, role, content, tool_calls FROM chat_messages
     WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50`,
    [sessionId],
  );
  rows.reverse(); // 回到时间正序
  const out: ChatMessage[] = [];
  for (const r of rows) {
    if (r.id === excludeMessageId) continue;
    const role = r.role === 'model' ? 'assistant' : r.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const content = r.content || '';
    // 跳过空内容的 assistant 行（历史里以 tool_calls 收尾的轮次，无文本；空 assistant 会被部分 provider 拒绝）
    if (role === 'assistant' && !content.trim()) continue;
    out.push({ role, content } as ChatMessage);
  }
  return out;
}

/** 截断陈旧大工具结果：保留最近 keepLastN 条 tool 消息全文，更早且超 maxChars 的替换成占位。 */
function trimStaleToolMessages(msgs: ChatMessage[], keepLastN = 3, maxChars = 8000): void {
  const toolIdx: number[] = [];
  for (let i = 0; i < msgs.length; i++) if ((msgs[i] as any).role === 'tool') toolIdx.push(i);
  if (toolIdx.length <= keepLastN) return;
  const keep = new Set(toolIdx.slice(-keepLastN));
  for (const i of toolIdx) {
    if (keep.has(i)) continue;
    const m = msgs[i] as any;
    if (typeof m.content === 'string' && m.content.length > maxChars) {
      m.content = m.content.slice(0, 1500) + '\n…[较早的工具输出已截断以节省上下文]';
    }
  }
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
  // 多租户接缝:把本 run 的 userId 注入异步子树,供 worker 的 brain 适配器铸 per-user token。
  // microserver/standalone 的 brain 不读此上下文,无副作用。
  enterRunContext(userId);
  const modelId = run.model_id || '';
  const input = typeof run.input === 'string' ? safeParse(run.input) : run.input || {};
  const agentConfig = input.agentConfig || {};
  const maxIterations = Math.min(Math.max(1, agentConfig.maxIterations || 10), 30);
  const thinkingLevel: ThinkingLevel = agentConfig.thinkingLevel || 'off';
  const attachments = input.attachments || [];
  // host-exec（TUI）注入：execMode/cwd/approvalMode 只经 per-run agentConfig 传入。
  // 缺省 sandbox + full-auto → microserver/standalone-server/worker 行为零变化（审批仅 host 激活）。
  const execMode: 'sandbox' | 'host' = agentConfig.execMode === 'host' ? 'host' : 'sandbox';
  const cwd: string | undefined =
    typeof agentConfig.cwd === 'string' && agentConfig.cwd ? agentConfig.cwd : undefined;
  const approvalMode: 'readonly' | 'auto-edit' | 'full-auto' =
    agentConfig.approvalMode || (execMode === 'host' ? 'auto-edit' : 'full-auto');

  // 会话级沙箱：工作区/容器/kernel 按 (user, session) 跨消息常驻（懒 hydrate、空闲 TTL 回收）。
  // 文件工具与 run_python 都在本地操作（首次触发懒 hydrate），run 末按 sha256 diff 选择性回写 Penzor，
  // 沙箱保持温——避免每条消息全量 hydrate/snapshot 打远程 OSS（cn-beijing 单次往返 ~1-2s）。
  const sessKey = { userId, appId: appId(), sessionId };
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

    // 启用的技能（渐进式披露，对齐客户端 use_skill 机制）：
    //   ① system prompt 只放「名称 + 描述（触发契约）」目录——绝不全量注入 SKILL.md。
    //      大体量技能（pptx/docx 各 10 万+字）若每轮全量注入，单次调用就 10 万+ tokens，
    //      正是云端 token 暴涨的根因。
    //   ② 全文物化到 <appId>/.agent/skills/<id>/SKILL.md（云空间规范 + run_python 可读）。
    //   ③ 模型按需用 use_skill 工具加载某技能完整说明，只在相关时付费、且只付一次。
    const enabledSkillIds: string[] = Array.isArray(agentConfig.enabledSkillIds)
      ? agentConfig.enabledSkillIds
      : [];
    // 小体量技能(行为指令)直接内联进 prompt（始终生效）；大体量技能(参考文档，如 pptx/docx
    // 各 10 万+字)只放目录、经 use_skill 按需加载——避免每轮全量注入导致 token 暴涨。
    const INLINE_SKILL_MAX_CHARS = 8000;
    let inlineSkills: Array<{ name: string; body: string }> = [];
    let deferredSkills: Array<{ id: string; name: string; description: string }> = [];
    if (enabledSkillIds.length) {
      const skills = (
        await Promise.all(enabledSkillIds.map((id: string) => getSkill(id).catch(() => null)))
      ).filter(Boolean) as any[];
      for (const s of skills) {
        const body = String(s.content || '').trim();
        if (body && body.length <= INLINE_SKILL_MAX_CHARS) {
          inlineSkills.push({ name: s.name, body });
        } else if (body) {
          deferredSkills.push({ id: s.id, name: s.name, description: String(s.description || '').trim() });
        } else if (String(s.description || '').trim()) {
          // 无正文、仅描述：当作小指令内联
          inlineSkills.push({ name: s.name, body: String(s.description).trim() });
        }
        if (s.content) void materializeSkill(userId, appId(), s.id, s.content).catch(() => {});
      }
    }

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
    systemParts.push(
      '## 记忆与日志\n' +
        '- 遇到值得长期保留的用户事实/偏好，用 `remember` 工具记入长期记忆（跨会话保留，勿记一次性细节）。\n' +
        '- 完成的事/结论/产出可用 `log_event` 记入当天日志；需回顾历史用 `read_log` 查看某天。',
    );
    if (inlineSkills.length) {
      systemParts.push(
        '## Skill Instructions\n\n' +
          inlineSkills.map((s) => `### ${s.name}\n${s.body}`).join('\n\n---\n\n'),
      );
    }
    if (deferredSkills.length) {
      const lines = deferredSkills
        .map((s) => `- ${s.name} (id: \`${s.id}\`)${s.description ? ` — ${s.description}` : ''}`)
        .join('\n');
      systemParts.push(
        '## Available Skills (按需加载)\n' +
          '以下技能体量较大，未展开。当任务匹配某技能时，**先调用 `use_skill` 工具（传其 id）拿到完整说明书再执行**，' +
          '不要凭空假设其细节。无关的简单问题不必调用。\n\n' +
          lines,
      );
    }

    if (execMode === 'host') {
      // 本地直连形态（TUI）：真实文件系统 + shell，路径相对工作目录。沙箱/云工作区那套指引在此不适用。
      systemParts.push(
        '## 本地执行环境（重要）\n' +
          `你运行在**用户本机**，当前工作目录是 \`${cwd || process.cwd()}\`。\n` +
          '- 用 `run_bash` 执行 shell 命令；`list_dir`/`read_file` 查看；`edit_file` 做精确局部修改、`write_file` 写新文件——全部作用于真实文件系统（相对路径相对当前工作目录解析）。\n' +
          '- 优先用 `edit_file`（唯一匹配的 old_string→new_string）做小改，不要整文件重写。\n' +
          '- 破坏性操作（写文件 / 跑命令）可能需要用户审批；被拒绝时换方案或询问用户，不要反复重试同一操作。',
      );
    } else {
      // 文件输出位置（最常见的"产物丢失"原因：模型把文件写到工作区之外）。
      systemParts.push(
        '## 文件输出位置（重要）\n' +
          '本会话有一个**工作区**，是唯一会被保留并回流给用户的地方。' +
          '用 `write_file` 或在 `run_python` 里写文件时，一律用**相对路径**（如 `report.docx`、`out/data.csv`）——' +
          '它就落在工作区里（run_python 的当前目录 /workspace，等价 /mnt/data）。\n' +
          '**不要**把要交付的产物写到 `/tmp`、`~/`(HOME) 或其他绝对路径——那些不在工作区、不会保留，文件会丢失。',
      );

      // 效率约束（最影响耗时的是模型「生成量」：慢模型 ~50 tok/s，写 8000 token 要 ~160s）。
      // 引导：一步直接产出目标文件、不要重复生成内容、按需篇幅、别手搓 OOXML。
      systemParts.push(
        '## 执行效率（重要）\n' +
          '- 生成文档直接用 python-docx / openpyxl / python-pptx **一步写出目标文件**；' +
          '不要先写中间 md/txt 再转换、不要把同一份内容生成两遍、不要手搓 OOXML/XML、不用 docx-js/pandoc/node。\n' +
          '- 严格按用户要求的篇幅产出，不要无谓加长（生成越多越慢）。\n' +
          '- run_python 尽量一次写完整脚本，减少往返轮次。',
      );
    }

    const workingMessages: ChatMessage[] = [];
    if (systemParts.length) {
      workingMessages.push({ role: 'system', content: systemParts.join('\n\n') } as ChatMessage);
    }
    workingMessages.push(...history);

    // 自定义工具（HTTP/JS）：从 custom_tools 表 + 启用技能自带工具加载，喂给 LLM 并在云端执行。
    let customTools: Map<string, LoadedCustomTool> | undefined;
    try {
      const loaded = await loadCustomTools(appId(), agentConfig);
      if (loaded.length) {
        customTools = new Map(loaded.map((t) => [t.name, t]));
        console.log(`[agent-core] run=${runId} custom tools: ${loaded.map((t) => `${t.name}(${t.executor})`).join(', ')}`);
      }
    } catch (e) {
      console.warn('[agent-core] loadCustomTools failed:', e);
    }

    const toolCtx: ToolContext = {
      userId, sessionId, appId: appId(), runId, signal: ac.signal, customTools,
      enabledSkillIds, execMode, cwd, approvalMode,
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

      // 截断陈旧的大工具结果（如 13万字的 use_skill、超长 run_python 输出）：保留最近若干条全文，
      // 更早的大结果替换成占位，避免每轮重发巨量 prompt 拖慢 prefill + 烧 token。
      trimStaleToolMessages(workingMessages);

      // 最后一轮强制不再调工具，逼模型产出最终文本（避免以 tool_calls 收尾、finalContent 为空）
      const lastIter = iteration === maxIterations - 1;
      const payload = await buildProviderPayload({
        model,
        apiModelId,
        messages: workingMessages,
        projectSource: appId(),
        temperature: 0.7,
        tools: toolDefs,
        toolChoice: lastIter ? 'none' : 'auto',
        attachments: iteration === 0 ? attachments : [],
        thinkingLevel,
        stream: true,
      });

      let lastGenChars = 0; // 工具调用参数生成进度节流（每 ~600 字符播一次"生成中"）
      const res = await streamProviderCompletion({
        apiKey,
        baseUrl,
        payload,
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

      const cost = await calculateCost(modelId, res.usage.prompt_tokens, res.usage.completion_tokens);
      tokensTotal += (res.usage.prompt_tokens || 0) + (res.usage.completion_tokens || 0);
      // 把本轮 usage 播给订阅者（TUI 状态栏的实时 token / 预算用）。
      void publish(runId, 'usage', {
        prompt: res.usage.prompt_tokens || 0,
        completion: res.usage.completion_tokens || 0,
        total: tokensTotal,
        cost,
        iteration,
      });
      const consumed = await consumeTokenPoints(user.id, cost).catch(() => ({ ok: true } as any));
      await logApiUsage(
        user.username, modelId, model.name, model.provider,
        res.usage.prompt_tokens, res.usage.completion_tokens, true, undefined, appId(), cost,
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
        await publish(runId, 'tool_result', { id: call.id, name: result.name, result: result.result, isError: result.isError });
        toolResults.push({ tool_call_id: call.id, name: result.name, content: result.result, isError: result.isError });
        workingMessages.push({ role: 'tool', content: result.result, tool_call_id: call.id } as ChatMessage);
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
     ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, reasoning=EXCLUDED.reasoning, tool_calls=EXCLUDED.tool_calls, tool_results=EXCLUDED.tool_results, updated_at=NOW()`,
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
  await query(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?`, [sessionId]).catch(() => {});
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
