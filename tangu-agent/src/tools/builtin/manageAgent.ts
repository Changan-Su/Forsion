/**
 * manage_agent —— 让运行中的 agent 自创建/改写本地 Normal Agent 定义（参考 hermes 的 skill_manage：
 * agent 沉淀「人格」为可复用资产）。落盘 `~/.tangu/agents/<slug>.md`，created_by=agent。
 *
 * mode:'host' → 仅本地 host 会话可见；云端(sandbox 强制 + hostExec=false)永不暴露。
 * 写文件经 agentLoop 的审批闸门（与其它 host 写工具同档）。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { listAgents, getAgent, saveAgent, deleteAgent, slugify, isValidSlug } from '../../agents/agentRegistry.js';
import { THINKING_LEVELS } from '../../llm/modelCapabilities.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../../seams/runContext.js';

/** 自我判定用展示身份优先:shareDefaultMemory 的 agent 其 currentAgentSlug()=xyra,拿它比对会漏拦自己。 */
const selfSlug = (): string | undefined => currentDisplayAgentSlug() || currentAgentSlug();

export const manageAgentProvider: ToolProvider = {
  id: 'builtin:manage_agent',
  tools: () => [
    {
      name: 'manage_agent',
      mode: 'host',
      deferred: true, // P0-2:1.7KB schema,低频管理面 → 按需装载
      deferHint: 'Create or update a local agent (name/persona/model).',
      definition: {
        type: 'function',
        function: {
          name: 'manage_agent',
          description:
            'Create/update/delete/list local "Normal Agents" (a reusable conversational persona = system prompt + model + tools + settings). ' +
            'When you discover a role/way of working worth reusing, use action="create" to capture it as an agent for the user to select later. ' +
            'action ∈ create | update | delete | list. create/update require name and system_prompt.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create', 'update', 'delete', 'list'], description: 'The operation' },
              slug: { type: 'string', description: 'Unique agent identifier (lowercase alphanumerics and hyphens); required for update/delete, optional for create (derived from name)' },
              name: { type: 'string', description: 'Display name (required for create/update)' },
              description: { type: 'string', description: 'One-sentence summary' },
              system_prompt: { type: 'string', description: 'The agent\'s development instructions (what to do / how to do it / what to read; required for create/update)' },
              soul: { type: 'string', description: 'Persona definition (SOUL.md; tone/values; optional)' },
              model: { type: 'string', description: 'Model id that overrides the session model (optional)' },
              tools: { type: 'array', items: { type: 'string' }, description: 'Allowlist of enabled custom/MCP tool ids (optional)' },
              thinking_level: { type: 'string', enum: [...THINKING_LEVELS], description: 'Thinking intensity (optional)' },
              max_iterations: { type: 'number', description: 'Maximum number of loop iterations (optional)' },
              approval_mode: { type: 'string', enum: ['readonly', 'auto-edit', 'full-auto'], description: 'Approval level (optional)' },
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
            // 不能删除自己:删了再 create 同 slug = 绕过下面的人格守卫(Codex 评审 #2)。
            if (slug === selfSlug()) return 'Error: 不能删除自己(当前激活的 agent);请用户在设置里操作。';
            const ok = await deleteAgent(slug);
            return ok ? `已删除 agent: ${slug}` : `未找到 agent: ${slug}`;
          }
          if (action === 'create' || action === 'update') {
            if (!args.name || !args.system_prompt) return 'Error: create/update 需要 name 与 system_prompt';
            // slug 归一必须与 saveAgent 的落盘规则一致(非法 slug → slugify(name)),否则可以用
            // 大写等非法变体让守卫查不到 existing、saveAgent 却归一回自己的 slug(Codex 评审 #2)。
            const requested = args.slug ? String(args.slug) : '';
            const slug = requested && isValidSlug(requested) ? requested : slugify(String(args.name));
            const existing = await getAgent(slug);
            if (action === 'update' && !existing) return `Error: 未找到要更新的 agent: ${slug}`;
            // 人格主权:不能改写**自己**的人格——system_prompt/SOUL 归用户所有(create 撞自己 slug 同样拦,
            // saveAgent 对已存在 slug 是覆盖)。运行参数(model/tools/thinking 等)放行:那是自调参,不是人格漂移。
            // agent 自有的可进化层是 HARNESS.md(manage_harness)。
            if (slug === selfSlug()) {
              const soulChanged = args.soul != null && String(args.soul) !== (existing?.soul || '');
              if (!existing || String(args.system_prompt) !== existing.systemPrompt || soulChanged) {
                return 'Error: 不能修改自己的人格(system_prompt/SOUL 归用户所有)。运行参数(model/tools/thinking_level 等)可改——原样回传现有 system_prompt 即可;工作方法的沉淀请用 manage_harness。';
              }
            }
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
              soul: args.soul != null ? String(args.soul) : undefined,
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
