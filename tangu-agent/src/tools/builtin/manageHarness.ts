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
 * mode:'host':云端 sandbox 无持久 agent 目录,永不暴露。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../../seams/runContext.js';
import { applyHarnessEdit, loadHarness, appendHarnessCandidates, MAX_ENTRIES, TITLE_MAX, BODY_MAX, EVIDENCE_MAX, type HarnessEntry } from '../../agents/harnessStore.js';
import { getAgent, isValidSlug } from '../../agents/agentRegistry.js';
import { effectiveRemote, remoteManagementDenied } from '../../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../../services/agentFileSync.js';

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
            'Curate your own Working Notes (HARNESS.md) — durable lessons about HOW you should work, injected into your system prompt on every run. ' +
            'This is your self-evolution surface: you own it, changes apply immediately, and the user gets a card they can undo. Do not ask for permission or wait for /refine. ' +
            'WHEN: at a natural stopping point, once this conversation has taught you something durable about your own method — the user corrected how you work, a technique or delegation pattern proved itself, you hit a landmine you can avoid next time. ' +
            'NOT here: facts about the user or the world → remember; how the human can work with you → manage_human; a reusable step-by-step procedure (optionally with scripts) → manage_skill with scope "agent". ' +
            'NEVER record environment/setup failures, "tool X is broken" claims, transient errors, or one-off task narratives — they harden into refusals that bite you later. ' +
            'action ∈ upsert | delete | list | rollback | propose. ' +
            'upsert WITHOUT id creates an entry (needs title + body + evidence of what actually happened); upsert WITH id revises it (version bumps, old version stays recoverable). ' +
            'rollback restores an entry to its previous version (this also overwrites hand-edits made since). ' +
            'propose (with agent + candidates) suggests lessons to ANOTHER agent: they land in that agent\'s candidate inbox for it to triage — you never write another agent\'s notes directly. ' +
            `Keep entries sharp: title ≤${TITLE_MAX} chars, body ≤${BODY_MAX}, evidence ≤${EVIDENCE_MAX}, max ${MAX_ENTRIES} entries — at the cap, merge or delete weaker entries first. ` +
            'kind: "note" = working method (default); "recipe" = a delegation pattern that worked.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['upsert', 'delete', 'list', 'rollback', 'propose'], description: 'The operation' },
              agent: { type: 'string', description: 'propose: slug of the agent to propose to' },
              candidates: { type: 'array', items: { type: 'string' }, description: 'propose: 1-3 one-line lessons for that agent (each ≤300 chars)' },
              id: { type: 'string', description: 'Entry id (e.g. "h-x3k9"); required for delete/rollback; upsert with id = revise, without = create' },
              kind: { type: 'string', enum: ['note', 'recipe'], description: 'Entry type (default "note")' },
              title: { type: 'string', description: `Short label (≤${TITLE_MAX} chars; required to create)` },
              body: { type: 'string', description: `The lesson itself (≤${BODY_MAX} chars; required to create)` },
              evidence: { type: 'string', description: `What actually happened that justifies this (≤${EVIDENCE_MAX} chars; required to create)` },
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
            if (!(await getAgent(target))) return `Error: agent "${target}" does not exist`;
            const cands = (Array.isArray(args.candidates) ? args.candidates : [])
              .map((c: unknown) => String(c ?? '').replace(/\s+/g, ' ').trim().slice(0, 300))
              .filter(Boolean)
              .slice(0, 3);
            if (!cands.length) return 'Error: propose needs 1-3 non-empty candidates';
            const n = await appendHarnessCandidates(target, ctx.sessionId, cands.map((c: string) => `(proposed by ${slug}) ${c}`));
            return n ? `Proposed ${n} candidate(s) to "${target}" (they wait in its candidate inbox until it reviews them).` : `Nothing new to propose to "${target}" (duplicates of existing candidates).`;
          }
          if (action === 'list') {
            const entries = await loadHarness(slug);

            if (!entries.length) return '(working notes are empty)';
            return entries
              .map((e) => `- [${e.id}] (${e.kind}, v${e.version}, ${e.updatedAt || e.createdAt}) ${e.title} — ${e.body.replace(/\s*\n\s*/g, ' ')}${e.evidence ? ` (evidence: ${e.evidence})` : ''}`)
              .join('\n');
          }
          if (action === 'upsert' || action === 'delete' || action === 'rollback') {
            ctx.signal?.throwIfAborted();
            const { entry, before, ts, rev } = await applyHarnessEdit(
              slug,
              {
                action: action as 'upsert' | 'delete' | 'rollback',
                id: args.id != null ? String(args.id) : undefined,
                kind: args.kind != null ? String(args.kind) : undefined,
                title: args.title != null ? String(args.title) : undefined,
                body: args.body != null ? String(args.body) : undefined,
                evidence: args.evidence != null ? String(args.evidence) : undefined,
              },
              { sessionId: ctx.sessionId },
            );
            scheduleAgentFilesSync(ctx.userId); // HARNESS.md 在跨设备同步名单里(agentSyncPaths)
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
