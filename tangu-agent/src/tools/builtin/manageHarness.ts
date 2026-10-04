/**
 * manage_harness —— agent 自维护「工作笔记」(agents/<slug>/HARNESS.md;借 prime-agent Continual
 * Harness 的 per-agent 版,评审见记忆 project_tangu_continual_harness_borrow)。
 *
 * 10-04 用户裁决「HARNESS 和 HUMAN 都应该是 Agent 自己放开的」→ 与 manage_human 同一做法:
 *   - **常驻**(教训出现在任何一轮,不能要求先 load_tools);coding 预设例外,见 core/presetTable 的 CODING_PRESET_DEFERRED;
 *   - **不逐笔审批、立即生效**:回执是 JSON(kind:'harness_update'),桌面据此在对话里渲染一张可撤销的卡 ——
 *     卡片就是原来审批的位置(事后可撤,而不是事前拦)。
 * 仍然收紧的三点:
 *   1. 只操作**当前激活 agent** 自己的笔记(无 slug 参数,结构上摸不到别人、摸不到 SOUL/config——
 *      人格主权归用户,agent 唯一自有可进化层就是 HARNESS.md);给别的 agent 只能 propose 进它的候选收件箱;
 *   2. 远程污点 run 只许 list;临时成员(ephemeral)没有自己的文件夹,不可见;子代理缺省硬闸(toolRegistry.SUB_AGENT_DENY_TOOLS);
 *   3. 每笔改动经 harnessStore 唯一写点留 before/after 快照,rollback 可回滚。
 * 装备层(kind 'equip',10-04):agent 给自己**收起**少用的工具 / 技能 —— 只有收起这一个方向(工具改走按需目录、技能不再列目录),
 * 不删能力、更不能给自己加能力;名字在这里按「此刻真的有、且收得起」核过才落盘(读侧 toolRegistry.isShelvable 再认一遍)。
 * mode:'host':云端 sandbox 无持久 agent 目录,永不暴露。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { resolveTools, isDeferredIn, isShelvable } from '../toolRegistry.js';
import { deps } from '../../seams/runtime.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../../seams/runContext.js';
import { applyHarnessEdit, loadHarness, appendHarnessCandidates, MAX_ENTRIES, TITLE_MAX, BODY_MAX, EVIDENCE_MAX, type HarnessEntry } from '../../agents/harnessStore.js';
import { getAgent, isValidSlug } from '../../agents/agentRegistry.js';
import { effectiveRemote, remoteManagementDenied } from '../../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../../services/agentFileSync.js';

/** propose 一条候选的字数上限(候选进对方 /refine 那一轮的提示,所以要有上限)。 */
const PROPOSE_MAX = 1000;

/** 回执里的一次改动(桌面 services/harnessUpdates.ts 按这个形状校验后渲染撤销卡;字段只增不改)。
 *  rev = 这次改动的 journal 行身份,卡片用它认「我这次改动」:撤销时原样带回(expectRev),对不上就不撤。 */
export interface HarnessChange {
  rev: string;
  at: string;
  agent: string;
  entryId: string;
  action: 'create' | 'revise' | 'delete' | 'rollback';
  kind: string;
  title: string;
  body: string;
  evidence: string;
  version: number;
  /** kind 'equip':改完之后这一条收起的工具 / 技能。 */
  tools?: string[];
  skills?: string[];
}

const names = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : undefined);

/** 收起之前先核名字:工具必须是这个 agent 此刻解析得到的注册表工具(内置 / 插件;MCP 与会话自定义工具不过 deferred 这条路)、
 *  不在保护名单、且不是本来就按需;技能必须在本 run 准许 use_skill 的清单里。返回给模型看的英文说明,null = 没问题。 */
function equipProblem(ctx: ToolContext, tools: string[], skills: string[]): string | null {
  const base = { ...ctx, shelvedTools: undefined }; // 修订时自己已收起的那几个不能算「本来就按需」
  const visible = resolveTools(ctx.profile ?? deps().profile, base);
  const unknown = tools.filter((n) => !visible.has(n));
  if (unknown.length) return `unknown tool name(s): ${unknown.join(', ')}. Shelve only tools from your own tool list, by exact name (MCP and session custom tools cannot be shelved).`;
  const fixed = tools.filter((n) => !isShelvable(n));
  if (fixed.length) return `${fixed.join(', ')} cannot be shelved: they are how you load tools, use skills, keep your own memory and notes, or undo this.`;
  const already = tools.filter((n) => isDeferredIn(base, n, visible.get(n)?.deferred));
  if (already.length) return `${already.join(', ')} already load on demand, so shelving them saves nothing; leave them out.`;
  const allowed = new Set(ctx.enabledSkillIds ?? []);
  const badSkills = skills.filter((id) => !allowed.has(id));
  if (badSkills.length) return `unknown skill id(s): ${badSkills.join(', ')}. Use the exact ids from your skill list (e.g. "local:name").`;
  return null;
}

const receipt = (change: HarnessChange): string =>
  JSON.stringify({ kind: 'harness_update', change, message: 'Applied immediately; your next run reads this version. The user sees an update card and can undo it.' });

export const manageHarnessProvider: ToolProvider = {
  id: 'builtin:manage_harness',
  tools: () => [
    {
      name: 'manage_harness',
      mode: 'host',
      // 门禁工具 → 另在 toolRegistry.LOADOUT_GATED 里登记,用户仍能按 agent 用工具名单关掉它。
      // 计划模式 / 子代理 / 远程由共享层管(PLAN_MODE_TOOLS、SUB_AGENT_DENY_TOOLS、下面的 remoteManagementDenied),这里只补两条:
      // 没有本机 agent 目录的 profile(云端)与临时成员(ephemeral)—— 都没有自己的 HARNESS.md 可写。
      isEnabledFor: (profile, ctx) => !!profile.capabilities.hostExec && !ctx.ephemeral,
      capabilities: { sideEffect: 'write', concurrencyKey: 'harness' },
      definition: {
        type: 'function',
        function: {
          name: 'manage_harness',
          description:
            'Your Working Notes (HARNESS.md): durable lessons about HOW you work, loaded into your system prompt on every run. You own them: changes apply at once and the user gets a card to undo, so do not ask permission or wait for /refine. ' +
            'Use it when this conversation taught you something lasting about your own method: the user corrected how you work, a technique or delegation pattern proved itself, a pitfall you can avoid next time. ' +
            'Elsewhere: facts about the user or the world → remember; how the human can work with you → manage_human; a reusable procedure → manage_skill (scope "agent"). ' +
            // 10-04 真实场景量跑:grok 把同一句纠正同时写进这里、协作说明和记忆(三处都进系统提示;撤销一张卡,另外两处还在)
            'One lesson, one place: if you are saving a point with remember or manage_human, do not repeat it here. ' +
            'Never record environment/setup failures, "tool X is broken", transient errors or one-off task stories; they harden into refusals. ' +
            'upsert without id creates an entry (title, body and evidence of what actually happened are required); with id it revises. rollback restores the previous version. ' +
            "propose (agent + candidates) drops suggestions into ANOTHER agent's candidate inbox; you never write its notes. " +
            `Limits: title ≤${TITLE_MAX}, body ≤${BODY_MAX}, evidence ≤${EVIDENCE_MAX} chars, ${MAX_ENTRIES} entries; at the cap, merge or delete weaker ones. ` +
            'kind "note" = working method (default); "recipe" = a delegation pattern that worked; "equip" = shelve tools/skills you rarely use to keep your context lean (pass tools / skills): a shelved tool moves to the load-on-demand catalog (load_tools brings it back), a shelved skill leaves your skill list (use_skill by id still works). ' +
            'Shelving never removes or grants a capability; shelve on evidence such as a usage review, and revise or delete the entry to undo.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['upsert', 'delete', 'list', 'rollback', 'propose'], description: 'The operation' },
              agent: { type: 'string', description: 'propose: target agent slug' },
              candidates: { type: 'array', items: { type: 'string' }, description: 'propose: 1-3 one-line lessons' },
              id: { type: 'string', description: 'Entry id, e.g. "h-x3k9" (delete / rollback / revise)' },
              kind: { type: 'string', enum: ['note', 'recipe', 'equip'], description: 'Entry type (default "note")' },
              tools: { type: 'array', items: { type: 'string' }, description: 'equip: exact tool names to shelve (replaces the list on revise)' },
              skills: { type: 'array', items: { type: 'string' }, description: 'equip: exact skill ids to shelve, e.g. "local:pptx" (replaces the list on revise)' },
              title: { type: 'string', description: 'Short label' },
              body: { type: 'string', description: 'The lesson itself' },
              evidence: { type: 'string', description: 'What actually happened that justifies it' },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args, ctx) => {
        if (ctx.ephemeral) return 'Error: Working notes are unavailable in this execution context.';
        // 展示身份优先:prompt 注入槽用的是 activeAgentSlug,写入必须落同一个文件夹——
        // shareDefaultMemory 的 agent 其 currentAgentSlug()=xyra,拿它写会写进别人家(Codex 评审 #3)。
        const slug = currentDisplayAgentSlug() || currentAgentSlug() || DEFAULT_AGENT_SLUG;
        const action = String(args.action || '');
        // 远程污点 run 只许 list(P0 第三轮,Codex 评审 P1):工作笔记注入下一次本机 run 的系统提示;propose 写别的 Agent 的候选收件箱。
        const remoteDenied = effectiveRemote(ctx) ? remoteManagementDenied('manage_harness', args.action) : null;
        if (remoteDenied) return `Error: ${remoteDenied}`;
        try {
          if (action === 'propose') {
            // 只追加对方的候选收件箱(.harness-raw.md),不碰 HARNESS.md:候选是提名非资产,采纳权在对方自己。
            const target = String(args.agent || '').trim();
            if (!target || !isValidSlug(target)) return 'Error: propose needs a valid agent slug';
            // 自己的笔记直接写:给自己提名只会躺在候选收件箱里等 /refine(10-04 live:接手巡检建议的 agent 照着「propose」给自己提了名,什么都没收起)
            if (target === slug) return 'Error: propose is for ANOTHER agent. These are your own notes: use action "upsert" (kind "equip" with tools / skills to shelve your own equipment).';
            if (!(await getAgent(target))) return `Error: agent "${target}" does not exist`;
            const cands = (Array.isArray(args.candidates) ? args.candidates : [])
              .map((c: unknown) => String(c ?? '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .slice(0, 3);
            if (!cands.length) return 'Error: propose needs 1-3 non-empty candidates';
            // 超长就报错让对方缩短,不静默截断:一个 agent 的装备建议(8 工具 + 8 技能,带次数)要放得下。
            // 10-04 live:原先截到 300 字,正好切在技能名中间,对方复盘时以「信息不完整」为由一项没采纳。
            const long = cands.find((c: string) => c.length > PROPOSE_MAX);
            if (long) return `Error: a candidate is ${long.length} characters; keep each within ${PROPOSE_MAX} (shorten it, or split it into separate candidates)`;
            const n = await appendHarnessCandidates(target, ctx.sessionId, cands.map((c: string) => `(proposed by ${slug}) ${c}`));
            return n ? `Proposed ${n} candidate(s) to "${target}" (they wait in its candidate inbox until it reviews them).` : `Nothing new to propose to "${target}" (duplicates of existing candidates).`;
          }
          if (action === 'list') {
            const entries = await loadHarness(slug);

            if (!entries.length) return '(working notes are empty)';
            return entries
              .map((e) => `- [${e.id}] (${e.kind}, v${e.version}, ${e.updatedAt || e.createdAt}) ${e.title} — ${e.tools?.length ? `tools: ${e.tools.join(', ')}; ` : ''}${e.skills?.length ? `skills: ${e.skills.join(', ')}; ` : ''}${e.body.replace(/\s*\n\s*/g, ' ')}${e.evidence ? ` (evidence: ${e.evidence})` : ''}`)
              .join('\n');
          }
          if (action === 'upsert' || action === 'delete' || action === 'rollback') {
            ctx.signal?.throwIfAborted();
            const tools = names(args.tools), skills = names(args.skills);
            if (action === 'upsert' && (tools?.length || skills?.length)) {
              const problem = equipProblem(ctx, tools ?? [], skills ?? []);
              if (problem) return `Error: ${problem}`;
            }
            const { entry, before, ts, rev } = await applyHarnessEdit(
              slug,
              {
                action: action as 'upsert' | 'delete' | 'rollback',
                id: args.id != null ? String(args.id) : undefined,
                kind: args.kind != null ? String(args.kind) : undefined,
                title: args.title != null ? String(args.title) : undefined,
                body: args.body != null ? String(args.body) : undefined,
                evidence: args.evidence != null ? String(args.evidence) : undefined,
                tools,
                skills,
              },
              { sessionId: ctx.sessionId },
            );
            scheduleAgentFilesSync(ctx.userId, slug); // HARNESS.md 在跨设备同步名单里(agentSyncPaths);不带 slug 这个调用是空操作
            // 卡片展示的是「改完之后的样子」;删除 / 撤掉一次新建后条目已不在,就拿改动前的那份来说明删的是什么。
            const shown = (entry ?? before) as HarnessEntry | null;
            if (!shown) return 'Nothing to roll back: that entry no longer exists.'; // journal 说「新建前」是空,而条目又被手改删掉了
            return receipt({
              rev,
              at: ts,
              agent: slug,
              entryId: shown.id,
              action: action === 'upsert' ? (before ? 'revise' : 'create') : (action as 'delete' | 'rollback'),
              kind: shown.kind,
              title: shown.title,
              body: shown.body,
              evidence: shown.evidence || '',
              version: shown.version,
              ...(shown.tools?.length ? { tools: shown.tools } : {}),
              ...(shown.skills?.length ? { skills: shown.skills } : {}),
            });
          }
          return `Error: unknown action: ${action}`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
