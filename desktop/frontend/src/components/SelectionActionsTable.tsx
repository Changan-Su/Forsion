/**
 * 设置 → 外观 →「大小、阅读与输入」→「划线菜单」下拉下面的管理表(2026-11-21 划线插件常驻方案 C):
 * 每个动作一行 —— 拖排序、「条上 / ⋯ / 不显示」、支持的才有「划选后自动」开关(排最前那个开着的挂「先跑」)。
 * 只改用户动到的那一项(selectionActions.updateSelectionActionPrefs);停用着的插件不在表里,它们的选择原样留着。
 * 列的是**这个窗口**插件仓里注册了的动作(设置是独立浮窗,插件在这里同样跑 setup)。
 */
import { useEffect, useState, type DragEvent, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { GripVertical, Languages, MessageCircle, Volume2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { usePluginStore } from '../amadeus/plugins/pluginStore'
import { resolveIcon } from '../amadeus/components/icons'
import { pluginDisplayName } from '../amadeus/plugins/display'
import { readTangu } from '../amadeus/plugins/tanguSeam'
import {
  HOST_SELECTION_KEYS, autoSelectionAction, hostSelectionEntry, hostTranslateAllowed, orderedSelectionEntries, placementOf, pluginSelectionEntry,
  moveSelectionAction, selectionActionPrefs, selectionActionTitle, setSelectionAuto, setSelectionPlacement,
  type OwnedSelectionAction, type SelectionEntry, type SelectionPlacement,
} from '../selectionActions'
import { SELECTION_PREFS_EVENT } from '../uiPrefsBus'
import { ttsHostAvailable } from '../selectionTts'
import { SettingsSwitch } from './SettingsPrimitives'
import './SelectionActionsTable.css'

registerMessages({
  'selactions.head': { zh: '动作', en: 'Actions' },
  'selactions.headHint': { zh: '拖动排序；「条上」最多 3 个插件动作，多出来的进 ⋯', en: 'Drag to reorder. Up to 3 plugin actions fit on the bar; the rest go behind ⋯' },
  'selactions.col.name': { zh: '名字', en: 'Name' },
  'selactions.col.source': { zh: '来源', en: 'From' },
  'selactions.col.place': { zh: '放在哪', en: 'Where' },
  'selactions.col.auto': { zh: '划选后自动', en: 'Run on select' },
  'selactions.place.bar': { zh: '条上', en: 'Bar' },
  'selactions.place.more': { zh: '⋯', en: '⋯' },
  'selactions.place.moreLabel': { zh: '收进 ⋯', en: 'Behind ⋯' },
  'selactions.place.hidden': { zh: '不显示', en: 'Hidden' },
  'selactions.ask': { zh: '问 Tangu / 引用 / 顺便问', en: 'Ask Tangu / Quote / Side question' },
  'selactions.translate': { zh: '翻译', en: 'Translate' },
  'selactions.speak': { zh: '朗读', en: 'Read aloud' },
  'selactions.builtin': { zh: '内置', en: 'Built-in' },
  'selactions.corePlugin': { zh: '{name} · 内置插件', en: '{name} · Built-in plugin' },
  'selactions.first': { zh: '先跑', en: 'Runs' },
  'selactions.firstTitle': { zh: '开了几个，只有排在最前的这一个自动跑', en: 'When several are on, only the first one in this list runs' },
  'selactions.grip': { zh: '拖动排序（也可以按 Alt + ↑ / ↓）', en: 'Drag to reorder (or press Alt + ↑ / ↓)' },
  'selactions.foot': { zh: '「划选后自动」只有支持它的动作才有，缺省关。开了几个，只有排在最前的那个自动跑。每次划选都会调用模型，计入额度。', en: '"Run on select" is only offered by actions that support it, and starts off. When several are on, only the first one in the list runs. Every selection calls the model and counts toward your quota.' },
})

type Row = SelectionEntry & { owned?: OwnedSelectionAction }

/** 偏好变了(本窗 / 别的窗重放)就重画。 */
function usePrefsTick(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const on = (): void => setN((x) => x + 1)
    window.addEventListener(SELECTION_PREFS_EVENT, on)
    window.addEventListener('storage', on)
    return () => { window.removeEventListener(SELECTION_PREFS_EVENT, on); window.removeEventListener('storage', on) }
  }, [])
  return n
}

export function SelectionActionsTable(): ReactElement {
  const { t, locale } = useI18n()
  usePrefsTick()
  const registered = usePluginStore((s) => s.selectionActions)
  const installed = usePluginStore((s) => s.plugins)
  const [drag, setDrag] = useState<{ key: string; over?: string; after?: boolean } | null>(null)
  const prefs = selectionActionPrefs()

  const rows: Row[] = [
    hostSelectionEntry(HOST_SELECTION_KEYS.ask),
    ...(hostTranslateAllowed(installed, registered) && readTangu()?.complete !== undefined ? [hostSelectionEntry(HOST_SELECTION_KEYS.translate)] : []),
    ...(ttsHostAvailable() ? [hostSelectionEntry(HOST_SELECTION_KEYS.speak)] : []),
    ...registered.map((o, i) => ({ ...pluginSelectionEntry(o, i, installed), owned: o })),
  ]
  const ordered = orderedSelectionEntries(rows, prefs)
  const first = autoSelectionAction(rows, prefs)

  const nameOf = (r: Row): string => (r.owned ? selectionActionTitle(r.owned)
    : t(r.key === HOST_SELECTION_KEYS.ask ? 'selactions.ask' : r.key === HOST_SELECTION_KEYS.translate ? 'selactions.translate' : 'selactions.speak'))
  const iconOf = (r: Row): ReactNode => {
    if (r.owned) return resolveIcon(r.owned.item.icon) ?? <span className="selactions-ico-blank" />
    return r.key === HOST_SELECTION_KEYS.ask ? <MessageCircle size={15} /> : r.key === HOST_SELECTION_KEYS.translate ? <Languages size={15} /> : <Volume2 size={15} />
  }
  const sourceOf = (r: Row): string => {
    if (!r.owned) return t('selactions.builtin')
    const p = installed.find((x) => x.id === r.owned!.pluginId)
    const name = p ? pluginDisplayName(p, locale) : r.owned.pluginId
    return r.kind === 'core' ? t('selactions.corePlugin', { name }) : name
  }
  /** 只在同一组里挪(宿主那组 / 插件那组各自成行;跨组拖过去在条上也不会换组)。 */
  const sameGroup = (a: Row, b: Row): boolean => (a.kind === 'plugin') === (b.kind === 'plugin')
  const move = (key: string, target: string, after: boolean): void => {
    if (key === target) return
    const me = ordered.find((r) => r.key === key)
    const to = ordered.find((r) => r.key === target)
    if (!me || !to || !sameGroup(me, to)) return
    moveSelectionAction(key, target, after, ordered.map((r) => r.key)) // 只挪这一个;表外(别处 / 停用插件)的先后不动
  }
  const onKey = (r: Row) => (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const group = ordered.filter((x) => sameGroup(x, r))
    const i = group.findIndex((x) => x.key === r.key)
    const next = group[i + (e.key === 'ArrowUp' ? -1 : 1)]
    if (next) move(r.key, next.key, e.key === 'ArrowDown')
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-selaction-grip="${CSS.escape(r.key)}"]`)?.focus())
  }
  const dragProps = (r: Row) => ({
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!drag) return
      const me = ordered.find((x) => x.key === drag.key)
      if (!me || !sameGroup(me, r)) return
      e.preventDefault()
      const box = e.currentTarget.getBoundingClientRect()
      const after = e.clientY > box.top + box.height / 2
      if (drag.over !== r.key || drag.after !== after) setDrag({ ...drag, over: r.key, after })
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); if (drag?.over) move(drag.key, drag.over, !!drag.after); setDrag(null) },
  })
  const places: Array<[SelectionPlacement, string, string]> = [
    ['bar', t('selactions.place.bar'), t('selactions.place.bar')],
    ['more', t('selactions.place.more'), t('selactions.place.moreLabel')],
    ['hidden', t('selactions.place.hidden'), t('selactions.place.hidden')],
  ]

  return (
    <div className="selactions" data-testid="selection-actions-table">
      <div className="selactions-cap"><b>{t('selactions.head')}</b><span>{t('selactions.headHint')}</span></div>
      <div className="selactions-grid" role="table" aria-label={t('selactions.head')}>
        <div className="selactions-row selactions-th" role="row">
          <span role="columnheader" aria-hidden />
          <span role="columnheader">{t('selactions.col.name')}</span>
          <span role="columnheader">{t('selactions.col.source')}</span>
          <span role="columnheader">{t('selactions.col.place')}</span>
          <span role="columnheader" className="selactions-auto-col">{t('selactions.col.auto')}</span>
        </div>
        {ordered.map((r) => {
          const at = placementOf(r, prefs)
          const over = drag?.over === r.key && drag.key !== r.key
          return (
            <div key={r.key} role="row" className={`selactions-row${drag?.key === r.key ? ' dragging' : ''}${over ? (drag!.after ? ' drop-after' : ' drop-before') : ''}`}
              data-selaction={r.key} {...dragProps(r)}>
              <span role="cell">
                <button type="button" className="selactions-grip" draggable data-selaction-grip={r.key} title={t('selactions.grip')} aria-label={`${t('selactions.grip')}: ${nameOf(r)}`}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.key); setDrag({ key: r.key }) }}
                  onDragEnd={() => setDrag(null)} onKeyDown={onKey(r)}>
                  <GripVertical size={14} />
                </button>
              </span>
              <span role="cell" className="selactions-name"><span className="selactions-ico">{iconOf(r)}</span><span>{nameOf(r)}</span></span>
              <span role="cell" className="selactions-src">{sourceOf(r)}</span>
              <span role="cell">
                <span className="seg seg-sm" role="radiogroup" aria-label={`${t('selactions.col.place')}: ${nameOf(r)}`}>
                  {places.map(([v, label, aria]) => (
                    <button key={v} type="button" role="radio" aria-checked={at === v} aria-label={aria} data-place={v} className={at === v ? 'active' : undefined}
                      onClick={() => { if (at !== v) setSelectionPlacement(r.key, v) }}>{label}</button>
                  ))}
                </span>
              </span>
              <span role="cell" className="selactions-auto-col">
                {r.auto ? (
                  <span className="selactions-auto">
                    {first?.key === r.key && <span className="selactions-first" title={t('selactions.firstTitle')}>{t('selactions.first')}</span>}
                    <SettingsSwitch checked={prefs.auto[r.key] === true} label={`${t('selactions.col.auto')}: ${nameOf(r)}`} data-auto={r.key}
                      onChange={(on) => setSelectionAuto(r.key, on)} />
                  </span>
                ) : <span className="selactions-none" aria-hidden>—</span>}
              </span>
            </div>
          )
        })}
      </div>
      <p className="selactions-foot">{t('selactions.foot')}</p>
    </div>
  )
}
