/** 事件/待办 旁弹编辑卡 —— 从 CalendarView 抽出,CalendarView 与 TodoListView 共用。
 *  target.colId = calendarDate 列 id(null = 该表没有日历列,不渲染时间区,todo 表常见)。
 *  透明捕获层点外即关;卡片 fixed 定位在锚点旁,不依赖事件块 DOM。
 *
 *  ★ astryx 试点(facebook/astryx,Beta):卡片面子 = astryx Card/TextInput/Button,
 *  LCL token 桥 = defineTheme 的 token 值直接引用 LCL CSS 变量(--accent/--bg/--text…),
 *  明暗由 LCL 变量自身随 data-mode 流动,mode 再镜像给 Theme 管 astryx 内建色。
 *  域内编辑器(CalDateFields/CardPropField)与定位/动画壳保持原样;回滚 = 分支不合并。 */
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'
import { Theme, defineTheme } from '@astryxdesign/core/theme'
import { Card } from '@astryxdesign/core/Card'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useTheme } from '../../stores/themeStore'
import { coerceForDisplay, type CellValue, type DbColumn } from '@amadeus-shared/db/schema'
import { CalDateFields } from '../../amadeus/blocks/database/propertyTypes.builtins'
import { getPropertyType, resolveBaseType } from '../../amadeus/blocks/database/propertyTypes'
import { setAggCell, setAggName, deleteAggRow, cellText, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'

// LCL → astryx token 桥:单值字符串引用 LCL 变量,换肤/明暗零维护跟随。
const lclTheme = defineTheme({
  name: 'forsion-lcl',
  tokens: {
    '--color-accent': 'var(--accent, #6c5ce7)',
    '--color-background-body': 'var(--bg)',
    '--color-background-surface': 'var(--bg-card, var(--bg))',
    '--color-text-primary': 'var(--text)',
    '--color-text-secondary': 'var(--text-muted)',
    '--radius-container': 'var(--radius-md, 12px)',
  },
})

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
  const W = 320
  let left = at.right + 8
  if (left + W > window.innerWidth) left = Math.max(8, at.left - W - 8)
  const top = Math.max(8, Math.min(at.top, window.innerHeight - 380))
  return { left, top }
}

export function EventCard({ ev, at, onClose }: { ev: CardTarget; at: Anchor; onClose: () => void }) {
  const mode = useTheme((s) => s.mode)
  const { db, row, colId, title } = ev
  const nameCol = db.columns[0]
  const titleEditable = !(db.isNoteView && nameCol?.type === 'page')
  const others = db.columns.filter((c) => c.id !== nameCol?.id && c.id !== colId)
  const pos = cardPos(at)
  return (
    <div className="amx-cal-cardcatch" onMouseDown={onClose}>
      <div className="amx-cal-cardwrap" style={pos} onMouseDown={(e) => e.stopPropagation()}>
        <Theme theme={lclTheme} mode={mode}>
          <Card padding={3}>
            <div className="amx-cal-cardin">
              <div className="amx-cal-card-db" style={{ color: ev.color ?? 'var(--accent, #6c5ce7)' }}>◆ {db.name}</div>
              {titleEditable ? (
                <TextInput
                  label="名称"
                  isLabelHidden
                  size="sm"
                  value={title}
                  placeholder="未命名"
                  onChange={(v) => setAggName(db, row.rowId, v)}
                />
              ) : (
                <div className="amx-cal-card-title">{title || '未命名'}</div>
              )}
              {colId && (
                <>
                  <div className="amx-cal-card-sec">时间</div>
                  <CalDateFields value={ev.raw} onChange={(v) => setAggCell(db, row.rowId, colId, v)} />
                </>
              )}
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
                <Button label="删除" variant="destructive" size="sm" onClick={() => { deleteAggRow(db, row.rowId); onClose() }} />
                <Button label="关闭" variant="secondary" size="sm" onClick={onClose} />
              </div>
            </div>
          </Card>
        </Theme>
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
