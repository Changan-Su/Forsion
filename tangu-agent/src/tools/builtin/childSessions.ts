/**
 * 父子会话的工具(services/childSessions.ts 是逻辑):
 *  - start_session:主会话开可见子会话(context fork = 带上这段对话)。
 *  - hand_off_task:做到一半用户换了话题 → 手头没做完的挪成独立会话(带这段对话),这里接着答新话题(方案「会话互通升级」11-08)。
 *  - send_to_session / list_linked_sessions:互发消息(自己的子会话 / 主会话 / 兄弟,11-08 起也能发给树外这个用户的别的会话)与列出同一棵树(deferred,同组连坐解锁)。
 *  「等你」不靠模型声明(live 10-17:GPT 6 Luna 三次都没调专门的工具):收尾问句由引擎兜底(childSessions.markIfAsked),阻塞询问走 ask_user。
 * 只在本机引擎;子代理 / 讨论 / Muse / 团队成员 / 通道 / 无人值守 run 不可见。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { AppProfile } from '../../seams/appProfile.js';
import type { ToolContext } from '../toolTypes.js';
import { effectiveRemote } from '../../services/remoteOrigin.js';
import { publish } from '../../services/eventBus.js';
import { THINKING_LEVELS } from '../../llm/modelCapabilities.js';
import { runApprovalCap } from '../../services/approvals.js';
import { childThinkingLevel, handOffTask, listLinkedSessions, resolveChildModel, sendSessionMessage, startChildSession } from '../../services/childSessions.js';

/** 这一轮被会话互发钳过的审批上限(approvals.runApprovalCap):开子会话 / 挪出去 / 再转发都带下去,不经派生放大(Codex 11-08)。 */
const runCap = (ctx: { runId?: string }) => (ctx.runId ? runApprovalCap(ctx.runId) : undefined);

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
            + 'Choose context every time: "fresh" — the child sees only your brief, so the brief must be complete; '
            + '"fork" — the child also gets this conversation so far as background (the brief still says what to do). '
            + 'If your brief relies on anything said or read here ("the conversation above", "what we discussed", a file you just read) and does not spell it out, you must use "fork" — a fresh child sees none of it and will guess. '
            + 'The child can message you back with send_to_session. '
            + 'Optionally pick a cheaper model for read-only work (research, counting, searching) with model; leave it out to use this session\'s model, and keep this session\'s model for writing code. '
            + 'This is for pieces of the user\'s request that you split off yourself. When the user names a separate job that does not belong in this conversation, do not start it on your own: '
            + 'offer it with an ask card and let them choose — ```forsion-task\ntitle: <short title>\nask: true\n---\n<complete brief>\n``` (buttons "New session" / "Do it here"; nothing starts until they pick).',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short title shown in the session list, in the user\'s language (max ~60 chars).' },
              message: { type: 'string', description: 'The complete brief: goal, the context it needs, constraints, and what done looks like.' },
              context: { type: 'string', enum: ['fresh', 'fork'], description: '"fresh": the child sees only the brief. "fork": it also gets this conversation so far. Use "fork" whenever the brief leans on this conversation.' },
              model: { type: 'string', description: 'Optional model for the child (id or part of a name, e.g. "kimi"). Omit to use this session\'s model.' },
              thinking_level: { type: 'string', enum: [...THINKING_LEVELS], description: 'Optional thinking level for the child. Omit to use this session\'s.' },
            },
            // context 必填(同 Claude 的 start_session):选填时 live 10-28 模型写「根据上面的对话」却不传 fork,子会话照着空气编(2/3)
            required: ['title', 'message', 'context'],
          },
        },
      },
      execute: async (args, ctx) => {
        const message = String(args.message ?? '').trim();
        if (!message) return 'Error: message is required — write the complete brief for the child session.';
        if (message.length > 20_000) return 'Error: message is too long (max 20000 characters).';
        try {
          const picked = typeof args.model === 'string' && args.model.trim() ? await resolveChildModel(args.model) : {};
          const level = typeof args.thinking_level === 'string' ? childThinkingLevel(args.thinking_level) : undefined;
          const r = await startChildSession({
            parentId: ctx.sessionId, userId: ctx.userId, modelId: ctx.modelId || ctx.profile?.defaultModelId || '',
            title: String(args.title ?? ''), message, remote: effectiveRemote(ctx), fork: args.context === 'fork',
            parentMessages: args.context === 'fork' ? ctx.getWorkingMessages?.() : undefined,
            inherit: { execMode: ctx.execMode, cwd: ctx.cwd, extraRoots: ctx.extraRoots, workspaceProject: ctx.wsProject ?? undefined, approvalMode: ctx.approvalMode, agentSlug: ctx.agentSlug, preset: ctx.preset, thinkingLevel: ctx.thinkingLevel },
            approvalCap: runCap(ctx),
            ...(picked.id ? { model: picked.id } : {}), ...(level ? { thinkingLevel: level } : {}),
          });
          // 侧栏刷新(同 start_project_session 的 session_created;nested = 子会话,不弹「已派往项目」提示)
          if (ctx.runId) void publish(ctx.runId, 'session_created', { sessionId: r.sessionId, runId: r.runId, nested: true, parentSessionId: ctx.sessionId, title: r.title });
          return `Started child session "${r.title}" (id ${r.sessionId})${args.context === 'fork' ? (r.forked ? ' with this conversation as background' : ' (this conversation could not be attached; it has only the brief)') : ''}${picked.id ? ` on ${picked.id}` : ''}. ${picked.note ? `${picked.note} ` : ''}It is working on its own; its result will come back to you automatically — do not poll it, check on it, message it, or read it now, and do not also do its task yourself. `
            + 'Tell the user in a sentence what you started, then end your turn or carry on with other work that is not delegated.';
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
    {
      name: 'hand_off_task',
      mode: 'both',
      isEnabledFor: guard,
      // 不延迟加载:要在用户插话的那一轮里当场想得到它(同 start_session)
      definition: {
        type: 'function',
        function: {
          name: 'hand_off_task',
          description:
            'Move the task you are in the middle of into its own session, so this conversation is free for the user\'s new topic. '
            + 'Use it when, while you are still working on a task, the user sends a message about something unrelated — a different subject, not a correction, constraint, follow-up or progress question about the current task — '
            + 'or when a <new_topic> note tells you to. The new session gets this conversation as background plus your brief, continues the task on its own, and is listed in the user\'s session list; '
            + 'when it finishes it leaves one line here, and this conversation does not resume the task. '
            + 'After calling it, tell the user in one sentence that the task moved, then answer their new message here. '
            + 'Do not use it when the task is already finished, when the new message is about the current task, or for new work the user has not started yet (use start_session for that).',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short title for the moved task, shown in the session list, in the user\'s language (max ~60 chars).' },
              brief: { type: 'string', description: 'What the task is, what is already done, what is left (the unchecked items of your checklist), and exactly where you stopped.' },
            },
            required: ['title', 'brief'],
          },
        },
      },
      execute: async (args, ctx) => {
        const brief = String(args.brief ?? '').trim();
        if (!brief) return 'Error: brief is required — say what is done, what is left and where you stopped.';
        if (brief.length > 20_000) return 'Error: brief is too long (max 20000 characters).';
        try {
          const r = await handOffTask({
            fromId: ctx.sessionId, userId: ctx.userId, modelId: ctx.modelId || ctx.profile?.defaultModelId || '',
            title: String(args.title ?? ''), brief, remote: effectiveRemote(ctx), parentMessages: ctx.getWorkingMessages?.(),
            inherit: { execMode: ctx.execMode, cwd: ctx.cwd, extraRoots: ctx.extraRoots, workspaceProject: ctx.wsProject ?? undefined, approvalMode: ctx.approvalMode, agentSlug: ctx.agentSlug, preset: ctx.preset, thinkingLevel: ctx.thinkingLevel },
            approvalCap: runCap(ctx),
          });
          if (ctx.runId) void publish(ctx.runId, 'session_created', { sessionId: r.sessionId, runId: r.runId, nested: true, parentSessionId: r.parentId, title: r.title });
          return `Moved the unfinished task to a new session "${r.title}" (id ${r.sessionId})${r.forked ? ' with this conversation as background' : ''}. It continues there on its own and leaves a line here when done. `
            + 'Do not continue that task here, and do not check on it. Tell the user in one sentence that it moved, then answer their new message.';
        } catch (e: any) {
          return `Error: ${e?.message || e}. The task was not moved — answer the user\'s new message briefly, then carry on with the task here.`;
        }
      },
    },
    {
      name: 'send_to_session',
      mode: 'both',
      isEnabledFor: guard,
      deferred: true,
      deferGroup: 'child_sessions',
      deferHint: 'Message another session: a child you started, the session that started you, a sibling, or any other of the user\'s sessions by id (answer a question, add a requirement, hand over a finding, ask it something).',
      definition: {
        type: 'function',
        function: {
          name: 'send_to_session',
          description:
            'Send a message to a linked session. To a child session you started: answer the question it is waiting on or add a requirement; it continues '
            + '(queued if it is still running) and reports back to you again when done. To the session that started you (session_id "parent") or a sibling '
            + '(another child of it): it arrives in their conversation as a <session_message> and they act on it in their own turn; they reply only if they '
            + 'choose to, with send_to_session — do not wait or poll for it. Use list_linked_sessions to find ids. '
            + 'You can also message any other of the user\'s sessions outside this tree, by id (from search_sessions or a session reference in the conversation); it arrives the same way, '
            + 'and that session\'s turn runs with an approval level no looser than yours. Archived sessions, Muse, external-engine chats and sessions connected to a messaging channel cannot receive messages. '
            + 'Never use it to check on, nudge or hurry a session that is still working: results and replies arrive on their own. Do not send messages just to acknowledge.',
          parameters: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'The session id (from start_session, a <child_sessions_update>, a <session_message>, list_linked_sessions or search_sessions), or "parent".' },
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
          const r = await sendSessionMessage({ fromId: ctx.sessionId, userId: ctx.userId, toId: childId, message, remote: effectiveRemote(ctx), senderMode: ctx.approvalMode, senderCap: runCap(ctx) });
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
          description: 'List the sessions in this session tree — the session that started you, its other child sessions (siblings), and the child sessions you started — with id and title. To find other sessions of the user, use search_sessions. '
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
