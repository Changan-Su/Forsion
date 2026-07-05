/**
 * delegate 工具:把可隔离的子任务外包给子代理(services/subAgent.ts),只把结论带回父上下文。
 * 适合大范围搜索/批量分析——中间过程不占父上下文。仅 hostExec profile(本地形态)暴露;
 * 深度上限 1(子代理内本工具不可见,见 ToolContext.subAgentDepth)。
 */
import { runSubAgent } from '../../services/subAgent.js';
import type { ToolProvider } from '../toolRegistry.js';

export const delegateProvider: ToolProvider = {
  id: 'builtin:delegate',
  tools: () => [
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
            'Pass agentSlug to run a specific named agent as the subagent (it takes on that agent\'s persona/model) — e.g. an agent the user @-mentioned. ' +
            'Or pass instructions to spin up an ad-hoc subagent with custom instructions you write on the fly (no saved agent needed). ' +
            'The subtask description must be self-contained (the subagent cannot see the current conversation).',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Subtask description (self-contained, clear goal, stating what to return)' },
              context: { type: 'string', description: 'Optional: background information the subagent needs (relevant paths, known conclusions, etc.)' },
              agentSlug: { type: 'string', description: 'Optional: delegate to a specific named agent by its slug (runs with that agent\'s persona). Use the slug of an agent the user @-mentioned; omit for a generic or ad-hoc subagent.' },
              instructions: { type: 'string', description: 'Optional: inline instructions/role for an ad-hoc subagent you create on the fly (used when no agentSlug is given) — define its focus and how to work.' },
              name: { type: 'string', description: 'Optional: a short display name for the ad-hoc subagent.' },
            },
            required: ['task'],
          },
        },
      },
      execute: async (args, ctx) => {
        const task = String(args.task ?? '').trim();
        if (!task) return 'Error: task is required';
        const modelId = ctx.modelId || ctx.profile?.defaultModelId || '';
        if (!modelId) return 'Error: 无可用模型(父 run 未带 modelId)';
        try {
          return await runSubAgent({
            task,
            context: args.context ? String(args.context) : undefined,
            parentCtx: ctx,
            modelId,
            agentSlug: args.agentSlug ? String(args.agentSlug) : undefined,
            instructions: args.instructions ? String(args.instructions) : undefined,
            name: args.name ? String(args.name) : undefined,
          });
        } catch (e: any) {
          return `Error: 子代理失败: ${e?.message || e}`;
        }
      },
    },
  ],
};
