/**
 * review_loadout —— 装备用量巡检(只读):每个 agent 的常驻工具 / 目录技能在最近 N 天被用了几次,哪些一直挂着却没人用。
 * 10-04 用户定「这部分工作交给 Muse」:Muse 每周看一次(muse.ts 播种的日程条目),只提建议(add_muse_todo),不改任何 agent。
 *
 * 可见性同 read_activity 的 Muse 那一半:本机(hostExec)且 Muse 周期(ctx.muse)或手聊 Muse(ctx.agentSlug='muse')。
 * 别的 agent 看不到 —— 这份报告横跨所有 agent 的用量。普通 run 不可见 → tooldefs 快照零扰动。
 */
import type { ToolProvider } from '../toolRegistry.js';

export const reviewLoadoutProvider: ToolProvider = {
  id: 'builtin:review_loadout',
  tools: () => [
    {
      name: 'review_loadout',
      mode: 'host',
      deferred: true, // Muse 周期全量可见(deferBypass);手聊 Muse 时走按需目录
      deferHint: 'Usage report: which always-loaded tools and listed skills each agent never or rarely used lately',
      // 'muse' = MUSE_AGENT_SLUG(硬编码避免 builtin→agentRegistry import 环,同 readActivity)
      isEnabledFor: (profile, ctx) => !!profile.capabilities.hostExec && (!!ctx.muse || ctx.agentSlug === 'muse'),
      capabilities: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 60_000 },
      definition: {
        type: 'function',
        function: {
          name: 'review_loadout',
          description:
            "Read-only usage report for a loadout review: per agent, how many runs it had in the user's own sessions, which always-loaded tools were never or rarely called, and which listed skills were never loaded. " +
            'Use it to suggest what an agent could shelve to cut per-request context. It changes nothing; agents with too few runs are marked as not judgeable and must be left alone.',
          parameters: {
            type: 'object',
            properties: {
              days: { type: 'number', description: 'Look-back window in days (default 30, min 7, max 90)' },
              agent: { type: 'string', description: 'Optional: only this agent slug' },
            },
            required: [],
          },
        },
      },
      execute: async (args, ctx) => {
        try {
          // 动态 import:loadoutUsage 要用 registry.getToolDefinitions 算各 agent 的常驻工具面,静态 import 会成环(registry → 本文件 → loadoutUsage → registry)
          const { buildLoadoutReview } = await import('../../services/loadoutUsage.js');
          return await buildLoadoutReview(ctx, { days: Number(args.days) || undefined, agent: typeof args.agent === 'string' ? args.agent : undefined });
        } catch (e: any) {
          return `Error: could not read usage data (${String(e?.message || e).slice(0, 200)}). Do not recommend anything from this cycle.`;
        }
      },
    },
  ],
};
