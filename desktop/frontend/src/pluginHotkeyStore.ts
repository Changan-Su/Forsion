/** 本窗插件命令默认键的判定结果(engine 命令 id → 状态),由 amadeusPlugins 的命令桥写、设置 → 快捷键读。
 *  每个窗口各算各的(设置浮窗也装插件、也跑这座桥);判定规则在 shortcutUsage.resolvePluginHotkeys。 */
import { create } from 'zustand'
import type { PluginHotkeyState } from './shortcutUsage'

export const usePluginHotkeys = create<{ states: Record<string, PluginHotkeyState> }>(() => ({ states: {} }))
