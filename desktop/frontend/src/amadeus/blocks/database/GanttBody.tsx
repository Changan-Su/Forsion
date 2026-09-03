/**
 * 甘特视图体(view.type='gantt'),只读 v1:左侧行标题 + 右侧时间轴横条(按 calendarDate 起止列),
 * 日/周两档缩放,今日线;无拖拽改期。无日期的行排到底部灰显。
 *
 * 点行标题 / 条 → openRow(RowEditor 那条路,不造第三个分发点)。几何全在 ganttLogic.ts(纯逻辑,有单测),
 * 这里只摆 DOM。dbRowTitle / colMeta / openRow 都是 DatabaseEmbed 的模块私有,经 props 拿到,别反向 import 成环。
 * 样式在 ganttBody.css(别碰 amadeus-host.css)。
 */
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { DbFile, DbRow, DbView } from '@amadeus-shared/db/schema'
import { PX_PER_DAY, ganttLayout, ganttScaleOf, resolveGanttCols, type GanttScale } from './ganttLogic'
import { registerMessages, useI18n } from '../../../i18n'
import './ganttBody.css'

registerMessages({
  'gantt.scaleDay': { zh: '日', en: 'Day' },
  'gantt.scaleWeek': { zh: '周', en: 'Week' },
  'gantt.needDateCol': { zh: '甘特图需要一个日期列(日历日期)。', en: 'The Gantt view needs a date column (calendar date).' },
  'gantt.addDateCol': { zh: '＋ 添加「日期」列', en: '+ Add a "Date" column' },
  'gantt.today': { zh: '今天', en: 'Today' },
  'gantt.colHint': { zh: '甘特所用的起止列(在视图 tab 菜单里换)', en: 'Start and end columns used by the Gantt view (change them in the view tab menu)' },
  'gantt.nameFallback': { zh: '名称', en: 'Name' },
  'gantt.noDate': { zh: '无日期', en: 'No date' },
})

/** ⚠️ 模块级表只存**键**,文案在渲染时 t() —— 写死文案会在模块加载那刻冻住,切语言不更新。 */
const SCALE_LABEL: Record<GanttScale, string> = { day: 'gantt.scaleDay', week: 'gantt.scaleWeek' }
/** 条内写标题的最小宽(px):再窄只留 title 提示,免得 28px 的单日条里挤一个省略号。 */
const BAR_TEXT_MIN = 56

export function GanttBody({ db, rows, view, openRow, rowTitle, addDateCol, patchView, colIcon }: {
  db: DbFile
  /** 已按视图筛选/排序/搜索过的行(DatabaseEmbed 的 rows),这里只把无日期行挪到底部。 */
  rows: DbRow[]
  view: DbView
  openRow: (e: ReactMouseEvent, rowId: string) => void
  rowTitle: (r: DbRow) => string
  /** 引导态:一键补一列 calendarDate。 */
  addDateCol: () => void
  /** 缩放切换落盘到 view.gantt(调用方就是 patchView(view.id, …))。 */
  patchView: (p: Partial<DbView>) => void
  colIcon: (type: string) => ReactNode
}) {
  const { t } = useI18n()
  const cols = resolveGanttCols(db.columns, view)
  const scale = ganttScaleOf(view.gantt?.scale)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lay = cols ? ganttLayout(rows, cols.start, cols.end, scale) : null
  const todayLeft = lay?.todayLeft ?? null
  const scrollToToday = (): void => {
    const el = scrollRef.current
    if (el && todayLeft != null) el.scrollLeft = Math.max(0, todayLeft - el.clientWidth / 3)
  }
  // 首挂 / 换档 / 换起止列 → 今天进视口(轴可能长达数月,不滚的话首屏是最早那条)。
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在这三样变时滚,行变了别把用户拖走
  useEffect(scrollToToday, [scale, cols?.start.id, cols?.end.id])

  if (!cols || !lay) {
    return (
      <div className="amx-db-state">
        {t('gantt.needDateCol')}
        <button className="amx-db-linkbtn" onClick={addDateCol}>{t('gantt.addDateCol')}</button>
      </div>
    )
  }
  const unit = PX_PER_DAY[scale]
  const setScale = (s: GanttScale): void => patchView({ gantt: { ...view.gantt, scale: s } })
  return (
    <div className="amx-db-gantt" data-scale={scale} data-view={view.id}>
      <div className="amx-db-gantt-nav">
        {(['day', 'week'] as const).map((s) => (
          <button key={s} className="amx-db-gantt-scale" data-scale={s} data-on={scale === s || undefined} onClick={() => setScale(s)} aria-pressed={scale === s}>
            {t(SCALE_LABEL[s])}
          </button>
        ))}
        <button className="amx-db-linkbtn" onClick={scrollToToday}>{t('gantt.today')}</button>
        <span className="amx-db-gantt-colhint" title={t('gantt.colHint')}>
          <span className="amx-db-th-icon" aria-hidden>{colIcon(cols.start.type)}</span>
          {cols.start.name}
          {cols.end.id !== cols.start.id && ` → ${cols.end.name}`}
        </span>
      </div>
      <div className="amx-db-gantt-body">
        <div className="amx-db-gantt-labels">
          <div className="amx-db-gantt-lhead">{db.columns[0]?.name ?? t('gantt.nameFallback')}</div>
          {lay.dated.map(({ row }) => (
            <button key={row.id} className="amx-db-gantt-label" data-row={row.id} onClick={(e) => openRow(e, row.id)} title={rowTitle(row)}>
              {rowTitle(row)}
            </button>
          ))}
          {lay.undated.map((row) => (
            <button key={row.id} className="amx-db-gantt-label" data-row={row.id} data-undated onClick={(e) => openRow(e, row.id)} title={rowTitle(row)}>
              {rowTitle(row)}
              <span className="amx-db-gantt-nodate">{t('gantt.noDate')}</span>
            </button>
          ))}
        </div>
        <div className="amx-db-gantt-scroll" ref={scrollRef}>
          <div className="amx-db-gantt-canvas" style={{ width: lay.width, ['--gantt-unit' as string]: `${scale === 'week' ? unit * 7 : unit}px` }}>
            <div className="amx-db-gantt-head">
              {lay.ticks.map((tick) => (
                <div key={tick.date} className="amx-db-gantt-tick" style={{ width: tick.days * unit }} data-major={tick.major || undefined} data-weekend={tick.weekend || undefined} title={tick.date}>
                  {tick.label}
                </div>
              ))}
            </div>
            {lay.dated.map(({ row, span, left, width }) => (
              <div key={row.id} className="amx-db-gantt-row">
                <button
                  className="amx-db-gantt-bar"
                  style={{ left, width }}
                  data-row={row.id}
                  data-start={span.s}
                  data-end={span.e}
                  onClick={(e) => openRow(e, row.id)}
                  title={`${rowTitle(row)} · ${span.s}${span.e !== span.s ? ` → ${span.e}` : ''}`}
                >
                  {width >= BAR_TEXT_MIN ? rowTitle(row) : ''}
                </button>
              </div>
            ))}
            {lay.undated.map((row) => (
              <div key={row.id} className="amx-db-gantt-row" data-undated />
            ))}
            {todayLeft != null && <div className="amx-db-gantt-today" style={{ left: todayLeft }} title={t('gantt.today')} />}
          </div>
        </div>
      </div>
    </div>
  )
}
