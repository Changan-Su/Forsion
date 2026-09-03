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
import { linkLabel, rowLinkIds } from '../../amadeus/blocks/database/rowLink'
import { setAggCell, setAggName, cellText, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'
import { useDbStore } from '../../amadeus/store/dbStore'
import { openDb } from '../../amadeusNav'
import { eventTimeSummary } from './dateUtils'
import { deleteCalendarRow } from './eventActions'
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
  'evcard.openDb': { zh: '打开数据库', en: 'Open database' },
  'evcard.delete': { zh: '删除', en: 'Delete' },
  'evcard.rowlinkReadonly': { zh: '关联表列请在表格里编辑', en: 'Edit related rows in the table' },
  'evcard.noOptions': { zh: '（无选项,请在表格里添加）', en: '(No options — add them in the table)' },
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

function cardPos(at: Anchor): { left: number; top: number } {
  const zoom = at.zoom || 1
  const W = 360
  const H = 380
  const margin = 8 * zoom
  let left = at.right + margin
  if (left + W * zoom > window.innerWidth) left = Math.max(margin, at.left - W * zoom - margin)
  const top = Math.max(margin, Math.min(at.top, window.innerHeight - H * zoom - margin))
  // body 使用 CSS zoom 时，fixed 的 left/top 仍是元素自身的 CSS 像素；锚点则来自视口像素。
  return { left: left / zoom, top: top / zoom }
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
  const { t } = useI18n()
  const { db, row, colId, title } = ev
  // 只读源(agent 日程 / ICS / 另一侧 Vault):全字段展示,底部无删除。
  // 可编辑投影(笔记 `@` 标记源)有 writeCell:时间可改(回写那行 markdown),但删除仍关着 ——
  // 「删掉一个日历事件」对一行笔记来说是删整行还是只删 `@`,语义不明,不做。
  // `readonly` 只管**时间那一行**:可编辑投影把它放开。
  const readonly = !!db.readonly && !db.writeCell
  // 其余一律看严格的 db.readonly —— 投影只支持改时间,标题/属性放开就是「看着能改、改了没反应」。
  const deletable = !db.readonly
  const fullyEditable = !db.readonly
  const nameCol = db.columns[0]
  const titleEditable = fullyEditable && !(db.isNoteView && nameCol?.type === 'page')
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
  const canOpenSource = !db.readonly || !!db.openRow

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
        aria-label={t('evcard.editEvent', { title: title || t('evcard.untitled') })}
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
            <button className="amx-cal-card-x" ref={closeRef} onClick={onClose} aria-label={t('evcard.close')}>×</button>
          </div>

          {/* 标题 */}
          <div className="amx-cal-card-head">
            <span className="amx-cal-card-ico amx-cal-card-headico"><PageIcon /></span>
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
                    <CalDateFields value={ev.raw} onChange={(v) => setAggCell(db, row.rowId, colId, v)} autoFocus={editTime} />
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

          {(canOpenSource || deletable) && (
            <div className="amx-cal-card-foot">
              {canOpenSource && (
                <button className="amx-cal-card-open" onClick={() => { db.openRow ? db.openRow(row.rowId) : openDb(db.path); onClose() }}>
                  <ExternalLink size={13} /> {db.openRow ? t('evcard.openNote') : t('evcard.openDb')}
                </button>
              )}
              {deletable && (
                <button className="amx-cal-card-del" onClick={() => { deleteCalendarRow(db, row, title); onClose() }}>{t('evcard.delete')}</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
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
