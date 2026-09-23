/**
 * delegate 工具:把可隔离的子任务外包给子代理(services/subAgent.ts),只把结论带回父上下文。
 * 适合大范围搜索/批量分析——中间过程不占父上下文。仅 hostExec profile(本地形态)暴露;
 * 深度上限 1(子代理内本工具不可见,见 ToolContext.subAgentDepth)。
 *
 * 子代理后端可换成外部 agent CLI(engine 参数,借 DSH 的 subagent-provider 思路):
 * 复用已有的 deps().engines(ACP 管理器),不新建注册表。装了引擎才暴露该参数。
 */
import { runSubAgent, SUB_MAX_ITERATIONS } from '../../services/subAgent.js';
import { deps } from '../../seams/runtime.js';
import { resolveTools, canonicalToolName, SUB_AGENT_GRANTABLE_TOOLS, type ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';

/**
 * grantTools 入参校验。两条硬约束(缺一子代理就可能比父代理更强):
 *   ① 名字必须是可授予的管理工具正典名(旧别名 muse_watch 先归一);
 *   ② 父代理**此刻**自己解析得出该工具 —— 判据就是主 registry 的 resolveTools(与 executeTool
 *      解析工具用的同一份口径:profile 取 ctx.profile ?? deps().profile)。云端 / 沙箱 / chat 正向面 /
 *      toolsMode 黑名单 / Muse 非 full-auto 档下,父代理本就拿不到 manage_*,自然也授不出去。
 * 第三条(engine × grantTools 互斥)不在本函数:它要先知道 engineId 合法,见 execute 里的 engine 分支。
 * 返回 { names } 或 { error }(错误措辞面向模型,英文)。
 */
function validateGrants(raw: unknown, ctx: ToolContext): { names: string[]; error?: undefined } | { names?: undefined; error: string } {
  if (raw === undefined || raw === null) return { names: [] };
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    return { error: 'Error: grantTools must be an array of tool names' };
  }
  const grantable = new Set(SUB_AGENT_GRANTABLE_TOOLS);
  const out: string[] = [];
  let available: Map<string, unknown> | null = null;
  for (const entry of raw as string[]) {
    const name = canonicalToolName(entry.trim());
    if (!grantable.has(name)) {
      return { error: `Error: unknown grantTools entry "${entry}" (grantable: ${SUB_AGENT_GRANTABLE_TOOLS.join(', ')})` };
    }
    // 懒解析:只在真有待校验名字时算一次(resolveTools 要遍历全部 provider)。
    if (!available) available = resolveTools(ctx.profile ?? deps().profile, ctx) as unknown as Map<string, unknown>;
    if (!available.has(name)) return { error: `Error: cannot grant "${name}": it is not available to you in this run` };
    if (!out.includes(name)) out.push(name); // 去重,保持给出顺序
  }
  return { names: out };
}

/** 已登录可直接用的外部引擎。云端/未装 CLI → 空数组 → 不暴露 engine 参数(零噪音)。 */
function availableEngines(): Array<{ id: string; name: string }> {
  try {
    return (deps().engines?.list() || [])
      .filter((e) => e.available)
      .map((e) => ({ id: e.id, name: e.name }));
  } catch {
    return [];
  }
}

export const delegateProvider: ToolProvider = {
  id: 'builtin:delegate',
  tools: () => {
    const engines = availableEngines();
    // 参数按需追加在 properties 末尾:没装引擎的机器上工具定义与改动前逐字节一致(prompt 缓存不断)。
    const engineProp = engines.length
      ? {
          engine: {
            type: 'string',
            enum: engines.map((e) => e.id),
            description:
              `Optional: hand this subtask to an external agent CLI instead of a built-in subagent (${engines.map((e) => `${e.id} = ${e.name}`).join(', ')}). ` +
              'That CLI runs its own loop, tools, skills and model on the user\'s own subscription, in the same working directory, and its permission prompts are relayed to the user. ' +
              'It supersedes agentSlug (the engine brings its own persona); task, context, forkContext and instructions still apply. ' +
              'Use it when the user asks for a specific CLI, or for a heavy self-contained coding subtask worth a second agent\'s judgement; omit it for ordinary delegation.',
          },
        }
      : {};
    return [
      {
        name: 'delegate',
        mode: 'both',
        // 本地形态限定(云端待计费按子轮次核验后再开)+ 防递归:子代理内不可见
        isEnabledFor: (profile, ctx) => profile.capabilities.hostExec && !(ctx.subAgentDepth && ctx.subAgentDepth >= 1),
        definition: {
          type: 'function',
          function: {
            name: 'delegate',
            // E1 三段式(§五)。agentSlug / instructions / forkContext 的用法不在这里重复——
            // 三个参数各自的 schema description 已经写全了,描述里只留「任务须自足」这条硬约束。
            // 「reduced tool set」仍是实情(防递归的 delegate/start_discussion/self_brainstorm 在子代理内不可见),
            // 但 deferred 那一半已经可取回:子代理有自己的解锁集 + 目录段(subAgent.ts),故这里要说清楚。
            description:
              `Delegate an independent subtask to a subagent (its own context, a reduced tool set that it can extend with load_tools, up to ${SUB_MAX_ITERATIONS} turns) and return its final report. ` +
              'One-shot, no back-and-forth: for long intermediate work — broad searches, batch file analysis — that should not fill your context, since you get only the conclusion. ' +
              'Several calls in one turn run in parallel (keep their write scopes disjoint). ' +
              'The task must be self-contained: the subagent cannot see this conversation unless forkContext is set. ' +
              'For multi-round deliberation with a peer, use start_discussion instead.',
            parameters: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'Subtask description (self-contained, clear goal, stating what to return)' },
                context: { type: 'string', description: 'Optional: background information the subagent needs (relevant paths, known conclusions, etc.)' },
                forkContext: { type: 'boolean', description: 'Optional: give the subagent a read-only transcript of this conversation so far (user and assistant messages only — no tool calls/results). Use when the subtask refers to things discussed above; default false starts clean.' },
                agentSlug: { type: 'string', description: 'Optional: delegate to a specific named agent by its slug (runs with that agent\'s persona). Pick a slug from the "Other Agents" list in the system prompt or one the user @-mentioned; omit for a generic or ad-hoc subagent.' },
                instructions: { type: 'string', description: 'Optional: inline instructions/role for an ad-hoc subagent you create on the fly (used when no agentSlug is given) — define its focus and how to work.' },
                name: { type: 'string', description: 'Optional: a short display name for the ad-hoc subagent.' },
                // 位置铁律:追加在 name 之后、engineProp 之前 —— 没装引擎的机器上 engineProp 为空,
                // 本属性就是 properties 的最后一项,工具定义快照是**严格追加**(旧字节逐字不动)。
                grantTools: {
                  type: 'array',
                  items: { type: 'string', enum: [...SUB_AGENT_GRANTABLE_TOOLS] },
                  description:
                    'Optional: management tools to hand to the subagent. Subagents cannot change agent, skill, automation, schedule or harness configuration unless you list those tools here. ' +
                    'Grant only what the subtask genuinely requires and only when the user asked for that change; the subagent gets the tool immediately, with the usual approval rules.',
                },
                ...engineProp,
              },
              required: ['task'],
            },
          },
        },
        execute: async (args, ctx) => {
          const task = String(args.task ?? '').trim();
          if (!task) return 'Error: task is required';
          const modelId = ctx.modelId || ctx.profile?.defaultModelId || '';
          if (!modelId) return 'Error: no model available (parent run carries no modelId)';
          // 名字校验放在 engine 分支**之前**:写错的名字是模型的错误认知,两条路都该当场纠正而不是静默丢掉。
          const grant = validateGrants(args.grantTools, ctx);
          if (grant.error !== undefined) return grant.error; // `!== undefined` 而非真值判断:后者不收窄联合
          const grantTools = grant.names;
          const engineId = args.engine ? String(args.engine).trim() : '';
          if (engineId) {
            const ids = availableEngines().map((e) => e.id);
            if (!ids.includes(engineId)) {
              return `Error: unknown or unavailable engine '${engineId}'${ids.length ? ` (available: ${ids.join(', ')})` : ' (no external agent CLI is set up)'}`;
            }
            // 引擎的权限请求经父 run 的审批弹窗中继;没有 runId(Muse/自动化等无人值守 run)就没人能应答,
            // 会在 ACP requestPermission 上永久挂起 —— 提前拒绝,别 spawn。
            if (!ctx.runId) return 'Error: engine delegation needs an interactive run (its permission prompts have nowhere to go here)';
            // engine × grantTools 互斥:外部 CLI 跑它自己的工具面,授予根本到不了它那里。原先是「校验完静默丢掉」,
            // 模型不会知道自己点名的管理工具是个空操作,而 start 事件还照发 grants —— 审计面上等于记了一条
            // 从未授出去的管理权限。宁可让这次委派失败:模型要么去掉 grantTools,要么改用内置子代理。
            if (grantTools.length) {
              return `Error: grantTools does not apply to engine delegation — '${engineId}' runs its own tools and never sees ${grantTools.join(', ')}. ` +
                'Drop grantTools, or delegate to a built-in subagent instead (omit engine).';
            }
          }
          try {
            return await runSubAgent({
              task,
              context: args.context ? String(args.context) : undefined,
              forkContext: args.forkContext === true,
              parentCtx: ctx,
              modelId,
              agentSlug: args.agentSlug ? String(args.agentSlug) : undefined,
              instructions: args.instructions ? String(args.instructions) : undefined,
              name: args.name ? String(args.name) : undefined,
              engineId: engineId || undefined,
              ...(grantTools.length ? { grantTools } : {}),
            });
          } catch (e: any) {
            // 中止(父 run 停止/registry 超时)必须重抛:registry 据 scopedCtx.signal 区分
            // 「超时→isError 提示语」与「父停→随 run 终止」;这里吞掉会把中止伪装成普通结果(Codex 评审 #4)。
            // ⚠ `message==='aborted'` 只是**自有子 loop** 的约定(subAgent.ts 自己 throw 的那个字面量);
            // 引擎路径的中止来自 ACP SDK,message 是别的(AbortError / "Query closed…")—— 必须按信号态兜底,
            // 否则超时/父停会被吞成一条普通结论。判据同 externalEngineLoop(err.name / signal.aborted)。
            if (e?.message === 'aborted' || e?.name === 'AbortError' || ctx.signal?.aborted) throw e;
            return `Error: subagent failed: ${e?.message || e}`;
          }
        },
      },
    ];
  },
};
