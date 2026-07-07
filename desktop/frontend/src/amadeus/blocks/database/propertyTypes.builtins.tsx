/** 内置属性类型:todo(勾选,但仅被 ToDo List View 识别)+ calendarDate(带时刻/起止的日期,被 Calendar View 识别)。
 *  经属性注册表注册(与三方插件同一入口),自我 dogfood 该 API。side-effect import 于 bootstrap,始终在场
 *  (视图依赖它们,故不做成可禁用插件)。 */
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { parseCalDate, fmtCalDate, splitSide } from '@amadeus-shared/db/calDate'
import { registerPropertyType, type PropCellProps } from './propertyTypes'

// ── todo:baseType=checkbox,渲染同勾选框 ──────────────────────────────────────
function TodoCell({ value, onChange }: PropCellProps) {
  return (
    <input
      className="amx-db-checkbox"
      type="checkbox"
      checked={value === true}
      onChange={(e) => onChange(e.target.checked ? true : undefined)}
    />
  )
}

// ── calendarDate:baseType=text,存 `start[/end]`,每侧 = 日期 [+ 可选时间] ────────
/** 日期(必填)+ 时间(可选,留空=全天)+ 可选结束。直接契合「可设时间可不设,不设=全天」。 */
export function CalDateFields({ value, onChange, autoFocus }: { value: string | null; onChange(v: string | undefined): void; autoFocus?: boolean }) {
  const cur = parseCalDate(value ?? '')
  const s = cur ? splitSide(cur.start) : { date: '', time: '' }
  const e = cur?.end ? splitSide(cur.end) : null
  const hasEnd = !!cur?.end

  const build = (sDate: string, sTime: string, eDate: string, eTime: string, withEnd: boolean): void => {
    if (!sDate) return onChange(undefined) // 无日期 = 清空
    const start = sTime ? `${sDate}T${sTime}` : sDate
    if (withEnd && eDate) {
      const end = eTime ? `${eDate}T${eTime}` : eDate
      return onChange(`${start}/${end}`)
    }
    onChange(start)
  }

  return (
    <>
      <label className="amx-cal-row">
        <span>日期</span>
        <input type="date" value={s.date} autoFocus={autoFocus} onChange={(ev) => build(ev.target.value, s.time, e?.date ?? s.date, e?.time ?? '', hasEnd)} />
        <input type="time" className="amx-cal-timein" value={s.time} title="留空 = 全天" onChange={(ev) => build(s.date, ev.target.value, e?.date ?? s.date, e?.time ?? '', hasEnd)} />
      </label>
      {hasEnd && (
        <label className="amx-cal-row">
          <span>结束</span>
          <input type="date" value={e?.date ?? s.date} onChange={(ev) => build(s.date, s.time, ev.target.value, e?.time ?? s.time, true)} />
          <input type="time" className="amx-cal-timein" value={e?.time ?? ''} title="留空 = 全天" onChange={(ev) => build(s.date, s.time, e?.date ?? s.date, ev.target.value, true)} />
        </label>
      )}
      <label className="amx-cal-check">
        <input
          type="checkbox"
          checked={hasEnd}
          onChange={(ev) => {
            if (!cur) return
            if (ev.target.checked) build(s.date, s.time, s.date, s.time, true) // 结束默认 = 开始
            else build(s.date, s.time, '', '', false)
          }}
        />{' '}
        设置结束时间
      </label>
    </>
  )
}

function CalendarDateCell({ value, onChange }: PropCellProps) {
  const raw = typeof value === 'string' ? value : ''
  const cur = parseCalDate(raw)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const open = (e: ReactMouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ x: Math.min(r.left, window.innerWidth - 300), y: Math.min(r.bottom + 4, window.innerHeight - 240) })
  }
  return (
    <>
      <button className="amx-db-cellbtn" onClick={open}>
        {cur ? <span className="amx-cal-chip">{fmtCalDate(cur)}</span> : <span className="amx-db-blank">空</span>}
      </button>
      {pos && (
        <div className="amx-db-popwrap" onMouseDown={() => setPos(null)}>
          <div className="amx-db-pop amx-cal-pop" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
            <CalDateFields value={raw} onChange={onChange} autoFocus />
            {cur && (
              <button className="amx-db-opt amx-db-opt-clear" onClick={() => onChange(undefined)}>清空</button>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** 注册内置类型(bootstrap 期 side-effect import 触发一次)。 */
let done = false
export function registerBuiltinPropertyTypes(): void {
  if (done) return
  done = true
  registerPropertyType({ type: 'todo', label: '待办', icon: '✓', baseType: 'checkbox', Cell: TodoCell })
  registerPropertyType({
    type: 'calendarDate',
    label: '日历日期',
    icon: '🗓',
    baseType: 'text',
    Cell: CalendarDateCell,
    sortValue: (v) => (typeof v === 'string' ? v : ''),
  })
}

registerBuiltinPropertyTypes()
