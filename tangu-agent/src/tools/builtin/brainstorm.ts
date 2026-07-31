/**
 * self_brainstorm 工具:从当前上下文分裂多视角分身自我批判(services/selfBrainstorm.ts)。
 * 与 delegate(无上下文外包)/start_discussion(异人格对辩)/群聊(多人格会话)互补的第四象限:
 * 同一人格 × 完整在存上下文 × N 路批判。仅主 loop(有 getWorkingMessages 接缝)可真正执行;
 * host 形态限定 + 防递归(子代理内不可见),与 delegate 同门禁。纯推理无副作用 → 计划模式放行。
 */
import { runSelfBrainstorm } from '../../services/selfBrainstorm.js';
import type { ToolProvider } from '../toolRegistry.js';

export const brainstormProvider: ToolProvider = {
  id: 'builtin:self-brainstorm',
  tools: () => [
    {
      name: 'self_brainstorm',
      mode: 'both',
      isEnabledFor: (profile, ctx) => profile.capabilities.hostExec && !(ctx.subAgentDepth && ctx.subAgentDepth >= 1),
      definition: {
        type: 'function',
        function: {
          name: 'self_brainstorm',
          description:
            'Fork yourself into 2-4 parallel perspectives over the CURRENT conversation context to stress-test a decision before committing: independent takes, then cross-critique, then you synthesize the conclusion. ' +
            'Use only for genuinely open design choices, tradeoffs, or plans where being wrong is expensive — not for factual lookups, mechanical tasks, or anything a single pass answers; a request for thoroughness alone does not justify forking. ' +
            'Each perspective is a task contract (what it examines and what it must produce — a failure scenario, an alternative, a cost estimate), not a personality; an adversarial Challenger seat is always included. ' +
            'The forks see the whole conversation so far, have no tools, and debate in the side chat; you receive a digest of their final positions — the synthesis you then write is the deliverable, so weigh arguments rather than counting seats.',
          parameters: {
            type: 'object',
            properties: {
              topic: { type: 'string', description: 'The specific question or decision to stress-test, stated neutrally (do not bake in your current lean).' },
              perspectives: {
                type: 'array',
                description: 'Optional 1-3 custom seats tailored to this problem. Prefer problem-specific axes (e.g. "migration cost" vs "query performance") over generic personas. A Challenger seat is auto-added unless one of yours is adversarial. Omit to use the default trio (Challenger / Steelman Builder / Alternative Seeker).',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Short seat name' },
                    brief: { type: 'string', description: 'Task contract: what this seat examines and what it MUST produce.' },
                  },
                  required: ['name', 'brief'],
                },
              },
              rounds: { type: 'number', description: '1 = independent takes only; 2 (default) = takes + one cross-critique round.' },
            },
            required: ['topic'],
          },
        },
      },
      execute: async (args, ctx) => {
        const topic = String(args.topic ?? '').trim();
        if (!topic) return 'Error: topic is required';
        if (!ctx.modelId && !ctx.profile?.defaultModelId) return 'Error: no model available (parent run carries no modelId)';
        try {
          return await runSelfBrainstorm({ topic, perspectives: args.perspectives, rounds: args.rounds, ctx });
        } catch (e: any) {
          // 与 delegate 同款:中止必须重抛,registry 据 scopedCtx.signal 区分超时/父停。
          if (e?.message === 'aborted') throw e;
          return `Error: brainstorm failed: ${e?.message || e}`;
        }
      },
    },
  ],
};
