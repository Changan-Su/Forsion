/** Calendar View —— Notion Calendar 式,连续原生滚动(跟手、无顿挫):
 *  周/3日/日 = 一条横向滚动的日列条(横滚一天一天连续推进);月 = 一条纵向滚动的周行条。
 *  小时线用背景渐变(零 DOM),事件拖拽 / 拖出新建走命令式 DOM(不触发整条重渲),故几百列仍丝滑。
 *  颜色/显隐/默认库/成员映射来自 calendarConfigStore;数据经 calendarMembers 汇成员库(+ agent 只读源)。
 *
 *  2026-10-16 用户定方案 B(docs/ToBeImproved/Calendar交互与待办右栏方案_2026-10-16/):
 *  · 桌面:单击空白 = 草稿(默认 1 小时),按住拖 = 拖出时长,全天行 / 月视图横拖 = 多天;草稿不落盘,标题在格子里打,
 *    Enter / 点别处保存,Esc / 没写标题就点走 = 丢弃。
 *  · 同日用户改口:编辑事件在事件旁的浮卡(EventCard),草稿的选日历 / 保存也是草稿块旁的浮卡(DraftCard),右栏只放待办。
 *  · 2026-10-20 第二轮方案:桌面右键动作 + 非模态浮卡;手机贴底抽屉、错位起止圆点,轻点空白先建草稿。 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
  type RefObject,
  type MutableRefObject,
} from 'react'
import { Check, ChevronLeft, ChevronRight, MoreHorizontal, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { zoomOf, UI_MODE, useViewModes, ViewModeSwitch } from '@lcl/engine'
import { AstryxScope } from '../theme/astryxBridge'
import { parseCalDate } from '@amadeus-shared/db/calDate'
import { usePageStore } from '../amadeus/store/pageStore'
import { isStamped } from '../amadeus/blocks/database/propertyTypes'
import {
  setAggCell,
  createAggEvent,
  firstDateCol,
  type AggDb,
  type AggRow,
} from '../amadeus/store/dbAggregateStore'
import { useCalendarMembers } from '../amadeus/store/calendarMembers'
import { useCalendarConfig, colorForDb, isHidden, defaultDbPath } from '../amadeus/store/calendarConfigStore'
import { HOUR_PX_DEFAULT, useCalendarNav, type CalDraft } from '../amadeus/store/calendarNavStore'
import { useAgentSchedulePolling, useAgentCalDbs } from '../stores/agentScheduleStore'
import { useOtherVaultCalDbs } from '../stores/otherVaultCalStore'
import { useIcsCalDbs } from '../stores/icsCalendarStore'
import { useMdCalDbs } from '../amadeus/store/mdMarkStore'
import { registerMessages, useI18n } from '../i18n'
import { track } from '../achievements/store'
import { EventCard, type Anchor } from './calendar/EventCard'
import { EventMenu, type EventCommand } from './calendar/EventMenu'
import './calendar/eventSurface.css'
import { clearCalendarClipboard, cloneCalendarEvent, copyCalendarEvent, pasteCalendarEvent, useCalendarClipboard } from './calendar/eventClipboard'
import { notifyApp } from '../stores/notificationStore'
import { DraftCard } from './calendar/DraftCard'
import { MODE_ITEMS, classifyCalKey } from './calendar/calKeys'
import { layoutTimedEvents } from './calendar/eventLayout'
import { calendarScope, deleteCalendarRow, rescheduleCalendarRow, undoLastCalendarEdit, redoLastCalendarEdit } from './calendar/eventActions'
import { TODO_DRAG_MIME, draftRange, draftValue, pickDraftDb } from './calendar/draft'
import {
  HOURS,
  weekdays,
  dowLabel,
  addDays,
  addMinutes,
  coversDay,
  daysRange,
  diffDays,
  eventBox,
  fmtDur,
  fmtStamp,
  isoWeek,
  localeWeekStart,
  monthLabel,
  sameDay,
  shiftDays,
  snap15,
  startOfDay,
  startOfWeek,
  toLocalDate,
  useWeekStart,
  useWeekStartPref,
  type WeekStartPref,
} from './calendar/dateUtils'

// 文案:本文件独占 `calview.*` 命名空间(其余日历文件各自持有自己的前缀,勿共用键)。
registerMessages({
  'calview.untitled': { zh: '未命名', en: 'Untitled' },
  'calview.newEventTitle': { zh: '新事件', en: 'New event' },
  'calview.newEvent': { zh: '新建事件', en: 'New event' },
  'calview.noTarget': { zh: '现在没有能写入的日历（个人日历暂时读不到）。请稍后再试，或在日历设置里添加一本日历。', en: 'No calendar can be written right now (your personal calendar could not be loaded). Try again later, or add a calendar in Calendar settings.' },
  'calview.today': { zh: '今天', en: 'Today' },
  'calview.prevPage': { zh: '上一页', en: 'Previous' },
  'calview.nextPage': { zh: '下一页', en: 'Next' },
  'calview.weekNo': { zh: '第 {n} 周', en: 'Week {n}' },
  'calview.zoomOut': { zh: '缩小时间轴', en: 'Zoom out timeline' },
  'calview.zoomIn': { zh: '放大时间轴', en: 'Zoom in timeline' },
  'calview.densityReset': { zh: '恢复默认密度', en: 'Reset to default density' },
  'calview.weekStart': { zh: '一周开始于', en: 'Week starts on' },
  'calview.weekStartAuto': { zh: '跟随语言（{day}）', en: 'Match language ({day})' },
  'calview.sunday': { zh: '周日', en: 'Sunday' },
  'calview.monday': { zh: '周一', en: 'Monday' },
  'calview.empty': {
    zh: '还没有日历事件。单击时间格新建，按住拖出时长，或按 C。',
    en: 'No calendar events yet. Click a time slot to add one, drag to set its length, or press C.',
  },
  // 还没有可写的日历时:点格子建不出东西,空态别再叫人点它(W-12)
  'calview.emptyNoDb': {
    zh: '还没有日历。在左栏「日历」右边点 +，选一个含日期属性的多维表。',
    en: 'No calendars yet. Use + next to "Calendars" in the left panel to pick a database with a date property.',
  },
  'calview.allDay': { zh: '全天', en: 'All-day' },
  'calview.a11yAllDayEvent': { zh: '{title}，全天事件', en: '{title}, all-day event' },
  'calview.allDayDragHint': { zh: '{title}（可拖入时间格设为定时）', en: '{title} (drag into a time slot to schedule it)' },
  'calview.a11yEvent': { zh: '{title}，{time}', en: '{title}, {time}' },
  'calview.a11yEventRange': { zh: '{title}，{start} 至 {end}', en: '{title}, {start} to {end}' },
  'calview.a11yDone': { zh: '标记完成：{title}', en: 'Mark done: {title}' },
  'calview.monthFirst': { zh: '{m}月1', en: '{m}/1' },
  'calview.moreItems': { zh: '还有 {n} 项', en: '{n} more' },
  'calview.viewOptions': { zh: '显示选项', en: 'Display options' },
  'calview.a11yMoreEvents': { zh: '查看 {m} 月 {d} 日全部 {n} 个事件', en: 'View all {n} events on {m}/{d}' },
  'calview.a11yDayEvents': { zh: '{m} 月 {d} 日事件', en: 'Events on {m}/{d}' },
  'calview.dayHeading': { zh: '{m} 月 {d} 日', en: '{m}/{d}' },
  'calview.closeAgenda': { zh: '关闭日程列表', en: 'Close agenda list' },
  'calview.resizeStart': { zh: '调整开始时间', en: 'Adjust start time' },
  'calview.resizeEnd': { zh: '调整结束时间', en: 'Adjust end time' },
})

// 小时高度改为可缩放状态(calendarNavStore.hourPx);CSS 网格线经 --amx-hour-px 变量同步(TimeScroll 根注入)。
const HEAD_H = 26
const EDGE = 8.4 // Selected desktop event edge hit zone; short events reserve their middle for movement/taps.
const SHORT_PX = 34 // 块高不够两行(约 45 分钟以内)→ 排成一行「标题 起始时间」
const DAY_HALF = 150 // 横向日窗 ±150 天(≈10 个月,足够一次会话连续滚动)
const WEEK_HALF = 40 // 纵向周窗 ±40 周
/** Phone uses a bottom drawer and touch controls; desktop keeps the adjacent nonmodal card. */
const DESK = !(UI_MODE === 'mobile' || (typeof window !== 'undefined' && !!window.tangu?.mobile))

interface CalApi { prev(): void; next(): void; today(): void; goto(date: Date): void }
interface CalEvent {
  key: string
  color: string
  db: AggDb
  row: AggRow
  colId: string
  title: string
  raw: string
  start: Date
  end: Date | null
  allDay: boolean
  /** 只读源事件(agent 日程):不可拖拽/缩放/编辑,点击只开只读卡。 */
  readonly?: boolean
  /** 这张表是待办来源(成员映射了勾选列)→ 列 id;块里画方框,在日历里就能勾。 */
  check?: string
  done?: boolean
}
type DraftGeom = Omit<CalDraft, 'title' | 'dbPath'>

interface CalEntry { db: AggDb; dateCol: string; checkboxCol?: string }
function buildEvents(entries: CalEntry[], vault: string, byVault: Parameters<typeof colorForDb>[1]): CalEvent[] {
  const out: CalEvent[] = []
  entries.forEach(({ db, dateCol, checkboxCol }, di) => {
    if (isHidden(vault, byVault, db.path)) return
    const color = colorForDb(vault, byVault, db.path, di)
    for (const r of db.rows) {
      const raw = typeof r.cells[dateCol] === 'string' ? (r.cells[dateCol] as string) : ''
      const cd = parseCalDate(raw)
      if (!cd) continue
      out.push({
        key: `${db.path}::${r.rowId}`,
        color,
        db,
        row: r,
        colId: dateCol,
        title: r.name, // 真实名(可空):网格层给「未命名」占位(见 visible),编辑卡显示空而非编码
        raw,
        start: toLocalDate(cd.start),
        end: cd.end ? toLocalDate(cd.end) : null,
        allDay: cd.allDay,
        // 可编辑投影(笔记 `@` 标记源)给了 writeCell → 允许拖拽/改期;删除仍由 db.readonly 关着。
        readonly: (!!db.readonly && !db.writeCell) || isStamped(db.columns.find((c) => c.id === dateCol)?.type ?? ''),
        check: checkboxCol,
        done: checkboxCol ? r.cells[checkboxCol] === true : undefined,
      })
    }
  })
  return out
}
/** 只有日期的待办(勾选列 + 单天全天)住右栏的待办,不进周 / 日视图的全天行(方案页「待办」那节)。
 *  只在桌面:手机这轮没动,待办不在右栏,滤掉就看不到了(Codex 评审)。 */
const dateOnlyTodo = (e: CalEvent): boolean => DESK && !!e.check && e.allDay && !e.end

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const fmtMin = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const iso = (d: Date): string => fmtStamp(d, true)
const rectOf = (e: ReactMouseEvent | ReactPointerEvent): Anchor => {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, zoom: zoomOf(el) || 1 }
}
const eventValue = (start: Date, end: Date | null, allDay: boolean): string =>
  end ? `${fmtStamp(start, allDay)}/${fmtStamp(end, allDay)}` : fmtStamp(start, allDay)
/** 拖动改时间 / 时长:写新值并给撤销(eventActions 出提示条,⌘Z 也能撤)。 */
const commitTime = (ev: CalEvent, start: Date, end: Date | null, allDay = ev.allDay): void =>
  rescheduleCalendarRow(ev.db, ev.row, ev.colId, ev.raw, eventValue(start, end, allDay), ev.title)

const eventColorStyle = (color: string): CSSProperties =>
  ({ '--amx-event-color': color } as CSSProperties)

const daySpanClass = (start: Date, end: Date | null, day: Date): string => {
  const t = startOfDay(day).getTime()
  const before = startOfDay(start).getTime() < t
  const after = startOfDay(end ?? start).getTime() > t
  return `${before ? ' continues-left' : ''}${after ? ' continues-right' : ''}`
}

/** 草稿收尾:写了标题 = 保存,没写 = 丢弃(点到别处 / 点网格空白时用;Enter 另走 commit,空标题用占位名)。 */
function finishDraft(): void {
  const n = useCalendarNav.getState()
  if (!n.draft) return
  if (n.draft.title.trim()) n.draftApi?.commit()
  else n.setDraft(null)
}
/** 草稿几何(不含标题):网格只订阅它,打字只重渲输入框本身,几百列不跟着重排。 */
const draftGeomKey = (s: { draft: CalDraft | null }): string =>
  s.draft ? `${s.draft.day}|${s.draft.endDay}|${s.draft.startMin}|${s.draft.endMin}` : ''

export function CalendarView({ leafId }: { leafId?: string } = {}) {
  const { t } = useI18n()
  // 周首日一变(语言 / 日历设置),月视图整块重挂:它的周行、居中滚动位都按周首日算过一遍。
  const firstDow = useWeekStart()
  const weekPref = useWeekStartPref((s) => s.pref)
  const members = useCalendarMembers()
  const agentDbs = useAgentCalDbs()
  const otherDbs = useOtherVaultCalDbs() // 非活动侧(Local↔Cloud 另一侧)只读日历,汇总两侧(任务1)
  const icsDbs = useIcsCalDbs() // 外部日历订阅(.ics):同为只读叠加源
  const mdDbs = useMdCalDbs() // 笔记正文 `@2026-09-01T14:30` 标记(无勾选框的那些):同为只读叠加源
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const byVault = useCalendarConfig((s) => s.byVault)
  const mode = useCalendarNav((s) => s.mode)
  const setMode = useCalendarNav((s) => s.setMode)
  // 日 / 周 / 3 日 / 月 = 视图模式(lcl viewModes,方案 A):胶囊在栏最左,⌥⌘V 切下一种;D / W / 3 / M 单键照旧(悬停提示里写着)。全局记(useCalendarNav)。
  useViewModes(leafId, { modes: MODE_ITEMS.map((m) => ({ value: m.id, label: m.label, hotkey: m.key.toUpperCase() })), value: mode, onChange: (v) => setMode(v as typeof mode) })
  const hourPx = useCalendarNav((s) => s.hourPx)
  const setHourPx = useCalendarNav((s) => s.setHourPx)
  const jumpNonce = useCalendarNav((s) => s.jumpNonce)
  const selection = useCalendarNav((s) => s.selection)
  const hasDraft = useCalendarNav((s) => !!s.draft)
  // 点开的事件:事件旁的浮卡(桌面、手机都是)。selection 只是高亮(刚建 / 刚复制的那条),Enter 再开卡。
  const [card, setCard] = useState<{ key: string; at: Anchor } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [preview, setPreview] = useState<CalEvent | null>(null)
  const [gesture, setGesture] = useState(false)
  const [focusTitle, setFocusTitle] = useState(false)
  const clip = useCalendarClipboard((s) => s.clip)
  const pasteAt = useRef<Date | undefined>(undefined)
  const titleRef = useRef<HTMLSpanElement>(null)
  const api = useRef<CalApi>(null)
  // 月视图当前看的是哪个月:周首日一变,月视图按新周首日整块重挂(key 带 firstDow),重挂后回到这个月而不是跳回今天
  // (Codex 第一轮 D-1)。切去周 / 日视图就作废 —— 从别的视图回月视图仍按老规矩落在今天。
  const monthAnchor = useRef<MonthAnchor | null>(null)
  useEffect(() => { if (mode !== 'month') monthAnchor.current = null }, [mode])
  const selRef = useRef<CalEvent | null>(null) // 常驻键盘 effect 读当前选中(避免 [] 闭包读旧值)
  const pendingKey = useRef<string | null>(null) // 刚建 / 刚复制的那行:出现在事件流里就选中它
  const interactionEpoch = useRef(0)

  // mini 日历点某日 → 主区丝滑跳转(当前挂载的 month/time 子视图各自在自身坐标系里滚动)。
  useEffect(() => {
    if (!jumpNonce) return
    const d = useCalendarNav.getState().jumpDate
    if (d) api.current?.goto(toLocalDate(d))
  }, [jumpNonce])

  useAgentSchedulePolling()

  // 成员库 + agent 只读源汇入事件流;新建只落成员库(绝不落到 agent:// 假路径)。
  const entries = useMemo<CalEntry[]>(
    () => [
      ...members.map((m) => ({ db: m.db, dateCol: m.dateCol, checkboxCol: m.checkboxCol })),
      ...[...agentDbs, ...otherDbs, ...icsDbs, ...mdDbs].map((db) => ({ db, dateCol: firstDateCol(db)?.id })).filter((x): x is CalEntry => !!x.dateCol),
    ],
    [members, agentDbs, otherDbs, icsDbs, mdDbs],
  )
  const events = useMemo(() => buildEvents(entries, vault, byVault), [entries, vault, byVault])
  const eventsRef = useRef(events)
  eventsRef.current = events
  // 无名事件以「未命名」占位上网格(清空名字时事件块不许消失);编辑卡走 events 原值,输入框保持真实空值。
  const visible = useMemo(() => events.map((e) => (e.title ? e : { ...e, title: t('calview.untitled') })), [events, t])
  const selectedKey = card?.key ?? selection?.key ?? null
  const selected = selectedKey ? events.find((e) => e.key === selectedKey) ?? null : null
  selRef.current = selected
  const target = pickDraftDb(members, null, defaultDbPath(vault, byVault))
  const colorOf = (dbPath: string | null): string => {
    const m = pickDraftDb(members, dbPath, defaultDbPath(vault, byVault))
    return m ? colorForDb(vault, byVault, m.db.path, members.indexOf(m)) : 'var(--accent)'
  }

  /** 点开事件:在事件旁浮卡编辑(10-16 用户:「和之前一样在旁边的悬浮卡片,不要在 right panel」)。 */
  const pick = (key: string, at: Anchor): void => {
    ++interactionEpoch.current
    if (DESK) finishDraft()
    else {
      if (useCalendarNav.getState().draft?.title.trim() && !window.confirm(t('calside.discard'))) return
      useCalendarNav.getState().setDraft(null)
    }
    pendingKey.current = null // 用户自己点了别的:等着的新行到了也别再把选中抢过去
    const ev = eventsRef.current.find((e) => e.key === key)
    if (ev) useCalendarNav.getState().setSelection({ key, target: ev })
    setMenu(null)
    setCollapsed(false)
    setFocusTitle(false)
    pasteAt.current = undefined
    setCard({ key, at })
  }
  /** 刚建 / 刚复制的那条:只高亮(不弹卡),Delete / ⌘D 对它生效,Enter 开卡。 */
  const selectWhenReady = (key: string): void => {
    const ev = eventsRef.current.find((e) => e.key === key)
    if (!ev) { pendingKey.current = key; return }
    useCalendarNav.getState().setSelection({ key, target: ev })
    if (!DESK) {
      const node = rootRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      if (node) {
        const r = node.getBoundingClientRect()
        setCollapsed(false)
        setCard({ key, at: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, zoom: zoomOf(node) || 1 } })
      }
    }
  }
  // 事件流一变:等着的新行到了就高亮;高亮的那条换成最新对象,被删了就清掉。
  useEffect(() => {
    const nav = useCalendarNav.getState()
    if (card && !events.some((e) => e.key === card.key)) { setCard(null); setMenu(null) }
    const p = pendingKey.current
    if (p && events.some((e) => e.key === p)) { pendingKey.current = null; selectWhenReady(p) }
    const sel = useCalendarNav.getState().selection
    if (!sel) return
    const ev = events.find((e) => e.key === sel.key)
    if (!ev) nav.setSelection(null)
    else if (ev !== sel.target) nav.setSelection({ key: sel.key, target: ev })
  }, [events]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    setCard(null); setMenu(null); setPreview(null); clearCalendarClipboard()
    interactionEpoch.current++; pendingKey.current = null; pasteAt.current = undefined; selRef.current = null
    const nav = useCalendarNav.getState()
    nav.setDraft(null); nav.setSelection(null)
    return () => { clearCalendarClipboard() }
  }, [vault])

  /** 点网格空白:有草稿 / 选中 / 浮卡时第一下只退出,返回 true(这一下不再新建)。 */
  const dismiss = (): boolean => {
    ++interactionEpoch.current
    const nav = useCalendarNav.getState()
    const had = !!nav.draft || !!nav.selection || !!card
    if (DESK) finishDraft()
    else if (nav.draft) {
      if (nav.draft.title.trim() && !window.confirm(t('calside.discard'))) return true
      nav.setDraft(null)
    }
    if (nav.selection) nav.setSelection(null)
    setCard(null)
    setMenu(null)
    pasteAt.current = undefined
    return had
  }
  // 没有可写的日历时点了要有回应,别让人以为没点到(10-23 用户)
  const noTarget = (): void => { notifyApp({ level: 'warning', text: t('calview.noTarget') }) }
  const startDraft = (g: DraftGeom): void => {
    ++interactionEpoch.current
    if (!target) { noTarget(); return }
    const nav = useCalendarNav.getState()
    nav.setSelection(null)
    setCard(null)
    pasteAt.current = addMinutes(toLocalDate(g.day), g.startMin ?? 0)
    nav.setDraft({ ...g, scope: calendarScope(), title: '', dbPath: clip && members.some((m) => m.db.path === clip.event.db.path) ? clip.event.db.path : null })
  }
  // 草稿提交 / 取消挂进 store,右栏草稿面板的按钮和格子里的输入框走同一份。
  const commitRef = useRef<() => Promise<void>>(async () => {})
  commitRef.current = async () => {
    const nav = useCalendarNav.getState()
    const d = nav.draft
    if (!d) return
    if (d.scope !== calendarScope()) { nav.setDraft(null); return }
    nav.setDraft(null)
    const m = pickDraftDb(members, d.dbPath, defaultDbPath(vault, byVault))
    if (!m) return
    const before = nav.selection
    const epoch = interactionEpoch.current, scope = calendarScope()
    const id = await createAggEvent(m.db, m.dateCol, draftValue(d), d.title.trim() || t('calview.newEventTitle'))
    track('calendar.event')
    // 存盘期间用户已经点了别的事件(常见:打完标题直接点别的块 = 失焦保存)→ 不抢它的选中。
    if (epoch === interactionEpoch.current && scope === calendarScope() && !useCalendarNav.getState().draft && useCalendarNav.getState().selection === before) selectWhenReady(`${m.db.path}::${id}`)
  }
  useEffect(() => {
    const nav = useCalendarNav.getState()
    nav.setDraftApi({ commit: () => void commitRef.current(), cancel: () => useCalendarNav.getState().setDraft(null) })
    return () => { const n = useCalendarNav.getState(); n.setDraftApi(null); n.setDraft(null); n.setSelection(null) }
  }, [])

  // 手机:双击空白当场建一条 30 分钟的事件并开浮卡(这一轮不动)。
  const createNow = async (day: Date, min: number | null, at: Anchor): Promise<void> => {
    if (!target) { noTarget(); return }
    if (!DESK) {
      const dayKey = iso(day)
      startDraft({ day: dayKey, endDay: dayKey, startMin: min, endMin: min === null ? 0 : min + 30 })
      return
    }
    const { db, dateCol } = target
    let value: string
    if (min === null) value = fmtStamp(day, true)
    else {
      const start = addMinutes(startOfDay(day), min)
      value = `${fmtStamp(start, false)}/${fmtStamp(addMinutes(start, 30), false)}`
    }
    const newId = await createAggEvent(db, dateCol, value, t('calview.newEventTitle'))
    track('calendar.event')
    setCard({ key: `${db.path}::${newId}`, at })
  }
  /** C:在下一个整刻钟建草稿(月视图 = 今天的全天)。 */
  const newAtNextSlot = (): void => {
    const now = new Date()
    const day = iso(now)
    api.current?.today()
    if (mode === 'month') { startDraft({ day, endDay: day, startMin: null, endMin: 0 }); return }
    const [s, e] = draftRange(Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15, 0, true)
    startDraft({ day, endDay: day, startMin: s, endMin: e })
  }
  const newRef = useRef(newAtNextSlot)
  newRef.current = newAtNextSlot
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  const runCommand = (action: EventCommand): void => {
    const sel = selRef.current
    setMenu(null)
    rootRef.current?.focus({ preventScroll: true })
    switch (action) {
      case 'copy': if (sel) copyCalendarEvent(sel); break
      case 'cut': if (sel) copyCalendarEvent(sel, true); break
      case 'clone': {
        const epoch = interactionEpoch.current, scope = calendarScope()
        if (sel) void cloneCalendarEvent(sel).then((id) => {
          if (id && epoch === interactionEpoch.current && scope === calendarScope()) { setCard(null); selectWhenReady(`${sel.db.path}::${id}`) }
        })
        break
      }
      case 'paste': {
        const draft = useCalendarNav.getState().draft
        if (draft?.title.trim() && !window.confirm(t('calside.discard'))) break
        const epoch = interactionEpoch.current, scope = calendarScope()
        const date = pasteAt.current ?? (draft ? addMinutes(toLocalDate(draft.day), draft.startMin ?? 0) : undefined)
        void pasteCalendarEvent(date ? undefined : sel?.db, date).then((result) => {
          if (!result || epoch !== interactionEpoch.current || calendarScope() !== scope || useCalendarNav.getState().draft !== draft) return
          useCalendarNav.getState().setDraft(null)
          setCard(null)
          selectWhenReady(`${result.db.path}::${result.id}`)
        })
        break
      }
      case 'delete':
        if (!sel || sel.db.readonly) break
        deleteCalendarRow(sel.db, sel.row, sel.title)
        useCalendarNav.getState().setSelection(null)
        setCard(null)
        if (clip?.cut && clip.event.row.rowId === sel.row.rowId && clip.event.db.path === sel.db.path) clearCalendarClipboard()
        break
      case 'undo': undoLastCalendarEdit(); break
      case 'redo': redoLastCalendarEdit(); break
      case 'summary':
        if (sel) void navigator.clipboard?.writeText(`${sel.title}\n${sel.raw}\n${sel.db.name}`).catch(() => notifyApp({ level: 'warning', text: t('calclip.failed') }))
        break
    }
  }
  const commandRef = useRef(runCommand)
  commandRef.current = runCommand
  const closeSurface = (): void => { if (menu) setMenu(null); else dismissRef.current() }
  useEffect(() => {
    if (DESK || (!card && !menu)) return
    const back = (e: Event): void => {
      e.preventDefault()
      if (!(e as CustomEvent).detail?.probe) closeSurface()
    }
    window.addEventListener('forsion:mobile-back', back)
    return () => window.removeEventListener('forsion:mobile-back', back)
  }, [card, menu])

  // 键盘:D/W/3/M 切模式、←/→ 翻页、T 回今天、C 新建、Enter 改标题、Esc 退出、⌘C/⌘V/⌘D 复制、Delete 删除、⌘Z 撤销。
  // 输入控件不劫持;日历不在前台(别的标签 / 别的 Space)或焦点在别的面板里也不劫持。
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root || !root.getClientRects().length) return
      const el = e.target as HTMLElement | null
      if (e.isComposing || el?.closest('[role="menu"]')) return
      if (el && el.closest('input, textarea, select, [contenteditable]')) return
      const side = useCalendarNav.getState().sideEl
      const a = document.activeElement
      // 焦点在事件卡 / 当日日程里:卡片自己管 Esc / Tab / 删除,日历快捷键让开 ——
      // 右栏待办常驻后,待办卡开着时 Delete 会删掉主区高亮的另一条、C 会在卡下面起草稿(Codex 评审)
      if (a?.closest('[role="dialog"]') && !a.closest('.amx-cal-cardcatch.calendar')) return
      const inCfg = !!a?.closest('.amx-calcfg') // 刚点过左栏小月历 / 日历列表:翻页类快捷键照样生效
      if (a && a !== document.body && !root.contains(a) && !side?.contains(a) && !inCfg && a.closest('.dv-react-part')) return
      const act = classifyCalKey(e)
      if (!act) return
      if (inCfg && !['today', 'prev', 'next', 'mode'].includes(act.kind)) return // 删除 / 复制这类只在焦点在日历里时生效
      const sel = selRef.current
      const nav = useCalendarNav.getState()
      switch (act.kind) {
        case 'copy':
        case 'cut':
        case 'paste':
        case 'duplicate':
        case 'delete':
        case 'undo':
        case 'redo':
          commandRef.current(act.kind === 'duplicate' ? 'clone' : act.kind)
          break
        case 'menu': {
          if (!sel) return
          const r = root.querySelector(`[data-key="${CSS.escape(sel.key)}"]`)?.getBoundingClientRect()
          if (r) setMenu({ x: r.left, y: r.bottom })
          break
        }
        case 'new':
          if (!DESK) return
          newRef.current()
          break
        case 'today':
          api.current?.today()
          break
        case 'rename': {
          // 焦点在工具栏按钮上时 Enter 照旧按按钮;高亮着一条事件时 Enter = 在它旁边开卡(卡里标题框自动聚焦)。
          if (el?.closest('button') && !el.closest('.amx-cal-event, .amx-cal-chip-ev')) return
          if (!sel) return
          setFocusTitle(true)
          if (card) break
          if (!nav.selection) return
          // 事件块不一定渲染出来(月视图一天超过三条会折进「还有 N 项」):找不到就贴在那一天的格子旁
          const node = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(nav.selection.key)}"]`)
            ?? root.querySelector<HTMLElement>(`.amx-cal-mcell[data-date="${iso(sel.start)}"], .amx-cal-daycol2[data-date="${iso(sel.start)}"]`)
          if (!node) return
          const r = node.getBoundingClientRect()
          setCard({ key: nav.selection.key, at: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, zoom: zoomOf(node) || 1 } })
          nav.setSelection(null)
          break
        }
        case 'escape':
          if (useCalendarClipboard.getState().clip?.cut) clearCalendarClipboard()
          if (menu) { setMenu(null); break }
          if (nav.draft) nav.setDraft(null)
          else if (nav.selection || card) dismissRef.current()
          else return
          break
        case 'prev':
          api.current?.prev()
          break
        case 'next':
          api.current?.next()
          break
        case 'mode':
          nav.setMode(act.mode)
          break
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, menu]) // eslint-disable-line react-hooks/exhaustive-deps

  // 主区放不下 7 列(每列最窄 84,左轴 52;10-16 从 112 降下来:右栏常驻后 1200 宽的窗口也该看到整周)时,「周」按放得下的天数显示(3 天,再窄 1 天);「3 日」同理。
  // 标题、可见区与右栏高亮都跟着 n 走,不再只露两天半、标题却写一整周(W-13)。列宽下限与 TimeScroll 的 minCol 一致。
  const [fit, setFit] = useState(7)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    // 标签不显示时 Dockview 把 DOM 摘下,量到的是 0:别拿它改状态(否则挂回来按 1 列的列宽换算滚动位置,跳到 8 月;10-17)。下同。
    const measure = (): void => { if (!el.clientWidth) return; const w = el.clientWidth - 52; setFit(w >= 7 * 84 ? 7 : w >= 3 * 84 ? 3 : 1) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const n = Math.min(mode === 'week' ? 7 : mode === '3day' ? 3 : 1, fit)
  const dayName = (d: 0 | 1): string => t(d === 1 ? 'calview.monday' : 'calview.sunday')
  const weekStartItems: Array<{ value: WeekStartPref; label: string }> = [
    { value: 'auto', label: t('calview.weekStartAuto', { day: dayName(localeWeekStart()) }) },
    { value: 0, label: dayName(0) },
    { value: 1, label: dayName(1) },
  ]
  /** 右栏待办拖进来:时间格 = 排 30 分钟的时段,全天行 = 只改日期;给撤销。 */
  const todoDrop = (data: { dbPath: string; rowId: string }, value: string): void => {
    const m = members.find((x) => x.db.path === data.dbPath)
    const row = m?.db.rows.find((r) => r.rowId === data.rowId)
    if (!m || !row || m.db.readonly) return
    const raw = typeof row.cells[m.dateCol] === 'string' ? (row.cells[m.dateCol] as string) : ''
    rescheduleCalendarRow(m.db, row, m.dateCol, raw, value, row.name)
  }
  const tick = (on: boolean) => (on ? <Check size={14} /> : <span style={{ display: 'inline-block', width: 14 }} />)
  const gridProps = {
    events: visible,
    selectedKey,
    cutKey: clip?.cut ? `${clip.event.db.path}::${clip.event.row.rowId}` : null,
    onPick: pick,
    canCreate: !!target,
    onDismiss: dismiss,
    onDraft: startDraft,
    colorOf,
    onTodoDrop: todoDrop,
    titleRef,
    onGesture: (ev: CalEvent | null): void => {
      setGesture(!!ev)
      setPreview((before) => before?.key === ev?.key && before?.raw === ev?.raw ? before : ev)
      if (ev) {
        if (useCalendarNav.getState().selection?.key !== ev.key) useCalendarNav.getState().setSelection({ key: ev.key, target: ev })
        setCollapsed(true)
      }
    },
  }
  return (
    // tabIndex -1:点进日历时焦点落在这里,键盘快捷键据此判断「用户正在用日历」。
    <div className={`amx-cal${!DESK ? ' mobile' : ''}${!DESK && (card || hasDraft) ? ` drawer-open${collapsed && card ? ' drawer-small' : ''}` : ''}`} ref={rootRef} tabIndex={-1}
      data-cut-key={clip?.cut ? `${clip.event.db.path}::${clip.event.row.rowId}` : undefined}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.amx-cal-cardwrap, input, textarea')) return
        const node = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')
        const ev = eventsRef.current.find((x) => x.key === node?.dataset.key)
        if (ev) {
          e.preventDefault(); e.stopPropagation()
          const r = node!.getBoundingClientRect()
          if (DESK) {
            useCalendarNav.getState().setSelection({ key: ev.key, target: ev })
            setCard(null)
            pasteAt.current = undefined
          } else pick(ev.key, { left: r.left, top: r.top, right: r.right, bottom: r.bottom, zoom: zoomOf(node!) || 1 })
          setMenu({ x: e.clientX, y: e.clientY })
          return
        }
        const day = (e.target as HTMLElement).closest<HTMLElement>('[data-date]')
        if (day?.dataset.date) {
          e.preventDefault(); e.stopPropagation()
          dismiss()
          const mins = day.classList.contains('amx-cal-daycol2') ? Math.max(0, Math.min(1425, snap15((e.clientY - day.getBoundingClientRect().top) / (zoomOf(day) || 1) / hourPx * 60))) : 0
          pasteAt.current = addMinutes(toLocalDate(day.dataset.date), mins)
          setMenu({ x: e.clientX, y: e.clientY })
        }
      }}>
      <AstryxScope>
        {/* 左:看法胶囊(日 / 周 / 3 日 / 月)+ 月份 + 周数;右:今天 ‹ › 「…」(密度、一周开始)。新建 = 单击格子 / 按 C。 */}
        <header className="amx-cal-bar">
          <div className="amx-cal-nav">
            <ViewModeSwitch leafId={leafId} />
            <span className="amx-cal-title" ref={titleRef} />
          </div>
          <div className="amx-cal-modes">
            <Button size="sm" variant="secondary" label={t('calview.today')} onClick={() => api.current?.today()} />
            <Button size="sm" variant="ghost" isIconOnly icon={<ChevronLeft size={14} />} label={t('calview.prevPage')} onClick={() => api.current?.prev()} />
            <Button size="sm" variant="ghost" isIconOnly icon={<ChevronRight size={14} />} label={t('calview.nextPage')} onClick={() => api.current?.next()} />
            <DropdownMenu button={{ label: t('calview.viewOptions'), isIconOnly: true, icon: <MoreHorizontal size={14} />, variant: 'ghost', size: 'sm' }} menuWidth={208}>
              {mode !== 'month' && <DropdownMenuItem icon={<ZoomOut size={14} />} label={t('calview.zoomOut')} onClick={() => setHourPx(hourPx - 8)} />}
              {mode !== 'month' && <DropdownMenuItem icon={<ZoomIn size={14} />} label={t('calview.zoomIn')} onClick={() => setHourPx(hourPx + 8)} />}
              {mode !== 'month' && <DropdownMenuItem icon={<RotateCcw size={14} />} label={t('calview.densityReset')} endContent={`${hourPx}px`} onClick={() => setHourPx(HOUR_PX_DEFAULT)} />}
              {mode !== 'month' && <div className="amx-cal-menusep" role="separator" />}
              <div className="amx-cal-menulabel">{t('calview.weekStart')}</div>
              {weekStartItems.map((o) => (
                <DropdownMenuItem key={String(o.value)} icon={tick(weekPref === o.value)} label={o.label} onClick={() => useWeekStartPref.getState().setPref(o.value)} />
              ))}
            </DropdownMenu>
          </div>
        </header>
      </AstryxScope>

      {visible.length === 0 && (
        <div className="amx-cal-empty">
          {t(target ? 'calview.empty' : 'calview.emptyNoDb')}
          {target && DESK && (
            <AstryxScope>
              <Button size="sm" variant="secondary" label={t('calview.newEvent')} onClick={newAtNextSlot} />
            </AstryxScope>
          )}
        </div>
      )}

      {mode === 'month' ? (
        <MonthScroll key={`dow${firstDow}`} ref={api} anchorRef={monthAnchor} {...gridProps} onCreate={(d, at) => void createNow(d, null, at)} />
      ) : (
        <TimeScroll ref={api} n={n} weekStartDow={mode === 'week' && n === 7 ? firstDow : null} {...gridProps} onCreate={(d, min, at) => void createNow(d, min, at)} />
      )}

      {selected && card && (!DESK || !gesture) && <EventCard key={selected.key} calendar focusTitle={focusTitle} ev={preview ?? selected} at={card.at} collapsed={!DESK && collapsed} onExpand={() => setCollapsed(false)}
        maxRight={rootRef.current?.getBoundingClientRect().right} onClose={closeSurface}
        onActions={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom }); setCollapsed(false) }}
        actions={!DESK && menu ? <EventMenu at={menu} mobile canCut={!selected.readonly} writable={!selected.db.readonly} note={selected.db.isNoteView} hasClip={!!clip} onRun={runCommand} onClose={() => setMenu(null)} /> : undefined} />}
      {menu && (DESK || !card) && <EventMenu at={menu} mobile={false} hasEvent={!!selected} canCut={!selected?.readonly} writable={!selected?.db.readonly} note={!!selected?.db.isNoteView} hasClip={!!clip} onRun={runCommand} onClose={() => setMenu(null)} />}
      <DraftCard rootRef={rootRef} onPasted={selectWhenReady} />
    </div>
  )
}

interface GridProps {
  events: CalEvent[]
  selectedKey: string | null
  cutKey?: string | null
  onPick: (key: string, at: Anchor) => void
  /** 有可写的日历(没有就点不出草稿)。 */
  canCreate: boolean
  /** 点网格空白时先退出草稿 / 选中;返回 true = 这一下只用来退出。 */
  onDismiss: () => boolean
  onDraft: (g: DraftGeom) => void
  colorOf: (dbPath: string | null) => string
  onTodoDrop?: (data: { dbPath: string; rowId: string }, value: string) => void
  titleRef: RefObject<HTMLSpanElement | null>
  onGesture?: (ev: CalEvent | null) => void
}

/** 草稿的标题框:格子里直接打。Enter 保存(空标题 = 不建),Esc 丢弃;焦点去别处(草稿卡除外)= 写了就存、没写就丢。 */
function DraftInput({ first = true }: { first?: boolean }) {
  const { t } = useI18n()
  const title = useCalendarNav((s) => s.draft?.title ?? '')
  if (!first || !DESK) return <span className="amx-cal-event-title">{title || t('calview.newEventTitle')}</span>
  return (
    <input
      className="amx-cal-draft-input"
      autoFocus
      value={title}
      placeholder={t('calview.newEventTitle')}
      aria-label={t('calview.newEventTitle')}
      onChange={(e) => { const nav = useCalendarNav.getState(); if (nav.draft) nav.setDraft({ ...nav.draft, title: e.target.value }) }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') {
          e.preventDefault()
          const nav = useCalendarNav.getState()
          if (nav.draft?.title.trim()) nav.draftApi?.commit()
          else nav.setDraft(null) // 有标题才落库:空标题回车 = 不建(走查里误回车留下了「新事件」)
        }
        else if (e.key === 'Escape') { e.preventDefault(); useCalendarNav.getState().setDraft(null) }
      }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Element && e.relatedTarget.closest('.amx-cal-draftcard')) return // Tab 进草稿卡不算点走
        if (!document.hasFocus()) return // 切到别的 App 不算「点到别处」:回来时草稿还在
        finishDraft()
      }}
    />
  )
}
/** 草稿块 / 条的外壳:点在块上(不是输入框)别让网格当成「点空白」,焦点留在输入框里。 */
const draftShell = {
  onPointerDown: (e: ReactPointerEvent) => e.stopPropagation(),
  onMouseDown: (e: ReactMouseEvent) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault() },
}
function DraftChip({ day, colorOf }: { day: Date; colorOf: GridProps['colorOf'] }) {
  const draft = useCalendarNav((s) => s.draft)
  if (!draft) return null
  return (
    <div className={`amx-cal-chip-ev amx-cal-draft selected${daySpanClass(toLocalDate(draft.day), toLocalDate(draft.endDay), day)}`} style={eventColorStyle(colorOf(draft.dbPath))} {...draftShell}>
      {draft.startMin !== null && <span className="amx-cal-chip-t">{fmtMin(draft.startMin)}</span>}
      <DraftInput first={iso(day) === draft.day} />
    </div>
  )
}
function DraftBlock({ hourPx, colorOf }: { hourPx: number; colorOf: GridProps['colorOf'] }) {
  const draft = useCalendarNav((s) => s.draft)
  if (!draft || draft.startMin === null) return null
  const h = ((draft.endMin - draft.startMin) / 60) * hourPx
  return (
    <div
      className={`amx-cal-event amx-cal-draft selected${h < SHORT_PX ? ' short' : ''}`}
      style={{ ...eventColorStyle(colorOf(draft.dbPath)), top: (draft.startMin / 60) * hourPx, height: Math.max(14, h), left: 2, width: 'calc(100% - 4px)' }}
      {...draftShell}
    >
      <DraftInput />
      <span className="amx-cal-event-t">{h < SHORT_PX ? fmtMin(draft.startMin) : `${fmtMin(draft.startMin)}–${fmtMin(draft.endMin)}`}</span>
    </div>
  )
}

// ── 时间网格(横向连续日列条)────────────────────────────────────────────────
interface TimeProps extends GridProps {
  n: number
  /** 「周」模式整周可见时 = 周首日(0/1):首列、「今天」与跳转都对齐到这一天(W-74);其余模式 null,按天滚动。 */
  weekStartDow: number | null
  /** 手机:双击当场建。 */
  onCreate: (day: Date, min: number | null, at: Anchor) => void
}
const TimeScroll = forwardRef<CalApi, TimeProps>(function TimeScroll({ n, weekStartDow, events, selectedKey, cutKey, onPick, canCreate, onDismiss, onDraft, colorOf, onTodoDrop, onCreate, titleRef, onGesture }, ref) {
  const { t } = useI18n()
  const wrap = useRef<HTMLDivElement>(null)
  const gutterHours = useRef<HTMLDivElement>(null) // 表头/全天常驻；仅小时轴随正文纵向滚动。
  const [colw, setColw] = useState(0)
  const [alldayH, setAlldayH] = useState(0) // 全天行高(auto,由日区量出)→ 左轴 gallday 镜像,保小时刻度对齐
  const hourPx = useCalendarNav((s) => s.hourPx)
  const setVisibleRange = useCalendarNav((s) => s.setVisibleRange)
  const draftGeom = useCalendarNav(draftGeomKey)
  const draftAt = draftGeom ? draftGeom.split('|') : null // [day, endDay, startMin, endMin]
  // 左轴纵向跟随日区滚动(命令式,不触发重渲,几百列仍丝滑)。
  const syncGutter = (): void => {
    if (gutterHours.current && wrap.current) gutterHours.current.style.transform = `translateY(${-wrap.current.scrollTop}px)`
  }
  const today = useMemo(() => startOfDay(new Date()), [])
  const days = useMemo(() => {
    const b = addDays(today, -DAY_HALF)
    return Array.from({ length: DAY_HALF * 2 + 1 }, (_, i) => addDays(b, i))
  }, [today])
  // 把列下标退到所在周的周首日(不在周模式时原样返回)。
  const alignIdx = (i: number): number => (weekStartDow == null ? i : Math.max(0, i - ((days[i].getDay() - weekStartDow + 7) % 7)))
  const firstIdx = useRef(DAY_HALF)
  const alignedFor = useRef<number | null | undefined>(undefined) // 上次按哪个周首日对齐过;只在它变时对齐,单纯拉宽窗口不拽回
  const centered = useRef(false)
  const lastTitle = useRef('')
  const lastRangeI = useRef(-1)
  const makeEl = useRef<HTMLDivElement>(null) // 拖出新建时的预览块(命令式定位,松手后换成草稿)
  const hoverEl = useRef<HTMLDivElement>(null) // 悬停时「点下去会建在哪」
  const hideHover = (): void => { if (hoverEl.current) hoverEl.current.style.display = 'none' }
  const dragRef = useRef<{
    mode: 'move' | 'start' | 'end'
    ev: CalEvent      // 拖拽中实时反算时间文本用
    el: HTMLElement
    tEl: HTMLElement | null // 块内时间文本 span(拖拽中命令式更新)
    t0: string        // 原始时间文本(未生效的拖拽收手时还原)
    pid: number      // 按下的那根指针:别的指针(笔拖着时鼠标划过)的移动 / 松手不算这次拖动
    x0: number; y0: number
    zoom: number      // PointerEvent 是视口 px；transform/hourPx 是未缩放局部 px，换算必须除累计 CSS zoom。
    top0: number; h0: number
    grabOffY: number // 按下时光标距事件顶部的偏移,拖动保持该抓握点
    durMin: number   // 时长(分,用于吸附上限)
    msDur: number    // 原始 end-start 毫秒(0=无 end);提交时保留精确时长
    col0: number; min0: number // 原位置(列下标 + 起始分钟):块按吸附后的差值整格平移
    dup: boolean     // 按住 ⌥ 拖 = 复制一份
    shadow: HTMLElement | null // 原位置留的淡影(复制时是原件本身的样子)
    dyMin: number
    moved: boolean
    target: { iso: string; topMin: number } | null // move 落点:目标日 + 吸附后起始分钟
    last?: ReactPointerEvent
  } | null>(null)
  const makeRef = useRef<{ pid: number; zone: 'time' | 'all'; col: number; min: number; cur: { col: number; min: number }; x0: number; y0: number; moved: boolean } | null>(null)

  // 当前时间线(任务2):每 30s 刷新分钟位置;卸载清区间条(mini 据此判断 Calendar 是否挂载)。
  const [nowMin, setNowMin] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() })
  useEffect(() => {
    const id = setInterval(() => { const d = new Date(); setNowMin(d.getHours() * 60 + d.getMinutes()) }, 30_000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => () => setVisibleRange(null, null), [setVisibleRange])
  const nowTs = addMinutes(today, nowMin).getTime()

  const updateTitle = (): void => {
    const el = wrap.current
    if (!el || !colw) return
    const i = Math.max(0, Math.min(days.length - n, Math.round(el.scrollLeft / colw)))
    firstIdx.current = i
    const mid = days[i + Math.floor((n - 1) / 2)]
    const label = monthLabel(mid)
    const week = t('calview.weekNo', { n: isoWeek(mid) })
    if (label + week !== lastTitle.current) {
      lastTitle.current = label + week
      if (titleRef.current) { titleRef.current.textContent = label; titleRef.current.dataset.week = week }
    }
    // 缓存键带上 n:窄窗下天数从 7 变 3 而左起日期不变时,右栏高亮也得跟着缩(Codex r3a-5)
    if (i * 8 + n !== lastRangeI.current) {
      lastRangeI.current = i * 8 + n
      setVisibleRange(iso(days[i]), iso(days[Math.min(days.length - 1, i + n - 1)]))
      // 跨天条只在头一段写标题;可见区最左那天(lead)例外,滚到半截也看得出是什么。命令式挂类,滚动不触发重渲。
      el.querySelector('.amx-cal-allday2.lead')?.classList.remove('lead')
      el.querySelector(`.amx-cal-allday2[data-date="${iso(days[i])}"]`)?.classList.add('lead')
    }
  }

  // 全天行高由日区量出(随全天事件 / 全天草稿增减变化)→ 喂给左轴 gallday,保证小时刻度与网格线对齐。
  // 摘下期间(事件照样会更新)offsetTop 读到 0:跳过,挂回来时下面 RO 的那一下再量(Codex 评审)。
  const measureAllday = (): void => {
    const el = wrap.current
    const dc = el?.clientWidth ? el.querySelector('.amx-cal-daycol2') as HTMLElement | null : null
    if (dc) setAlldayH(Math.max(0, dc.offsetTop - (HEAD_H + 14)))
  }
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    // 左轴已是独立 flex 项(52px),日区宽度不再含它 → colw 直接按日区宽均分。
    const minCol = n >= 3 ? 84 : 180
    const measure = (): void => { if (el.clientWidth) { setColw(Math.max(minCol, el.clientWidth / n)); measureAllday() } }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [n]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(measureAllday, [events, colw, n, draftGeom]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el || !colw) return
    if (!centered.current) {
      firstIdx.current = DAY_HALF
      centered.current = true
      // 首次打开:纵向把「当前时间线」滚到视口正中(用户要求),而非停在 0:00。
      const dc = el.querySelector('.amx-cal-daycol2') as HTMLElement | null
      const bodyTop = dc ? dc.offsetTop : HEAD_H + 14
      el.scrollTop = Math.max(0, bodyTop + (nowMin / 60) * hourPx - el.clientHeight / 2)
    }
    // 换 n(colw 变)时保持最左那天;首挂、进周模式或改周首日时退到那一周的周首日。
    if (alignedFor.current !== weekStartDow) {
      alignedFor.current = weekStartDow
      firstIdx.current = alignIdx(firstIdx.current)
    }
    el.scrollLeft = firstIdx.current * colw
    updateTitle()
    syncGutter()
  }, [colw, weekStartDow]) // eslint-disable-line react-hooks/exhaustive-deps

  // 缩放锚定:hourPx 变化时保持视口中心的时刻不动(菜单里的缩放与 Ctrl+滚轮共用这一条路径)。
  const prevHourPx = useRef(hourPx)
  useLayoutEffect(() => {
    const el = wrap.current
    const old = prevHourPx.current
    prevHourPx.current = hourPx
    if (!el || old === hourPx) return
    const dc = el.querySelector('.amx-cal-daycol2') as HTMLElement | null
    const bodyTop = dc ? dc.offsetTop : HEAD_H + 14
    const center = el.clientHeight / 2
    const hoursAtCenter = (el.scrollTop + center - bodyTop) / old
    el.scrollTop = Math.max(0, bodyTop + hoursAtCenter * hourPx - center)
    syncGutter()
  }, [hourPx]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/Cmd+滚轮缩放。原生监听:React 的 wheel 是 passive,synthetic 里 preventDefault 拦不住浏览器缩放。
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const nav = useCalendarNav.getState()
      nav.setHourPx(nav.hourPx * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useImperativeHandle(ref, () => ({
    prev: () => wrap.current?.scrollBy({ left: -n * colw, behavior: 'smooth' }),
    next: () => wrap.current?.scrollBy({ left: n * colw, behavior: 'smooth' }),
    today: () => wrap.current?.scrollTo({ left: alignIdx(DAY_HALF) * colw, behavior: 'smooth' }),
    goto: (date: Date) => {
      if (!colw) return
      // 先对齐再夹:日窗末端凑不满整周时,宁可不对齐也要让目标日可见。
      const i = Math.min(days.length - n, alignIdx(Math.max(0, Math.min(days.length - 1, diffDays(startOfDay(date), days[0])))))
      wrap.current?.scrollTo({ left: i * colw, behavior: 'smooth' })
    },
  }), [n, colw, days, weekStartDow]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 指针 → 列下标 + 时间体里的分钟(raw = 未取整;min = 向下取整到 15,即指针所在的那一格)。 */
  const bodyTop = HEAD_H + 14 + alldayH
  const locate = (e: { clientX: number; clientY: number }, grabOffY = 0): { col: number; min: number; raw: number } => {
    const sc = wrap.current!
    const r = sc.getBoundingClientRect()
    const z = zoomOf(sc) || 1
    const col = Math.max(0, Math.min(days.length - 1, Math.floor(((e.clientX - r.left) / z + sc.scrollLeft) / colw)))
    const raw = (((e.clientY - r.top) / z - grabOffY + sc.scrollTop - bodyTop) / hourPx) * 60
    return { col, raw, min: Math.max(0, Math.min(24 * 60 - 15, Math.floor(raw / 15) * 15)) }
  }

  // ── 已有事件:拖动(整格吸附)、拖上下边缘改时长、⌥ 拖复制 ──
  const down = (ev: CalEvent, e: ReactPointerEvent, edge?: 'start' | 'end'): void => {
    e.stopPropagation()
    cancelDrag() // 上一次拖动没收尾(松手丢了)就先撤掉它的预览,别留下两份
    if (ev.readonly || e.button !== 0 || (!DESK && selectedKey !== ev.key)) return
    hideHover()
    const el = (e.currentTarget as HTMLElement).closest<HTMLElement>('.amx-cal-event')!
    const rect = el.getBoundingClientRect()
    const zoom = zoomOf(el) || 1
    const offY = (e.clientY - rect.top) / zoom
    const hit = Math.min(EDGE, rect.height / zoom / 4)
    const mode: 'move' | 'start' | 'end' = edge ?? (DESK && selectedKey === ev.key ? offY < hit ? 'start' : rect.height / zoom - offY < hit ? 'end' : 'move' : 'move')
    const box = eventBox(ev.start, ev.end, hourPx)
    const h0 = Math.max(14, box.height)
    const tEl = el.querySelector('.amx-cal-event-t') as HTMLElement | null
    el.setPointerCapture(e.pointerId)
    dragRef.current = {
      mode, ev, el, tEl, t0: tEl?.textContent ?? '', pid: e.pointerId, x0: e.clientX, y0: e.clientY, zoom, top0: box.top, h0, grabOffY: offY,
      durMin: ev.end ? (ev.end.getTime() - ev.start.getTime()) / 60000 : 60, msDur: ev.end ? ev.end.getTime() - ev.start.getTime() : 0,
      col0: diffDays(startOfDay(ev.start), days[0]), min0: ev.start.getHours() * 60 + ev.start.getMinutes(),
      dup: DESK && mode === 'move' && e.altKey && !ev.db.readonly, shadow: null,
      dyMin: 0, moved: false, target: null,
    }
  }
  const move = (e: ReactPointerEvent): void => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pid) {
      if (DESK && (e.currentTarget as HTMLElement).classList.contains('selected')) {
        const el = e.currentTarget as HTMLElement
        const r = el.getBoundingClientRect()
        const y = (e.clientY - r.top) / (zoomOf(el) || 1)
        const hit = Math.min(EDGE, r.height / (zoomOf(el) || 1) / 4)
        el.style.cursor = y < hit || r.height / (zoomOf(el) || 1) - y < hit ? 'ns-resize' : 'grab'
      }
      return
    }
    d.last = e
    // 松手那一下没送到(切走了 App、在窗外松开、输入注入丢了 up):鼠标已经没按着,就按松手收尾,别把预览晾在那里
    if (e.pointerType === 'mouse' && e.buttons === 0) { up(d.ev, e); return }
    // move:块本身按吸附后的落点整格平移(不再是「块自由飘 + 另一个落点框」两份),原位置留一个淡影。
    if (d.mode === 'move') {
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) <= 3) return
      if (!colw || !wrap.current) return
      if (!d.moved) {
        d.moved = true
        d.el.classList.add('dragging')
        onGesture?.(d.ev)
        const shadow = d.el.cloneNode(true) as HTMLElement
        shadow.classList.remove('dragging', 'selected')
        shadow.classList.add(d.dup ? 'dup-src' : 'drag-shadow')
        shadow.removeAttribute('aria-label')
        d.el.parentElement?.insertBefore(shadow, d.el)
        d.shadow = shadow
      }
      const p = locate(e, d.grabOffY) // 减掉抓握点 = 块顶在哪
      const topMin = Math.max(0, Math.min(24 * 60 - Math.min(d.durMin, 24 * 60), snap15(p.raw)))
      const sameMin = topMin === snap15(d.min0) && p.col === d.col0 // 没离开原来那一格:原样(别把 10:07 吸成 10:00)
      const top = sameMin ? d.min0 : topMin
      d.target = sameMin ? null : { iso: iso(days[p.col]), topMin }
      d.el.style.transform = `translate(${(p.col - d.col0) * colw}px, ${((top - d.min0) / 60) * hourPx}px)`
      const ns = addMinutes(days[p.col], top)
      onGesture?.({ ...d.ev, raw: eventValue(ns, d.ev.end ? new Date(ns.getTime() + d.msDur) : null, false) })
      const range = d.msDur ? `${hhmm(ns)}–${hhmm(new Date(ns.getTime() + d.msDur))}` : hhmm(ns)
      if (d.tEl) d.tEl.textContent = sameMin ? d.t0 : p.col !== d.col0 ? `${dowLabel(days[p.col].getDay())} ${range}` : range
      return
    }
    // resize(start/end):竖向改时长;时间文本随预览实时反算(与 up() 的钳制一致)
    const delta = snap15((((e.clientY - d.y0) / d.zoom) / hourPx) * 60)
    const baseEndForClamp = d.ev.end ?? addMinutes(d.ev.start, 60)
    const duration = (baseEndForClamp.getTime() - d.ev.start.getTime()) / 60000
    const dyMin = d.mode === 'start' ? Math.max(-d.min0, Math.min(duration - 15, delta)) : Math.max(15 - duration, delta)
    if (!d.moved && Math.abs(e.clientY - d.y0) < 5) return
    if (!d.moved) { d.moved = true; d.el.classList.add('dragging') }
    d.dyMin = dyMin
    const dPx = (dyMin / 60) * hourPx
    if (d.mode === 'end') d.el.style.height = `${Math.max(14, d.h0 + dPx)}px`
    else {
      d.el.style.top = `${d.top0 + dPx}px`
      d.el.style.height = `${Math.max(14, d.h0 - dPx)}px`
    }
    if (dyMin !== 0 && d.tEl) {
      const baseEnd = d.ev.end ?? addMinutes(d.ev.start, 60)
      if (d.mode === 'end') {
        let ne = addMinutes(baseEnd, dyMin)
        if (ne.getTime() <= d.ev.start.getTime()) ne = addMinutes(d.ev.start, 15)
        d.tEl.textContent = `${hhmm(d.ev.start)}–${hhmm(ne)} · ${fmtDur(Math.round((ne.getTime() - d.ev.start.getTime()) / 60000))}`
        onGesture?.({ ...d.ev, raw: eventValue(d.ev.start, ne, false) })
      } else {
        let ns = addMinutes(d.ev.start, dyMin)
        if (ns.getTime() >= baseEnd.getTime()) ns = addMinutes(baseEnd, -15)
        d.tEl.textContent = `${hhmm(ns)}–${hhmm(baseEnd)} · ${fmtDur(Math.round((baseEnd.getTime() - ns.getTime()) / 60000))}`
        onGesture?.({ ...d.ev, raw: eventValue(ns, baseEnd, false) })
      }
    }
  }
  const up = (ev: CalEvent, e: ReactPointerEvent): void => {
    const d = dragRef.current
    if (d && e.pointerId !== d.pid) return
    dragRef.current = null
    if (!d) {
      return
    }
    onGesture?.(null)
    d.el.classList.remove('dragging')
    if (d.mode === 'move') {
      d.el.style.transform = ''
      d.shadow?.remove()
      if (!d.target) {
        if (d.tEl) d.tEl.textContent = d.t0 // 未生效的拖拽:还原被预览覆盖的时间文本
        if (!d.moved) onPick(ev.key, rectOf(e))
        return
      }
      const newStart = addMinutes(startOfDay(toLocalDate(d.target.iso)), d.target.topMin)
      const newEnd = ev.end ? new Date(newStart.getTime() + d.msDur) : null
      if (d.tEl) d.tEl.textContent = d.t0
      if (d.dup) {
        const value = eventValue(newStart, newEnd, ev.allDay)
        void cloneCalendarEvent(ev, value)
        return
      }
      commitTime(ev, newStart, newEnd) // 跨日+改时刻,保留时长
      return
    }
    d.el.style.top = `${d.top0}px`
    d.el.style.height = `${d.h0}px`
    if (d.dyMin === 0) {
      if (d.tEl) d.tEl.textContent = d.t0
      if (!d.moved) onPick(ev.key, rectOf(e))
      return
    }
    const baseEnd = ev.end ?? addMinutes(ev.start, 60)
    if (d.mode === 'end') {
      let ne = addMinutes(baseEnd, d.dyMin)
      if (ne.getTime() <= ev.start.getTime()) ne = addMinutes(ev.start, 15)
      commitTime(ev, ev.start, ne)
    } else {
      let ns = addMinutes(ev.start, d.dyMin)
      if (ns.getTime() >= baseEnd.getTime()) ns = addMinutes(baseEnd, -15)
      commitTime(ev, ns, baseEnd)
    }
  }
  const cancelDrag = (): void => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    onGesture?.(null)
    d.el.classList.remove('dragging')
    d.el.style.transform = ''
    d.el.style.top = `${d.top0}px` // 还原成渲染时的原位;清空的话 React 值没变不会补回,块就丢了定位和高度
    d.el.style.height = `${d.h0}px`
    d.shadow?.remove()
    if (d.tEl) d.tEl.textContent = d.t0
  }
  const moveRef = useRef(move)
  moveRef.current = move
  useEffect(() => {
    const cancel = (e: Event): void => { if (e.type === 'blur' || (e as KeyboardEvent).key === 'Escape') cancelDrag() }
    const timer = window.setInterval(() => {
      const d = dragRef.current
      const sc = wrap.current
      if (!d?.moved || !d.last || !sc) return
      const r = sc.getBoundingClientRect()
      const x = d.last.clientX, y = d.last.clientY
      const dx = x < r.left + 24 ? -12 : x > r.right - 24 ? 12 : 0
      const dy = y < r.top + bodyTop + 24 ? -12 : y > r.bottom - 24 ? 12 : 0
      if (dx || dy) { sc.scrollBy(dx, dy); moveRef.current(d.last) }
    }, 32)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', cancel)
    return () => { clearInterval(timer); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', cancel); cancelDrag() }
  }, [])

  // 全天事件「拖出来」→ 拖进某天的时间格 = 转成该时刻起 30 分钟的定时事件;没拖进则视作点击开卡片。
  const allDrag = useRef<{ x: number; y: number; mode: 'move' | 'start' | 'end' } | null>(null)
  const allDown = (ev: CalEvent, e: ReactPointerEvent): void => {
    e.stopPropagation()
    if (e.button !== 0 || ev.readonly || (!DESK && selectedKey !== ev.key)) return
    const r = e.currentTarget.getBoundingClientRect()
    const edge = Math.min(8, r.width / 4)
    allDrag.current = { x: e.clientX, y: e.clientY, mode: selectedKey === ev.key && DESK ? e.clientX - r.left < edge ? 'start' : r.right - e.clientX < edge ? 'end' : 'move' : 'move' }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const allUp = (ev: CalEvent, e: ReactPointerEvent): void => {
    const drag = allDrag.current
    allDrag.current = null
    if (!drag) return
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) { onPick(ev.key, rectOf(e)); return }
    const all = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.amx-cal-allday2')
    if (all?.dataset.date) {
      const day = toLocalDate(all.dataset.date)
      if (drag.mode === 'start') commitTime(ev, day > (ev.end ?? ev.start) ? ev.end ?? ev.start : day, ev.end, true)
      else if (drag.mode === 'end') commitTime(ev, ev.start, day < ev.start ? ev.start : day, true)
      else {
        const delta = diffDays(day, ev.start)
        commitTime(ev, shiftDays(ev.start, delta), ev.end ? shiftDays(ev.end, delta) : null, true)
      }
      return
    }
    const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.amx-cal-daycol2')
    const dayIso = cell?.getAttribute('data-date')
    if (cell && dayIso) {
      const rect = cell.getBoundingClientRect()
      const min = Math.max(0, Math.min(24 * 60 - 30, snap15((((e.clientY - rect.top) / (zoomOf(cell) || 1)) / hourPx) * 60)))
      const start = addMinutes(startOfDay(toLocalDate(dayIso)), min)
      commitTime(ev, start, addMinutes(start, 30), false)
      return
    }
    onPick(ev.key, rectOf(e))
  }

  // ── 空白处:悬停提示、单击 = 1 小时草稿、按住拖 = 拖出时长;全天行单击 / 横拖 = 全天草稿(只在桌面,手指不触发)──
  const hover = (e: ReactPointerEvent): void => {
    const h = hoverEl.current
    if (!h) return
    const tgt = e.target as HTMLElement
    const nav = useCalendarNav.getState()
    if (!DESK || !canCreate || e.pointerType === 'touch' || dragRef.current || nav.draft || nav.selection || !colw
      || !tgt.closest('.amx-cal-daycol2') || tgt.closest('.amx-cal-event, .amx-cal-draft')) { hideHover(); return }
    const p = locate(e)
    const [s, en] = draftRange(p.min, p.min, true)
    h.style.display = 'block'
    h.style.left = `${p.col * colw + 2}px`
    h.style.width = `${colw - 4}px`
    h.style.top = `${bodyTop + (s / 60) * hourPx}px`
    h.style.height = `${((en - s) / 60) * hourPx}px`
  }
  const rangeOf = (m: NonNullable<typeof makeRef.current>): [number, number] =>
    m.moved ? draftRange(Math.min(m.min, m.cur.min), Math.max(m.min, m.cur.min) + 15, false) : draftRange(m.min, m.min, true)
  const gridDown = (e: ReactPointerEvent): void => {
    if (!DESK || e.button !== 0 || e.pointerType === 'touch') return
    const tgt = e.target as HTMLElement
    if (tgt.closest('.amx-cal-event, .amx-cal-chip-ev, .amx-cal-draft')) return
    const zone = tgt.closest('.amx-cal-allday2') ? 'all' : tgt.closest('.amx-cal-daycol2') ? 'time' : null
    if (!zone || !colw) return
    hideHover()
    const had = onDismiss() // 先收草稿(它的输入框随后失焦时就没东西可收了),再把焦点拿回日历
    ;(wrap.current?.closest('.amx-cal') as HTMLElement | null)?.focus({ preventScroll: true })
    if (had || !canCreate) return
    e.preventDefault()
    const p = locate(e)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    makeRef.current = { pid: e.pointerId, zone, col: p.col, min: p.min, cur: p, x0: e.clientX, y0: e.clientY, moved: false }
  }
  const gridMove = (e: ReactPointerEvent): void => {
    const m = makeRef.current
    if (!m) { hover(e); return }
    if (e.pointerId !== m.pid) return
    if (e.pointerType === 'mouse' && e.buttons === 0) { gridUp(); return } // 松手没送到:同 move()
    if (!m.moved && Math.hypot(e.clientX - m.x0, e.clientY - m.y0) < 4) return
    m.moved = true
    m.cur = locate(e)
    const el = makeEl.current
    if (!el) return
    el.style.display = 'block'
    if (m.zone === 'time') {
      const [s, en] = rangeOf(m)
      el.style.left = `${m.col * colw + 2}px`
      el.style.width = `${colw - 4}px`
      el.style.top = `${bodyTop + (s / 60) * hourPx}px`
      el.style.height = `${((en - s) / 60) * hourPx}px`
      el.textContent = `${fmtMin(s)}–${fmtMin(en)} · ${fmtDur(en - s)}`
    } else {
      const c0 = Math.min(m.col, m.cur.col)
      const c1 = Math.max(m.col, m.cur.col)
      el.style.left = `${c0 * colw + 4}px`
      el.style.width = `${(c1 - c0 + 1) * colw - 8}px`
      el.style.top = `${HEAD_H + 14 + 3}px`
      el.style.height = '20px'
      el.textContent = c1 > c0 ? fmtDur((c1 - c0 + 1) * 1440) : ''
    }
  }
  const gridUp = (e?: { pointerId: number }): void => {
    const m = makeRef.current
    if (m && e && e.pointerId !== m.pid) return
    makeRef.current = null
    if (makeEl.current) makeEl.current.style.display = 'none'
    if (!m) return
    if (m.zone === 'time') {
      const [s, en] = rangeOf(m)
      onDraft({ day: iso(days[m.col]), endDay: iso(days[m.col]), startMin: s, endMin: en })
    } else {
      const [c0, c1] = m.moved ? [Math.min(m.col, m.cur.col), Math.max(m.col, m.cur.col)] : [m.col, m.col]
      onDraft({ day: iso(days[c0]), endDay: iso(days[c1]), startMin: null, endMin: 0 })
    }
  }
  const gridCancel = (): void => {
    makeRef.current = null
    if (makeEl.current) makeEl.current.style.display = 'none'
  }

  // 右栏待办拖进来:预览块复用拖出新建那一个(时间格 30 分钟,全天行一格)。
  const todoSlot = (e: ReactDragEvent): { value: string; zone: 'time' | 'all'; col: number; s: number } | null => {
    const tgt = e.target as HTMLElement
    const zone = tgt.closest('.amx-cal-allday2') ? 'all' : tgt.closest('.amx-cal-daycol2') ? 'time' : null
    if (!zone || !colw) return null
    const p = locate(e)
    const day = iso(days[p.col])
    const s = Math.min(p.min, 24 * 60 - 30)
    return { zone, col: p.col, s, value: zone === 'all' ? day : `${day}T${fmtMin(s)}/${day}T${fmtMin(s + 30)}` }
  }
  const hideMake = (): void => { if (makeEl.current) makeEl.current.style.display = 'none' }
  const todoOver = (e: ReactDragEvent): void => {
    if (!onTodoDrop || !e.dataTransfer.types.includes(TODO_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const slot = todoSlot(e)
    const el = makeEl.current
    if (!el) return
    if (!slot) { hideMake(); return }
    el.style.display = 'block'
    el.style.left = `${slot.col * colw + (slot.zone === 'all' ? 4 : 2)}px`
    el.style.width = `${colw - (slot.zone === 'all' ? 8 : 4)}px`
    el.style.top = `${slot.zone === 'all' ? HEAD_H + 14 + 3 : bodyTop + (slot.s / 60) * hourPx}px`
    el.style.height = slot.zone === 'all' ? '20px' : `${(30 / 60) * hourPx}px`
    el.textContent = slot.zone === 'all' ? '' : `${fmtMin(slot.s)}–${fmtMin(slot.s + 30)}`
  }
  const todoDropHere = (e: ReactDragEvent): void => {
    if (!onTodoDrop || !e.dataTransfer.types.includes(TODO_DRAG_MIME)) return
    e.preventDefault()
    hideMake()
    const slot = todoSlot(e)
    if (!slot) return
    try { onTodoDrop(JSON.parse(e.dataTransfer.getData(TODO_DRAG_MIME)), slot.value) } catch { /* 载荷坏了就不动 */ }
  }

  // 全天行:跨天事件占同一行(贪心分道;先开始的、长的在上),只有日期的待办不进来。
  const allDay = useMemo(() => {
    const list = events.filter((e) => e.allDay && !dateOnlyTodo(e)).sort((a, b) =>
      +startOfDay(a.start) - +startOfDay(b.start) || +startOfDay(b.end ?? b.start) - +startOfDay(a.end ?? a.start))
    const ends: number[] = []
    const lane = new Map<string, number>()
    for (const e of list) {
      const s = +startOfDay(e.start)
      let i = ends.findIndex((x) => x < s)
      if (i < 0) i = ends.length
      ends[i] = +startOfDay(e.end ?? e.start)
      lane.set(e.key, i)
    }
    return { list, lane }
  }, [events])
  const draftCovers = (d: Date): boolean => !!draftAt && draftAt[2] === 'null' && iso(d) >= draftAt[0] && iso(d) <= draftAt[1]

  return (
    /* --amx-hour-px 喂给 CSS 网格线(repeating-gradient 周期必须与 hourPx 同步,否则线与事件错位)。 */
    <div className="amx-cal-timerow" style={{ '--amx-hour-px': `${hourPx}px` } as CSSProperties}>
      {/* 常驻左轴(任务:左侧 24h 时间轴常驻):独立 52px 列,只纵向随日区滚(横滚不走)。 */}
      <div className="amx-cal-gutterfixed">
        <div className="amx-cal-gutterinner">
          <div className="amx-cal-gcorner" style={{ height: HEAD_H + 14 }} />
          <div className="amx-cal-gallday" style={{ height: alldayH }}>{t('calview.allDay')}</div>
          <div className="amx-cal-ghours" ref={gutterHours}>
            {HOURS.map((h) => (
              <div key={h} className="amx-cal-hour" style={{ height: hourPx }}>
                {h === 0 ? '' : `${h}:00`}
              </div>
            ))}
            {/* 当前时刻标签:钉在左轴上,主题色。 */}
            <span className="amx-cal-nowlabel" style={{ top: (nowMin / 60) * hourPx }}>
              {String(Math.floor(nowMin / 60)).padStart(2, '0')}:{String(nowMin % 60).padStart(2, '0')}
            </span>
          </div>
        </div>
      </div>
      <div className="amx-cal-tscroll" ref={wrap} onScroll={() => { updateTitle(); syncGutter() }} onPointerLeave={hideHover}>
      <div
        className="amx-cal-tgrid2"
        style={{ gridTemplateColumns: `repeat(${days.length}, ${colw}px)`, gridTemplateRows: `${HEAD_H + 14}px auto ${HOURS.length * hourPx}px` }}
        onPointerDown={gridDown}
        onPointerMove={gridMove}
        onPointerUp={gridUp}
        onPointerCancel={gridCancel}
        onLostPointerCapture={() => { if (makeRef.current) gridUp() }}
        onDragOver={todoOver}
        onDragLeave={(e) => { if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) hideMake() }}
        onDrop={todoDropHere}
      >
        {days.map((d) => (
          <div key={+d} className={`amx-cal-thead2${sameDay(d, today) ? ' today' : ''}`}>
            <span className="amx-cal-tdow">{dowLabel(d.getDay())}</span>
            <span className="amx-cal-tdate">{d.getMonth() + 1}/{d.getDate()}</span>
          </div>
        ))}
        {days.map((d) => {
          const here = allDay.list.filter((e) => coversDay(e.start, e.end, d))
          const rows: Array<CalEvent | null> = []
          for (const e of here) rows[allDay.lane.get(e.key) ?? 0] = e
          return (
            <div key={+d} className="amx-cal-allday2" data-date={iso(d)} onClick={DESK ? undefined : (ce) => {
              if ((ce.target as HTMLElement).closest('.amx-cal-chip-ev') || onDismiss()) return
              onCreate(d, null, rectOf(ce))
            }}>
              {Array.from(rows, (e, i) => e ? (
                <button
                  key={e.key}
                  data-key={e.key}
                  className={`amx-cal-chip-ev amx-cal-alldrag${e.readonly ? ' readonly' : ''}${cutKey === e.key ? ' cut' : ''}${selectedKey === e.key ? ' selected' : ''}${+startOfDay(e.end ?? e.start) < +today ? ' past' : ''}${daySpanClass(e.start, e.end, d)}`}
                  style={eventColorStyle(e.color)}
                  aria-label={t('calview.a11yAllDayEvent', { title: e.title })}
                  title={e.readonly ? e.title : t('calview.allDayDragHint', { title: e.title })}
                  onPointerDown={(pe) => allDown(e, pe)}
                  onPointerUp={(pe) => allUp(e, pe)}
                  onPointerCancel={() => { allDrag.current = null }}
                  onClick={(ce) => { if (e.readonly || (!DESK && selectedKey !== e.key) || ce.detail === 0) onPick(e.key, rectOf(ce)) }}
                >
                  {e.title}
                </button>
              ) : <span key={`gap${i}`} className="amx-cal-chip-gap" />)}
              {draftCovers(d) && <DraftChip day={d} colorOf={colorOf} />}
            </div>
          )
        })}
        {days.map((d) => (
          <div
            key={+d}
            className="amx-cal-daycol2"
            data-date={iso(d)}
            onClick={DESK ? undefined : (e) => {
              if ((e.target as HTMLElement).closest('.amx-cal-event')) return
              if (onDismiss()) return
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              const zoom = zoomOf(e.currentTarget) || 1
              const min = Math.max(0, Math.min(24 * 60 - 30, snap15((((e.clientY - rect.top) / zoom) / hourPx) * 60)))
              onCreate(d, min, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, zoom })
            }}
          >
            {(() => {
              const dayEvents = events.filter((e) => !e.allDay && sameDay(e.start, d))
              const layouts = layoutTimedEvents(dayEvents)
              return dayEvents.map((e) => {
                const box = eventBox(e.start, e.end, hourPx)
                const layout = layouts.get(e.key) ?? { leftPct: 0, widthPct: 100, lane: 0, laneCount: 1 }
                const short = box.height < SHORT_PX
                const past = (e.end ?? e.start).getTime() < nowTs
                return (
                  <button
                    key={e.key}
                    data-key={e.key}
                    className={`amx-cal-event${e.readonly ? ' readonly' : ''}${cutKey === e.key ? ' cut' : ''}${selectedKey === e.key ? ' selected' : ''}${short ? ' short' : ''}${past ? ' past' : ''}${e.check ? ' todo' : ''}${e.done ? ' done' : ''}`}
                    style={{
                      ...eventColorStyle(e.color),
                      top: box.top,
                      height: Math.max(14, box.height),
                      left: `calc(${layout.leftPct}% + 2px)`,
                      width: `calc(${layout.widthPct}% - 4px)`,
                    }}
                    aria-label={e.end
                      ? t('calview.a11yEventRange', { title: e.title, start: hhmm(e.start), end: hhmm(e.end) })
                      : t('calview.a11yEvent', { title: e.title, time: hhmm(e.start) })}
                    title={e.title}
                    onPointerDown={(pe) => down(e, pe)}
                    onPointerMove={move}
                    onPointerUp={(pe) => up(e, pe)}
                    onPointerCancel={cancelDrag}
                    onLostPointerCapture={cancelDrag}
                    onClick={(ce) => { if (e.readonly || (!DESK && selectedKey !== e.key) || ce.detail === 0) onPick(e.key, rectOf(ce)) }}
                  >
                    {e.check && (
                      <span
                        className="amx-cal-event-check"
                        role="checkbox"
                        aria-checked={!!e.done}
                        aria-label={t('calview.a11yDone', { title: e.title })}
                        onPointerDown={(pe) => pe.stopPropagation()}
                        onClick={(ce) => { ce.stopPropagation(); if (!e.db.readonly) { setAggCell(e.db, e.row.rowId, e.check!, e.done ? undefined : true); if (!e.done) track('todo.done') } }}
                      />
                    )}
                    <span className="amx-cal-event-title">{e.title}</span>
                    <span className="amx-cal-event-t">{short || !e.end ? hhmm(e.start) : `${hhmm(e.start)}–${hhmm(e.end)}`}</span>
                    {!DESK && selectedKey === e.key && !e.readonly && colw * layout.widthPct / 100 >= 88 && <>
                      <span className="amx-cal-handle start" aria-label={t('calview.resizeStart')} onPointerDown={(pe) => down(e, pe, 'start')} />
                      <span className="amx-cal-handle end" aria-label={t('calview.resizeEnd')} onPointerDown={(pe) => down(e, pe, 'end')} />
                    </>}
                  </button>
                )
              })
            })()}
            {draftAt && draftAt[2] !== 'null' && draftAt[0] === iso(d) && <DraftBlock hourPx={hourPx} colorOf={colorOf} />}
            {/* 当前时间线(任务2):横跨整个日历所有列(每列一段,相邻拼成一条);圆点只在「今天」列。
             *  pointer-events:none 不挡点击建事件。 */}
            <div className={`amx-cal-nowline${sameDay(d, today) ? ' today' : ''}`} style={{ top: (nowMin / 60) * hourPx }} />
          </div>
        ))}
        {/* 悬停提示 + 拖出新建的预览块:命令式定位(唯一两个持久元素,默认隐藏)。 */}
        <div className="amx-cal-hoverslot" ref={hoverEl} />
        <div className="amx-cal-making" ref={makeEl} style={eventColorStyle(colorOf(null))} />
      </div>
      </div>
    </div>
  )
})

// ── 月视图(纵向连续周行条)────────────────────────────────────────────────
/** 月视图正在看的月份(y 年、m 月 0-11)= 标题显示的那个月。 */
export interface MonthAnchor { y: number; m: number }
interface MonthProps extends GridProps {
  /** 父组件持有的「当前看的月」:本组件滚动时写入,挂载时若有值就回到这个月(周首日变化重挂时用)。 */
  anchorRef?: MutableRefObject<MonthAnchor | null>
  /** 手机:双击当场建。 */
  onCreate: (day: Date, at: Anchor) => void
}
export const MonthScroll = forwardRef<CalApi, MonthProps>(function MonthScroll({ anchorRef, events, selectedKey, cutKey, onPick, canCreate, onDismiss, onDraft, colorOf, onCreate, titleRef }, ref) {
  const { t } = useI18n()
  const wrap = useRef<HTMLDivElement>(null)
  const [rowH, setRowH] = useState(0)
  const setVisibleRange = useCalendarNav((s) => s.setVisibleRange)
  const draftGeom = useCalendarNav(draftGeomKey)
  const draftAt = draftGeom ? draftGeom.split('|') : null
  const today = useMemo(() => startOfDay(new Date()), [])
  const weeks = useMemo(() => {
    const b = addDays(startOfWeek(today), -WEEK_HALF * 7)
    return Array.from({ length: WEEK_HALF * 2 + 1 }, (_, i) => addDays(b, i * 7))
  }, [today])
  const centered = useRef(false)
  const [agenda, setAgenda] = useState<{ day: Date; events: CalEvent[]; at: Anchor } | null>(null)
  const lastTitle = useRef('')
  const lastRangeI = useRef(-1)
  const makeRef = useRef<{ pid: number; a: string; b: string; moved: boolean } | null>(null)
  useEffect(() => () => setVisibleRange(null, null), [setVisibleRange])

  const idxOfMonth = (y: number, m: number): number => Math.round(diffDays(startOfWeek(new Date(y, m, 1)), weeks[0]) / 7)
  const updateTitle = (): void => {
    const el = wrap.current
    if (!el || !rowH) return
    const i = Math.max(0, Math.min(weeks.length - 1, Math.round(el.scrollTop / rowH)))
    const mid = addDays(weeks[i], 3)
    const label = monthLabel(mid)
    if (anchorRef) anchorRef.current = { y: mid.getFullYear(), m: mid.getMonth() }
    if (label !== lastTitle.current) {
      lastTitle.current = label
      if (titleRef.current) { titleRef.current.textContent = label; delete titleRef.current.dataset.week }
    }
    if (i !== lastRangeI.current) {
      lastRangeI.current = i
      const visibleRows = Math.max(1, Math.round(el.clientHeight / rowH))
      const lastWeek = weeks[Math.min(weeks.length - 1, i + visibleRows - 1)]
      setVisibleRange(iso(weeks[i]), iso(addDays(lastWeek, 6)))
    }
  }

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = (): void => { if (el.clientHeight) setRowH(Math.max(64, (el.clientHeight - HEAD_H) / 6)) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el || !rowH || centered.current) return
    centered.current = true
    const a = anchorRef?.current
    if (a) {
      // 回到重挂前看的那个月:按新周首日,该月 1 号所在周的「标题日」(周首 +3)可能还落在上个月 → 再往下一行。
      let i = Math.max(0, Math.min(weeks.length - 1, idxOfMonth(a.y, a.m)))
      if (addDays(weeks[i], 3).getMonth() !== a.m && i + 1 < weeks.length) i += 1
      el.scrollTop = i * rowH
    } else {
      el.scrollTop = idxOfMonth(today.getFullYear(), today.getMonth()) * rowH
    }
    updateTitle()
  }, [rowH]) // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    prev: () => jump(-1),
    next: () => jump(1),
    today: () => wrap.current?.scrollTo({ top: idxOfMonth(today.getFullYear(), today.getMonth()) * rowH, behavior: 'smooth' }),
    goto: (date: Date) => {
      if (!rowH) return
      const wi = Math.max(0, Math.min(weeks.length - 1, Math.round(diffDays(startOfWeek(date), weeks[0]) / 7)))
      wrap.current?.scrollTo({ top: wi * rowH, behavior: 'smooth' })
    },
  }), [rowH]) // eslint-disable-line react-hooks/exhaustive-deps
  const jump = (delta: number): void => {
    const el = wrap.current
    if (!el || !rowH) return
    const i = Math.max(0, Math.min(weeks.length - 1, Math.round(el.scrollTop / rowH)))
    const mid = addDays(weeks[i], 3)
    el.scrollTo({ top: Math.max(0, idxOfMonth(mid.getFullYear(), mid.getMonth() + delta)) * rowH, behavior: 'smooth' })
  }

  const chipDrag = useRef<{ x: number; y: number } | null>(null)
  const chipDown = (ev: CalEvent, e: ReactPointerEvent): void => {
    e.stopPropagation()
    if (e.button !== 0 || ev.readonly || (!DESK && selectedKey !== ev.key)) return
    chipDrag.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const chipUp = (ev: CalEvent, e: ReactPointerEvent): void => {
    const drag = chipDrag.current
    chipDrag.current = null
    if (!drag) return
    const rect = rectOf(e)
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) { onPick(ev.key, rect); return }
    if (ev.readonly) { onPick(ev.key, rect); return } // 只读:月视图芯片不可跨日拖,只开卡
    const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.amx-cal-mcell')
    const dayIso = cell?.getAttribute('data-date')
    if (dayIso) {
      const delta = diffDays(toLocalDate(dayIso), ev.start)
      if (delta !== 0) {
        commitTime(ev, shiftDays(ev.start, delta), ev.end ? shiftDays(ev.end, delta) : null)
        return
      }
    }
    onPick(ev.key, rect)
  }

  // 空白处单击 = 当天全天草稿,横拖 / 竖拖跨格 = 多天(只在桌面,手指不触发)。拖动中命令式给经过的格子挂 making。
  const cellAt = (e: { clientX: number; clientY: number }): string | null =>
    (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.amx-cal-mcell')?.getAttribute('data-date') ?? null
  const paint = (lo: string | null, hi: string | null): void => {
    wrap.current?.querySelectorAll<HTMLElement>('.amx-cal-mcell').forEach((c) => {
      const d = c.dataset.date ?? ''
      c.classList.toggle('making', !!lo && !!hi && d >= lo && d <= hi)
    })
  }
  const gridDown = (e: ReactPointerEvent): void => {
    if (!DESK || e.button !== 0 || e.pointerType === 'touch') return
    const tgt = e.target as HTMLElement
    if (tgt.closest('.amx-cal-chip-ev, .amx-cal-more, .amx-cal-draft')) return
    const day = tgt.closest('.amx-cal-mcell')?.getAttribute('data-date')
    if (!day) return
    const had = onDismiss()
    ;(wrap.current?.closest('.amx-cal') as HTMLElement | null)?.focus({ preventScroll: true })
    if (had || !canCreate) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    makeRef.current = { pid: e.pointerId, a: day, b: day, moved: false }
  }
  const gridMove = (e: ReactPointerEvent): void => {
    const m = makeRef.current
    if (!m || e.pointerId !== m.pid) return
    if (e.pointerType === 'mouse' && e.buttons === 0) { gridUp(); return } // 松手没送到:按松手收尾
    const b = cellAt(e)
    if (!b || b === m.b) return
    m.b = b
    m.moved = true
    paint(m.a < b ? m.a : b, m.a < b ? b : m.a)
  }
  const gridUp = (e?: { pointerId: number }): void => {
    const m = makeRef.current
    if (m && e && e.pointerId !== m.pid) return
    makeRef.current = null
    if (!m) return
    if (m.moved) paint(null, null)
    const [lo, hi] = m.a < m.b ? [m.a, m.b] : [m.b, m.a]
    onDraft({ day: lo, endDay: hi, startMin: null, endMin: 0 })
  }
  const gridCancel = (): void => {
    if (makeRef.current?.moved) paint(null, null)
    makeRef.current = null
  }

  return (
    <div className="amx-cal-mscroll" ref={wrap} onScroll={updateTitle}>
      <div className="amx-cal-weekhead2">
        {weekdays().map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="amx-cal-mweeks" onPointerDown={gridDown} onPointerMove={gridMove} onPointerUp={gridUp} onPointerCancel={gridCancel}>
        {weeks.map((ws) => (
          <div key={+ws} className="amx-cal-mweek" style={{ height: rowH }}>
            {daysRange(ws, 7).map((day) => {
              const dayIso = iso(day)
              const dayEvents = events.filter((e) => coversDay(e.start, e.end, day))
              const drafted = !!draftAt && dayIso >= draftAt[0] && dayIso <= draftAt[1]
              const room = drafted ? 2 : 3
              return (
                <div
                  key={+day}
                  className={`amx-cal-mcell${sameDay(day, today) ? ' today' : ''}`}
                  data-date={dayIso}
                  onClick={DESK ? undefined : (e) => {
                    if ((e.target as HTMLElement).closest('.amx-cal-chip-ev')) return
                    if (onDismiss()) return
                    onCreate(day, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, zoom: zoomOf(e.currentTarget) || 1 })
                  }}
                >
                  <div className="amx-cal-mnum">{day.getDate() === 1 ? t('calview.monthFirst', { m: day.getMonth() + 1 }) : day.getDate()}</div>
                  {drafted && <DraftChip day={day} colorOf={colorOf} />}
                  {dayEvents.slice(0, room).map((e) => (
                    <button
                      key={e.key}
                      data-key={e.key}
                      className={`amx-cal-chip-ev${e.readonly ? ' readonly' : ''}${selectedKey === e.key ? ' selected' : ''}${daySpanClass(e.start, e.end, day)}`}
                      style={eventColorStyle(e.color)}
                      title={e.title}
                      aria-label={!e.allDay && sameDay(e.start, day)
                        ? t('calview.a11yEvent', { title: e.title, time: hhmm(e.start) })
                        : e.title}
                      onPointerDown={(pe) => chipDown(e, pe)}
                      onPointerUp={(pe) => chipUp(e, pe)}
                      onPointerCancel={() => { chipDrag.current = null }}
                      onClick={(ce) => { if (e.readonly || (!DESK && selectedKey !== e.key) || ce.detail === 0) onPick(e.key, rectOf(ce)) }}
                    >
                      {!e.allDay && sameDay(e.start, day) && <span className="amx-cal-chip-t">{hhmm(e.start)}</span>} {e.title}
                    </button>
                  ))}
                  {dayEvents.length > room && (
                    <button
                      className="amx-cal-more"
                      aria-label={t('calview.a11yMoreEvents', { m: day.getMonth() + 1, d: day.getDate(), n: dayEvents.length })}
                      onClick={(e) => setAgenda({ day, events: dayEvents, at: rectOf(e) })}
                    >
                      {t('calview.moreItems', { n: dayEvents.length - room })}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {agenda && (
        <DayAgendaPopover
          day={agenda.day}
          events={agenda.events}
          at={agenda.at}
          onPick={(key, at) => { setAgenda(null); onPick(key, at) }}
          onClose={() => setAgenda(null)}
        />
      )}
    </div>
  )
})

function DayAgendaPopover({
  day,
  events,
  at,
  onPick,
  onClose,
}: {
  day: Date
  events: CalEvent[]
  at: Anchor
  onPick: (key: string, at: Anchor) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const width = 292
  const zoom = at.zoom || 1
  const margin = 12 * zoom
  const left = Math.max(margin, Math.min(at.left, window.innerWidth - width * zoom - margin)) / zoom
  const top = Math.max(margin, Math.min(at.bottom + 6 * zoom, window.innerHeight - 356 * zoom - margin)) / zoom
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.querySelector<HTMLButtonElement>('.amx-cal-agenda-list > button')?.focus()
    const keydown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', keydown)
    return () => { window.removeEventListener('keydown', keydown); previous?.focus() }
  }, [])
  return (
    <div className="amx-cal-agenda-overlay" onMouseDown={onClose}>
      <section
        className="amx-cal-agenda"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('calview.a11yDayEvents', { m: day.getMonth() + 1, d: day.getDate() })}
        style={{ left, top, width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <strong>{t('calview.dayHeading', { m: day.getMonth() + 1, d: day.getDate() })}</strong>
          <button onClick={onClose} aria-label={t('calview.closeAgenda')}>×</button>
        </header>
        <div className="amx-cal-agenda-list">
          {events.map((ev) => (
            <button key={ev.key} style={eventColorStyle(ev.color)} onClick={(e) => onPick(ev.key, rectOf(e))}>
              <span className="amx-cal-agenda-time">{ev.allDay ? t('calview.allDay') : hhmm(ev.start)}</span>
              <span>{ev.title}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

// 旁弹编辑卡已抽到 ./calendar/EventCard.tsx(与 TodoListView 共用);CalEvent 结构性满足 CardTarget。
