/**
 * 插件 commands → engine 命令面板(**全局可见**,2026-07-18 放开——插件视图可装进任意 Space,「打开视图」类命令必须随处可用)。
 * id 前缀 amadeus:<插件 id>:<命令 id> 保持稳定,快捷键绑定不破。
 *
 * 2026-11-16 起:插件可以在运行中加 / 换 / 撤单条命令(registerCommand 回 disposer、同 id 原位替换),而插件默认键
 * (CommandContribution.hotkey)的生效与否取决于别的命令和用户覆盖 —— 那两样一变就得重判。重判的结果没变就不碰命令表;
 * 变了才整块按插件表顺序重加。监听别的命令时把插件这一块排除在外,桥自己写命令表不会再触发重判(不会转个不停)。
 */
import { addCommand, effectiveHotkey, isMacPlatform, listFirstNow, removeCommand, useCommandStore, useShortcuts, useSpaceStore, useWorkspace } from '@lcl/engine'
import type { Command } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { AmadeusPlugin, CommandContribution } from '@amadeus/plugins/types'
import { pluginDisplayName } from '@amadeus/plugins/display'
import { currentLocale } from './i18n'
import { pluginDefaultHotkey, resolvePluginHotkeys, type PluginHotkeyState } from './shortcutUsage'
import { usePluginHotkeys } from './pluginHotkeyStore'
import { pluginSpaceOwner } from './stores/spaceProgress'

const engineId = (pluginId: string, id: string): string => `amadeus:${pluginId}:${id}`

/** 屏上是不是这个插件自己的页面:当前 Space 是它带的,或主区当前的视图是它注册的(`plugin:<插件 id>:<视图 id>`,
 *  pluginViews.tsx)。手机的「⋯」只装这一页的事 —— 插件的命令只在它自己的页面上列出来(命令面板照旧处处搜得到)。
 *  插件 id 用生效的那个(商店安装是 `market-<UUID>`),和 Space / 视图登记时用的是同一个。 */
export function pluginOwnsPage(pluginId: string): boolean {
  if (pluginSpaceOwner.get(useSpaceStore.getState().activeSpaceId) === pluginId) return true
  const ws = useWorkspace.getState() as { getActiveLeaf?: () => { type: string } | null; leftVisible?: boolean }
  // 两级导航停在列表层:屏上是那张列表,主区的视图压在它后面看不见 —— 别人 Space 的列表不算这个插件的页面
  // (和外壳取「这一页自己的项」用的是同一个判断,见 SingleColumnHost 的 moreModel)。
  if (listFirstNow() && ws.leftVisible) return false
  return !!ws.getActiveLeaf?.()?.type.startsWith(`plugin:${pluginId}:`)
}

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
      // 刚被插件撤掉、还没从命令表摘下的那几条也是「自己的」:不排除的话,它们(连同用户给它们设的键)会被当成别人占着键
      const mine = new Set([...want.keys(), ...bridged.keys()])
      const others = otherRows(mine)
      othersSig = sigOf(others)
      const states = resolvePluginHotkeys(
        [...want].map(([id, o]) => ({ id, hotkey: pluginDefaultHotkey(o.item.hotkey) })),
        others, useShortcuts.getState().overrides, isMacPlatform(),
      )
      const nextStates: Record<string, PluginHotkeyState> = Object.fromEntries(states)
      if (JSON.stringify(nextStates) !== JSON.stringify(usePluginHotkeys.getState().states)) usePluginHotkeys.setState({ states: nextStates })
      const next = [...want].map(([id, o]) => {
        const st = states.get(id)
        return { id, o, owner: plugins.find((p) => p.id === o.pluginId), hotkey: st?.active ? st.hotkey : '' }
      })
      // 没变就不碰命令表;变了就整块按插件表的顺序撤了重加(engine 的 addCommand 是「删掉再追加」,只重加变了的那条
      // 会把它挪到最后 —— 同 id 原位替换、默认键开关一下,命令面板和手机「⋯」里的顺序就跟着漂,独立评审指出)。
      const same = next.length === bridged.size && next.every((n, i) => {
        const prev = bridged.get(n.id)
        return !!prev && [...bridged.keys()][i] === n.id && prev.item === n.o.item && prev.owner === n.owner && prev.hotkey === n.hotkey
      })
      if (same) return
      for (const id of bridged.keys()) removeCommand(id)
      bridged.clear()
      for (const { id, o, owner, hotkey } of next) {
        // 外置插件没有 ribbon 图标、手机上也没有命令区可钉 → 声明 moreGroup,手机「⋯」按插件分节直接列出
        // (节标题 = 插件展示名,渲染期按当前语言求值)。内置插件(callout / 字数)的命令各有入口,不进「⋯」。
        // when:手机竖屏上只在这个插件自己的页面列(别的页面的「⋯」不装它的事);平板横屏、抽屉形态不看它,照旧全列。
        const pluginId = o.pluginId
        const moreGroup = owner && !owner.builtin
          ? { id: `amadeus:${pluginId}`, title: () => pluginDisplayName(owner, currentLocale()), when: () => pluginOwnsPage(pluginId) }
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
    if (sigOf(otherRows(new Set([...pluginIds(), ...bridged.keys()]))) !== othersSig) sync()
  })
  return () => {
    offPlugins(); offShortcuts(); offCommands()
    for (const id of bridged.keys()) removeCommand(id)
    bridged.clear()
    usePluginHotkeys.setState({ states: {} })
  }
}
