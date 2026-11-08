/**
 * Muse Space 主区「今日简报」(2026-11-08,方案 D 第一期;方案页 docs/ToBeImproved/MuseSpace优化方案_2026-11-07/)。
 * 宿主自己画:卜算子那句话 → 备好的 → 小组件(格子)→ 今天(手记)。布局走引擎 GET /agent/special/muse/space(两份文件合成好的),
 * 你的每一下走 POST …/placement(带 expectedRev)。卜算子只写那句话、备好的、提议;格子归你。
 *
 * 用户 11-08 定:老用户直接换成这一页 —— 不再加载卜算子写的 main.js(文件留在原处),也没有切回旧页的开关;
 * 第一轮之前宿主先画内置卡(待你看的 · 今天 · 在跟的),只有那句话和备好的是占位。
 * 读坏:引擎用最后一份有效的,头行一个小警示点,「⋯ → 查看问题」。停用:页留着,顶上一条,操作变灰。
 * 窄(Muse 私聊旁的 Desk、窄窗口):按容器宽度,<720 收成单列。
 */
import React, { useRef, useState } from 'react'
import {
  BookOpen, Check, Ellipsis, Eye, EyeOff, FileText, FolderOpen, GripVertical, House, LayoutGrid, ListTodo, NotebookPen, Pause, PanelRight, Pencil, Plus, Radar, Settings, Sparkles, Activity,
} from 'lucide-react'
import { createDropIndicator, useWorkspace, type ViewProps } from '@lcl/engine'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { ContextMenu, type CtxMenu } from '../../components/RightPanel'
import { panelToast } from '../../components/PanelNotice'
import { EmptyState } from '../../components/EmptyState'
import { WidgetHost, useWidgetTitle } from '../../components/WidgetHost'
import { listWidgets, type WidgetListItem } from '../../services/widgetClient'
import { placeOnBoard } from '../../services/widgetPlaces'
import { isOnHome, placeOnHome, readHomeLayout, saveHomeLayout } from '../homeWidgets'
import { trackDrag } from '../HomeWidgetParts'
import { formatDayTime, formatRelative } from '../../format/time'
import { wakeMuse } from '../../services/backendService'
import { homeTarget } from '../../services/engine/targets'
import type { MusePlacementOp, MuseSpaceCard, MuseSpaceProposal, MuseSpaceView, MuseStatusInfo } from '../../types'
import { SegmentLine, StatusBody, TodayBody, TodosBody, TrackingBody } from './museBriefCards'
import { useMuseJournalToday, useMuseSpaceView, useMuseStatusLive, widgetCardKey } from './museBriefData'
import { wakeSettle } from './museBriefCards'
import './museBrief.css'

registerMessages({
  'museBrief.title': { zh: '今日简报', en: "Today's brief" },
  'museBrief.hello.morning': { zh: '早上好。', en: 'Good morning.' },
  'museBrief.hello.noon': { zh: '中午好。', en: 'Good afternoon.' },
  'museBrief.hello.afternoon': { zh: '下午好。', en: 'Good afternoon.' },
  'museBrief.hello.evening': { zh: '晚上好。', en: 'Good evening.' },
  'museBrief.hello.night': { zh: '夜深了。', en: 'Late night.' },
  'museBrief.by': { zh: '卜算子 · {time} 写的', en: 'Muse · written {time}' },
  'museBrief.byNever': { zh: '卜算子 · 还没醒过', en: 'Muse · not awake yet' },
  'museBrief.byNone': { zh: '卜算子 · 还没写今天的话', en: 'Muse · nothing written yet today' },
  'museBrief.firstLede': { zh: '卜算子第一次醒来后，会在这里写一句今天的情况，把替你备好的东西放在下面。', en: "After Muse wakes for the first time, it writes a line about your day here and puts what it prepared for you below." },
  'museBrief.noneLede': { zh: '它下次醒来会在这里写一句今天的情况。', en: 'It writes a line about your day here the next time it wakes.' },
  'museBrief.what': { zh: '它会做什么', en: 'What it does' },
  'museBrief.prepared': { zh: '备好的', en: 'Ready for you' },
  'museBrief.preparedNote': { zh: '{n} 份 · 都在 Library', en: '{n} in the Library' },
  'museBrief.open': { zh: '打开', en: 'Open' },
  'museBrief.widgets': { zh: '小组件', en: 'Widgets' },
  'museBrief.today': { zh: '今天', en: 'Today' },
  'museBrief.todayNote': { zh: '手记 · {n} 段', en: 'Journal · {n} parts' },
  'museBrief.todayEmpty': { zh: '今天还没有手记。', en: 'No journal entry today yet.' },
  'museBrief.edit': { zh: '编辑', en: 'Edit' },
  'museBrief.more': { zh: '更多', en: 'More' },
  'museBrief.reset': { zh: '恢复默认', en: 'Reset' },
  'museBrief.done': { zh: '完成', en: 'Done' },
  'museBrief.add': { zh: '添加', en: 'Add' },
  'museBrief.hide': { zh: '隐藏', en: 'Hide' },
  'museBrief.show': { zh: '显示', en: 'Show' },
  'museBrief.hiddenSection': { zh: '已隐藏', en: 'Hidden' },
  'museBrief.byMuse': { zh: '卜算子做的', en: 'Made by Muse' },
  'museBrief.propose': { zh: '卜算子想加这张', en: 'Muse wants to add this' },
  'museBrief.accept': { zh: '放上', en: 'Add it' },
  'museBrief.reject': { zh: '不要', en: 'No thanks' },
  'museBrief.pop.builtin': { zh: '内置', en: 'Built in' },
  'museBrief.pop.muse': { zh: '卜算子做的', en: 'Made by Muse' },
  'museBrief.pop.museEmpty': { zh: '它还没做过小组件', en: "Muse hasn't made any widgets yet" },
  'museBrief.pop.placed': { zh: '已放', en: 'Added' },
  'museBrief.toHome': { zh: '放到主页', en: 'Put on Home' },
  'museBrief.onHome': { zh: '已在主页', en: 'On Home' },
  'museBrief.homeFull': { zh: '主页放满了，先在主页拿掉一张', en: 'Home is full. Remove a card there first' },
  'museBrief.toRail': { zh: '放进卡片区', en: 'Add to cards' },
  'museBrief.off': { zh: '卜算子已停用，下面是 {time} 停下前留的。', en: 'Muse is off. Below is what it left before it stopped at {time}.' },
  'museBrief.offNoTime': { zh: '卜算子已停用，下面是它停下前留的。', en: 'Muse is off. Below is what it left before it stopped.' },
  'museBrief.turnOn': { zh: '去设置开启', en: 'Turn on in Settings' },
  'museBrief.problems': { zh: '查看问题', en: 'See problems' },
  'museBrief.problemsTitle': { zh: '有一份布局读不懂，先用的是上一份好的：{msg}', en: "A layout file couldn't be read, so the last good one is shown: {msg}" },
  'museBrief.openLibrary': { zh: '打开 Library', en: 'Open the Library' },
  'museBrief.settings': { zh: '卜算子设置', en: 'Muse settings' },
  'museBrief.failed': { zh: '没办成：{e}', en: "Couldn't do that: {e}" },
  'museBrief.offTitle': { zh: 'Muse 还没开', en: 'Muse is off' },
  'museBrief.offLine': { zh: '开启后，它会在后台读你的笔记和对话，写草稿、提待办，每天留一份工作日志。', en: 'Once on, it reads your notes and chats in the background, drafts, suggests to-dos and keeps a daily log.' },
  'museBrief.turnOnMuse': { zh: '开启 Muse', en: 'Turn on Muse' },
  'museBrief.loadFailed': { zh: '暂时读不到简报的布局，下面先画内置卡。', en: "Couldn't load the brief's layout right now. Showing the built-in cards." },
})

const BUILTIN_ICON: Record<string, typeof Sparkles> = { todos: ListTodo, tracking: Radar, today: NotebookPen, status: Activity }
const BUILTIN_TITLE: Record<string, string> = { todos: 'museBrief.card.todos', tracking: 'museBrief.card.tracking', today: 'museBrief.card.today', status: 'museBrief.card.status' }
const BUILTIN_ORDER = ['todos', 'tracking', 'today', 'status'] as const
/** 旧引擎 / 读不到布局时的格子:和第一轮之前一样的缺省三张。 */
const FALLBACK_CARDS: MuseSpaceView['cards'] = [
  { key: 'todos', ref: { builtin: 'todos' }, source: 'default' },
  { key: 'today', ref: { builtin: 'today' }, source: 'default' },
  { key: 'tracking', ref: { builtin: 'tracking' }, source: 'default' },
]

const greetingKey = (h = new Date().getHours()): string =>
  h >= 5 && h < 11 ? 'museBrief.hello.morning' : h < 13 && h >= 11 ? 'museBrief.hello.noon' : h >= 13 && h < 18 ? 'museBrief.hello.afternoon' : h >= 18 && h < 23 ? 'museBrief.hello.evening' : 'museBrief.hello.night'

const baseName = (p: string): string => (p.split('/').pop() || p).replace(/\.md$/i, '')
const dirName = (p: string): string => (p.includes('/') ? p.split('/').slice(0, -1).join('/') : 'Library')

function openLibraryFile(root: string | undefined, rel: string): void {
  if (!root) return
  useWorkspace.getState().openView('wsfile', { path: `${root}/${rel}`, name: rel.split('/').pop() || rel }, 'main', { newTab: true })
}
const openMuseSettings = (): void => useApp.getState().openSettings('agents/ag-special/muse')

/** 那句话:把 [[Library 路径]] 画成链接,点了在主区新标签打开。 */
function HeroText({ text, root }: { text: string; root?: string }): React.JSX.Element {
  const parts: React.ReactNode[] = []
  const re = /\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g
  let at = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > at) parts.push(text.slice(at, m.index))
    const path = m[1].trim()
    const label = (m[2] || baseName(path)).trim()
    parts.push(<a key={m.index} className="msb-link" role="link" tabIndex={0} onClick={() => openLibraryFile(root, /\.[a-z0-9]+$/i.test(path) ? path : `${path}.md`)}
      onKeyDown={(e) => { if (e.key === 'Enter') openLibraryFile(root, /\.[a-z0-9]+$/i.test(path) ? path : `${path}.md`) }}>{label}</a>)
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function Hero({ view, status, off }: { view: MuseSpaceView | null | undefined; status: MuseStatusInfo | null | undefined; off: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const [waking, setWaking] = useState(false)
  const hero = view?.hero
  const canWake = !off && !!status?.enabled && !status.running && typeof status.wakePending === 'boolean' && !status.wakePending && !waking
  if (hero) {
    return (
      <div className="msb-hero" data-hero="">
        <div className="msb-by"><Sparkles size={13} /><span>{t('museBrief.by', { time: formatDayTime(hero.at) })}</span></div>
        <h1 className="msb-h1">{t(greetingKey())}</h1>
        <p className="msb-lede"><HeroText text={hero.text} root={view?.libraryRoot} /></p>
      </div>
    )
  }
  const never = !status?.lastCycleAt
  return (
    <div className="msb-hero" data-hero="empty">
      <div className="msb-by"><Sparkles size={13} /><span>{t(never ? 'museBrief.byNever' : 'museBrief.byNone')}</span></div>
      <h1 className="msb-h1">{t(greetingKey())}</h1>
      <p className="msb-lede muted">{t(never ? 'museBrief.firstLede' : 'museBrief.noneLede')}</p>
      {!off && (
        <div className="msb-row">
          {(status?.wakePending || waking)
            ? <span className="msb-note" role="status">{t('museBrief.waking')}</span>
            : canWake && <button type="button" className="msb-pill solid" data-action="muse-wake" onClick={() => { setWaking(true); void wakeMuse(homeTarget()).then(() => wakeSettle(setWaking), (e) => { setWaking(false); panelToast(t('museBrief.failed', { e: e instanceof Error ? e.message : String(e) }), true) }) }}>{t('museBrief.wake')}</button>}
          <button type="button" className="msb-pill ghost" onClick={openMuseSettings}>{t('museBrief.what')}</button>
        </div>
      )}
    </div>
  )
}

function SectionHead({ title, note, editing, hidden, onToggle, extra }: { title: string; note?: string; editing?: boolean; hidden?: boolean; onToggle?: () => void; extra?: React.ReactNode }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="msb-sh">
      <b>{title}</b>
      {hidden ? <span>{t('museBrief.hiddenSection')}</span> : note && <span>{note}</span>}
      <span className="msb-sp" />
      {extra}
      {editing && onToggle && (
        <button type="button" className="msb-icbtn" title={t(hidden ? 'museBrief.show' : 'museBrief.hide')} aria-label={t(hidden ? 'museBrief.show' : 'museBrief.hide')} onClick={onToggle}>
          {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      )}
    </div>
  )
}

/** 卡壳:头行(图标 / 把手、标题、归属、隐藏 / ⋯)+ 提议条 + 卡身。 */
function CardShell({ card, editing, off, proposal, onHide, onGrip, onAccept, onReject, status, root }: {
  card: MuseSpaceCard; editing: boolean; off: boolean; proposal?: MuseSpaceProposal
  onHide?: () => void; onGrip?: (e: React.PointerEvent) => void; onAccept?: () => void; onReject?: () => void
  status: MuseStatusInfo | null | undefined; root?: string
}): React.JSX.Element {
  const { t } = useI18n()
  const widgetId = 'widgetId' in card.ref ? card.ref.widgetId : ''
  const w = useWidgetTitle(widgetId)
  const [menu, setMenu] = useState<CtxMenu>(null)
  const builtin = 'builtin' in card.ref ? card.ref.builtin : null
  const Icon = builtin ? BUILTIN_ICON[builtin] : LayoutGrid
  const title = builtin ? t(BUILTIN_TITLE[builtin]) : w.title || card.key
  const body = builtin === 'todos' ? <TodosBody disabled={off} placeholder={!status?.lastCycleAt} />
    : builtin === 'tracking' ? <TrackingBody />
      : builtin === 'today' ? <TodayBody onOpen={(p) => openLibraryFile(root, p)} />
        : builtin === 'status' ? <StatusBody status={status} />
          : <WidgetHost id={widgetId} titled />
  const widgetMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const home = readHomeLayout()
    const onHome = isOnHome(home, widgetId)
    setMenu({
      x: r.right, y: r.bottom + 4, anchorTop: r.top,
      items: [
        { label: t(onHome ? 'museBrief.onHome' : 'museBrief.toHome'), icon: <House size={14} />, checked: onHome, disabled: onHome, run: () => {
          const next = placeOnHome(readHomeLayout(), widgetId)
          if (!next) { panelToast(t('museBrief.homeFull'), true); return }
          saveHomeLayout(next)
        } },
        { label: t('museBrief.toRail'), icon: <PanelRight size={14} />, run: () => void placeOnBoard('rail', { id: widgetId }).catch((err: unknown) => panelToast(t('museBrief.failed', { e: err instanceof Error ? err.message : String(err) }), true)) },
        ...(onHide ? [{ label: t('museBrief.hide'), icon: <EyeOff size={14} />, separatorBefore: true, run: onHide }] : []),
      ],
    })
  }
  return (
    <section className={`msb-card${proposal ? ' msb-proposed' : ''}`} data-card-key={card.key} data-card-kind={builtin ?? 'widget'}>
      {proposal && (
        <div className="msb-prop" data-proposal={proposal.key}>
          <Sparkles size={12} />
          <span className="msb-prop-t" title={proposal.why || undefined}>{t('museBrief.propose')}{proposal.why ? ` · ${proposal.why}` : ''}</span>
          <button type="button" className="msb-pill solid" disabled={off} onClick={onAccept}>{t('museBrief.accept')}</button>
          <button type="button" className="msb-pill ghost" disabled={off} onClick={onReject}>{t('museBrief.reject')}</button>
        </div>
      )}
      <header className="msb-ch" onPointerDown={editing && onGrip ? onGrip : undefined}>
        {editing && onGrip ? <span className="msb-grip" aria-hidden><GripVertical size={13} /></span> : <Icon size={13} />}
        <span className="msb-ct">{title}</span>
        {!builtin && <span className="msb-co">{t('museBrief.byMuse')}</span>}
        {editing && onHide && <button type="button" className="msb-icbtn" title={t('museBrief.hide')} aria-label={t('museBrief.hide')} onClick={onHide}><EyeOff size={13} /></button>}
        {!editing && !builtin && !proposal && !off && <button type="button" className="msb-icbtn" title={t('museBrief.more')} aria-label={t('museBrief.more')} onClick={widgetMenu}><Ellipsis size={13} /></button>}
      </header>
      <div className={`msb-cb${editing ? ' inert' : ''}`}>{body}</div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </section>
  )
}

/** 编辑态「添加」:内置四张 + 卜算子做的小组件(插件小组件接口做好后再加一组)。已放的打勾;点一下放到最后一格。 */
function AddPopover({ view, widgets, onAdd, onClose }: { view: MuseSpaceView; widgets: WidgetListItem[] | null; onAdd: (card: MuseSpaceCard) => void; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const placed = new Set(view.cards.map((c) => c.key))
  const placedWidgets = new Set(view.cards.flatMap((c) => ('widgetId' in c.ref ? [c.ref.widgetId] : [])))
  const row = (key: string, icon: React.ReactNode, label: string, sub: string, on: boolean, card: MuseSpaceCard): React.JSX.Element => (
    <button type="button" key={key} className={`msb-pop-row${on ? ' on' : ''}`} disabled={on} onClick={() => { onAdd(card); onClose() }} data-add={key}>
      {icon}<span className="msb-n">{label}</span>
      <span className="msb-time r">{on ? <><Check size={12} />{t('museBrief.pop.placed')}</> : sub}</span>
    </button>
  )
  return (
    <div className="msb-pop" role="menu" data-add-popover="">
      <div className="msb-pop-h">{t('museBrief.pop.builtin')}</div>
      {BUILTIN_ORDER.map((b) => {
        const Icon = BUILTIN_ICON[b]
        return row(b, <Icon size={14} />, t(BUILTIN_TITLE[b]), '', placed.has(b), { key: b, ref: { builtin: b } })
      })}
      <div className="msb-pop-h">{t('museBrief.pop.muse')}</div>
      {widgets === null && <div className="msb-pop-empty" aria-busy="true" />}
      {widgets && !widgets.length && <div className="msb-pop-empty">{t('museBrief.pop.museEmpty')}</div>}
      {widgets?.map((w) => row(w.id, <LayoutGrid size={14} />, w.title || w.name, w.updatedAt ? formatRelative(Date.parse(w.updatedAt)) : '', placedWidgets.has(w.id), { key: widgetCardKey(view, w), ref: { widgetId: w.id } }))}
    </div>
  )
}

export function MuseBriefView(_props: ViewProps): React.JSX.Element {
  const { t } = useI18n()
  const { view, unsupported, failed, apply } = useMuseSpaceView()
  const status = useMuseStatusLive()
  const journal = useMuseJournalToday()
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [widgets, setWidgets] = useState<WidgetListItem[] | null>(null)
  const [menu, setMenu] = useState<CtxMenu>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const off = view ? !view.enabled : status ? !status.enabled : false
  const canEdit = !!view && !off
  const cards = view?.cards ?? FALLBACK_CARDS
  const proposed = view?.proposed ?? []
  const sections = view?.sections ?? { prepared: true, today: true }
  const problems = view?.problems ?? []
  // 旧引擎没有布局读口(view = null)时 Library 根从状态里拿,手记 / 卡里的链接照样能打开
  const libRoot = view?.libraryRoot || status?.libraryDir || undefined

  const run = (op: MusePlacementOp): void => {
    void apply(op).catch((e) => panelToast(t('museBrief.failed', { e: e instanceof Error ? e.message : String(e) }), true))
  }
  const openAdd = (): void => {
    setAdding((v) => !v)
    setWidgets(null)
    void listWidgets().then((ws) => setWidgets(ws.filter((w) => w.agentSlug === 'muse' && w.entry === 'widget.json')), () => setWidgets([]))
  }
  const addCard = (card: MuseSpaceCard): void => {
    // 卜算子正提议的就是这张 → 等于点了「放上」(同一个 key,不另起一张)
    const pending = 'widgetId' in card.ref ? proposed.find((p) => 'widgetId' in p.ref && p.ref.widgetId === (card.ref as { widgetId: string }).widgetId) : undefined
    // 藏着的那张(同一个键)→ 显示回来,不另加
    const hidden = view?.hidden.some((h) => h.key === card.key)
    run(pending ? { type: 'accept', key: pending.key } : hidden ? { type: 'show', key: card.key } : { type: 'add', card })
  }
  // 格子拖动:只读格子位(#378 的判定),落点线画在指针所在那张卡的前沿;松手发一次 move
  const grip = (key: string) => (e: React.PointerEvent): void => {
    const root = gridRef.current
    const el = root?.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(key)}"]`)
    if (!root || !el) return
    const ind = createDropIndicator({ host: root })
    let to = -1
    trackDrag(e, el, (ev) => {
      const others = [...root.querySelectorAll<HTMLElement>('[data-card-key]:not(.msb-proposed)')].filter((x) => x !== el)
      const before = others.findIndex((x) => { const r = x.getBoundingClientRect(); return ev.clientY < r.top || (ev.clientY <= r.bottom && ev.clientX < r.left + r.width / 2) })
      to = before < 0 ? others.length : before
      const anchor = others[Math.min(to, others.length - 1)]
      if (!anchor) { ind.hide(); return }
      const r = anchor.getBoundingClientRect()
      ind.line({ x: before < 0 ? r.right + 6 : r.left - 6, y: r.top, h: r.height }, { axis: 'v', key: `${to}` })
    }, () => {
      const visible = cards.map((c) => c.key)
      const from = visible.indexOf(key)
      if (to < 0 || to === from) return false
      run({ type: 'move', key, to })
      return true
    }, () => ind.destroy())
  }
  const moreMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: r.right, y: r.bottom + 4, anchorTop: r.top,
      items: [
        ...(problems.length ? [{ label: t('museBrief.problems'), icon: <Sparkles size={14} />, detail: problems.map((p) => p.message).join('\n').slice(0, 200), run: () => panelToast(t('museBrief.problemsTitle', { msg: problems.map((p) => p.message).join('; ') }), true) }] : []),
        { label: t('museBrief.openLibrary'), icon: <FolderOpen size={14} />, separatorBefore: problems.length > 0, run: () => useWorkspace.getState().openView('muse-files', {}, 'main', { newTab: true }) },
        { label: t('museBrief.settings'), icon: <Settings size={14} />, run: openMuseSettings },
      ],
    })
  }
  const stopped = view?.stoppedAt ?? status?.lastCycleAt ?? null

  // 两条读口都回来之前(失败 = null,也算回来了)先空着:否则每次进来都先闪一下「还没醒过」再换成真的那句话
  if ((view === undefined && !failed) || status === undefined) return <div className="msb-root" data-muse-brief="" data-state="loading" aria-busy="true" />

  // 从没开过(关着、没留下那句话、也没醒过):没有「停下前留的」可看,中间放公共空态 + 「开启 Muse」(10-25 第四轮 4.1 的口径)
  if (off && !view?.hasDoc && !status?.lastCycleAt) {
    return (
      <div className="msb-root msb-root-empty" data-muse-brief="" data-state="off">
        <EmptyState icon={Sparkles} title={t('museBrief.offTitle')} line={t('museBrief.offLine')} data-state="off"
          action={{ label: t('museBrief.turnOnMuse'), icon: Settings, action: 'muse-settings', onClick: openMuseSettings }} />
      </div>
    )
  }

  return (
    <div className="msb-root" data-muse-brief="" data-editing={editing || undefined} data-off={off || undefined}>
      <div className="msb-head">
        <span className="msb-head-t"><BookOpen size={13} />{t('museBrief.title')}{problems.length > 0 && <i className="msb-warn" title={t('museBrief.problemsTitle', { msg: problems.map((p) => p.message).join('; ') })} data-problems={problems.length} />}</span>
        <span className="msb-sp" />
        {editing
          ? <>
            <button type="button" className="msb-pill ghost" onClick={() => run({ type: 'reset' })}>{t('museBrief.reset')}</button>
            <button type="button" className="msb-pill solid" data-action="edit-done" onClick={() => { setEditing(false); setAdding(false) }}>{t('museBrief.done')}</button>
          </>
          : <>
            {canEdit && <button type="button" className="msb-icbtn" data-action="edit" title={t('museBrief.edit')} aria-label={t('museBrief.edit')} onClick={() => setEditing(true)}><Pencil size={14} /></button>}
            <button type="button" className="msb-icbtn" title={t('museBrief.more')} aria-label={t('museBrief.more')} onClick={moreMenu}><Ellipsis size={14} /></button>
          </>}
      </div>
      <div className="msb-page">
        {off && (
          <div className="msb-off" role="status">
            <Pause size={13} />
            <span>{stopped ? t('museBrief.off', { time: formatDayTime(stopped) }) : t('museBrief.offNoTime')}</span>
            <button type="button" className="msb-pill ghost" onClick={openMuseSettings}>{t('museBrief.turnOn')}</button>
          </div>
        )}
        {(failed || unsupported) && !off && <div className="msb-note" role="status">{t('museBrief.loadFailed')}</div>}

        <Hero view={view} status={status} off={off} />

        {view && (view.prepared.length > 0 || editing) && (sections.prepared || editing) && (
          <section className="msb-sec" data-section="prepared">
            <SectionHead title={t('museBrief.prepared')} note={view.prepared.length ? t('museBrief.preparedNote', { n: view.prepared.length }) : undefined}
              editing={editing} hidden={!sections.prepared} onToggle={() => run({ type: sections.prepared ? 'hide' : 'show', key: 'section:prepared' })} />
            {sections.prepared && view.prepared.length > 0 && (
              <div className="msb-grid3">
                {view.prepared.map((f) => (
                  <button type="button" key={f.path} className="msb-card msb-file" data-file={f.path} onClick={() => openLibraryFile(view.libraryRoot, f.path)}>
                    <span className="msb-fic"><FileText size={16} /></span>
                    <span className="msb-ft"><b>{f.title || baseName(f.path)}</b><i>{dirName(f.path)} · {formatDayTime(f.mtime)}</i></span>
                    <span className="msb-pill">{t('museBrief.open')}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="msb-sec" data-section="widgets">
          <SectionHead title={t('museBrief.widgets')} extra={editing && view ? (
            <button type="button" className="msb-add" data-action="add" onClick={openAdd}><Plus size={13} />{t('museBrief.add')}</button>
          ) : undefined} />
          {adding && view && <AddPopover view={view} widgets={widgets} onAdd={addCard} onClose={() => setAdding(false)} />}
          <div className="msb-grid3 msb-wrow" ref={gridRef}>
            {cards.map((c) => (
              <CardShell key={c.key} card={c} editing={editing} off={off} status={status} root={libRoot}
                onHide={canEdit ? () => run({ type: 'hide', key: c.key }) : undefined} onGrip={canEdit ? grip(c.key) : undefined} />
            ))}
            {!editing && proposed.map((p) => (
              <CardShell key={`p:${p.key}`} card={p} editing={false} off={off} status={status} root={libRoot} proposal={p}
                onAccept={() => run({ type: 'accept', key: p.key })} onReject={() => run({ type: 'reject', key: p.key })} />
            ))}
          </div>
          {editing && view && view.hidden.length > 0 && (
            <div className="msb-hidden-row" data-hidden-cards="">
              <span>{t('museBrief.hiddenSection')}</span>
              {view.hidden.map((c) => <button type="button" key={c.key} className="msb-pill ghost" onClick={() => run({ type: 'show', key: c.key })}><Eye size={12} />{'builtin' in c.ref ? t(BUILTIN_TITLE[c.ref.builtin]) : c.key}</button>)}
            </div>
          )}
        </section>

        {(sections.today || editing) && (
          <section className="msb-sec" data-section="today">
            <SectionHead title={t('museBrief.today')} note={journal?.segments.length ? t('museBrief.todayNote', { n: journal.segments.length }) : undefined}
              editing={editing && canEdit} hidden={!sections.today} onToggle={() => run({ type: sections.today ? 'hide' : 'show', key: 'section:today' })} />
            {sections.today && (journal?.segments.length
              ? <button type="button" className="msb-tl" onClick={() => openLibraryFile(libRoot, journal.path)}>
                {journal.segments.map((s, i) => <div key={i} className="msb-tli"><i aria-hidden /><SegmentLine s={s} /></div>)}
              </button>
              : journal && <div className="msb-blank left">{t('museBrief.todayEmpty')}</div>)}
          </section>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

