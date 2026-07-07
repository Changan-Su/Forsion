/** Calendar View —— Notion Calendar 式,连续原生滚动(跟手、无顿挫):
 *  周/3日/日 = 一条横向滚动的日列条(横滚一天一天连续推进);月 = 一条纵向滚动的周行条。
 *  小时线用背景渐变(零 DOM),事件拖拽走命令式 DOM(不触发整条重渲),故几百列仍丝滑。
 *  颜色/显隐/默认库来自 calendarConfigStore;数据经 dbAggregateStore 聚合全库 calendarDate 列。 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { parseCalDate } from '@amadeus-shared/db/calDate'
import { coerceForDisplay, type CellValue, type DbColumn } from '@amadeus-shared/db/schema'
import { CalDateFields } from '../amadeus/blocks/database/propertyTypes.builtins'
import { getPropertyType, resolveBaseType } from '../amadeus/blocks/database/propertyTypes'
import { usePageStore } from '../amadeus/store/pageStore'
import {
  useAggregatedDatabases,
  setAggCell,
  setAggName,
  createAggEvent,
  deleteAggRow,
  cellText,
  type AggDb,
  type AggRow,
} from '../amadeus/store/dbAggregateStore'
import { useCalendarConfig, colorForDb, isHidden, defaultDbPath } from '../amadeus/store/calendarConfigStore'
import { useCalendarNav, type CalMode } from '../amadeus/store/calendarNavStore'
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

const HOUR_PX = 44 // 必须与 CSS .amx-cal-daycol2 的渐变周期一致
const HEAD_H = 26
const EDGE = 8.4 // 事件上下边缘「拉伸时长」命中带(px);比原 7 宽松约 20%,更好抓。与 CSS ::before/::after 高度同步
const DAY_HALF = 150 // 横向日窗 ±150 天(≈10 个月,足够一次会话连续滚动)
const WEEK_HALF = 40 // 纵向周窗 ±40 周

interface Anchor { left: number; top: number; right: number; bottom: number }
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
}

function buildEvents(dbs: AggDb[], vault: string, byVault: Parameters<typeof colorForDb>[1]): CalEvent[] {
  const out: CalEvent[] = []
  dbs.forEach((db, di) => {
    if (isHidden(vault, byVault, db.path)) return
    const col = db.columns.find((c) => c.type === 'calendarDate')
    if (!col) return
    const color = colorForDb(vault, byVault, db.path, di)
    for (const r of db.rows) {
      const raw = typeof r.cells[col.id] === 'string' ? (r.cells[col.id] as string) : ''
      const cd = parseCalDate(raw)
      if (!cd) continue
      out.push({
        key: `${db.path}::${r.rowId}`,
        color,
        db,
        row: r,
        colId: col.id,
        title: r.name || '未命名',
        raw,
        start: toLocalDate(cd.start),
        end: cd.end ? toLocalDate(cd.end) : null,
        allDay: cd.allDay,
      })
    }
  })
  return out
}

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const rectOf = (e: ReactMouseEvent | ReactPointerEvent): Anchor => (e.currentTarget as HTMLElement).getBoundingClientRect()
const eventValue = (start: Date, end: Date | null, allDay: boolean): string =>
  end ? `${fmtStamp(start, allDay)}/${fmtStamp(end, allDay)}` : fmtStamp(start, allDay)
const commitTime = (ev: CalEvent, start: Date, end: Date | null): void =>
  setAggCell(ev.db, ev.row.rowId, ev.colId, eventValue(start, end, ev.allDay))

export function CalendarView() {
  const dbs = useAggregatedDatabases('calendarDate')
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const byVault = useCalendarConfig((s) => s.byVault)
  const mode = useCalendarNav((s) => s.mode)
  const setMode = useCalendarNav((s) => s.setMode)
  const jumpNonce = useCalendarNav((s) => s.jumpNonce)
  const [card, setCard] = useState<{ key: string; at: Anchor } | null>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const api = useRef<CalApi>(null)

  // mini 日历点某日 → 主区丝滑跳转(当前挂载的 month/time 子视图各自在自身坐标系里滚动)。
  useEffect(() => {
    if (!jumpNonce) return
    const d = useCalendarNav.getState().jumpDate
    if (d) api.current?.goto(toLocalDate(d))
  }, [jumpNonce])

  const events = useMemo(() => buildEvents(dbs, vault, byVault), [dbs, vault, byVault])
  const selected = card ? events.find((e) => e.key === card.key) ?? null : null
  const openCard = (key: string, at: Anchor): void => setCard({ key, at })

  const resolveDefaultDb = (): AggDb | null => {
    const dp = defaultDbPath(vault, byVault)
    return dbs.find((d) => d.path === dp) ?? dbs.find((d) => !d.isNoteView) ?? dbs[0] ?? null
  }
  const create = async (day: Date, min: number | null, at: Anchor): Promise<void> => {
    const db = resolveDefaultDb()
    const col = db?.columns.find((c) => c.type === 'calendarDate')
    if (!db || !col) return
    let value: string
    if (min === null) value = fmtStamp(day, true)
    else {
      const start = addMinutes(startOfDay(day), min)
      value = `${fmtStamp(start, false)}/${fmtStamp(addMinutes(start, 30), false)}`
    }
    const newId = await createAggEvent(db, col.id, value, '新事件')
    openCard(`${db.path}::${newId}`, at)
  }

  const n = mode === 'week' ? 7 : mode === '3day' ? 3 : 1
  return (
    <div className="amx-cal">
      <header className="amx-cal-bar">
        <div className="amx-cal-nav">
          <button className="amx-cal-btn" onClick={() => api.current?.prev()} aria-label="上一页">‹</button>
          <button className="amx-cal-btn amx-cal-today" onClick={() => api.current?.today()}>今天</button>
          <button className="amx-cal-btn" onClick={() => api.current?.next()} aria-label="下一页">›</button>
          <span className="amx-cal-title" ref={titleRef} />
        </div>
        <div className="amx-cal-modes">
          {(['month', 'week', '3day', 'day'] as CalMode[]).map((m) => (
            <button key={m} className={`amx-cal-mode${mode === m ? ' on' : ''}`} onClick={() => setMode(m)}>
              {m === 'month' ? '月' : m === 'week' ? '周' : m === '3day' ? '3 日' : '日'}
            </button>
          ))}
        </div>
      </header>

      {events.length === 0 && (
        <div className="amx-cal-empty">还没有日历事件。双击空白处新建,或给多维表加「日历日期」列。</div>
      )}

      {mode === 'month' ? (
        <MonthScroll ref={api} events={events} onPick={openCard} onCreate={(d, at) => void create(d, null, at)} titleRef={titleRef} />
      ) : (
        <TimeScroll ref={api} n={n} events={events} onPick={openCard} onCreate={(d, min, at) => void create(d, min, at)} titleRef={titleRef} />
      )}

      {selected && card && <EventCard ev={selected} at={card.at} onClose={() => setCard(null)} />}
    </div>
  )
}

// ── 时间网格(横向连续日列条)────────────────────────────────────────────────
interface TimeProps {
  n: number
  events: CalEvent[]
  onPick: (key: string, at: Anchor) => void
  onCreate: (day: Date, min: number, at: Anchor) => void
  titleRef: RefObject<HTMLSpanElement | null>
}
const TimeScroll = forwardRef<CalApi, TimeProps>(function TimeScroll({ n, events, onPick, onCreate, titleRef }, ref) {
  const wrap = useRef<HTMLDivElement>(null)
  const gutterInner = useRef<HTMLDivElement>(null) // 固定左轴内层:纵向随日区 scrollTop 命令式平移(横滚不动)
  const [colw, setColw] = useState(0)
  const [alldayH, setAlldayH] = useState(0) // 全天行高(auto,由日区量出)→ 左轴 gallday 镜像,保小时刻度对齐
  const setVisibleRange = useCalendarNav((s) => s.setVisibleRange)
  // 左轴纵向跟随日区滚动(命令式,不触发重渲,几百列仍丝滑)。
  const syncGutter = (): void => {
    if (gutterInner.current && wrap.current) gutterInner.current.style.transform = `translateY(${-wrap.current.scrollTop}px)`
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
    el: HTMLElement
    x0: number; y0: number
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
    const measure = (): void => setColw(Math.max(64, el.clientWidth / n))
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
      el.scrollTop = Math.max(0, bodyTop + (nowMin / 60) * HOUR_PX - el.clientHeight / 2)
    }
    el.scrollLeft = firstIdx.current * colw // 换 n(colw 变)时保持最左那天
    updateTitle()
    syncGutter()
  }, [colw]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    const offY = e.clientY - rect.top
    const mode: 'move' | 'start' | 'end' = offY < EDGE ? 'start' : rect.height - offY < EDGE ? 'end' : 'move'
    const box = eventBox(ev.start, ev.end, HOUR_PX)
    const h0 = Math.max(14, box.height)
    el.setPointerCapture(e.pointerId)
    el.classList.add('dragging')
    dragRef.current = {
      mode, el, x0: e.clientX, y0: e.clientY, top0: box.top, h0, grabOffY: offY,
      durMin: Math.round((h0 / HOUR_PX) * 60), msDur: ev.end ? ev.end.getTime() - ev.start.getTime() : 0,
      dyMin: 0, moved: false, target: null,
    }
  }
  const move = (e: ReactPointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    // move = 整个日历自由拖动:块本身跟手不吸附(translate),吸附只体现在落点提示 ghost 上。
    if (d.mode === 'move') {
      const dx = e.clientX - d.x0
      const dy = e.clientY - d.y0
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true
      d.el.style.transform = `translate(${dx}px, ${dy}px)`
      const sc = wrap.current
      if (!sc || !colw) return
      const scRect = sc.getBoundingClientRect()
      const colIndex = Math.max(0, Math.min(days.length - 1, Math.floor((e.clientX - scRect.left + sc.scrollLeft) / colw)))
      const bodyTop = HEAD_H + 14 + alldayH
      const eventTopY = e.clientY - d.grabOffY - scRect.top + sc.scrollTop - bodyTop // 保持抓握点:算事件顶在时间体内的 y
      const topMin = Math.max(0, Math.min(24 * 60 - d.durMin, snap15((eventTopY / HOUR_PX) * 60)))
      d.target = { iso: fmtStamp(days[colIndex], true), topMin }
      const g = ghostRef.current
      if (g) {
        g.style.display = 'block'
        g.style.left = `${colIndex * colw}px`
        g.style.width = `${colw}px`
        g.style.top = `${bodyTop + (topMin / 60) * HOUR_PX}px`
        g.style.height = `${d.h0}px`
      }
      return
    }
    // resize(start/end):竖向改时长,原逻辑不变
    const dyMin = snap15(((e.clientY - d.y0) / HOUR_PX) * 60)
    d.dyMin = dyMin
    const dPx = (dyMin / 60) * HOUR_PX
    if (d.mode === 'end') d.el.style.height = `${Math.max(14, d.h0 + dPx)}px`
    else {
      d.el.style.top = `${d.top0 + dPx}px`
      d.el.style.height = `${Math.max(14, d.h0 - dPx)}px`
    }
  }
  const up = (ev: CalEvent, e: ReactPointerEvent): void => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    d.el.classList.remove('dragging')
    if (d.mode === 'move') {
      d.el.style.transform = ''
      hideGhost()
      if (!d.moved || !d.target) { if (!d.moved) onPick(ev.key, rectOf(e)); return } // 没挪 = 点击开卡片
      const newStart = addMinutes(startOfDay(toLocalDate(d.target.iso)), d.target.topMin)
      commitTime(ev, newStart, ev.end ? new Date(newStart.getTime() + d.msDur) : null) // 跨日+改时刻,保留时长
      return
    }
    if (d.dyMin === 0) return
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
    const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.amx-cal-daycol2')
    const iso = cell?.getAttribute('data-date')
    if (cell && iso) {
      const rect = cell.getBoundingClientRect()
      const min = Math.max(0, Math.min(24 * 60 - 30, snap15(((e.clientY - rect.top) / HOUR_PX) * 60)))
      const start = addMinutes(startOfDay(toLocalDate(iso)), min)
      setAggCell(ev.db, ev.row.rowId, ev.colId, `${fmtStamp(start, false)}/${fmtStamp(addMinutes(start, 30), false)}`)
      return
    }
    onPick(ev.key, rectOf(e))
  }

  return (
    <div className="amx-cal-timerow">
      {/* 常驻左轴(任务:左侧 24h 时间轴常驻):独立 52px 列,只纵向随日区滚(横滚不走)。 */}
      <div className="amx-cal-gutterfixed">
        <div className="amx-cal-gutterinner" ref={gutterInner}>
          <div className="amx-cal-gcorner" style={{ height: HEAD_H + 14 }} />
          <div className="amx-cal-gallday" style={{ height: alldayH }}>全天</div>
          <div className="amx-cal-ghours">
            {HOURS.map((h) => (
              <div key={h} className="amx-cal-hour" style={{ height: HOUR_PX }}>
                {h === 0 ? '' : `${h}:00`}
              </div>
            ))}
            {/* 当前时刻标签:钉在左轴上,主题色。 */}
            <span className="amx-cal-nowlabel" style={{ top: (nowMin / 60) * HOUR_PX }}>
              {String(Math.floor(nowMin / 60)).padStart(2, '0')}:{String(nowMin % 60).padStart(2, '0')}
            </span>
          </div>
        </div>
      </div>
      <div className="amx-cal-tscroll" ref={wrap} onScroll={() => { updateTitle(); syncGutter() }}>
      <div
        className="amx-cal-tgrid2"
        style={{ gridTemplateColumns: `repeat(${days.length}, ${colw}px)`, gridTemplateRows: `${HEAD_H + 14}px auto ${HOURS.length * HOUR_PX}px` }}
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
                  className="amx-cal-chip-ev amx-cal-alldrag"
                  style={{ background: e.color }}
                  title={`${e.title}（可拖入时间格设为定时）`}
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
              const min = Math.max(0, Math.min(24 * 60 - 30, snap15(((e.clientY - rect.top) / HOUR_PX) * 60)))
              onCreate(d, min, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY })
            }}
          >
            {events
              .filter((e) => !e.allDay && sameDay(e.start, d))
              .map((e) => {
                const box = eventBox(e.start, e.end, HOUR_PX)
                return (
                  <button
                    key={e.key}
                    className="amx-cal-event"
                    style={{ top: box.top, height: Math.max(14, box.height), background: e.color }}
                    title={e.title}
                    onPointerDown={(pe) => down(e, pe)}
                    onPointerMove={move}
                    onPointerUp={(pe) => up(e, pe)}
                  >
                    <span className="amx-cal-event-t">{hhmm(e.start)}{e.end ? `–${hhmm(e.end)}` : ''}</span>
                    <span className="amx-cal-event-title">{e.title}</span>
                  </button>
                )
              })}
            {/* 当前时间线(任务2):横跨整个日历所有列(每列一段,相邻拼成一条);圆点只在「今天」列。
             *  pointer-events:none 不挡双击建事件。 */}
            <div className={`amx-cal-nowline${sameDay(d, today) ? ' today' : ''}`} style={{ top: (nowMin / 60) * HOUR_PX }} />
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
  onPick: (key: string, at: Anchor) => void
  onCreate: (day: Date, at: Anchor) => void
  titleRef: RefObject<HTMLSpanElement | null>
}
const MonthScroll = forwardRef<CalApi, MonthProps>(function MonthScroll({ events, onPick, onCreate, titleRef }, ref) {
  const wrap = useRef<HTMLDivElement>(null)
  const [rowH, setRowH] = useState(0)
  const setVisibleRange = useCalendarNav((s) => s.setVisibleRange)
  const today = useMemo(() => startOfDay(new Date()), [])
  const weeks = useMemo(() => {
    const b = addDays(startOfWeek(today), -WEEK_HALF * 7)
    return Array.from({ length: WEEK_HALF * 2 + 1 }, (_, i) => addDays(b, i * 7))
  }, [today])
  const centered = useRef(false)
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
                    onCreate(day, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY })
                  }}
                >
                  <div className="amx-cal-mnum">{day.getDate() === 1 ? `${day.getMonth() + 1}月1` : day.getDate()}</div>
                  {dayEvents.slice(0, 3).map((e) => (
                    <button key={e.key} className="amx-cal-chip-ev" style={{ background: e.color }} title={e.title} onPointerDown={chipDown} onPointerUp={(pe) => chipUp(e, pe)}>
                      {!e.allDay && sameDay(e.start, day) && <span className="amx-cal-chip-t">{hhmm(e.start)}</span>} {e.title}
                    </button>
                  ))}
                  {dayEvents.length > 3 && <div className="amx-cal-more">+{dayEvents.length - 3}</div>}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
})

// ── 旁弹卡片(不覆盖页面,改全部属性)──────────────────────────────────────────
function cardPos(at: Anchor): { left: number; top: number } {
  const W = 320
  let left = at.right + 8
  if (left + W > window.innerWidth) left = Math.max(8, at.left - W - 8)
  const top = Math.max(8, Math.min(at.top, window.innerHeight - 380))
  return { left, top }
}

function EventCard({ ev, at, onClose }: { ev: CalEvent; at: Anchor; onClose: () => void }) {
  const { db, row, colId, title } = ev
  const nameCol = db.columns[0]
  const titleEditable = !(db.isNoteView && nameCol?.type === 'page')
  const others = db.columns.filter((c) => c.id !== nameCol?.id && c.id !== colId)
  const pos = cardPos(at)
  return (
    <div className="amx-cal-cardcatch" onMouseDown={onClose}>
      <div className="amx-cal-card" style={pos} onMouseDown={(e) => e.stopPropagation()}>
        <div className="amx-cal-card-db" style={{ color: ev.color }}>◆ {db.name}</div>
        {titleEditable ? (
          <input className="amx-cal-card-title" value={title} placeholder="未命名" onChange={(e) => setAggName(db, row.rowId, e.target.value)} />
        ) : (
          <div className="amx-cal-card-title">{title || '未命名'}</div>
        )}
        <div className="amx-cal-card-sec">时间</div>
        <CalDateFields value={ev.raw} onChange={(v) => setAggCell(db, row.rowId, colId, v)} />
        {others.length > 0 && (
          <>
            <div className="amx-cal-card-sec">属性</div>
            {others.map((c) => (
              <div key={c.id} className="amx-cal-card-prop">
                <span className="amx-cal-card-key">{c.name}</span>
                <div className="amx-cal-card-ctl"><CardPropField db={db} row={row} col={c} /></div>
              </div>
            ))}
          </>
        )}
        <div className="amx-cal-card-foot">
          <button className="amx-cal-card-del" onClick={() => { deleteAggRow(db, row.rowId); onClose() }}>删除</button>
          <button className="amx-cal-card-close" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

/** 卡片里一个属性的编辑器:自定义类型复用注册表 Cell,primitive 各给紧凑原生编辑器。 */
function CardPropField({ db, row, col }: { db: AggDb; row: AggRow; col: DbColumn }) {
  const custom = getPropertyType(col.type)
  const base = resolveBaseType(col.type)
  const v = coerceForDisplay(row.cells[col.id], base)
  const set = (nv: CellValue | undefined): void => setAggCell(db, row.rowId, col.id, nv)
  if (custom) {
    const Custom = custom.Cell
    return <Custom value={v} onChange={set} />
  }
  switch (base) {
    case 'checkbox':
      return <input type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked ? true : undefined)} />
    case 'number':
      return (
        <input
          className="amx-cal-card-input"
          type="number"
          value={(v as number | null) ?? ''}
          onChange={(e) => (e.target.value === '' ? set(undefined) : Number.isFinite(Number(e.target.value)) && set(Number(e.target.value)))}
        />
      )
    case 'date':
      return <input className="amx-cal-card-input" type="date" value={v as string} onChange={(e) => set(e.target.value || undefined)} />
    case 'select':
      return (
        <select className="amx-cal-card-input" value={v as string} onChange={(e) => set(e.target.value || undefined)}>
          <option value="">—</option>
          {(col.options ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      )
    case 'multiselect': {
      const arr = (v as string[]) ?? []
      return (
        <div className="amx-cal-card-chips">
          {(col.options ?? []).map((o) => {
            const on = arr.includes(o)
            return (
              <button
                key={o}
                className={`amx-cal-card-chip${on ? ' on' : ''}`}
                onClick={() => {
                  const next = on ? arr.filter((x) => x !== o) : [...arr, o]
                  set(next.length ? next : undefined)
                }}
              >
                {o}
              </button>
            )
          })}
          {(col.options ?? []).length === 0 && <span className="amx-cal-card-key">（无选项,请在表格里添加）</span>}
        </div>
      )
    }
    case 'page':
      return <span className="amx-cal-card-val">{cellText(row.cells[col.id]) || '—'}</span>
    default:
      return <input className="amx-cal-card-input" value={v as string} onChange={(e) => set(e.target.value || undefined)} />
  }
}
