/**
 * 划线条上每一枚放哪(2026-11-21 划线插件常驻 / 朗读 / 翻译改插件):聊天 / 插件视图(ViewSelectionBar)和笔记(UnifiedPage →
 * InlineToolbar)两条路径都从这里取同一份「条上 / ⋯ / 不显示」,不各排各的。放哪的规矩本身在 selectionActions.ts(纯逻辑、有单测);
 * 这里只把它翻成 SelectionBar 要的按钮:宿主那组(带去对话、翻译、核心插件、朗读)| 插件那组(最多 3 颗)| ⋯(带钉、顶上一行
 * 「还有 N 个放不下 · 去管理」),条上按钮右键「收进 ⋯ / 管理划线菜单…」。
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Languages, Loader2, Square, Volume2 } from 'lucide-react'
import type { SelectionBarAction, SelectionBarMoreNotice } from '@lcl/components'
import { currentLocale, registerMessages, translate } from '../../i18n'
import { resolveIcon } from '@amadeus/components/icons'
import { openPluginContextMenu } from '@amadeus/plugins/contextMenuSurface'
import { pluginDisplayName } from '@amadeus/plugins/display'
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import { readTangu } from '@amadeus/plugins/tanguSeam'
import { SELECTION_PREFS_EVENT } from '../../uiPrefsBus'
import {
  HOST_SELECTION_KEYS, arrangeSelectionActions, autoSelectionAction, hostSelectionEntry, hostTranslateAllowed, listSelectionActions, pinSelectionAction,
  placementOf, pluginSelectionEntry, selectionActionKey, selectionActionPrefs, selectionActionTitle,
  type OwnedSelectionAction, type SelectionActionPrefs, type SelectionEntry,
} from '../../selectionActions'

registerMessages({
  'selbar.speak': { zh: '朗读', en: 'Read aloud' },
  'selbar.speakStop': { zh: '停止朗读', en: 'Stop reading' },
  'selbar.speakLoading': { zh: '正在合成，点一下停止', en: 'Preparing audio, click to stop' },
  'selbar.pin': { zh: '钉到条上', en: 'Pin to the bar' },
  'selbar.unpin': { zh: '取消钉住', en: 'Unpin' },
  'selbar.overflow': { zh: '还有 {n} 个放不下', en: '{n} more did not fit' },
  'selbar.manage': { zh: '去管理', en: 'Manage' },
  'selbar.ctx.moveToMore': { zh: '收进 ⋯', en: 'Move to ⋯' },
  'selbar.ctx.manage': { zh: '管理划线菜单…', en: 'Manage selection menu…' },
  'selbar.builtin': { zh: '内置', en: 'Built-in' },
})

/** 打开设置 → 外观里「划线菜单」那一格(管理表就在它下面)。走窗口事件,笔记(Amadeus 层)也能用。 */
export function openSelectionMenuSettings(): void {
  window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: 'selection-bar' }))
}

export type SpeakPhase = 'loading' | 'playing' | null

/** 此刻在念的那一段(订阅全应用那一个播放器);偏好变了(钉 / 收进 ⋯ / 别的窗)也重画。条和笔记格式栏都挂它。 */
export function useSelectionBarLive(): { key: string; phase: 'loading' | 'playing' } | null {
  const tts = readTangu()?.tts
  const [st, setSt] = useState(() => tts?.state() ?? null)
  const [, setTick] = useState(0)
  useEffect(() => (tts ? tts.subscribe(() => setSt(tts.state())) : undefined), [tts])
  useEffect(() => {
    const on = (): void => setTick((n) => n + 1)
    window.addEventListener(SELECTION_PREFS_EVENT, on)
    return () => window.removeEventListener(SELECTION_PREFS_EVENT, on)
  }, [])
  return st
}

/** 划线朗读的 key:按那段字本身认(同一段再点 = 停;换一段 = 念新的)。不用哈希:两段不同的字不能撞成同一个 key。
 *  前缀免得和聊天消息 id 撞上。 */
export const speakKeyOf = (text: string): string => `sel:${text}`

export interface BarModelHost {
  /** 「带去对话」那一格(host:ask):聊天是引用 / 在侧栏提问 / 顺便问,别处是「问 Tangu」。空 = 这里没有。 */
  ask: SelectionBarAction[]
  /** 宿主翻译(这里做得了才给;装了翻译插件时这里自己不出)。 */
  translate?: () => void
  /** 朗读(这个宿主有朗读才给)。phase = 此刻在念的是不是这段。 */
  speak?: { phase: SpeakPhase; onRun(): void }
}

type Entry = SelectionEntry & { owned?: OwnedSelectionAction }

export interface BarModel {
  /** 竖线前:宿主那组 + 核心插件。 */
  actions: SelectionBarAction[]
  /** 竖线后:条上的插件动作。 */
  plugins: SelectionBarAction[]
  /** ⋯ 里宿主自己的(用户收进去的)。 */
  moreHost: SelectionBarAction[]
  /** ⋯ 里的插件动作。 */
  more: SelectionBarAction[]
  notice?: SelectionBarMoreNotice
  /** 这次划选后该自动跑的那个插件动作(用户开了「划选后自动」、排最前的);没有 = null。 */
  auto: OwnedSelectionAction | null
}

const pluginIcon = (icon: string | undefined): ReactNode => {
  const el = resolveIcon(icon)
  return el ? <span className="selbar-ico">{el}</span> : null
}

export const speakIcon = (phase: SpeakPhase): ReactElement =>
  phase === 'loading' ? <Loader2 size={14} className="spin" data-spin="" /> : phase === 'playing' ? <Square size={12} fill="currentColor" /> : <Volume2 size={14} />

/** 这一次的条。where = 视图 / 能不能写 / 选了多少字(插件动作的 scope / when 按它过滤)。 */
export function buildSelectionBarModel(o: {
  view: string
  editable: boolean
  length: number
  registered: readonly OwnedSelectionAction[]
  installed: readonly AmadeusPlugin[]
  host: BarModelHost
  onPlugin(a: OwnedSelectionAction): void
  prefs?: SelectionActionPrefs
}): BarModel {
  const prefs = o.prefs ?? selectionActionPrefs()
  const t = translate
  const entries: Entry[] = []
  if (o.host.ask.length) entries.push(hostSelectionEntry(HOST_SELECTION_KEYS.ask))
  if (o.host.translate && hostTranslateAllowed(o.installed, o.registered)) entries.push(hostSelectionEntry(HOST_SELECTION_KEYS.translate))
  if (o.host.speak) entries.push(hostSelectionEntry(HOST_SELECTION_KEYS.speak))
  for (const a of listSelectionActions(o.registered, { view: o.view, editable: o.editable, length: o.length })) {
    entries.push({ ...pluginSelectionEntry(a, o.registered.indexOf(a), o.installed), owned: a })
  }

  const pin = (e: Entry): SelectionBarAction['pin'] => {
    const on = placementOf(e, prefs) === 'bar'
    return { on, title: t(on ? 'selbar.unpin' : 'selbar.pin'), onToggle: () => pinSelectionAction(e.key, !on, entries) }
  }
  const menu = (e: Entry, title: string) => (anchor: HTMLElement): void => {
    const plugin = e.owned ? o.installed.find((p) => p.id === e.owned!.pluginId) : undefined
    const from = plugin ? pluginDisplayName(plugin, currentLocale()) : t('selbar.builtin')
    openPluginContextMenu({ anchor, align: 'start' }, [
      { kind: 'head', label: `${title} · ${from}` },
      { kind: 'item', label: t('selbar.ctx.moveToMore'), icon: 'more', run: () => pinSelectionAction(e.key, false, entries) },
      { kind: 'item', label: t('selbar.ctx.manage'), icon: 'settings', run: openSelectionMenuSettings },
    ], (run) => run())
  }

  /** 一个排序项 → 条上 / ⋯ 里的按钮(host:ask 一项可以是好几枚)。 */
  const buttons = (e: Entry, where: 'bar' | 'more'): SelectionBarAction[] => {
    const extra = where === 'more' ? { pin: pin(e) } : {}
    if (e.owned) {
      const title = selectionActionTitle(e.owned)
      const a = e.owned
      return [{ id: e.key, label: title, icon: pluginIcon(a.item.icon), ...extra, ...(where === 'bar' ? { onContextMenu: menu(e, title) } : {}), onRun: () => o.onPlugin(a) }]
    }
    if (e.key === HOST_SELECTION_KEYS.ask) {
      return o.host.ask.map((b) => ({ ...b, ...extra, ...(where === 'bar' ? { onContextMenu: menu(e, b.label) } : {}) }))
    }
    if (e.key === HOST_SELECTION_KEYS.translate) {
      const label = t('inlineai.action.translate')
      return [{ id: 'translate', label, icon: <Languages size={14} />, testId: 'selection-translate', ...extra, ...(where === 'bar' ? { onContextMenu: menu(e, label) } : {}), onRun: o.host.translate! }]
    }
    const sp = o.host.speak!
    const label = t('selbar.speak')
    return [{
      id: 'speak', label, icon: speakIcon(sp.phase), testId: 'selection-speak', pressed: sp.phase != null,
      title: sp.phase === 'loading' ? t('selbar.speakLoading') : sp.phase === 'playing' ? t('selbar.speakStop') : label,
      ...extra, ...(where === 'bar' ? { onContextMenu: menu(e, label) } : {}), onRun: sp.onRun,
    }]
  }

  const arranged = arrangeSelectionActions(entries, prefs)
  const autoEntry = autoSelectionAction(entries, prefs)
  return {
    actions: arranged.lead.flatMap((e) => buttons(e, 'bar')),
    plugins: arranged.plugins.flatMap((e) => buttons(e, 'bar')),
    moreHost: arranged.more.filter((e) => e.kind === 'host').flatMap((e) => buttons(e, 'more')),
    more: arranged.more.filter((e) => e.kind !== 'host').flatMap((e) => buttons(e, 'more')),
    notice: arranged.overflow > 0 ? { text: t('selbar.overflow', { n: String(arranged.overflow) }), action: t('selbar.manage'), onRun: openSelectionMenuSettings } : undefined,
    auto: autoEntry?.owned ?? null,
  }
}

/** 插件动作在结果卡上要宿主画的那几样(card 字段只认对象里 === true 的几项)。 */
export function cardOptionsOf(a: OwnedSelectionAction | undefined): { language: boolean; source: boolean; speak: boolean; auto: boolean } {
  const c = a?.item.card
  const ok = !!c && typeof c === 'object' && !Array.isArray(c)
  return {
    language: ok && c!.language === true,
    source: ok && c!.source === true,
    speak: ok && c!.speak === true,
    auto: a?.item.auto === true && a.item.output !== 'none',
  }
}

export { selectionActionKey }
