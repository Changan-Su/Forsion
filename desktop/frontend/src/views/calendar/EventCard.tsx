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
import { useEffect, useRef, useState, type ReactElement, type SVGProps } from 'react'
import { ExternalLink } from 'lucide-react'
import { coerceForDisplay, type CellValue, type DbColumn } from '@amadeus-shared/db/schema'
import { CalDateFields } from '../../amadeus/blocks/database/propertyTypes.builtins'
import { getPropertyType, resolveBaseType } from '../../amadeus/blocks/database/propertyTypes'
import { setAggCell, setAggName, cellText, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'
import { openDb } from '../../amadeusNav'
import { eventTimeSummary } from './dateUtils'
import { deleteCalendarRow } from './eventActions'
import {
  PageIcon, DateTimeIcon, TextIcon, NumberIcon,
  SingleSelectIcon, MultiSelectIcon, LinkIcon, CheckBoxCheckLinearIcon,
} from '../../amadeus/components/icons'

export interface Anchor { left: number; top: number; right: number; bottom: number }

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

function cardPos(at: Anchor): { left: number; top: number } {
  const W = 360
  let left = at.right + 8
  if (left + W > window.innerWidth) left = Math.max(8, at.left - W - 8)
  const top = Math.max(8, Math.min(at.top, window.innerHeight - 380))
  return { left, top }
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

export function EventCard({ ev, at, onClose }: { ev: CardTarget; at: Anchor; onClose: () => void }) {
  const { db, row, colId, title } = ev
  const readonly = !!db.readonly // 只读源(agent 日程):全字段展示,底部无删除
  const nameCol = db.columns[0]
  const titleEditable = !readonly && !(db.isNoteView && nameCol?.type === 'page')
  const others = db.columns.filter((c) => c.id !== nameCol?.id && c.id !== colId)
  const pos = cardPos(at)
  const summary = colId ? eventTimeSummary(ev.raw) : null
  const [editTime, setEditTime] = useState(false)
  const accent = ev.color ?? 'var(--accent, #6c5ce7)'
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // 只读聚合源可能来自 Agent / ICS / 另一侧 Vault，路径不是活动 Vault 可打开的数据库路径。
  const canOpenSource = !readonly

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => {
      const titleInput = dialogRef.current?.querySelector<HTMLInputElement>('.amx-cal-card-title:not(.amx-cal-card-title-ro)')
      ;(titleInput ?? closeRef.current)?.focus()
    })
    const keydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
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
  }, [])

  return (
    <div className="amx-cal-cardcatch" onMouseDown={onClose}>
      <div
        className="amx-cal-cardwrap"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`编辑事件：${title || '未命名'}`}
        style={pos}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="amx-cal-cardin">
          {/* 顶栏:来源库(色点)+ 关闭 */}
          <div className="amx-cal-card-top">
            <span className="amx-cal-card-src">
              <span className="amx-cal-card-dot" style={{ background: accent }} />
              {db.name}
            </span>
            <button className="amx-cal-card-x" ref={closeRef} onClick={onClose} aria-label="关闭">×</button>
          </div>

          {/* 标题 */}
          <div className="amx-cal-card-head">
            <span className="amx-cal-card-ico amx-cal-card-headico"><PageIcon /></span>
            {titleEditable ? (
              <input
                className="amx-cal-card-title"
                aria-label="名称"
                value={title}
                placeholder="未命名"
                onChange={(e) => setAggName(db, row.rowId, e.target.value)}
              />
            ) : (
              <div className="amx-cal-card-title amx-cal-card-title-ro">{title || '未命名'}</div>
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
                    <CalDateFields value={ev.raw} onChange={(v) => setAggCell(db, row.rowId, colId, v)} autoFocus={editTime} />
                    {summary && (
                      <button type="button" className="amx-cal-card-timedone" onClick={() => setEditTime(false)}>完成</button>
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
                    {readonly
                      ? <span className="amx-cal-card-val">{cellText(row.cells[c.id]) || '—'}</span>
                      : <CardPropField db={db} row={row} col={c} />}
                  </div>
                </div>
              ))}
            </div>
          )}

          {(canOpenSource || !readonly) && (
            <div className="amx-cal-card-foot">
              {canOpenSource && (
                <button className="amx-cal-card-open" onClick={() => { openDb(db.path); onClose() }}>
                  <ExternalLink size={13} /> 打开数据库
                </button>
              )}
              {!readonly && (
                <button className="amx-cal-card-del" onClick={() => { deleteCalendarRow(db, row, title); onClose() }}>删除</button>
              )}
            </div>
          )}
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
          {(col.options ?? []).length === 0 && <span className="amx-cal-card-key">（无选项,请在表格里添加）</span>}
        </div>
      )
    }
    case 'page':
      return <span className="amx-cal-card-val">{cellText(row.cells[col.id]) || '—'}</span>
    default:
      return <input aria-label={col.name} className="amx-cal-card-input" value={v as string} onChange={(e) => set(e.target.value || undefined)} />
  }
}
