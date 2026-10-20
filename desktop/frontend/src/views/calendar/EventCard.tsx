/** 事件/待办 旁弹编辑卡 —— 从 CalendarView 抽出,CalendarView 与 TodoListView 共用。
 *  target.colId = calendarDate 列 id(null = 该表没有日历列,不渲染时间区,todo 表常见)。
 *  透明捕获层点外即关;卡片 fixed 定位在锚点旁,不依赖事件块 DOM。
 *
 *  视觉对标 Notion Calendar 的事件 peek:顶栏(来源库色点 + 关闭)/ 文档标题 /
 *  时间块(时段主行 + 日期星期 + 时长徽章,点击展开原生编辑器)/ 带类型图标的属性行。
 *  ★ 承载面用 app 自己的浮层主题(--bg-card + 描边环,与 .amx-db-pop 同一套 token),
 *    刻意不套 astryx Card/Scope —— 那会把整卡盖成 astryx 中性灰、与 app 暖色主题不搭。
 *  ponytail: 时间仍用原生 date/time 输入编辑(点击展开),未做参考图那种内联时间胶囊编辑器;
 *  select 值显示为中性胶囊,无每选项配色(schema 的 options 是纯字符串,无色)。 */
import { useEffect, useRef, useState, type ReactElement, type RefObject, type SVGProps, type ReactNode, type MouseEvent } from 'react'
import { ExternalLink, MoreHorizontal, ChevronUp } from 'lucide-react'
import { UI_MODE, useNativeChromeClaim } from '@lcl/engine'
import { coerceForDisplay, type CellValue, type DbColumn } from '@amadeus-shared/db/schema'
import { CalDateFields } from '../../amadeus/blocks/database/propertyTypes.builtins'
import { getPropertyType, isStamped, resolveBaseType } from '../../amadeus/blocks/database/propertyTypes'
import { linkLabel, rowLinkIds } from '../../amadeus/blocks/database/rowLink'
import { setAggCell, setAggName, cellText, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'
import { useDbStore } from '../../amadeus/store/dbStore'
import { openDb } from '../../amadeusNav'
import { eventTimeSummary } from './dateUtils'
import { deleteCalendarRow, rescheduleCalendarRow } from './eventActions'
import { registerMessages, useI18n } from '../../i18n'
import {
  PageIcon, DateTimeIcon, TextIcon, NumberIcon,
  SingleSelectIcon, MultiSelectIcon, LinkIcon, CheckBoxCheckLinearIcon,
} from '../../amadeus/components/icons'

// 文案:本文件独占 `evcard.*` 命名空间(日历各文件各持自己的前缀,勿共用键)。
registerMessages({
  'evcard.editEvent': { zh: '编辑事件：{title}', en: 'Edit event: {title}' },
  'evcard.untitled': { zh: '未命名', en: 'Untitled' },
  'evcard.close': { zh: '关闭', en: 'Close' },
  'evcard.name': { zh: '名称', en: 'Name' },
  'evcard.done': { zh: '完成', en: 'Done' },
  'evcard.openNote': { zh: '打开笔记', en: 'Open note' },
  'evcard.openDb': { zh: '打开多维表', en: 'Open database' },
  'evcard.delete': { zh: '删除', en: 'Delete' },
  'evcard.actions': { zh: '事件操作', en: 'Event actions' },
  'evcard.expand': { zh: '展开详情', en: 'Expand details' },
  'evcard.rowlinkReadonly': { zh: '关联表列请在表格里编辑', en: 'Edit related rows in the table' },
  'evcard.noOptions': { zh: '（无选项，请在表格里添加）', en: '(No options — add them in the table)' },
})

export interface Anchor { left: number; top: number; right: number; bottom: number; zoom?: number }

export interface CardTarget {
  db: AggDb
  row: AggRow
  /** calendarDate 列 id;null = 无时间区。 */
  colId: string | null
  /** 真实名称(可为空串,空即显示空 + placeholder,不显示行 id 编码)。 */
  title: string
  /** calendarDate 原始字符串('' = 未设)。 */
  raw: string
  color?: string
}

/** 卡片落点:默认贴锚点右侧,放不下就翻到左侧。maxRight = 右边界(视口像素;缺省窗口右缘)——
 *  日历传主区右缘,卡片翻到事件左边,而不是盖住右栏的待办。 */
export function cardPos(at: Anchor, { w = 360, h = 380, maxRight }: { w?: number; h?: number; maxRight?: number } = {}): { left: number; top: number; width?: number } {
  const zoom = at.zoom || 1
  // 窗口比卡片还窄(Mini 窗 320px):卡片收窄到窗口宽减两侧边距,不越出窗口。
  const W = Math.min(w, window.innerWidth / zoom - 16)
  const H = h
  const margin = 8 * zoom
  let left = at.right + margin
  if (left + W * zoom > (maxRight ?? window.innerWidth)) left = Math.max(margin, at.left - W * zoom - margin)
  const top = Math.max(margin, Math.min(at.top, window.innerHeight - H * zoom - margin))
  // body 使用 CSS zoom 时，fixed 的 left/top 仍是元素自身的 CSS 像素；锚点则来自视口像素。
  return { left: left / zoom, top: top / zoom, ...(W < w ? { width: W } : {}) }
}

/** 属性行的类型图标:自定义类型用注册表已声明的图标,primitive 按 baseType 取。 */
const BASE_ICON: Record<string, (p: SVGProps<SVGSVGElement>) => ReactElement> = {
  text: TextIcon, number: NumberIcon, checkbox: CheckBoxCheckLinearIcon,
  date: DateTimeIcon, select: SingleSelectIcon, multiselect: MultiSelectIcon,
  url: LinkIcon, page: PageIcon,
}
function PropIcon({ col }: { col: DbColumn }) {
  const custom = getPropertyType(col.type)
  if (custom?.icon) return <>{custom.icon}</>
  const Ic = BASE_ICON[resolveBaseType(col.type)] ?? TextIcon
  return <Ic />
}

export function EventCard({ ev, at, onClose, maxRight, calendar = false, onActions, actions, collapsed = false, onExpand, focusTitle = false }: {
  ev: CardTarget; at: Anchor; onClose: () => void; maxRight?: number; calendar?: boolean;
  onActions?: (e: MouseEvent<HTMLButtonElement>) => void; actions?: ReactNode; collapsed?: boolean; onExpand?: () => void; focusTitle?: boolean;
}) {
  const { t } = useI18n()
  const mobile = calendar && (UI_MODE === 'mobile' || !!window.tangu?.mobile)
  const pos = cardPos(at, { maxRight })
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useNativeChromeClaim(mobile ? { mode: 'page', title: ev.db.name, back: t('evcard.close'), onBack: () => {
    const handled = !window.dispatchEvent(new Event('forsion:mobile-back', { cancelable: true }))
    if (!handled) onClose()
  } } : null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => {
      const titleInput = dialogRef.current?.querySelector<HTMLInputElement>('.amx-cal-card-title:not(.amx-cal-card-title-ro)')
      if (!calendar || focusTitle) (titleInput ?? closeRef.current)?.focus()
    })
    const keydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (calendar || e.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
      previous?.focus()
    }
  }, [calendar, focusTitle])

  return (
    <div className={`amx-cal-cardcatch${calendar ? ' calendar' : ''}${mobile ? ' mobile' : ''}`} onMouseDown={calendar ? undefined : onClose}>
      <div
        className={`amx-cal-cardwrap${mobile ? ' amx-cal-drawer' : ''}${collapsed ? ' collapsed' : ''}`}
        ref={dialogRef}
        role="dialog"
        aria-modal={calendar ? false : true}
        aria-label={t('evcard.editEvent', { title: ev.title || t('evcard.untitled') })}
        data-kb-rise={mobile ? 'bar' : undefined}
        style={mobile ? undefined : pos}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {mobile && <button className="amx-cal-drawer-grab" aria-label={t('evcard.expand')} onClick={onExpand} onPointerDown={(e) => { e.currentTarget.dataset.y = String(e.clientY); e.currentTarget.setPointerCapture(e.pointerId) }} onPointerUp={(e) => {
          if (e.clientY - Number(e.currentTarget.dataset.y) > 55) onClose()
          else onExpand?.()
        }}><span /></button>}
        {actions ?? (collapsed ? <div className="amx-cal-drawer-summary">
          <button className="amx-cal-card-x" onClick={onExpand} aria-label={t('evcard.expand')}><ChevronUp size={18} /></button>
          <div><strong>{ev.title || t('evcard.untitled')}</strong><span>{eventTimeSummary(ev.raw)?.head} {eventTimeSummary(ev.raw)?.badge}</span></div>
          <button className="amx-cal-card-x" onClick={onClose} aria-label={t('evcard.close')}>×</button>
        </div> : <EventCardBody ev={ev} onClose={onClose} closeRef={closeRef} onActions={onActions} />)}
      </div>
    </div>
  )
}

function EventCardBody({ ev, onClose, closeRef, onActions }: { ev: CardTarget; onClose: () => void; closeRef?: RefObject<HTMLButtonElement | null>; onActions?: (e: MouseEvent<HTMLButtonElement>) => void }) {
  const { t } = useI18n()
  const { db, row, title } = ev
  const deletable = !db.readonly
  const accent = ev.color ?? 'var(--accent, #6c5ce7)'
  // 只读聚合源可能来自 Agent / ICS / 另一侧 Vault，路径不是活动 Vault 可打开的数据库路径。
  const canOpenSource = !db.readonly || !!db.openRow

  return (
    <div className="amx-cal-cardin">
      {/* 顶栏:来源库(色点)+ 关闭 */}
      <div className="amx-cal-card-top">
        <span className="amx-cal-card-src">
          <span className="amx-cal-card-dot" style={{ background: accent }} />
          {db.name}
        </span>
        <span className="amx-cal-card-buttons">{onActions && <button className="amx-cal-card-x" onClick={onActions} aria-label={t('evcard.actions')}><MoreHorizontal size={18} /></button>}
        <button className="amx-cal-card-x" ref={closeRef} onClick={onClose} aria-label={t('evcard.close')}>×</button></span>
      </div>

      <RecordFields db={db} row={row} colId={ev.colId ?? undefined} title={title} raw={ev.raw} />

      {(canOpenSource || deletable) && (
        <div className="amx-cal-card-foot">
          {canOpenSource && (
            <button className="amx-cal-card-open" onClick={() => { db.openRow ? db.openRow(row.rowId) : openDb(db.path); onClose() }}>
              <ExternalLink size={13} /> {db.openRow ? t('evcard.openNote') : t('evcard.openDb')}
            </button>
          )}
          {deletable && !onActions && (
            <button className="amx-cal-card-del" onClick={() => { deleteCalendarRow(db, row, title); onClose() }}>{t('evcard.delete')}</button>
          )}
        </div>
      )}
    </div>
  )
}

/** 一行记录的字段:标题、时间(`colId` 那一列)、其余属性。事件浮卡与插件的 ctx.ui.mountRecord(recordSurface)共用 ——
 *  外框、关闭、打开 / 删除归调用方。`title` / `raw` 缺省取这一行自己的(浮卡传事件流里算好的那份);`lock` = 一律只读。 */
export function RecordFields({ db, row, colId, title = row.name, raw, lock = false }: {
  db: AggDb; row: AggRow; colId?: string; title?: string; raw?: string; lock?: boolean
}) {
  const { t } = useI18n()
  // 只读源(agent 日程 / ICS / 另一侧 Vault):全字段展示。
  // 可编辑投影(笔记 `@` 标记源)有 writeCell:时间可改(回写那行 markdown)。`readonly` 只管**时间那一行**:可编辑投影把它放开。
  const readonly = lock || (!!db.readonly && !db.writeCell) || isStamped(db.columns.find((c) => c.id === colId)?.type ?? '')
  // 其余一律看严格的 db.readonly —— 投影只支持改时间,标题/属性放开就是「看着能改、改了没反应」。
  const fullyEditable = !lock && !db.readonly
  const nameCol = db.columns[0]
  const titleEditable = fullyEditable && !(db.isNoteView && nameCol?.type === 'page')
  const others = db.columns.filter((c) => c.id !== nameCol?.id && c.id !== colId)
  const timeRaw = raw ?? (colId && typeof row.cells[colId] === 'string' ? (row.cells[colId] as string) : '')
  const summary = colId ? eventTimeSummary(timeRaw) : null
  const [editTime, setEditTime] = useState(false)
  useEffect(() => {
    if (!editTime) return
    const back = (e: Event): void => {
      e.preventDefault(); e.stopImmediatePropagation()
      if (!(e as CustomEvent).detail?.probe) setEditTime(false)
    }
    window.addEventListener('forsion:mobile-back', back, true)
    return () => window.removeEventListener('forsion:mobile-back', back, true)
  }, [editTime])

  return (
    <>
      {/* 标题 */}
      <div className="amx-cal-card-head">
        {titleEditable ? (
          <input
            className="amx-cal-card-title"
            aria-label={t('evcard.name')}
            value={title}
            placeholder={t('evcard.untitled')}
            onChange={(e) => setAggName(db, row.rowId, e.target.value)}
          />
        ) : (
          <div className="amx-cal-card-title amx-cal-card-title-ro">{title || t('evcard.untitled')}</div>
        )}
      </div>

      {/* 时间:摘要主行 +(点击展开)原生编辑器;只读源仅展示 */}
      {colId && (
        <div className="amx-cal-card-row amx-cal-card-timerow">
          <span className="amx-cal-card-ico"><DateTimeIcon /></span>
          <div className="amx-cal-card-timebody">
            {summary && !(editTime && !readonly) && (
              <button
                type="button"
                className="amx-cal-card-timebtn"
                disabled={readonly}
                onClick={() => setEditTime(true)}
              >
                <span className="amx-cal-card-timehead">
                  {summary.head}
                  {summary.badge && <span className="amx-cal-card-badge">{summary.badge}</span>}
                </span>
                {summary.date && <span className="amx-cal-card-timesub">{summary.date}</span>}
              </button>
            )}
            {!readonly && (editTime || !summary) && (
              <div className="amx-cal-card-timeedit">
                <CalDateFields value={timeRaw} onChange={(v) => rescheduleCalendarRow(db, row, colId, timeRaw, v ?? '', title)} autoFocus={editTime} />
                {summary && (
                  <button type="button" className="amx-cal-card-timedone" onClick={() => setEditTime(false)}>{t('evcard.done')}</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 属性 */}
      {others.length > 0 && (
        <div className="amx-cal-card-props">
          {others.map((c) => (
            <div key={c.id} className="amx-cal-card-row amx-cal-card-prop">
              <span className="amx-cal-card-key">
                <span className="amx-cal-card-ico"><PropIcon col={c} /></span>
                <span className="amx-cal-card-keyt">{c.name}</span>
              </span>
              <div className="amx-cal-card-ctl">
                {fullyEditable
                  ? <CardPropField db={db} row={row} col={c} />
                  : <span className="amx-cal-card-val">{cellText(row.cells[c.id]) || '—'}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** 只读展示的嵌入层扩展类型:它们的 baseType 折算成 text,default 分支会渲成可编辑输入框 ——
 *  rowlink 的数组一敲键就被写成 "id1, id2" 字符串(关联不可逆丢失),formula/lookup 是物化值不该落盘,
 *  file 是路径。卡片里一律只读文本;要改去表格里改。 */
const READONLY_EXTRA = new Set(['rowlink', 'lookup', 'formula', 'file'])

/** 卡片里一个属性的编辑器:自定义类型复用注册表 Cell,primitive 各给紧凑原生编辑器。 */
function CardPropField({ db, row, col }: { db: AggDb; row: AggRow; col: DbColumn }) {
  const { t } = useI18n() // hook 无条件调,别放到下面的分支返回之后
  const custom = getPropertyType(col.type)
  const base = resolveBaseType(col.type)
  const v = coerceForDisplay(row.cells[col.id], base)
  const set = (nv: CellValue | undefined): void => setAggCell(db, row.rowId, col.id, nv)
  // 关联表列的目标库(已加载才有;不在这里触发加载 —— 只读展示,读不到就退回 id 串)。hook 无条件调,别放分支里。
  const refDb = useDbStore((s) => (col.type === 'rowlink' && col.refDb ? s.entries[col.refDb]?.data ?? null : null))
  if (custom) {
    const Custom = custom.Cell
    return <Custom value={v} column={col} onChange={set} />
  }
  if (READONLY_EXTRA.has(col.type)) {
    const raw = row.cells[col.id]
    let text = cellText(raw)
    if (col.type === 'rowlink' && refDb) {
      // 芯片文案与表格同源:按列的 titleCol(缺省首列),别在这里再抄一遍 columns[0]
      text = rowLinkIds(raw).map((id) => { const hit = refDb.rows.find((r) => r.id === id); return hit ? linkLabel(refDb, hit, col.titleCol) : '已失联' }).join(', ')
    }
    return <span className="amx-cal-card-val" title={col.type === 'rowlink' ? t('evcard.rowlinkReadonly') : undefined}>{text || '—'}</span>
  }
  switch (base) {
    case 'checkbox':
      return <input aria-label={col.name} className="amx-cal-card-check" type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked ? true : undefined)} />
    case 'number':
      return (
        <input
          className="amx-cal-card-input"
          aria-label={col.name}
          type="number"
          value={(v as number | null) ?? ''}
          onChange={(e) => (e.target.value === '' ? set(undefined) : Number.isFinite(Number(e.target.value)) && set(Number(e.target.value)))}
        />
      )
    case 'date':
      return <input aria-label={col.name} className="amx-cal-card-input" type="date" value={v as string} onChange={(e) => set(e.target.value || undefined)} />
    case 'select':
      return (
        <select aria-label={col.name} className="amx-cal-card-input amx-cal-card-select" value={v as string} onChange={(e) => set(e.target.value || undefined)}>
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
                aria-pressed={on}
                onClick={() => {
                  const next = on ? arr.filter((x) => x !== o) : [...arr, o]
                  set(next.length ? next : undefined)
                }}
              >
                {o}
              </button>
            )
          })}
          {(col.options ?? []).length === 0 && <span className="amx-cal-card-key">{t('evcard.noOptions')}</span>}
        </div>
      )
    }
    case 'page':
      return <span className="amx-cal-card-val">{cellText(row.cells[col.id]) || '—'}</span>
    default:
      return <input aria-label={col.name} className="amx-cal-card-input" value={v as string} onChange={(e) => set(e.target.value || undefined)} />
  }
}
