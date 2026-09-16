/**
 * start_project_session —— 私聊里「@项目派遣」(新工作区 × 轨道体系 P4,方案 §5.4;拍板 ④:actor 是 Agent)。
 * Agent 在自己的私聊里被用户 @ 了某个项目 → 调本工具在**该项目**新建一条可见的用户会话(kind='user',进侧栏),并以给定指令起首个 run;
 * 私聊会话本身不动。新会话跑的是同一个 Agent 的人格(agentSlug 随 ctx),cwd = 项目目录,host 模式;审批走该会话自己的同步审批
 * (会话在侧栏可见、带运行中指示,用户点进去批;不做无人值守排队 —— 那是 Muse 的口径,派遣时用户在场)。
 * 仅 host 形态;子代理内 / 讨论 run 内不可见(防递归);deferred(低频,1KB schema)。
 */
import { v4 as uuidv4 } from 'uuid';
import { statSync } from 'node:fs';
import path from 'node:path';
import { query } from '../../core/db.js';
import { createRun } from '../../services/runStore.js';
import { publish } from '../../services/eventBus.js';
import type { ToolProvider } from '../toolRegistry.js';
import type { AppProfile } from '../../seams/appProfile.js';
import type { ToolContext } from '../toolTypes.js';

const guard = (profile: AppProfile, ctx: ToolContext): boolean =>
  !!profile.capabilities.hostExec && !(ctx.subAgentDepth && ctx.subAgentDepth >= 1) && !ctx.inDiscussion;

export interface DispatchInput {
  userId: string; appId: string; modelId: string; agentSlug?: string;
  projectPath: string; projectName?: string; title?: string; message: string; parentSessionId?: string;
}

/** 建项目会话 + 首个 run(纯逻辑,路由/工具共用;不检查目录存在,调用方先验)。返回新会话与 run 的 id。 */
export async function dispatchProjectSession(p: DispatchInput): Promise<{ sessionId: string; runId: string }> {
  const sessionId = uuidv4();
  const projectName = (p.projectName || path.basename(p.projectPath) || 'Project').slice(0, 255);
  const title = (p.title || p.message).replace(/\s+/g, ' ').trim().slice(0, 80) || 'New Chat';
  const agentConfig: Record<string, unknown> = { execMode: 'host', cwd: p.projectPath, preset: null, ...(p.agentSlug ? { agentSlug: p.agentSlug } : {}) };
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, project_path, project_name, projectless, agent_config, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, p.userId, p.appId, title, p.modelId || null, p.projectPath.slice(0, 1000), projectName, false, JSON.stringify(agentConfig), p.parentSessionId || null],
  );
  const runId = uuidv4();
  await createRun({
    id: runId, sessionId, userId: p.userId, appId: p.appId, modelId: p.modelId, assistantMessageId: uuidv4(),
    input: { message: p.message, userMessageId: uuidv4(), attachments: [], agentConfig },
  });
  const { enqueueRun } = await import('../../services/agentLoop.js');
  enqueueRun(sessionId, runId);
  return { sessionId, runId };
}

export const dispatchProvider: ToolProvider = {
  id: 'builtin:dispatch',
  tools: () => [
    {
      name: 'start_project_session',
      mode: 'both',
      isEnabledFor: guard,
      deferred: true,
      deferGroup: 'dispatch',
      deferHint: 'Open a new visible session in a project directory and start working there (used when the user @-mentions a project in a direct chat).',
      definition: {
        type: 'function',
        function: {
          name: 'start_project_session',
          description:
            'Start a new, user-visible session in a project directory and kick it off with a self-contained instruction. ' +
            'Use it when the user asks you (in a direct chat) to go do something in a specific project — you keep talking here while the work proceeds there. ' +
            'The new session runs with your persona in that directory; it may pause for the user’s approval on risky actions, which they answer inside that session. ' +
            'Returns the new sessionId. Do not call it for work that belongs in the current conversation.',
          parameters: {
            type: 'object',
            properties: {
              project_path: { type: 'string', description: 'Absolute path of the project directory (from the @-mention).' },
              message: { type: 'string', description: 'The first instruction for that session — self-contained (it cannot see this conversation): goal, constraints, what done looks like.' },
              project_name: { type: 'string', description: 'Optional display name of the project (defaults to the directory name).' },
              title: { type: 'string', description: 'Optional session title (defaults to the first line of message).' },
            },
            required: ['project_path', 'message'],
          },
        },
      },
      execute: async (args, ctx) => {
        const projectPath = String(args.project_path ?? '').trim();
        const message = String(args.message ?? '').trim();
        if (!projectPath || !path.isAbsolute(projectPath)) return 'Error: project_path must be an absolute directory path';
        if (!message) return 'Error: message is required';
        try { if (!statSync(projectPath).isDirectory()) return 'Error: project_path is not a directory'; } catch { return 'Error: project_path does not exist'; }
        const modelId = ctx.modelId || ctx.profile?.defaultModelId || '';
        if (!modelId) return 'Error: no model available (the run carries no modelId)';
        try {
          const { sessionId, runId } = await dispatchProjectSession({
            userId: ctx.userId, appId: ctx.appId, modelId, agentSlug: ctx.agentSlug,
            projectPath, projectName: args.project_name ? String(args.project_name) : undefined, title: args.title ? String(args.title) : undefined,
            message, parentSessionId: ctx.sessionId,
          });
          // 侧栏被告知(方案 §5.4 硬化 ②):前端据此刷新会话列表并提示;不等 listSessions 轮询(它没有轮询)。
          if (ctx.runId) void publish(ctx.runId, 'session_created', { sessionId, runId, projectPath, projectName: args.project_name ? String(args.project_name) : path.basename(projectPath) });
          return `Started session ${sessionId} in ${projectPath} (run ${runId}). It is now listed in the sidebar under that project; the user can open it to follow along or approve actions. Keep helping here.`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
