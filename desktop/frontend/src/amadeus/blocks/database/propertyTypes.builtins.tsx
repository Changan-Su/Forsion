/** 内置属性类型:todo(勾选,但仅被 ToDo List View 识别)+ calendarDate(带时刻/起止的日期,被 Calendar View 识别)
 *  + relation(关联页面,存 [[链接]])。经属性注册表注册(与三方插件同一入口),自我 dogfood 该 API。
 *  side-effect import 于 bootstrap,始终在场(视图依赖它们,故不做成可禁用插件)。 */
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { parseCalDate, fmtCalDate, splitSide } from '@amadeus-shared/db/calDate'
import { pageKey } from '@amadeus-shared/links'
import { fuzzyScore } from '../../lib/fuzzy'
import { usePageStore } from '../../store/pageStore'
import { CheckBoxCheckSolidIcon, LinkedPageIcon, TodayIcon } from '../../components/icons'
import { registerPropertyType, type PropCellProps } from './propertyTypes'
import { OverlayAt } from '../../lib/clampMenu'

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
  const [pos, setPos] = useState<{ x: number; y: number; anchorTop: number } | null>(null)
  // 交按钮下沿 + 上沿,不预夹(预夹会让 OverlayAt 误判锚点再翻面,codex#2)
  const open = (e: ReactMouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ x: r.left, y: r.bottom + 4, anchorTop: r.top })
  }
  return (
    <>
      <button className="amx-db-cellbtn" onClick={open}>
        {cur ? <span className="amx-cal-chip">{fmtCalDate(cur)}</span> : <span className="amx-db-blank">空</span>}
      </button>
      {pos && (
        <div className="amx-db-popwrap" onMouseDown={() => setPos(null)}>
          <OverlayAt className="amx-db-pop amx-cal-pop" x={pos.x} y={pos.y} anchorTop={pos.anchorTop} onMouseDown={(e) => e.stopPropagation()}>
            <CalDateFields value={raw} onChange={onChange} autoFocus />
            {cur && (
              <button className="amx-db-opt amx-db-opt-clear" onClick={() => onChange(undefined)}>清空</button>
            )}
          </OverlayAt>
        </div>
      )}
    </>
  )
}

// ── relation:baseType=text,存 `[[链接]]`(裸名或 dir/Name|Name);chip 点开笔记,✎ 换关联 ────
const REL_RE = /^\[\[([^\]\n]+)\]\]$/

function RelationCell({ value, onChange }: PropCellProps) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const inner = REL_RE.exec(raw)?.[1] ?? ''
  const label = (inner.split('|')[1] ?? inner.split('|')[0] ?? '').trim()
  const [pos, setPos] = useState<{ x: number; y: number; anchorTop: number } | null>(null)
  const open = (e: ReactMouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ x: r.left, y: r.bottom + 4, anchorTop: r.top })
  }
  return (
    <>
      {label ? (
        <div className="amx-db-urlcell">
          <button
            className="amx-db-wikilink"
            onClick={() => usePageStore.getState().openWikiLink(inner.split('|')[0].trim().replace(/\.md$/i, ''))}
            title={inner}
          >
            {label}
          </button>
          <button className="amx-db-edit" onClick={open} title="更换关联页面" aria-label="pick relation">✎</button>
        </div>
      ) : (
        <button className="amx-db-cellbtn" onClick={open}>
          {raw ? <span className="amx-db-urltext">{raw}</span> : <span className="amx-db-blank">空</span>}
        </button>
      )}
      {pos && (
        <RelationPicker
          x={pos.x}
          y={pos.y}
          anchorTop={pos.anchorTop}
          onClose={() => setPos(null)}
          onPick={(linkInner) => {
            onChange(linkInner ? `[[${linkInner}]]` : undefined)
            setPos(null)
          }}
        />
      )}
    </>
  )
}

/** 页面选择器:模糊搜索全库笔记,「唯一即最短」插入(与 [[ 补全同语义)。
 *  关联列与 text 单元格的 [[ 补全共用这一份 —— 别再复制一套搜索/重名消歧。 */
export function RelationPicker({ x, y, anchorTop, onPick, onClose }: {
  x: number
  y: number
  /** 触发按钮/输入框的上沿:下方放不下时浮层翻到它之上,不盖住源单元格(见 engine/menuAnchor)。 */
  anchorTop?: number
  onPick: (linkInner: string | null) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const pages = usePageStore.getState().pages
  const base = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')
  const dupes = new Map<string, number>()
  for (const p of pages) dupes.set(pageKey(base(p)), (dupes.get(pageKey(base(p))) ?? 0) + 1)
  const results = (q
    ? pages
        .map((p) => {
          const sName = fuzzyScore(q, base(p))
          const s = sName !== null ? sName + 1000 : fuzzyScore(q, p)
          return s === null ? null : { p, s }
        })
        .filter((x): x is { p: string; s: number } => x !== null)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.p)
    : pages
  ).slice(0, 12)
  const linkInner = (p: string): string =>
    (dupes.get(pageKey(base(p))) ?? 0) > 1 ? `${p.replace(/\\/g, '/').replace(/\.md$/i, '')}|${base(p)}` : base(p)
  return (
    <div className="amx-db-popwrap" onMouseDown={onClose}>
      <OverlayAt className="amx-db-pop" x={x} y={y} anchorTop={anchorTop} onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="amx-db-pop-input"
          autoFocus
          placeholder="搜索页面…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'Enter' && results[0]) onPick(linkInner(results[0]))
          }}
        />
        <div className="amx-db-pop-list">
          {results.map((p) => (
            <button key={p} className="amx-db-opt" onClick={() => onPick(linkInner(p))}>
              <span className="amx-db-relname">{base(p)}</span>
              <span className="amx-db-relpath">{p.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/'}</span>
            </button>
          ))}
          {results.length === 0 && <div className="amx-db-blank">无匹配页面</div>}
        </div>
        <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPick(null)}>清空关联</button>
      </OverlayAt>
    </div>
  )
}

/** 注册内置类型(bootstrap 期 side-effect import 触发一次)。 */
let done = false
export function registerBuiltinPropertyTypes(): void {
  if (done) return
  done = true
  registerPropertyType({ type: 'todo', label: '待办', icon: <CheckBoxCheckSolidIcon />, baseType: 'checkbox', Cell: TodoCell })
  registerPropertyType({
    type: 'calendarDate',
    label: '日期', // ponytail: 内部 id 仍 calendarDate(存储/迁移零改),用户只见「日期」= 标准富日期属性
    icon: <TodayIcon />,
    baseType: 'text',
    Cell: CalendarDateCell,
    sortValue: (v) => (typeof v === 'string' ? v : ''),
  })
  registerPropertyType({ type: 'relation', label: '关联', icon: <LinkedPageIcon />, baseType: 'text', Cell: RelationCell })
}

registerBuiltinPropertyTypes()
