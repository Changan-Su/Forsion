/**
 * 引擎插件自带的 hooks(manifest `tangu-plugin.json` 的 `hooks`,形态同 config.json hooks 段的 `events`)。
 *
 * **只开观察档**:插件 hook 照常收到事件 JSON、照常跑,但输出一律不进判定 —— 拦不住工具、停不了循环、
 * 也注入不了上下文(runner 丢掉它的输出)。能拦截 / 改写的 Pre* / PermissionRequest / UserPromptSubmit / PreCompact
 * 不收:那等于审批面的一部分,等有真插件要用再单开一档 capability。
 *
 * 信任 = 插件自己的代码(引擎插件本来就在引擎进程里跑任意代码),所以是 trusted、不走 needs-review;
 * 开关跟插件走(停用插件即摘),设置页只读列出。排在用户 hook 之后。
 * command 里的 `${pluginDir}` 展开成插件目录的绝对路径;工作目录与用户 hook 相同(会话 cwd)。
 */
import { normalizeHooksConfig, setPluginHooks } from './config.js';
import type { HookEventName, HookEventsConfig } from './types.js';

export const PLUGIN_HOOK_EVENTS: readonly HookEventName[] = ['SessionStart', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'];

/** manifest 原值 → 只含观察档事件的 events(坏项按 config 的 normalize 丢弃;不收的事件告警)。 */
export function sanitizePluginHooks(raw: unknown, pluginId: string, pluginDir: string): HookEventsConfig {
  const { events } = normalizeHooksConfig({ events: raw });
  const out: HookEventsConfig = {};
  for (const [event, groups] of Object.entries(events) as Array<[HookEventName, NonNullable<HookEventsConfig[HookEventName]>]>) {
    if (!PLUGIN_HOOK_EVENTS.includes(event)) {
      console.warn(`[tangu] 插件 ${pluginId} 的 ${event} hook 不收(插件只开观察档:${PLUGIN_HOOK_EVENTS.join(' / ')}),跳过`);
      continue;
    }
    const expand = (s: string) => s.split('${pluginDir}').join(pluginDir);
    out[event] = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) => ({ ...h, command: expand(h.command), ...(h.commandWindows ? { commandWindows: expand(h.commandWindows) } : {}) })),
    }));
  }
  return out;
}

/** 插件进入运行态后调用:有声明就登记(config.ts 的插件 hook 表),返回撤销函数(进实例台账)。 */
export function attachPluginHooks(pluginId: string, pluginName: string, pluginDir: string, raw: unknown): (() => void) | undefined {
  if (raw === undefined) return undefined;
  const events = sanitizePluginHooks(raw, pluginId, pluginDir);
  if (!Object.keys(events).length) return undefined;
  setPluginHooks(pluginId, { name: pluginName, events });
  return () => setPluginHooks(pluginId, null);
}
