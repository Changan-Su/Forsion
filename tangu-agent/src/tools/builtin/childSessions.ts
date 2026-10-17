/**
 * 父子会话的三个工具(services/childSessions.ts 是逻辑):
 *  - start_session / send_to_session:主会话开可见子会话、给自己的子会话再说一句(deferred,同组连坐解锁)。
 *  - wait_for_user:这一轮停下来是在等用户 → 会话列表行尾画「等你」(常驻;每一轮开始时清掉)。
 * 只在本机引擎;子代理 / 讨论 / Muse / 团队成员 / 通道 / 无人值守 run 不可见。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { AppProfile } from '../../seams/appProfile.js';
import type { ToolContext } from '../toolTypes.js';
import { effectiveRemote } from '../../services/remoteOrigin.js';
import { publish } from '../../services/eventBus.js';
import { markAwaitingUser, sendToChildSession, startChildSession } from '../../services/childSessions.js';

const guard = (profile: AppProfile, ctx: ToolContext): boolean =>
  !!profile.capabilities.hostExec && !(ctx.subAgentDepth && ctx.subAgentDepth >= 1) && !ctx.inDiscussion
  && !ctx.muse && !ctx.teamSessionId && ctx.runOrigin !== 'channel' && ctx.runOrigin !== 'unattended';

export const childSessionsProvider: ToolProvider = {
  id: 'builtin:child_sessions',
  tools: () => [
    {
      name: 'start_session',
      mode: 'both',
      isEnabledFor: guard,
      deferred: true,
      deferGroup: 'child_sessions',
      deferHint: 'Start a visible child session that works on a self-contained task in parallel and reports back to you here when done.',
      definition: {
        type: 'function',
        function: {
          name: 'start_session',
          description:
            'Start a child session: a separate, user-visible conversation (listed under this one in the session list) that works on one self-contained task on its own, '
            + 'in the same project and with your settings, while this conversation stays free. When it finishes or stops to ask something, its result comes back to you '
            + 'automatically in a <child_sessions_update> message (once no other child is still running) — you never need to poll or wait. '
            + 'Use it for independent pieces of work that take a while (research one option each, try an approach, do a separate change); '
            + 'use delegate instead for a quick lookup whose answer you need right now. One call per independent piece. '
            + 'The child cannot see this conversation, so the message must be a complete brief.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short title shown in the session list, in the user\'s language (max ~60 chars).' },
              message: { type: 'string', description: 'The complete brief: goal, the context it needs, constraints, and what done looks like.' },
            },
            required: ['title', 'message'],
          },
        },
      },
      execute: async (args, ctx) => {
        const message = String(args.message ?? '').trim();
        if (!message) return 'Error: message is required — write the complete brief for the child session.';
        if (message.length > 20_000) return 'Error: message is too long (max 20000 characters).';
        try {
          const r = await startChildSession({
            parentId: ctx.sessionId, userId: ctx.userId, modelId: ctx.modelId || ctx.profile?.defaultModelId || '',
            title: String(args.title ?? ''), message, remote: effectiveRemote(ctx),
            inherit: { execMode: ctx.execMode, cwd: ctx.cwd, extraRoots: ctx.extraRoots, workspaceProject: ctx.wsProject ?? undefined, approvalMode: ctx.approvalMode, agentSlug: ctx.agentSlug, preset: ctx.preset, thinkingLevel: ctx.thinkingLevel },
          });
          // 侧栏刷新(同 start_project_session 的 session_created;nested = 子会话,不弹「已派往项目」提示)
          if (ctx.runId) void publish(ctx.runId, 'session_created', { sessionId: r.sessionId, runId: r.runId, nested: true, parentSessionId: ctx.sessionId, title: r.title });
          return `Started child session "${r.title}" (id ${r.sessionId}). It is working on its own; its result will come back to you automatically — do not poll it, wait for it, or read it now. `
            + 'Tell the user in a sentence what you started, then end your turn or carry on with other work.';
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
    {
      name: 'send_to_session',
      mode: 'both',
      isEnabledFor: guard,
      deferred: true,
      deferGroup: 'child_sessions',
      deferHint: 'Send a follow-up message to a child session you started (answer its question, add a requirement).',
      definition: {
        type: 'function',
        function: {
          name: 'send_to_session',
          description:
            'Send a follow-up message to one of the child sessions you started with start_session — e.g. answer the question it is waiting on, or add a requirement. '
            + 'It continues in that session (queued if it is still running) and reports back to you again when done.',
          parameters: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'The child session id (from start_session or a <child_sessions_update>).' },
              message: { type: 'string', description: 'What to tell it.' },
            },
            required: ['session_id', 'message'],
          },
        },
      },
      execute: async (args, ctx) => {
        const childId = String(args.session_id ?? '').trim();
        const message = String(args.message ?? '').trim();
        if (!childId || !message) return 'Error: session_id and message are required.';
        if (message.length > 20_000) return 'Error: message is too long (max 20000 characters).';
        try {
          const r = await sendToChildSession({ parentId: ctx.sessionId, userId: ctx.userId, childId, message, remote: effectiveRemote(ctx) });
          return `Sent to "${r.title}"${r.queued ? ' (queued behind its current turn)' : ''}. Its reply will come back to you automatically.`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
    {
      name: 'wait_for_user',
      mode: 'both',
      isEnabledFor: guard,
      definition: {
        type: 'function',
        function: {
          name: 'wait_for_user',
          description:
            'Mark this conversation as waiting for the user. Call it right before ending your turn when you stopped because you need the user\'s answer, choice or approval '
            + 'before you can continue. The session list then shows it as waiting for them until they reply. Do not call it when you simply finished, or when you only offer optional next steps.',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: async (_args, ctx) => {
        await markAwaitingUser(ctx.sessionId, ctx.userId);
        return 'Marked as waiting for the user. End your turn now with your question.';
      },
    },
  ],
};
