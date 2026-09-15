/**
 * load_tools(P0-2,借 pi deferred-tools / Claude Code ToolSearch):按需装载 deferred 工具定义。
 * 可见性收口在 registry.getToolDefinitions:仅当存在「未解锁的 deferred 工具」且调用方提供
 * ctx.unlockTools 时进 defs;执行侧恒可达。解锁落到调用方的 run 级集合(下一迭代 defs 重算生效);
 * **严格 run-local**:历史可重放执行证据,但不据此绕过当前权限或自动解锁工具。
 * deferGroup 连坐:解锁组内任一成员即整组解锁(如 start/wait_discussion),防"解锁了开头没解锁收尾"。
 */
import type { ToolProvider, ToolDef } from '../toolRegistry.js';
import { resolveTools, isDeferredIn } from '../toolRegistry.js';
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
                description: 'Exact tool names from the Additional Tools catalog, e.g. ["browser_snapshot"]',
              },
            },
            required: ['names'],
          },
        },
      },
      execute: async (args, ctx) => {
        const names = Array.isArray(args.names) ? (args.names as unknown[]).map(String) : [];
        if (!names.length) return 'Error: names is required — pass the tool names to load, e.g. {"names":["browser_snapshot"]}';
        if (!ctx.unlockTools) return 'Error: load_tools is not available in this context.';
        const profile = ctx.profile ?? deps().profile;
        // 可解锁集合必须与目录/defs 过滤同一判定(isDeferredIn=静态标记∪coding 情境集),
        // 只认 t.deferred 会让 coding 预设目录里的工具永远 "Unknown/not loadable"。
        const visible = resolveTools(profile, ctx);
        const available = new Map<string, ToolDef>();
        for (const [n, t] of visible) if (isDeferredIn(ctx, n, t.deferred)) available.set(n, t);
        const toUnlock = new Set<string>();
        const ready = new Set<string>();
        const unknown: string[] = [];
        for (const n of names) {
          if (visible.has(n) && !available.has(n)) { ready.add(n); continue; }
          const t = available.get(n);
          if (!t) { unknown.push(n); continue; }
          toUnlock.add(n);
          if (t.deferGroup) {
            for (const [n2, t2] of available) if (t2.deferGroup === t.deferGroup) toUnlock.add(n2);
          }
        }
        // 回调可以拒掉一部分(子代理的管理面 deny 名单):返回数组时以**它实际解锁的**为准,
        // 被拒的并入 unknown 如实报「本会话不可用」——谎报已装载会让模型下一轮去调一个永远没有定义的工具。
        const accepted = toUnlock.size ? ctx.unlockTools([...toUnlock]) : undefined;
        const loaded = Array.isArray(accepted) ? [...toUnlock].filter((n) => accepted.includes(n)) : [...toUnlock];
        if (Array.isArray(accepted)) for (const n of toUnlock) if (!accepted.includes(n)) unknown.push(n);
        let msg = loaded.length
          ? `Loaded tool(s): ${loaded.join(', ')}. Their full definitions are now available — call them directly in your next step.`
          : 'No tools loaded.';
        if (ready.size) msg += ` Already available: ${[...ready].join(', ')}. Call these tools directly; no loading is needed.`;
        if (unknown.length) msg += ` Unavailable in this session: ${[...new Set(unknown)].join(', ')}. This may reflect platform support, plugin settings or permissions; it does not mean the other tools failed. Use only visible tools or exact names from the Additional Tools catalog.`;
        return msg;
      },
    },
  ],
};
