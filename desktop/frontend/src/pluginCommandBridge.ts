/**
 * 插件 commands → engine 命令面板(**全局可见**,2026-07-18 放开——插件视图可装进任意 Space,「打开视图」类命令必须随处可用)。
 * id 前缀 amadeus:<插件 id>:<命令 id> 保持稳定,快捷键绑定不破。
 *
 * 2026-11-16 起按差量同步(以前是整批撤了重加):插件可以在运行中加 / 换 / 撤单条命令(registerCommand 回 disposer、
 * 同 id 原位替换),而插件默认键(CommandContribution.hotkey)的生效与否取决于别的命令和用户覆盖 —— 那两样一变就得重判,
 * 整批重加会让「重判 → 改命令表 → 又触发重判」转个不停。这里只动真变了的那几条,自己写进命令表的那几条不算外部变化。
 */
import { addCommand, effectiveHotkey, isMacPlatform, removeCommand, useCommandStore, useShortcuts } from '@lcl/engine'
import type { Command } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { AmadeusPlugin, CommandContribution } from '@amadeus/plugins/types'
import { pluginDisplayName } from '@amadeus/plugins/display'
import { currentLocale } from './i18n'
import { pluginDefaultHotkey, resolvePluginHotkeys, type PluginHotkeyState } from './shortcutUsage'
import { usePluginHotkeys } from './pluginHotkeyStore'

const engineId = (pluginId: string, id: string): string => `amadeus:${pluginId}:${id}`

/** 装上桥并做第一次同步;返回卸载函数(测试用,应用里装一次不卸)。 */
export function installPluginCommandBridge(): () => void {
  /** engine id → 上次写进命令表时依据的东西;三样都没变就不重写。 */
  const bridged = new Map<string, { item: CommandContribution; owner: AmadeusPlugin | undefined; hotkey: string }>()
  let syncing = false
  let othersSig = ''

  const pluginIds = (): Set<string> => new Set(usePluginStore.getState().commands.map((o) => engineId(o.pluginId, o.item.id)))
  /** 非插件命令(+ 命令面板伪命令)的生效键;插件那几条按 id 排除,所以桥自己写命令表不会改变它。 */
  const otherRows = (mine: Set<string>): Array<{ id: string; hotkey: string }> => [
    { id: 'command-palette', hotkey: effectiveHotkey({ id: 'command-palette', hotkey: 'mod+k' }) },
    ...useCommandStore.getState().commands.filter((c) => !mine.has(c.id)).map((c) => ({ id: c.id, hotkey: effectiveHotkey(c) })),
  ]
  const sigOf = (rows: Array<{ id: string; hotkey: string }>): string => rows.map((r) => `${r.id}=${r.hotkey}`).sort().join('\n')

  const sync = (): void => {
    if (syncing) return
    syncing = true
    try {
      const { plugins, commands } = usePluginStore.getState()
      const want = new Map(commands.map((o) => [engineId(o.pluginId, o.item.id), o] as const))
      for (const id of [...bridged.keys()]) if (!want.has(id)) { removeCommand(id); bridged.delete(id) }
      const mine = new Set(want.keys())
      const others = otherRows(mine)
      othersSig = sigOf(others)
      const states = resolvePluginHotkeys(
        [...want].map(([id, o]) => ({ id, hotkey: pluginDefaultHotkey(o.item.hotkey) })),
        others, useShortcuts.getState().overrides, isMacPlatform(),
      )
      const nextStates: Record<string, PluginHotkeyState> = Object.fromEntries(states)
      if (JSON.stringify(nextStates) !== JSON.stringify(usePluginHotkeys.getState().states)) usePluginHotkeys.setState({ states: nextStates })
      for (const [id, o] of want) {
        const owner = plugins.find((p) => p.id === o.pluginId)
        const st = states.get(id)
        const hotkey = st?.active ? st.hotkey : ''
        const prev = bridged.get(id)
        if (prev && prev.item === o.item && prev.owner === owner && prev.hotkey === hotkey) continue
        // 外置插件没有 ribbon 图标、手机上也没有命令区可钉 → 声明 moreGroup,手机「⋯」按插件分节直接列出
        // (节标题 = 插件展示名,渲染期按当前语言求值)。内置插件(callout / 字数)的命令各有入口,不进「⋯」。
        const moreGroup = owner && !owner.builtin
          ? { id: `amadeus:${o.pluginId}`, title: () => pluginDisplayName(owner, currentLocale()) }
          : undefined
        // ⚠️ 这里是**逐字段重建**,不是透传 —— 给 CommandContribution 加字段必须同步加到这一行,
        //    否则插件声明了也永远到不了命令表(2026-09-04 加 invoke 时踩点)。hotkey 只在判定生效时才给:
        //    不生效的默认键必须不在命令表里(热键分发取第一条匹配,设置页按生效键查冲突),不能靠排序让位。
        const cmd: Command = { id, title: o.item.title, keywords: o.item.keywords, run: o.item.run, invoke: o.item.invoke, checked: o.item.checked, ...(hotkey ? { hotkey } : {}), ...(moreGroup ? { moreGroup } : {}) }
        addCommand(cmd)
        bridged.set(id, { item: o.item, owner, hotkey })
      }
    } finally {
      syncing = false
    }
  }

  sync()
  const offPlugins = usePluginStore.subscribe((s, p) => { if (s.commands !== p.commands || s.plugins !== p.plugins) sync() })
  // 用户改了键(本窗或别的窗经 storage 事件)→ 重判谁的默认键能生效
  const offShortcuts = useShortcuts.subscribe((s, p) => { if (s.overrides !== p.overrides) sync() })
  // 别的命令来来去去(懒注册的内置命令、别处 addCommand)→ 只在非插件命令的生效键集合真变了时重判
  const offCommands = useCommandStore.subscribe((s, p) => {
    if (syncing || s.commands === p.commands) return
    if (sigOf(otherRows(pluginIds())) !== othersSig) sync()
  })
  return () => {
    offPlugins(); offShortcuts(); offCommands()
    for (const id of bridged.keys()) removeCommand(id)
    bridged.clear()
    usePluginHotkeys.setState({ states: {} })
  }
}
