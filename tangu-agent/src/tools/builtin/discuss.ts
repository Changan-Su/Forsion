/**
 * start_discussion / wait_discussion(Mode B):主 agent「分身」一个自己进后台 2 人群聊,和对象 agent
 * 来回讨论到投票结束(services/discussion.ts)。start 立即返回句柄(后台跑,主 run 不阻塞),
 * wait 按句柄取结论(跑完直接返回、没跑完就阻塞等)——主 agent「继续处理主进程 / 需要时再等」二者皆可。
 *
 * 仅 host 形态暴露(分身要起后台 run + 读本地 agents 人设);防递归:子代理内 / 讨论 run 内不可见。
 */
import { startDiscussion, waitDiscussion } from '../../services/discussion.js';
import { publish } from '../../services/eventBus.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import type { ToolProvider } from '../toolRegistry.js';
import type { AppProfile } from '../../seams/appProfile.js';
import type { ToolContext } from '../toolTypes.js';

// host-only + 防递归:子代理内(subAgentDepth≥1)、讨论 run 内(inDiscussion)均不可见。
const guard = (profile: AppProfile, ctx: ToolContext): boolean =>
  !!profile.capabilities.hostExec && !(ctx.subAgentDepth && ctx.subAgentDepth >= 1) && !ctx.inDiscussion;

export const discussProvider: ToolProvider = {
  id: 'builtin:discuss',
  tools: () => [
    {
      name: 'start_discussion',
      mode: 'both',
      isEnabledFor: guard,
      definition: {
        type: 'function',
        function: {
          name: 'start_discussion',
          description:
            'Spawn a background discussion: a fork of yourself debates a peer agent over several rounds until both vote to end, then a moderator synthesizes a conclusion. ' +
            'Returns a discussionId immediately and runs in the background (non-blocking) — you can keep working and call wait_discussion later, or call it right away to block until the conclusion is ready. ' +
            'Use this (instead of delegate) when the task benefits from genuine back-and-forth deliberation with another agent rather than a one-shot subtask. ' +
            'Provide peer (a named agent slug, e.g. one the user @-mentioned) OR instructions (to spin up an ad-hoc peer). The topic must be self-contained (the peer cannot see this conversation).',
          parameters: {
            type: 'object',
            properties: {
              topic: { type: 'string', description: 'What to discuss / the question to deliberate (self-contained — frame it fully; the peer cannot see your conversation).' },
              peer: { type: 'string', description: 'Optional: a named agent slug to discuss with (use the slug of an @-mentioned agent). Provide peer OR instructions.' },
              instructions: { type: 'string', description: 'Optional: inline persona/role for an ad-hoc peer when no named agent fits. Provide peer OR instructions.' },
              context: { type: 'string', description: 'Optional: background the peer needs (relevant paths, constraints, known facts).' },
              maxRounds: { type: 'number', description: 'Optional: how deep the discussion may go (rounds; default 7, max 30). Voting can end it earlier.' },
            },
            required: ['topic'],
          },
        },
      },
      execute: async (args, ctx) => {
        const topic = String(args.topic ?? '').trim();
        if (!topic) return 'Error: topic is required';
        const peer = args.peer ? String(args.peer).trim() : '';
        const instructions = args.instructions ? String(args.instructions).trim() : '';
        if (!peer && !instructions) return 'Error: provide peer (a named agent slug) or instructions (an ad-hoc peer)';
        const modelId = ctx.modelId || ctx.profile?.defaultModelId || '';
        if (!modelId) return 'Error: no model available (the run carries no modelId)';
        try {
          const discId = await startDiscussion({
            userId: ctx.userId,
            appId: ctx.appId,
            modelId,
            selfSlug: ctx.agentSlug || DEFAULT_AGENT_SLUG,
            peerSlug: peer || undefined,
            peerInstructions: instructions || undefined,
            topic,
            context: args.context ? String(args.context) : undefined,
            maxRounds: typeof args.maxRounds === 'number' ? args.maxRounds : undefined,
            parentSessionId: ctx.sessionId, // Background Session 父链接:子聊天面板经 /background 持久列出
          });
          // 向父 run 流宣告一个「子聊天」(讨论);前端据此在子聊天区建条目并订阅该讨论 run 的事件流。
          if (ctx.runId) void publish(ctx.runId, 'subchat', { kind: 'discussion', id: discId, runId: discId, title: topic.slice(0, 80) });
          return `Discussion started in the background (discussionId: ${discId}). Call wait_discussion with this id to get the conclusion — now if you need it to proceed, or after you finish other work.`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
    {
      name: 'wait_discussion',
      mode: 'both',
      isEnabledFor: guard,
      definition: {
        type: 'function',
        function: {
          name: 'wait_discussion',
          description:
            'Retrieve the conclusion of a background discussion started with start_discussion. If it has finished, returns the synthesized conclusion immediately; if it is still running, blocks until it finishes (then returns the conclusion). ' +
            'If it is taking too long it returns the discussion so far plus a note — you may call it again.',
          parameters: {
            type: 'object',
            properties: {
              discussionId: { type: 'string', description: 'The discussionId returned by start_discussion.' },
            },
            required: ['discussionId'],
          },
        },
      },
      execute: async (args, ctx) => {
        const id = String(args.discussionId ?? '').trim();
        if (!id) return 'Error: discussionId is required';
        try {
          return await waitDiscussion(id, ctx.userId, ctx.signal);
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
