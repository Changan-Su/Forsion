/**
 * 父子会话的工具(services/childSessions.ts 是逻辑):
 *  - start_session:主会话开可见子会话(context fork = 带上这段对话)。
 *  - send_to_session / list_linked_sessions:同一棵树里互发消息(自己的子会话 / 主会话 / 兄弟)与列出它们(deferred,同组连坐解锁)。
 *  「等你」不靠模型声明(live 10-17:GPT 6 Luna 三次都没调专门的工具):收尾问句由引擎兜底(childSessions.markIfAsked),阻塞询问走 ask_user。
 * 只在本机引擎;子代理 / 讨论 / Muse / 团队成员 / 通道 / 无人值守 run 不可见。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { AppProfile } from '../../seams/appProfile.js';
import type { ToolContext } from '../toolTypes.js';
import { effectiveRemote } from '../../services/remoteOrigin.js';
import { publish } from '../../services/eventBus.js';
import { listLinkedSessions, sendSessionMessage, startChildSession } from '../../services/childSessions.js';

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
      // 不延迟加载:延迟时「开子会话」常被常驻的 delegate 抢走(live 10-17 两次里一次)。send_to_session 留延迟:回报行里点了它的名。
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
            + 'By default (context "fresh") the child cannot see this conversation, so the message must be a complete brief. '
            + 'Pass context "fork" when the task leans on a lot of what was discussed here: the child then also gets this conversation so far as background (the brief still says what to do). '
            + 'The child can message you back with send_to_session.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short title shown in the session list, in the user\'s language (max ~60 chars).' },
              message: { type: 'string', description: 'The complete brief: goal, the context it needs, constraints, and what done looks like.' },
              context: { type: 'string', enum: ['fresh', 'fork'], description: '"fresh" (default): the child sees only the brief. "fork": it also gets this conversation so far.' },
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
            title: String(args.title ?? ''), message, remote: effectiveRemote(ctx), fork: args.context === 'fork',
            parentMessages: args.context === 'fork' ? ctx.getWorkingMessages?.() : undefined,
            inherit: { execMode: ctx.execMode, cwd: ctx.cwd, extraRoots: ctx.extraRoots, workspaceProject: ctx.wsProject ?? undefined, approvalMode: ctx.approvalMode, agentSlug: ctx.agentSlug, preset: ctx.preset, thinkingLevel: ctx.thinkingLevel },
          });
          // 侧栏刷新(同 start_project_session 的 session_created;nested = 子会话,不弹「已派往项目」提示)
          if (ctx.runId) void publish(ctx.runId, 'session_created', { sessionId: r.sessionId, runId: r.runId, nested: true, parentSessionId: ctx.sessionId, title: r.title });
          return `Started child session "${r.title}" (id ${r.sessionId})${args.context === 'fork' ? (r.forked ? ' with this conversation as background' : ' (this conversation could not be attached; it has only the brief)') : ''}. It is working on its own; its result will come back to you automatically — do not poll it, check on it, message it, or read it now, and do not also do its task yourself. `
            + 'Tell the user in a sentence what you started, then end your turn or carry on with other work that is not delegated.';
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
      deferHint: 'Message a linked session: a child you started, the session that started you, or a sibling (answer a question, add a requirement, hand over a finding).',
      definition: {
        type: 'function',
        function: {
          name: 'send_to_session',
          description:
            'Send a message to a linked session. To a child session you started: answer the question it is waiting on or add a requirement; it continues '
            + '(queued if it is still running) and reports back to you again when done. To the session that started you (session_id "parent") or a sibling '
            + '(another child of it): it arrives in their conversation as a <session_message> and they act on it in their own turn; they reply only if they '
            + 'choose to, with send_to_session — do not wait or poll for it. Use list_linked_sessions to find ids. '
            + 'Never use it to check on, nudge or hurry a session that is still working: results and replies arrive on their own. Do not send messages just to acknowledge.',
          parameters: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'The session id (from start_session, a <child_sessions_update>, a <session_message> or list_linked_sessions), or "parent".' },
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
          const r = await sendSessionMessage({ fromId: ctx.sessionId, userId: ctx.userId, toId: childId, message, remote: effectiveRemote(ctx) });
          if (r.relation === 'child') return `Sent to "${r.title}"${r.queued ? ' (queued behind its current turn)' : ''}. Its reply will come back to you automatically.`;
          if (r.rowOnly) return `Added to "${r.title}", but it will not start a turn there now (too many messages back and forth without the user). They will see it on their next turn. Do not send it again.`;
          return `Sent to "${r.title}"${r.queued ? ' (queued behind its current turn)' : ''}. Carry on with your own work; a reply, if any, arrives as a <session_message>.`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
    {
      name: 'list_linked_sessions',
      mode: 'both',
      isEnabledFor: guard,
      deferred: true,
      deferGroup: 'child_sessions',
      deferHint: 'List the sessions you can message (parent, siblings, children) to find their ids.',
      capabilities: { sideEffect: 'read', parallel: true },
      definition: {
        type: 'function',
        function: {
          name: 'list_linked_sessions',
          description: 'List the sessions linked to this one that send_to_session can reach — the session that started you, its other child sessions (siblings), and the child sessions you started — with id and title. '
            + 'It is for finding who to message, not for checking progress: results of child sessions come back to you automatically.',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: async (_args, ctx) => {
        const rows = await listLinkedSessions(ctx.sessionId, ctx.userId);
        if (!rows.length) return 'No linked sessions: this conversation has no parent, siblings or child sessions.';
        return rows.map((r) => `- ${r.relation}: "${r.title}" (id ${r.id})`).join('\n');
      },
    },
  ],
};
