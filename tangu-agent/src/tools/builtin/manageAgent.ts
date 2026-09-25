/**
 * manage_agent —— 让运行中的 agent 自创建/改写本地 Normal Agent 定义（参考 hermes 的 skill_manage：
 * agent 沉淀「人格」为可复用资产）。落盘 `~/.tangu/agents/<slug>.md`，created_by=agent。
 *
 * mode:'host' → 仅本地 host 会话可见；云端(sandbox 强制 + hostExec=false)永不暴露。
 * 审批:create / update 是「控制面」(approvals.controlPlaneCall)—— 询问我批准 / 替我批准两档每次都问、
 * 不进「总允许」,完全放行档放过;list / delete 免批(delete 另有「不能删自己」守卫)。
 * (旧头注说「写文件经审批闸门、与 host 写工具同档」不属实:本工具不在写工具集合里,曾在所有档位免批。)
 * approval_mode 不对模型开放:审批档只归用户在设置里改;模型传了就报错、什么都不写。
 * update 时模型省略的字段一律保留原值(buildAgentDef 对省略项会写空,在本调用点兜住,不改它的公共语义)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { listAgents, getAgent, saveAgent, deleteAgent, slugify, isValidSlug, AGENT_MAX_ITERATIONS_MIN, DEFAULT_MAX_ITERATIONS, KEEP_APPROVAL_MODE } from '../../agents/agentRegistry.js';
import { THINKING_LEVELS } from '../../llm/modelCapabilities.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../../seams/runContext.js';

/** 自我判定用展示身份优先:shareDefaultMemory 的 agent 其 currentAgentSlug()=xyra,拿它比对会漏拦自己。 */
const selfSlug = (): string | undefined => currentDisplayAgentSlug() || currentAgentSlug();
/** 「自己」= 当前执行身份 ∪ 委派方(ctx.subAgentDelegator):被委派的具名子代理在自己的 ALS 里跑,
 *  父代理会变成「别人」—— 不连委派方一起保护,父代理借子代理之手就能删改父代理自己(Codex 09-15 复审 #1)。 */
const isSelf = (slug: string, ctx: { subAgentDelegator?: string }): boolean =>
  slug === selfSlug() || (!!ctx.subAgentDelegator && slug === ctx.subAgentDelegator);

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
              max_iterations: { type: 'number', description: `Maximum loop iterations per turn (optional, at least ${AGENT_MAX_ITERATIONS_MIN}; an agent may raise its own cap but never lower it)` },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args, ctx) => {
        const action = String(args.action || '');
        try {
          if (action === 'list') {
            const all = await listAgents();
            if (!all.length) return '(no local agents)';
            return all.map((a) => `- ${a.slug}: ${a.name}${a.description ? ` — ${a.description}` : ''}`).join('\n');
          }
          if (action === 'delete') {
            const slug = String(args.slug || '');
            if (!slug) return 'Error: delete requires slug.';
            // 不能删除自己:删了再 create 同 slug = 绕过下面的人格守卫(Codex 评审 #2)。
            if (isSelf(slug, ctx)) return 'Error: you cannot delete yourself (the active agent). Ask the user to do it in Settings.';
            const ok = await deleteAgent(slug);
            return ok ? `Deleted agent: ${slug}` : `Agent not found: ${slug}`;
          }
          if (action === 'create' || action === 'update') {
            // 审批档只归用户(H2):schema 里已删,模型照旧传 → 报错且不落盘(同 update_session_settings 的先例)。
            // 错误语要告诉模型怎么改:捆绑技能等旧材料可能还教它传 approval_mode,别让它卡在这一步。
            if (args.approval_mode !== undefined) return 'Error: approval_mode can only be changed by the user in Settings. Nothing was saved; call again without approval_mode.';
            if (!args.name || !args.system_prompt) return 'Error: create/update requires name and system_prompt.';
            // slug 归一必须与 saveAgent 的落盘规则一致(非法 slug → slugify(name)),否则可以用
            // 大写等非法变体让守卫查不到 existing、saveAgent 却归一回自己的 slug(Codex 评审 #2)。
            const requested = args.slug ? String(args.slug) : '';
            const slug = requested && isValidSlug(requested) ? requested : slugify(String(args.name));
            const existing = await getAgent(slug);
            if (action === 'update' && !existing) return `Error: agent not found: ${slug} (use action=list to see agents).`;
            // 人格主权:不能改写**自己**的人格——system_prompt/SOUL 归用户所有(create 撞自己 slug 同样拦,
            // saveAgent 对已存在 slug 是覆盖)。运行参数(model/tools/thinking 等)放行:那是自调参,不是人格漂移。
            // agent 自有的可进化层是 HARNESS.md(manage_harness)。
            if (isSelf(slug, ctx)) {
              const soulChanged = args.soul != null && String(args.soul) !== (existing?.soul || '');
              if (!existing || String(args.system_prompt) !== existing.systemPrompt || soulChanged) {
                return 'Error: you cannot change your own persona (system_prompt / SOUL belong to the user). You may change run parameters (model, tools, thinking_level, ...) by passing your current system_prompt back unchanged; record working methods with manage_harness instead.';
              }
            }
            // 轮数:低于下限一律拒(与 routes/agents 同口径);对**自己**只许持平或调高 —— 模型给自己写个 3,之后每回合
            // 两次工具调用就收尾,用户在会话里看不出是谁改的(09-13 导出实证)。
            if (args.max_iterations != null) {
              const want = Number(args.max_iterations);
              if (!Number.isFinite(want) || want < AGENT_MAX_ITERATIONS_MIN) return `Error: max_iterations must be at least ${AGENT_MAX_ITERATIONS_MIN} (got ${args.max_iterations}).`;
              const cur = existing?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
              if (isSelf(slug, ctx) && want < cur) return `Error: an agent may not lower its own max_iterations (current ${cur}, requested ${want}). Keep it or raise it; only the user can lower it in Settings.`;
            }
            // 省略 ≠ 清空(H2):buildAgentDef 对 description / model / tools / thinkingLevel / approvalMode 的省略项写空,
            // 而 approvalMode 写空 = 激活时回落 auto-edit —— 用户设成只读的 Agent 被模型改一次模型就悄悄放宽。
            // 覆盖同 slug 的 create(saveAgent 对已存在 slug 是覆盖)同样保留:existing 在就按它补。
            const def = await saveAgent({
              slug,
              name: String(args.name),
              description: args.description != null ? String(args.description) : existing?.description,
              model: args.model != null ? String(args.model) : existing?.model,
              tools: Array.isArray(args.tools) ? args.tools.map((t: any) => String(t)) : existing?.tools,
              thinkingLevel: args.thinking_level != null ? args.thinking_level : (existing?.thinkingLevel || undefined),
              // 省略 ≠ 清空:否则 update 只改 model 就把自己的 150 降回默认 90,上面的「不许自降」守卫形同虚设(Codex 09-13 #1)
              maxIterations: args.max_iterations != null ? Number(args.max_iterations) : (existing?.maxIterations ?? undefined),
              // 永不取自模型参数,也不取上面先读的 existing:从那次读到落盘之间用户可能刚在设置里收紧了档,
              // 传旧值会把它写回去(Codex 09-25 P1)。KEEP = saveAgent 在按 slug 串行化的保存里现读现留;
              // 此刻 slug 不存在 → 空(同全新 create)。先读到了却在保存前被删 → mustExist 让它报错,不悄悄新建一个空档的。
              // 反过来:预读时不存在(按「新建」批的)、保存前冒出一个同 slug 的 → mustNotExist 报错,不把指令写进一个可能是
              // full-auto 的现成 Agent;模型重来一次,审批卡就会如实写「overwrites existing agent · approval tier stays …」(09-25 #5)。
              approvalMode: KEEP_APPROVAL_MODE,
              mustExist: action === 'update' || !!existing,
              mustNotExist: action === 'create' && !existing,
              systemPrompt: String(args.system_prompt),
              soul: args.soul != null ? String(args.soul) : undefined,
              createdBy: 'agent',
            });
            // create 撞上已有 slug = 覆盖(设计如此,见上;readonly / auto-edit 的审批卡已写「overwrites」),但完全放行档不弹卡 ——
            // 回执必须点破,否则纯中文名不带 slug(slugify → 'agent')连建两个,模型两次都以为「建好了」,第一个已被悄悄替换。
            const verb = action === 'update'
              ? 'Updated agent'
              : existing ? 'Overwrote existing agent' : 'Created agent';
            const overwrote = action === 'create' && existing
              ? ' It replaced the agent that already had this slug; fields you omitted were kept from that agent. To add a separate agent, pass a different slug.'
              : '';
            return `${verb}: ${def.slug} (${def.name}).${overwrote} The user can select it in Settings or from the chat input bar.`;
          }
          return `Error: unknown action: ${action}`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
