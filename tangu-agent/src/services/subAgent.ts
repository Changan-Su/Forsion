/**
 * delegate 子代理:在父 run 内开一个独立上下文的小 loop(无 DB 会话、无历史),
 * 把可并行/可隔离的子任务(大范围搜索、批量文件分析)外包出去,只把**结论**带回父上下文,
 * 避免父上下文被中间过程灌爆(对齐 hermes delegate_task / Claude Code Agent tool)。
 *
 * 约束:
 *   - 深度上限 1(子代理内 delegate 不可见,见 ToolContext.subAgentDepth)
 *   - maxIterations 8,单工具结果照旧 capToolResult 由各工具自管
 *   - 工具集 = 主 registry 按 subCtx 过滤(delegate 自动滤掉);审批闸门照走(host 模式)
 *   - 仅 hostExec profile 暴露(本地形态;云端待计费/配额按子轮次核验后再开)——故计费走
 *     noopBilling,这里不重复扣点;usage 经 `subagent` 事件上报给父 run 的订阅者
 */
import { v4 as uuidv4 } from 'uuid';
import { deps } from '../seams/runtime.js';
import { getToolDefinitions, executeTool, type ToolContext } from '../tools/registry.js';
import { gateToolCall } from './approvals.js';
import { publish } from './eventBus.js';
import { getAgent, resolveMemorySlug } from '../agents/agentRegistry.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { loadCustomTools } from '../tools/customTools.js';
import type { ChatMessage } from '../core/types.js';

const SUB_MAX_ITERATIONS = 8;
const SUB_RESULT_CAP = 12_000;

const SUB_SYSTEM_PROMPT =
  'You are a sub-agent: complete the assigned subtask independently, then give a **self-contained final report**.\n' +
  '- Your final reply is returned to the main agent verbatim; it cannot see your intermediate steps — all conclusions/file paths/key findings must go into the final reply\n' +
  '- Focus on the assigned subtask, do not expand the scope; verify what you can with tools\n' +
  '- Be concise: report mainly in bullet points, cite locations as file:line';

export interface SubAgentParams {
  task: string;
  context?: string;
  parentCtx: ToolContext;
  modelId: string;
  /** 具名 Normal Agent slug:子代理用它的人格(systemPrompt+SOUL)与模型/思考档跑(用户 @ 该 agent 触发)。 */
  agentSlug?: string;
  /** 内联临时人设:无 agentSlug 时,主 agent 在调用处直接给的指令/角色(Codex spawn_agent 式「自建」临时子代理)。 */
  instructions?: string;
  /** 内联临时子代理的显示名(仅事件展示)。 */
  name?: string;
}

export async function runSubAgent(p: SubAgentParams): Promise<string> {
  const { parentCtx } = p;
  const runId = parentCtx.runId || '';
  const subId = uuidv4(); // 子聊天区据此把本子代理的流式内容归到一个气泡组(同 run 内可多个子代理)
  const { llm } = deps().brain;

  // 具名 agent:载入它的人格叠在子代理契约之上;模型/思考档随它。拿不到则退回通用子代理。
  // 无 def 但带 instructions → 主 agent「自建」的临时子代理:用内联指令当人设(无文件夹 → 不写记忆日志)。
  const def = p.agentSlug ? await getAgent(p.agentSlug).catch(() => null) : null;
  const persona = def
    ? [def.systemPrompt, def.soul].map((s) => String(s || '').trim()).filter(Boolean).join('\n\n')
    : (p.instructions ? String(p.instructions).trim() : '');
  const sysPrompt = persona ? `${persona}\n\n---\n${SUB_SYSTEM_PROMPT}` : SUB_SYSTEM_PROMPT;
  const effModelId = def?.model || p.modelId;
  const thinking = (def?.thinkingLevel as any) || 'off';
  const memSlug = def ? resolveMemorySlug(def) : ''; // 具名子代理:remember/log_event 落它自己(或共用默认)

  // 具名 agent 用它自己的工具集:按 def.tools 白名单重载 custom 工具(空=不限→继承父)。
  // 内置工具仍随 profile(与主 loop 跑该 agent 时一致);MCP 同主 loop 不受 agent.tools 收窄。
  let subCustomTools = parentCtx.customTools;
  if (def && def.tools.length) {
    try {
      const loaded = await loadCustomTools(parentCtx.appId, { enabledToolIds: def.tools });
      subCustomTools = new Map(loaded.map((t) => [t.name, t]));
    } catch { /* 失败回退父工具集 */ }
  }

  const subCtx: ToolContext = {
    ...parentCtx,
    subAgentDepth: (parentCtx.subAgentDepth || 0) + 1,
    customTools: subCustomTools,
  };
  const toolDefs = getToolDefinitions(subCtx);

  const { model, apiKey, baseUrl, apiModelId } = await llm.resolveModelAndKey(effModelId);

  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt } as ChatMessage,
    {
      role: 'user',
      content: p.context ? `${p.task}\n\n## Context\n${p.context}` : p.task,
    } as ChatMessage,
  ];

  const label = def?.name || p.name || 'Subagent';
  if (runId) {
    // 向父 run 流宣告一个「子聊天」(子代理),前端据此在子聊天区建一个可切换条目。
    void publish(runId, 'subchat', { kind: 'subagent', id: subId, title: label, task: p.task.slice(0, 120) });
    void publish(runId, 'subagent', { phase: 'start', subId, label, task: p.task.slice(0, 200) });
  }

  let finalContent = '';
  for (let iteration = 0; iteration < SUB_MAX_ITERATIONS; iteration++) {
    if (parentCtx.signal?.aborted) throw new Error('aborted');
    const lastIter = iteration === SUB_MAX_ITERATIONS - 1;

    const payload = await llm.buildProviderPayload({
      model,
      apiModelId,
      messages,
      projectSource: parentCtx.appId,
      temperature: 0.7,
      // 最后一轮不发 tools(而非 toolChoice:'none'):思考模式渠道(DeepSeek 等)拒绝显式 tool_choice。
      tools: lastIter ? undefined : toolDefs,
      toolChoice: lastIter ? undefined : 'auto',
      attachments: [],
      thinkingLevel: thinking,
      stream: true,
      // 子代理用独立缓存路由键:消息序列与父会话完全不同,蹭父会话的键反而打散其缓存
      cacheKey: `${parentCtx.sessionId}:sub`,
    });

    const res = await llm.streamProviderCompletion({
      apiKey,
      baseUrl,
      payload,
      provider: (model as any)?.provider,
      signal: parentCtx.signal,
      // 流式回灌子聊天区(tag subId);主聊天不渲染 `subagent` 事件,故不会串进主气泡。
      onToken: (d) => { if (runId) void publish(runId, 'subagent', { phase: 'token', subId, delta: d }); },
      onReasoning: (d) => { if (runId) void publish(runId, 'subagent', { phase: 'reasoning', subId, delta: d }); },
      onToolCallDelta: (info) => {
        if (info.argsDelta && runId) void publish(runId, 'subagent', { phase: 'tool_stream', subId, id: info.id, name: info.name, delta: info.argsDelta });
      },
    });

    if (runId) {
      void publish(runId, 'subagent', {
        phase: 'iteration',
        subId,
        iteration,
        usage: { prompt: res.usage.prompt_tokens || 0, completion: res.usage.completion_tokens || 0 },
        toolCalls: (res.toolCalls || []).map((c) => c.function.name),
      });
    }

    if (!res.toolCalls?.length || lastIter) {
      finalContent = res.content || finalContent;
      break;
    }

    messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls } as ChatMessage);
    for (const call of res.toolCalls) {
      if (parentCtx.signal?.aborted) throw new Error('aborted');
      // 审批闸门照走(host 模式破坏性操作仍需用户批准;审批请求发到父 run 的事件流)
      const decision = await gateToolCall(
        runId,
        call,
        { sessionId: parentCtx.sessionId, execMode: parentCtx.execMode, approvalMode: parentCtx.approvalMode },
        parentCtx.signal,
      );
      let content: string;
      let isError = false;
      if (decision.action === 'reject') {
        content = 'The user rejected this operation.';
        isError = true;
      } else {
        const execCall = decision.argsOverride
          ? { ...call, function: { ...call.function, arguments: JSON.stringify(decision.argsOverride) } }
          : call;
        // 具名子代理:在它自己的记忆作用域内执行(remember/log_event 落它的文件夹),用完即恢复父作用域。
        const r = def
          ? await runWithAgentSlug(memSlug, () => executeTool(execCall, subCtx))
          : await executeTool(execCall, subCtx);
        content = r.result;
        isError = r.isError;
      }
      if (runId) {
        void publish(runId, 'subagent', {
          phase: 'tool',
          subId,
          name: call.function.name,
          args: (call.function.arguments || '').slice(0, 400),
          isError,
          preview: content.slice(0, 400),
        });
      }
      messages.push({ role: 'tool', content, tool_call_id: call.id } as ChatMessage);
    }
  }

  const result = (finalContent || '(the sub-agent produced no conclusion)').slice(0, SUB_RESULT_CAP);
  if (runId) void publish(runId, 'subagent', { phase: 'done', subId, resultChars: result.length });
  return result;
}
