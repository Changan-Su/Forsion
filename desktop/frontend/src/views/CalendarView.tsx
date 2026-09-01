/** Calendar View —— Notion Calendar 式,连续原生滚动(跟手、无顿挫):
 *  周/3日/日 = 一条横向滚动的日列条(横滚一天一天连续推进);月 = 一条纵向滚动的周行条。
 *  小时线用背景渐变(零 DOM),事件拖拽走命令式 DOM(不触发整条重渲),故几百列仍丝滑。
 *  颜色/显隐/默认库/成员映射来自 calendarConfigStore;数据经 calendarMembers 汇成员库(+ agent 只读源)。 */
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
  type RefObject,
} from 'react'
import { CalendarPlus, Check, ChevronLeft, ChevronRight, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { Kbd } from '@astryxdesign/core/Kbd'
import { zoomOf } from '@lcl/engine'
import { AstryxScope } from '../theme/astryxBridge'
import { parseCalDate } from '@amadeus-shared/db/calDate'
import { usePageStore } from '../amadeus/store/pageStore'
import {
  setAggCell,
  createAggEvent,
  duplicateAggRow,
  firstDateCol,
  type AggDb,
  type AggRow,
} from '../amadeus/store/dbAggregateStore'
import { useCalendarMembers } from '../amadeus/store/calendarMembers'
import { useCalendarConfig, colorForDb, isHidden, defaultDbPath } from '../amadeus/store/calendarConfigStore'
import { HOUR_PX_DEFAULT, useCalendarNav } from '../amadeus/store/calendarNavStore'
import { useAgentSchedules, useAgentCalDbs } from '../stores/agentScheduleStore'
import { useOtherVaultCalDbs } from '../stores/otherVaultCalStore'
import { useIcsCalDbs } from '../stores/icsCalendarStore'
import { useMdCalDbs } from '../amadeus/store/mdMarkStore'
import { useApp } from '../stores/appStore'
import { EventCard, type Anchor } from './calendar/EventCard'
import { MODE_ITEMS, classifyCalKey } from './calendar/calKeys'
import { layoutTimedEvents } from './calendar/eventLayout'
import { deleteCalendarRow } from './calendar/eventActions'
import {
  HOURS,
  WEEKDAYS,
  addDays,
  addMinutes,
  coversDay,
  daysRange,
  diffDays,
  eventBox,
  fmtStamp,
  monthLabel,
  rangeLabel,
  sameDay,
  shiftDays,
  snap15,
  startOfDay,
  startOfWeek,
  toLocalDate,
} from './calendar/dateUtils'

// 小时高度改为可缩放状态(calendarNavStore.hourPx);CSS 网格线经 --amx-hour-px 变量同步(TimeScroll 根注入)。
const HEAD_H = 26
const EDGE = 8.4 // 事件上下边缘「拉伸时长」命中带(px);比原 7 宽松约 20%,更好抓。与 CSS ::before/::after 高度同步
const DAY_HALF = 150 // 横向日窗 ±150 天(≈10 个月,足够一次会话连续滚动)
const WEEK_HALF = 40 // 纵向周窗 ±40 周

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
}

interface CalEntry { db: AggDb; dateCol: string }
function buildEvents(entries: CalEntry[], vault: string, byVault: Parameters<typeof colorForDb>[1]): CalEvent[] {
  const out: CalEvent[] = []
  entries.forEach(({ db, dateCol }, di) => {
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
        readonly: db.readonly && !db.writeCell,
      })
    }
  })
  return out
}

/** 模式下拉(Notion Calendar 式)的条目与单键快捷键。 */
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const rectOf = (e: ReactMouseEvent | ReactPointerEvent): Anchor => {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, zoom: zoomOf(el) || 1 }
}
const eventValue = (start: Date, end: Date | null, allDay: boolean): string =>
  end ? `${fmtStamp(start, allDay)}/${fmtStamp(end, allDay)}` : fmtStamp(start, allDay)
const commitTime = (ev: CalEvent, start: Date, end: Date | null): void =>
  setAggCell(ev.db, ev.row.rowId, ev.colId, eventValue(start, end, ev.allDay))

const eventColorStyle = (color: string): CSSProperties =>
  ({ '--amx-event-color': color } as CSSProperties)

const daySpanClass = (ev: CalEvent, day: Date): string => {
  const t = startOfDay(day).getTime()
  const before = startOfDay(ev.start).getTime() < t
  const after = startOfDay(ev.end ?? ev.start).getTime() > t
  return `${before ? ' continues-left' : ''}${after ? ' continues-right' : ''}`
}

export function CalendarView() {
  const members = useCalendarMembers()
  const agentDbs = useAgentCalDbs()
  const otherDbs = useOtherVaultCalDbs() // 非活动侧(Local↔Cloud 另一侧)只读日历,汇总两侧(任务1)
  const icsDbs = useIcsCalDbs() // 外部日历订阅(.ics):同为只读叠加源
  const mdDbs = useMdCalDbs() // 笔记正文 `@2026-09-01T14:30` 标记(无勾选框的那些):同为只读叠加源
  const cfg = useApp((s) => s.cfg)
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const byVault = useCalendarConfig((s) => s.byVault)
  const mode = useCalendarNav((s) => s.mode)
  const setMode = useCalendarNav((s) => s.setMode)
  const hourPx = useCalendarNav((s) => s.hourPx)
  const setHourPx = useCalendarNav((s) => s.setHourPx)
  const jumpNonce = useCalendarNav((s) => s.jumpNonce)
  const [card, setCard] = useState<{ key: string; at: Anchor } | null>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const api = useRef<CalApi>(null)
  const selRef = useRef<CalEvent | null>(null) // 常驻键盘 effect 读当前选中(避免 [] 闭包读旧值)
  const clipRef = useRef<{ db: AggDb; rowId: string } | null>(null) // 复制的事件(会话内内存剪贴板)

  // mini 日历点某日 → 主区丝滑跳转(当前挂载的 month/time 子视图各自在自身坐标系里滚动)。
  useEffect(() => {
    if (!jumpNonce) return
    const d = useCalendarNav.getState().jumpDate
    if (d) api.current?.goto(toLocalDate(d))
  }, [jumpNonce])

  // agent 日程只读源:打开即拉 + 60s 轮询(引擎侧 SCHEDULE.db 由工具/自动化写,无推送通道)。
  useEffect(() => {
    const pull = (): void => void useAgentSchedules.getState().refresh(cfg)
    pull()
    const t = window.setInterval(pull, 60_000)
    return () => window.clearInterval(t)
  }, [cfg])

  // 成员库 + agent 只读源汇入事件流;resolveDefaultDb 只吃成员库(双击新建绝不落到 agent:// 假路径)。
  const entries = useMemo<CalEntry[]>(
    () => [
      ...members.map((m) => ({ db: m.db, dateCol: m.dateCol })),
      ...[...agentDbs, ...otherDbs, ...icsDbs, ...mdDbs].map((db) => ({ db, dateCol: firstDateCol(db)?.id })).filter((x): x is CalEntry => !!x.dateCol),
    ],
    [members, agentDbs, otherDbs, icsDbs, mdDbs],
  )
  const events = useMemo(() => buildEvents(entries, vault, byVault), [entries, vault, byVault])
  // 无名事件以「未命名」占位上网格(清空名字时事件块不许消失);编辑卡走 events 原值,输入框保持真实空值。
  const visible = useMemo(() => events.map((e) => (e.title ? e : { ...e, title: '未命名' })), [events])
  const selected = card ? events.find((e) => e.key === card.key) ?? null : null
  selRef.current = selected
  const openCard = (key: string, at: Anchor): void => setCard({ key, at })

  const resolveDefaultDb = (): CalEntry | null => {
    const dp = defaultDbPath(vault, byVault)
    const m = members.find((x) => x.db.path === dp) ?? members.find((x) => !x.db.isNoteView) ?? members[0] ?? null
    return m ? { db: m.db, dateCol: m.dateCol } : null
  }
  const defaultEntry = resolveDefaultDb()
  const create = async (day: Date, min: number | null, at: Anchor): Promise<void> => {
    const target = resolveDefaultDb()
    if (!target) return
    const { db, dateCol } = target
    let value: string
    if (min === null) value = fmtStamp(day, true)
    else {
      const start = addMinutes(startOfDay(day), min)
      value = `${fmtStamp(start, false)}/${fmtStamp(addMinutes(start, 30), false)}`
    }
    const newId = await createAggEvent(db, dateCol, value, '新事件')
    openCard(`${db.path}::${newId}`, at)
  }

  // 键盘:D/W/3/M 切模式、←/→ 翻上/下一周期(任务3)、Cmd/Ctrl+C/V 复制粘贴选中事件、
  // Delete/Backspace 删除(任务2)。输入控件不劫持;选中/剪贴板经 ref(effect 常驻,免闭包读旧值)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('input, textarea, select, [contenteditable]')) return
      const act = classifyCalKey(e)
      if (!act) return
      const sel = selRef.current
      switch (act.kind) {
        case 'copy':
          if (sel && !sel.readonly) clipRef.current = { db: sel.db, rowId: sel.row.rowId }
          break
        case 'paste':
          if (clipRef.current) void duplicateAggRow(clipRef.current.db, clipRef.current.rowId)
          break
        case 'delete':
          if (sel && !sel.readonly) {
            deleteCalendarRow(sel.db, sel.row, sel.title)
            setCard(null)
          }
          break
        case 'prev':
          api.current?.prev()
          break
        case 'next':
          api.current?.next()
          break
        case 'mode':
          useCalendarNav.getState().setMode(act.mode)
          break
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const n = mode === 'week' ? 7 : mode === '3day' ? 3 : 1
  return (
    <div className="amx-cal">
      <AstryxScope>
        {/* 主任务优先:新建 / 回今天 / 翻页;视图与密度退到后面。双击空白仍保留为效率快捷方式。 */}
        <header className="amx-cal-bar">
          <div className="amx-cal-nav">
            <span className="amx-cal-title" ref={titleRef} />
          </div>
          <div className="amx-cal-modes">
            <Button
              size="sm"
              variant="primary"
              icon={<CalendarPlus size={14} />}
              label="新建"
              isDisabled={!defaultEntry}
              tooltip={defaultEntry ? `新建到「${defaultEntry.db.name}」` : '请先在右栏添加一个日历数据库'}
              onClick={(e) => {
                const now = new Date()
                const next = addMinutes(startOfDay(now), snap15(now.getHours() * 60 + now.getMinutes() + 15))
                const at = rectOf(e)
                void create(startOfDay(next), next.getHours() * 60 + next.getMinutes(), at)
              }}
            />
            <Button size="sm" variant="secondary" label="今天" onClick={() => api.current?.today()} />
            <Button size="sm" variant="ghost" isIconOnly icon={<ChevronLeft size={14} />} label="上一页" onClick={() => api.current?.prev()} />
            <Button size="sm" variant="ghost" isIconOnly icon={<ChevronRight size={14} />} label="下一页" onClick={() => api.current?.next()} />
            <DropdownMenu button={{ label: MODE_ITEMS.find((m) => m.id === mode)?.label ?? '周', variant: 'secondary', size: 'sm' }} menuWidth={168}>
              {MODE_ITEMS.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  icon={mode === m.id ? <Check size={14} /> : <span style={{ display: 'inline-block', width: 14 }} />}
                  label={m.label}
                  endContent={<Kbd keys={m.key} />}
                  onClick={() => setMode(m.id)}
                />
              ))}
            </DropdownMenu>
            {mode !== 'month' && (
              <span className="amx-cal-density">
                <DropdownMenu button={{ label: '密度', variant: 'ghost', size: 'sm' }} menuWidth={176}>
                  <DropdownMenuItem icon={<ZoomOut size={14} />} label="缩小时间轴" onClick={() => setHourPx(hourPx - 8)} />
                  <DropdownMenuItem icon={<ZoomIn size={14} />} label="放大时间轴" onClick={() => setHourPx(hourPx + 8)} />
                  <DropdownMenuItem icon={<RotateCcw size={14} />} label="恢复默认密度" endContent={`${hourPx}px`} onClick={() => setHourPx(HOUR_PX_DEFAULT)} />
                </DropdownMenu>
              </span>
            )}
          </div>
        </header>
      </AstryxScope>

      {visible.length === 0 && (
        <div className="amx-cal-empty">还没有日历事件。点「新建」，或在右栏添加一个含日期属性的数据库。</div>
      )}

      {mode === 'month' ? (
        <MonthScroll ref={api} events={visible} selectedKey={card?.key ?? null} onPick={openCard} onCreate={(d, at) => void create(d, null, at)} titleRef={titleRef} />
      ) : (
        <TimeScroll ref={api} n={n} events={visible} selectedKey={card?.key ?? null} onPick={openCard} onCreate={(d, min, at) => void create(d, min, at)} titleRef={titleRef} />
      )}

      {selected && card && <EventCard ev={selected} at={card.at} onClose={() => setCard(null)} />}
    </div>
  )
}

// ── 时间网格(横向连续日列条)────────────────────────────────────────────────
interface TimeProps {
  n: number
  events: CalEvent[]
  selectedKey: string | null
  onPick: (key: string, at: Anchor) => void
  onCreate: (day: Date, min: number, at: Anchor) => void
  titleRef: RefObject<HTMLSpanElement | null>
}
const TimeScroll = forwardRef<CalApi, TimeProps>(function TimeScroll({ n, events, selectedKey, onPick, onCreate, titleRef }, ref) {
  const wrap = useRef<HTMLDivElement>(null)
  const gutterHours = useRef<HTMLDivElement>(null) // 表头/全天常驻；仅小时轴随正文纵向滚动。
  const [colw, setColw] = useState(0)
  const [alldayH, setAlldayH] = useState(0) // 全天行高(auto,由日区量出)→ 左轴 gallday 镜像,保小时刻度对齐
  const hourPx = useCalendarNav((s) => s.hourPx)
  const setVisibleRange = useCalendarNav((s) => s.setVisibleRange)
  // 左轴纵向跟随日区滚动(命令式,不触发重渲,几百列仍丝滑)。
  const syncGutter = (): void => {
    if (gutterHours.current && wrap.current) gutterHours.current.style.transform = `translateY(${-wrap.current.scrollTop}px)`
  }
  const today = useMemo(() => startOfDay(new Date()), [])
  const days = useMemo(() => {
    const b = addDays(today, -DAY_HALF)
    return Array.from({ length: DAY_HALF * 2 + 1 }, (_, i) => addDays(b, i))
  }, [today])
  const firstIdx = useRef(DAY_HALF)
  const centered = useRef(false)
  const lastTitle = useRef('')
  const lastRangeI = useRef(-1)
  const ghostRef = useRef<HTMLDivElement>(null) // 落点吸附提示(唯一持久元素,拖动中命令式定位)
  const hideGhost = (): void => { if (ghostRef.current) ghostRef.current.style.display = 'none' }
  const dragRef = useRef<{
    mode: 'move' | 'start' | 'end'
    ev: CalEvent      // 拖拽中实时反算时间文本用
    el: HTMLElement
    tEl: HTMLElement | null // 块内时间文本 span(拖拽中命令式更新)
    t0: string        // 原始时间文本(未生效的拖拽收手时还原)
    x0: number; y0: number
    zoom: number      // PointerEvent 是视口 px；transform/hourPx 是未缩放局部 px，换算必须除累计 CSS zoom。
    top0: number; h0: number
    grabOffY: number // 按下时光标距事件顶部的偏移,拖动保持该抓握点
    durMin: number   // 时长(分,用于吸附上限与提示块高)
    msDur: number    // 原始 end-start 毫秒(0=无 end);提交时保留精确时长
    dyMin: number
    moved: boolean
    target: { iso: string; topMin: number } | null // move 落点:目标日 + 吸附后起始分钟
  } | null>(null)

  // 当前时间线(任务2):每 30s 刷新分钟位置;卸载清区间条(mini 据此判断 Calendar 是否挂载)。
  const [nowMin, setNowMin] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() })
  useEffect(() => {
    const id = setInterval(() => { const d = new Date(); setNowMin(d.getHours() * 60 + d.getMinutes()) }, 30_000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => () => setVisibleRange(null, null), [setVisibleRange])

  const updateTitle = (): void => {
    const el = wrap.current
    if (!el || !colw) return
    const i = Math.max(0, Math.min(days.length - n, Math.round(el.scrollLeft / colw)))
    firstIdx.current = i
    const label = rangeLabel(daysRange(days[i], n))
    if (label !== lastTitle.current) {
      lastTitle.current = label
      if (titleRef.current) titleRef.current.textContent = label
    }
    if (i !== lastRangeI.current) {
      lastRangeI.current = i
      setVisibleRange(fmtStamp(days[i], true), fmtStamp(days[Math.min(days.length - 1, i + n - 1)], true))
    }
  }

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    // 左轴已是独立 flex 项(52px),日区宽度不再含它 → colw 直接按日区宽均分。
    const minCol = n === 7 ? 112 : n === 3 ? 132 : 180
    const measure = (): void => setColw(Math.max(minCol, el.clientWidth / n))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [n])

  // 全天行高由日区量出(随全天事件增减变化)→ 喂给左轴 gallday,保证小时刻度与网格线对齐。
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const dc = el.querySelector('.amx-cal-daycol2') as HTMLElement | null
    if (dc) setAlldayH(Math.max(0, dc.offsetTop - (HEAD_H + 14)))
  }, [events, colw, n])

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
    el.scrollLeft = firstIdx.current * colw // 换 n(colw 变)时保持最左那天
    updateTitle()
    syncGutter()
  }, [colw]) // eslint-disable-line react-hooks/exhaustive-deps

  // 缩放锚定:hourPx 变化时保持视口中心的时刻不动(顶栏 ± 按钮与 Ctrl+滚轮共用这一条路径)。
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
    today: () => wrap.current?.scrollTo({ left: DAY_HALF * colw, behavior: 'smooth' }),
    goto: (date: Date) => {
      if (!colw) return
      const i = Math.max(0, Math.min(days.length - n, diffDays(startOfDay(date), days[0])))
      wrap.current?.scrollTo({ left: i * colw, behavior: 'smooth' })
    },
  }), [n, colw, days])

  const down = (ev: CalEvent, e: ReactPointerEvent): void => {
    e.stopPropagation()
    if (ev.readonly) return // 只读源:不设 dragRef 不 capture;up() 里补点击开卡
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    const zoom = zoomOf(el) || 1
    const offY = (e.clientY - rect.top) / zoom
    const mode: 'move' | 'start' | 'end' = offY < EDGE ? 'start' : rect.height / zoom - offY < EDGE ? 'end' : 'move'
    const box = eventBox(ev.start, ev.end, hourPx)
    const h0 = Math.max(14, box.height)
    const tEl = el.querySelector('.amx-cal-event-t') as HTMLElement | null
    el.setPointerCapture(e.pointerId)
    el.classList.add('dragging')
    dragRef.current = {
      mode, ev, el, tEl, t0: tEl?.textContent ?? '', x0: e.clientX, y0: e.clientY, zoom, top0: box.top, h0, grabOffY: offY,
      durMin: Math.round((h0 / hourPx) * 60), msDur: ev.end ? ev.end.getTime() - ev.start.getTime() : 0,
      dyMin: 0, moved: false, target: null,
    }
  }
  const move = (e: ReactPointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    // move = 整个日历自由拖动:块本身跟手不吸附(translate),吸附只体现在落点提示 ghost 上。
    if (d.mode === 'move') {
      const dx = (e.clientX - d.x0) / d.zoom
      const dy = (e.clientY - d.y0) / d.zoom
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true
      d.el.style.transform = `translate(${dx}px, ${dy}px)`
      const sc = wrap.current
      if (!sc || !colw) return
      const scRect = sc.getBoundingClientRect()
      const gridZoom = zoomOf(sc) || 1
      const colIndex = Math.max(0, Math.min(days.length - 1, Math.floor(((e.clientX - scRect.left) / gridZoom + sc.scrollLeft) / colw)))
      const bodyTop = HEAD_H + 14 + alldayH
      const eventTopY = (e.clientY - scRect.top) / gridZoom - d.grabOffY + sc.scrollTop - bodyTop // 保持抓握点:算事件顶在时间体内的 y
      const topMin = Math.max(0, Math.min(24 * 60 - d.durMin, snap15((eventTopY / hourPx) * 60)))
      d.target = { iso: fmtStamp(days[colIndex], true), topMin }
      const g = ghostRef.current
      if (g) {
        g.style.display = 'block'
        g.style.left = `${colIndex * colw}px`
        g.style.width = `${colw}px`
        g.style.top = `${bodyTop + (topMin / 60) * hourPx}px`
        g.style.height = `${d.h0}px`
      }
      // 实时时间:块内文本 + ghost 标签都跟吸附落点走(松手才 commit)。真拖起来才动文本,
      // 防止「原本 10:07 的事件被点一下就显示成吸附后的 10:00」。
      if (d.moved) {
        const ns = addMinutes(startOfDay(days[colIndex]), topMin)
        const label = d.msDur ? `${hhmm(ns)}–${hhmm(new Date(ns.getTime() + d.msDur))}` : hhmm(ns)
        if (d.tEl) d.tEl.textContent = label
        if (g) g.textContent = label
      }
      return
    }
    // resize(start/end):竖向改时长;时间文本随预览实时反算(与 up() 的钳制一致)
    const dyMin = snap15((((e.clientY - d.y0) / d.zoom) / hourPx) * 60)
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
        d.tEl.textContent = `${hhmm(d.ev.start)}–${hhmm(ne)}`
      } else {
        let ns = addMinutes(d.ev.start, dyMin)
        if (ns.getTime() >= baseEnd.getTime()) ns = addMinutes(baseEnd, -15)
        d.tEl.textContent = `${hhmm(ns)}–${hhmm(baseEnd)}`
      }
    }
  }
  const up = (ev: CalEvent, e: ReactPointerEvent): void => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) {
      if (ev.readonly) onPick(ev.key, rectOf(e)) // down() 对只读早退过 → 这里就是「点击开卡」
      return
    }
    d.el.classList.remove('dragging')
    if (d.mode === 'move') {
      d.el.style.transform = ''
      hideGhost()
      if (!d.moved || !d.target) {
        if (d.tEl) d.tEl.textContent = d.t0 // 未生效的拖拽:还原被预览覆盖的时间文本
        if (!d.moved) onPick(ev.key, rectOf(e))
        return
      }
      const newStart = addMinutes(startOfDay(toLocalDate(d.target.iso)), d.target.topMin)
      commitTime(ev, newStart, ev.end ? new Date(newStart.getTime() + d.msDur) : null) // 跨日+改时刻,保留时长
      return
    }
    if (d.dyMin === 0) {
      if (d.tEl) d.tEl.textContent = d.t0
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

  // 全天事件「拖出来」→ 拖进某天的时间格 = 转成该时刻起 30 分钟的定时事件;没拖进则视作点击开卡片。
  const allDown = (e: ReactPointerEvent): void => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const allUp = (ev: CalEvent, e: ReactPointerEvent): void => {
    if (ev.readonly) { onPick(ev.key, rectOf(e)); return } // 只读:不许「拖出来转定时」,只开卡
    const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.amx-cal-daycol2')
    const iso = cell?.getAttribute('data-date')
    if (cell && iso) {
      const rect = cell.getBoundingClientRect()
      const min = Math.max(0, Math.min(24 * 60 - 30, snap15((((e.clientY - rect.top) / (zoomOf(cell) || 1)) / hourPx) * 60)))
      const start = addMinutes(startOfDay(toLocalDate(iso)), min)
      setAggCell(ev.db, ev.row.rowId, ev.colId, `${fmtStamp(start, false)}/${fmtStamp(addMinutes(start, 30), false)}`)
      return
    }
    onPick(ev.key, rectOf(e))
  }

  return (
    /* --amx-hour-px 喂给 CSS 网格线(repeating-gradient 周期必须与 hourPx 同步,否则线与事件错位)。 */
    <div className="amx-cal-timerow" style={{ '--amx-hour-px': `${hourPx}px` } as CSSProperties}>
      {/* 常驻左轴(任务:左侧 24h 时间轴常驻):独立 52px 列,只纵向随日区滚(横滚不走)。 */}
      <div className="amx-cal-gutterfixed">
        <div className="amx-cal-gutterinner">
          <div className="amx-cal-gcorner" style={{ height: HEAD_H + 14 }} />
          <div className="amx-cal-gallday" style={{ height: alldayH }}>全天</div>
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
      <div className="amx-cal-tscroll" ref={wrap} onScroll={() => { updateTitle(); syncGutter() }}>
      <div
        className="amx-cal-tgrid2"
        style={{ gridTemplateColumns: `repeat(${days.length}, ${colw}px)`, gridTemplateRows: `${HEAD_H + 14}px auto ${HOURS.length * hourPx}px` }}
      >
        {days.map((d) => (
          <div key={+d} className={`amx-cal-thead2${sameDay(d, today) ? ' today' : ''}`}>
            <span className="amx-cal-tdow">周{WEEKDAYS[d.getDay()]}</span>
            <span className="amx-cal-tdate">{d.getMonth() + 1}/{d.getDate()}</span>
          </div>
        ))}
        {days.map((d) => (
          <div key={+d} className="amx-cal-allday2">
            {events
              .filter((e) => e.allDay && coversDay(e.start, e.end, d))
              .map((e) => (
                <button
                  key={e.key}
                  className={`amx-cal-chip-ev amx-cal-alldrag${e.readonly ? ' readonly' : ''}${selectedKey === e.key ? ' selected' : ''}${daySpanClass(e, d)}`}
                  style={eventColorStyle(e.color)}
                  aria-label={`${e.title}，全天事件`}
                  title={e.readonly ? e.title : `${e.title}（可拖入时间格设为定时）`}
                  onPointerDown={allDown}
                  onPointerUp={(pe) => allUp(e, pe)}
                >
                  {e.title}
                </button>
              ))}
          </div>
        ))}
        {days.map((d) => (
          <div
            key={+d}
            className="amx-cal-daycol2"
            data-date={fmtStamp(d, true)}
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).closest('.amx-cal-event')) return
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
                return (
                  <button
                    key={e.key}
                    className={`amx-cal-event${e.readonly ? ' readonly' : ''}${selectedKey === e.key ? ' selected' : ''}`}
                    style={{
                      ...eventColorStyle(e.color),
                      top: box.top,
                      height: Math.max(14, box.height),
                      left: `calc(${layout.leftPct}% + 2px)`,
                      width: `calc(${layout.widthPct}% - 4px)`,
                    }}
                    aria-label={`${e.title}，${hhmm(e.start)}${e.end ? ` 至 ${hhmm(e.end)}` : ''}`}
                    title={e.title}
                    onPointerDown={(pe) => down(e, pe)}
                    onPointerMove={move}
                    onPointerUp={(pe) => up(e, pe)}
                  >
                    <span className="amx-cal-event-t">{hhmm(e.start)}{e.end ? `–${hhmm(e.end)}` : ''}</span>
                    <span className="amx-cal-event-title">{e.title}</span>
                  </button>
                )
              })
            })()}
            {/* 当前时间线(任务2):横跨整个日历所有列(每列一段,相邻拼成一条);圆点只在「今天」列。
             *  pointer-events:none 不挡双击建事件。 */}
            <div className={`amx-cal-nowline${sameDay(d, today) ? ' today' : ''}`} style={{ top: (nowMin / 60) * hourPx }} />
          </div>
        ))}
        {/* 落点吸附提示:move 拖动时命令式定位到吸附后的目标列+时刻(唯一持久元素,默认隐藏)。 */}
        <div className="amx-cal-dropghost" ref={ghostRef} />
      </div>
      </div>
    </div>
  )
})

// ── 月视图(纵向连续周行条)────────────────────────────────────────────────
interface MonthProps {
  events: CalEvent[]
  selectedKey: string | null
  onPick: (key: string, at: Anchor) => void
  onCreate: (day: Date, at: Anchor) => void
  titleRef: RefObject<HTMLSpanElement | null>
}
const MonthScroll = forwardRef<CalApi, MonthProps>(function MonthScroll({ events, selectedKey, onPick, onCreate, titleRef }, ref) {
  const wrap = useRef<HTMLDivElement>(null)
  const [rowH, setRowH] = useState(0)
  const setVisibleRange = useCalendarNav((s) => s.setVisibleRange)
  const today = useMemo(() => startOfDay(new Date()), [])
  const weeks = useMemo(() => {
    const b = addDays(startOfWeek(today), -WEEK_HALF * 7)
    return Array.from({ length: WEEK_HALF * 2 + 1 }, (_, i) => addDays(b, i * 7))
  }, [today])
  const centered = useRef(false)
  const [agenda, setAgenda] = useState<{ day: Date; events: CalEvent[]; at: Anchor } | null>(null)
  const lastTitle = useRef('')
  const lastRangeI = useRef(-1)
  useEffect(() => () => setVisibleRange(null, null), [setVisibleRange])

  const idxOfMonth = (y: number, m: number): number => Math.round(diffDays(startOfWeek(new Date(y, m, 1)), weeks[0]) / 7)
  const updateTitle = (): void => {
    const el = wrap.current
    if (!el || !rowH) return
    const i = Math.max(0, Math.min(weeks.length - 1, Math.round(el.scrollTop / rowH)))
    const label = monthLabel(addDays(weeks[i], 3))
    if (label !== lastTitle.current) {
      lastTitle.current = label
      if (titleRef.current) titleRef.current.textContent = label
    }
    if (i !== lastRangeI.current) {
      lastRangeI.current = i
      const visibleRows = Math.max(1, Math.round(el.clientHeight / rowH))
      const lastWeek = weeks[Math.min(weeks.length - 1, i + visibleRows - 1)]
      setVisibleRange(fmtStamp(weeks[i], true), fmtStamp(addDays(lastWeek, 6), true))
    }
  }

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = (): void => setRowH(Math.max(64, (el.clientHeight - HEAD_H) / 6))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el || !rowH || centered.current) return
    centered.current = true
    el.scrollTop = idxOfMonth(today.getFullYear(), today.getMonth()) * rowH
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

  const chipDown = (e: ReactPointerEvent): void => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const chipUp = (ev: CalEvent, e: ReactPointerEvent): void => {
    const rect = rectOf(e)
    if (ev.readonly) { onPick(ev.key, rect); return } // 只读:月视图芯片不可跨日拖,只开卡
    const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.amx-cal-mcell')
    const iso = cell?.getAttribute('data-date')
    if (iso) {
      const delta = diffDays(toLocalDate(iso), ev.start)
      if (delta !== 0) {
        commitTime(ev, shiftDays(ev.start, delta), ev.end ? shiftDays(ev.end, delta) : null)
        return
      }
    }
    onPick(ev.key, rect)
  }

  return (
    <div className="amx-cal-mscroll" ref={wrap} onScroll={updateTitle}>
      <div className="amx-cal-weekhead2">
        {WEEKDAYS.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="amx-cal-mweeks">
        {weeks.map((ws) => (
          <div key={+ws} className="amx-cal-mweek" style={{ height: rowH }}>
            {daysRange(ws, 7).map((day) => {
              const dayEvents = events.filter((e) => coversDay(e.start, e.end, day))
              return (
                <div
                  key={+day}
                  className={`amx-cal-mcell${sameDay(day, today) ? ' today' : ''}`}
                  data-date={fmtStamp(day, true)}
                  onDoubleClick={(e) => {
                    if ((e.target as HTMLElement).closest('.amx-cal-chip-ev')) return
                    onCreate(day, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, zoom: zoomOf(e.currentTarget) || 1 })
                  }}
                >
                  <div className="amx-cal-mnum">{day.getDate() === 1 ? `${day.getMonth() + 1}月1` : day.getDate()}</div>
                  {dayEvents.slice(0, 3).map((e) => (
                    <button
                      key={e.key}
                      className={`amx-cal-chip-ev${e.readonly ? ' readonly' : ''}${selectedKey === e.key ? ' selected' : ''}${daySpanClass(e, day)}`}
                      style={eventColorStyle(e.color)}
                      title={e.title}
                      aria-label={`${e.title}${!e.allDay && sameDay(e.start, day) ? `，${hhmm(e.start)}` : ''}`}
                      onPointerDown={chipDown}
                      onPointerUp={(pe) => chipUp(e, pe)}
                    >
                      {!e.allDay && sameDay(e.start, day) && <span className="amx-cal-chip-t">{hhmm(e.start)}</span>} {e.title}
                    </button>
                  ))}
                  {dayEvents.length > 3 && (
                    <button
                      className="amx-cal-more"
                      aria-label={`查看 ${day.getMonth() + 1} 月 ${day.getDate()} 日全部 ${dayEvents.length} 个事件`}
                      onClick={(e) => setAgenda({ day, events: dayEvents, at: rectOf(e) })}
                    >
                      还有 {dayEvents.length - 3} 项
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
        aria-label={`${day.getMonth() + 1} 月 ${day.getDate()} 日事件`}
        style={{ left, top, width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <strong>{day.getMonth() + 1} 月 {day.getDate()} 日</strong>
          <button onClick={onClose} aria-label="关闭日程列表">×</button>
        </header>
        <div className="amx-cal-agenda-list">
          {events.map((ev) => (
            <button key={ev.key} style={eventColorStyle(ev.color)} onClick={(e) => onPick(ev.key, rectOf(e))}>
              <span className="amx-cal-agenda-time">{ev.allDay ? '全天' : hhmm(ev.start)}</span>
              <span>{ev.title}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

// 旁弹编辑卡已抽到 ./calendar/EventCard.tsx(与 TodoListView 共用);CalEvent 结构性满足 CardTarget。
