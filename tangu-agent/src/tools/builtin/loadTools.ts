/**
 * load_tools(P0-2,借 pi deferred-tools / Claude Code ToolSearch):按需装载 deferred 工具定义。
 * 可见性收口在 registry.getToolDefinitions:仅当存在「未解锁的 deferred 工具」且调用方提供
 * ctx.unlockTools 时进 defs;执行侧恒可达。解锁落到调用方的 run 级集合(下一迭代 defs 重算生效);
 * **严格 run-local,不跨 run 恢复**(hydrateHistory 不带 tool_calls,历史重放无数据源;与 use_skill
 * 每-run 按需同模式)——每个新 run 从精简集起步,需要时再 load 一次。
 * deferGroup 连坐:解锁组内任一成员即整组解锁(如 start/wait_discussion),防"解锁了开头没解锁收尾"。
 */
import type { ToolProvider, ToolDef } from '../toolRegistry.js';
import { resolveTools } from '../toolRegistry.js';
import { deps } from '../../seams/runtime.js';

export const loadToolsProvider: ToolProvider = {
  id: 'builtin:load-tools',
  tools: () => [
    {
      name: 'load_tools',
      mode: 'both',
      definition: {
        type: 'function',
        function: {
          name: 'load_tools',
          description:
            'Load the full definitions of tools listed in the "Additional Tools (load on demand)" section. Call once with ALL the tool names you need, wait for the result, then call those tools normally. Already-loaded or unknown names are harmless.',
          parameters: {
            type: 'object',
            properties: {
              names: {
                type: 'array',
                items: { type: 'string' },
                description: 'Exact tool names from the Additional Tools catalog, e.g. ["manage_automation"]',
              },
            },
            required: ['names'],
          },
        },
      },
      execute: async (args, ctx) => {
        const names = Array.isArray(args.names) ? (args.names as unknown[]).map(String) : [];
        if (!names.length) return 'Error: names is required — pass the tool names to load, e.g. {"names":["manage_automation"]}';
        if (!ctx.unlockTools) return 'Error: load_tools is not available in this context.';
        const profile = ctx.profile ?? deps().profile;
        const available = new Map<string, ToolDef>();
        for (const [n, t] of resolveTools(profile, ctx)) if (t.deferred) available.set(n, t);
        const toUnlock = new Set<string>();
        const unknown: string[] = [];
        for (const n of names) {
          const t = available.get(n);
          if (!t) { unknown.push(n); continue; }
          toUnlock.add(n);
          if (t.deferGroup) {
            for (const [n2, t2] of available) if (t2.deferGroup === t.deferGroup) toUnlock.add(n2);
          }
        }
        if (toUnlock.size) ctx.unlockTools([...toUnlock]);
        let msg = toUnlock.size
          ? `Loaded tool(s): ${[...toUnlock].join(', ')}. Their full definitions are now available — call them directly in your next step.`
          : 'No tools loaded.';
        if (unknown.length) msg += ` Unknown/not loadable: ${unknown.join(', ')} (use exact names from the Additional Tools catalog).`;
        return msg;
      },
    },
  ],
};
