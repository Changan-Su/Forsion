/**
 * manage_harness —— agent 自维护「工作笔记」(agents/<slug>/HARNESS.md;借 prime-agent Continual
 * Harness 的 per-agent 版,评审见记忆 project_tangu_continual_harness_borrow)。
 *
 * 与 manage_skill/manage_agent 同族但三点收紧:
 *   1. 只操作**当前激活 agent** 自己的笔记(无 slug 参数,结构上摸不到别人、摸不到 SOUL/config——
 *      人格主权归用户,agent 唯一自有可进化层就是 HARNESS.md);
 *   2. capabilities.approval:'command' —— 与 run_bash 同档,readonly/auto-edit 下逐笔弹审批
 *      (manage_skill 的零审批是历史遗留,自进化写入不沿袭);
 *   3. 每笔改动经 harnessStore 唯一写点留 before/after 快照,rollback 可回滚。
 * mode:'host':云端 sandbox 无持久 agent 目录,永不暴露。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { currentAgentSlug, currentDisplayAgentSlug } from '../../seams/runContext.js';
import { applyHarnessEdit, loadHarness, appendHarnessCandidates, MAX_ENTRIES, TITLE_MAX, BODY_MAX, EVIDENCE_MAX } from '../../agents/harnessStore.js';
import { getAgent, isValidSlug } from '../../agents/agentRegistry.js';

export const manageHarnessProvider: ToolProvider = {
  id: 'builtin:manage_harness',
  tools: () => [
    {
      name: 'manage_harness',
      mode: 'host',
      deferred: true, // 低频管理面 → 按需装载(经 load_tools)
      deferHint: 'Curate your Working Notes — durable self-earned lessons about how you should work (shown in your system prompt).',
      capabilities: { approval: 'command' }, // 自进化写入走审批档(readonly/auto-edit 逐笔批)
      definition: {
        type: 'function',
        function: {
          name: 'manage_harness',
          description:
            'Curate your own Working Notes — durable lessons about HOW you should work for this user, injected into your system prompt every session (per-agent; this is your self-evolution surface). ' +
            'Use after reflecting on a conversation (e.g. the /refine flow). action ∈ upsert | delete | list | rollback | propose. ' +
            'propose (with agent + candidates) suggests lessons to ANOTHER agent: they land in that agent\'s candidate inbox and are only adopted when it next runs /refine — you never write another agent\'s notes directly. ' +
            'upsert WITHOUT id creates an entry (needs title + body + evidence of what actually happened); upsert WITH id revises it (version bumps, old version stays recoverable). ' +
            'rollback restores an entry to its previous version (this also overwrites hand-edits made since). ' +
            `Keep entries sharp: title ≤${TITLE_MAX} chars, body ≤${BODY_MAX}, evidence ≤${EVIDENCE_MAX}, max ${MAX_ENTRIES} entries — at the cap, merge or delete weaker entries first. ` +
            'kind: "note" = working method (default); "recipe" = a delegation pattern that worked. ' +
            'Record only durable lessons: repeated user corrections, proven techniques, delegation recipes. ' +
            'NEVER record environment/setup failures, "tool X is broken" claims, transient errors, or one-off task narratives — they harden into refusals that bite you later. ' +
            'For reusable step-by-step procedures (optionally with scripts), prefer manage_skill with scope "agent" instead.',
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
        // 展示身份优先:prompt 注入槽用的是 activeAgentSlug,写入必须落同一个文件夹——
        // shareDefaultMemory 的 agent 其 currentAgentSlug()=xyra,拿它写会写进别人家(Codex 评审 #3)。
        const slug = currentDisplayAgentSlug() || currentAgentSlug() || DEFAULT_AGENT_SLUG;
        const action = String(args.action || '');
        try {
          if (action === 'propose') {
            // 只追加对方的候选收件箱(.harness-raw.md),不碰 HARNESS.md:候选是提名非资产,采纳权在对方的 /refine。
            const target = String(args.agent || '').trim();
            if (!target || !isValidSlug(target)) return 'Error: propose needs a valid agent slug';
            if (!(await getAgent(target))) return `Error: agent "${target}" does not exist`;
            const cands = (Array.isArray(args.candidates) ? args.candidates : [])
              .map((c: unknown) => String(c ?? '').replace(/\s+/g, ' ').trim().slice(0, 300))
              .filter(Boolean)
              .slice(0, 3);
            if (!cands.length) return 'Error: propose needs 1-3 non-empty candidates';
            const n = await appendHarnessCandidates(target, ctx.sessionId, cands.map((c: string) => `(proposed by ${slug}) ${c}`));
            return n ? `Proposed ${n} candidate(s) to "${target}" (adopted only if it accepts them at its next /refine).` : `Nothing new to propose to "${target}" (duplicates of existing candidates).`;
          }
          if (action === 'list') {
            const entries = await loadHarness(slug);

            if (!entries.length) return '(working notes are empty)';
            return entries
              .map((e) => `- [${e.id}] (${e.kind}, v${e.version}, ${e.updatedAt || e.createdAt}) ${e.title} — ${e.body.replace(/\s*\n\s*/g, ' ')}${e.evidence ? ` (evidence: ${e.evidence})` : ''}`)
              .join('\n');
          }
          if (action === 'upsert' || action === 'delete' || action === 'rollback') {
            const { entry, before } = await applyHarnessEdit(
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
            if (action === 'delete') return `已删除笔记 ${String(args.id)}(journal 留有快照,可 rollback 恢复)`;
            if (action === 'rollback') {
              return entry
                ? `已回滚 ${entry.id} 到上一版(v${entry.version});再次 rollback 会恢复回滚前内容`
                : `已回滚:${String(args.id)} 的新建被撤销(条目已移除)`;
            }
            return before
              ? `已修订笔记 ${entry!.id}(v${entry!.version}):${entry!.title}。下一场会话起生效`
              : `已新建笔记 ${entry!.id}:${entry!.title}。下一场会话起生效(本场系统提示不重建)`;
          }
          return `Error: 未知 action: ${action}`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
