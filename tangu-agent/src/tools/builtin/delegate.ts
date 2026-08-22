/**
 * delegate 工具:把可隔离的子任务外包给子代理(services/subAgent.ts),只把结论带回父上下文。
 * 适合大范围搜索/批量分析——中间过程不占父上下文。仅 hostExec profile(本地形态)暴露;
 * 深度上限 1(子代理内本工具不可见,见 ToolContext.subAgentDepth)。
 *
 * 子代理后端可换成外部 agent CLI(engine 参数,借 DSH 的 subagent-provider 思路):
 * 复用已有的 deps().engines(ACP 管理器),不新建注册表。装了引擎才暴露该参数。
 */
import { runSubAgent } from '../../services/subAgent.js';
import { deps } from '../../seams/runtime.js';
import type { ToolProvider } from '../toolRegistry.js';

/** 已登录可直接用的外部引擎。云端/未装 CLI → 空数组 → 不暴露 engine 参数(零噪音)。 */
function availableEngines(): Array<{ id: string; name: string }> {
  try {
    return (deps().engines?.list() || [])
      .filter((e) => e.available)
      .map((e) => ({ id: e.id, name: e.name }));
  } catch {
    return [];
  }
}

export const delegateProvider: ToolProvider = {
  id: 'builtin:delegate',
  tools: () => {
    const engines = availableEngines();
    // 参数按需追加在 properties 末尾:没装引擎的机器上工具定义与改动前逐字节一致(prompt 缓存不断)。
    const engineProp = engines.length
      ? {
          engine: {
            type: 'string',
            enum: engines.map((e) => e.id),
            description:
              `Optional: hand this subtask to an external agent CLI instead of a built-in subagent (${engines.map((e) => `${e.id} = ${e.name}`).join(', ')}). ` +
              'That CLI runs its own loop, tools, skills and model on the user\'s own subscription, in the same working directory, and its permission prompts are relayed to the user. ' +
              'It supersedes agentSlug (the engine brings its own persona); task, context, forkContext and instructions still apply. ' +
              'Use it when the user asks for a specific CLI, or for a heavy self-contained coding subtask worth a second agent\'s judgement; omit it for ordinary delegation.',
          },
        }
      : {};
    return [
      {
        name: 'delegate',
        mode: 'both',
        // 本地形态限定(云端待计费按子轮次核验后再开)+ 防递归:子代理内不可见
        isEnabledFor: (profile, ctx) => profile.capabilities.hostExec && !(ctx.subAgentDepth && ctx.subAgentDepth >= 1),
        definition: {
          type: 'function',
          function: {
            name: 'delegate',
            description:
              'Delegate an independent subtask to a subagent (its own context, the same set of tools, up to 8 turns) and return its final report. ' +
              'This is the quick, one-shot mode: fire-and-forget, no back-and-forth (for genuine multi-round deliberation with a peer, use start_discussion instead). ' +
              'Good for tasks with long intermediate steps such as broad searches or batch file analysis — the process does not consume your context, you only get the conclusion. ' +
              'Independent subtasks can run in parallel: issue several delegate calls in one turn and they execute concurrently (keep their write scopes disjoint). ' +
              'Pass agentSlug to run a specific named agent as the subagent (it takes on that agent\'s persona/model) — e.g. an agent the user @-mentioned. ' +
              'Or pass instructions to spin up an ad-hoc subagent with custom instructions you write on the fly (no saved agent needed). ' +
              'The subtask description must be self-contained (by default the subagent cannot see the current conversation; set forkContext:true to hand it a filtered transcript instead of re-typing background).',
            parameters: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'Subtask description (self-contained, clear goal, stating what to return)' },
                context: { type: 'string', description: 'Optional: background information the subagent needs (relevant paths, known conclusions, etc.)' },
                forkContext: { type: 'boolean', description: 'Optional: give the subagent a read-only transcript of this conversation so far (user and assistant messages only — no tool calls/results). Use when the subtask refers to things discussed above; default false starts clean.' },
                agentSlug: { type: 'string', description: 'Optional: delegate to a specific named agent by its slug (runs with that agent\'s persona). Use the slug of an agent the user @-mentioned; omit for a generic or ad-hoc subagent.' },
                instructions: { type: 'string', description: 'Optional: inline instructions/role for an ad-hoc subagent you create on the fly (used when no agentSlug is given) — define its focus and how to work.' },
                name: { type: 'string', description: 'Optional: a short display name for the ad-hoc subagent.' },
                ...engineProp,
              },
              required: ['task'],
            },
          },
        },
        execute: async (args, ctx) => {
          const task = String(args.task ?? '').trim();
          if (!task) return 'Error: task is required';
          const modelId = ctx.modelId || ctx.profile?.defaultModelId || '';
          if (!modelId) return 'Error: no model available (parent run carries no modelId)';
          const engineId = args.engine ? String(args.engine).trim() : '';
          if (engineId) {
            const ids = availableEngines().map((e) => e.id);
            if (!ids.includes(engineId)) {
              return `Error: unknown or unavailable engine '${engineId}'${ids.length ? ` (available: ${ids.join(', ')})` : ' (no external agent CLI is set up)'}`;
            }
            // 引擎的权限请求经父 run 的审批弹窗中继;没有 runId(Muse/自动化等无人值守 run)就没人能应答,
            // 会在 ACP requestPermission 上永久挂起 —— 提前拒绝,别 spawn。
            if (!ctx.runId) return 'Error: engine delegation needs an interactive run (its permission prompts have nowhere to go here)';
          }
          try {
            return await runSubAgent({
              task,
              context: args.context ? String(args.context) : undefined,
              forkContext: args.forkContext === true,
              parentCtx: ctx,
              modelId,
              agentSlug: args.agentSlug ? String(args.agentSlug) : undefined,
              instructions: args.instructions ? String(args.instructions) : undefined,
              name: args.name ? String(args.name) : undefined,
              engineId: engineId || undefined,
            });
          } catch (e: any) {
            // 中止(父 run 停止/registry 超时)必须重抛:registry 据 scopedCtx.signal 区分
            // 「超时→isError 提示语」与「父停→随 run 终止」;这里吞掉会把中止伪装成普通结果(Codex 评审 #4)。
            // ⚠ `message==='aborted'` 只是**自有子 loop** 的约定(subAgent.ts 自己 throw 的那个字面量);
            // 引擎路径的中止来自 ACP SDK,message 是别的(AbortError / "Query closed…")—— 必须按信号态兜底,
            // 否则超时/父停会被吞成一条普通结论。判据同 externalEngineLoop(err.name / signal.aborted)。
            if (e?.message === 'aborted' || e?.name === 'AbortError' || ctx.signal?.aborted) throw e;
            return `Error: subagent failed: ${e?.message || e}`;
          }
        },
      },
    ];
  },
};
