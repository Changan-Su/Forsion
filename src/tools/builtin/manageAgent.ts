/**
 * manage_agent —— 让运行中的 agent 自创建/改写本地 Normal Agent 定义（参考 hermes 的 skill_manage：
 * agent 沉淀「人格」为可复用资产）。落盘 `~/.tangu/agents/<slug>.md`，created_by=agent。
 *
 * mode:'host' → 仅本地 host 会话可见；云端(sandbox 强制 + hostExec=false)永不暴露。
 * 写文件经 agentLoop 的审批闸门（与其它 host 写工具同档）。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { listAgents, getAgent, saveAgent, deleteAgent, slugify } from '../../agents/agentRegistry.js';

export const manageAgentProvider: ToolProvider = {
  id: 'builtin:manage_agent',
  tools: () => [
    {
      name: 'manage_agent',
      mode: 'host',
      definition: {
        type: 'function',
        function: {
          name: 'manage_agent',
          description:
            '创建/更新/删除/列出本地「Normal Agent」（可复用的对话人格 = system prompt + 模型 + 工具 + 设置）。' +
            '当你发现一种值得复用的角色/工作方式时，可用 action="create" 把它沉淀为一个 agent，供用户之后选用。' +
            'action ∈ create | update | delete | list。create/update 需 name 与 system_prompt。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create', 'update', 'delete', 'list'], description: '操作' },
              slug: { type: 'string', description: 'agent 唯一标识(小写字母数字与连字符);update/delete 必填,create 可省(由 name 派生)' },
              name: { type: 'string', description: '显示名(create/update 必填)' },
              description: { type: 'string', description: '一句话简介' },
              system_prompt: { type: 'string', description: '该 agent 的 system prompt / 人格(create/update 必填)' },
              model: { type: 'string', description: '覆盖会话模型的模型 id(可省)' },
              tools: { type: 'array', items: { type: 'string' }, description: '启用的 custom/MCP 工具 id 白名单(可省)' },
              thinking_level: { type: 'string', enum: ['off', 'low', 'medium', 'high'], description: '思考强度(可省)' },
              max_iterations: { type: 'number', description: '最大循环轮数(可省)' },
              approval_mode: { type: 'string', enum: ['readonly', 'auto-edit', 'full-auto'], description: '审批档(可省)' },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args) => {
        const action = String(args.action || '');
        try {
          if (action === 'list') {
            const all = await listAgents();
            if (!all.length) return '(no local agents)';
            return all.map((a) => `- ${a.slug}: ${a.name}${a.description ? ` — ${a.description}` : ''}`).join('\n');
          }
          if (action === 'delete') {
            const slug = String(args.slug || '');
            if (!slug) return 'Error: delete 需要 slug';
            const ok = await deleteAgent(slug);
            return ok ? `已删除 agent: ${slug}` : `未找到 agent: ${slug}`;
          }
          if (action === 'create' || action === 'update') {
            if (!args.name || !args.system_prompt) return 'Error: create/update 需要 name 与 system_prompt';
            const slug = args.slug ? String(args.slug) : slugify(String(args.name));
            if (action === 'update' && !(await getAgent(slug))) return `Error: 未找到要更新的 agent: ${slug}`;
            const def = await saveAgent({
              slug,
              name: String(args.name),
              description: args.description != null ? String(args.description) : undefined,
              model: args.model != null ? String(args.model) : undefined,
              tools: Array.isArray(args.tools) ? args.tools.map((t: any) => String(t)) : undefined,
              thinkingLevel: args.thinking_level,
              maxIterations: args.max_iterations != null ? Number(args.max_iterations) : undefined,
              approvalMode: args.approval_mode,
              systemPrompt: String(args.system_prompt),
              createdBy: 'agent',
            });
            return `已${action === 'create' ? '创建' : '更新'} agent: ${def.slug}（${def.name}）。用户可在设置/输入栏选用它。`;
          }
          return `Error: 未知 action: ${action}`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
