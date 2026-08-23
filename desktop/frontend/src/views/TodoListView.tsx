/** ToDo List View —— 汇总日历成员库里带「完成/待办勾选列」的行,按所属多维表分组(可折叠展开)。
 *  顶部时间窗(以今天为中心前后对称)按日期列筛选事件;⚙ 设置:隐藏已完成 + 排序。
 *  每行显示 名称 + 勾选(写回落表);点名称打开旁弹编辑卡(与 Calendar 共用 EventCard)。 */
import { useMemo, useState } from 'react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { AstryxScope } from '../theme/astryxBridge'
import { parseCalDate } from '@amadeus-shared/db/calDate'
import type { AggRow } from '../amadeus/store/dbAggregateStore'
import { setAggCell } from '../amadeus/store/dbAggregateStore'
import { useCalendarMembers, type CalMemberDb } from '../amadeus/store/calendarMembers'
import { usePageStore } from '../amadeus/store/pageStore'
import { useTodoPrefs, prefsOf } from '../amadeus/store/todoPrefsStore'
import { centeredRange, windowTotal, type TodoWindow } from './calendar/todoWindow'
import { fmtStamp, startOfDay } from './calendar/dateUtils'
import { EventCard, type Anchor, type CardTarget } from './calendar/EventCard'
import { todoDueMeta } from './calendar/todoMeta'
import { OverlayAt } from '@lcl/engine'

const MODE_LABEL: Record<TodoWindow, string> = { day: '今天', '3day': '3 天', week: '7 天', month: '31 天', custom: '自定义' }
const ALL_MODES: TodoWindow[] = ['day', '3day', 'week', 'month', 'custom']

export function TodoListView() {
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const members = useCalendarMembers()
  const groups = useMemo(() => members.filter((m) => m.checkboxCol), [members])
  const byVault = useTodoPrefs((s) => s.byVault)
  const setPref = useTodoPrefs((s) => s.set)
  const prefs = prefsOf(vault, byVault)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [card, setCard] = useState<{ dbPath: string; rowId: string; at: Anchor } | null>(null)
  const [setPos, setSetPos] = useState<{ x: number; y: number } | null>(null) // ⚙ 设置弹层位置

  const today = useMemo(() => startOfDay(new Date()), [])
  const range = useMemo(() => centeredRange(windowTotal(prefs.win, prefs.customDays), today), [prefs.win, prefs.customDays, today])
  const startStr = fmtStamp(range.start, true)
  const endStr = fmtStamp(range.end, true)

  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })

  // 编辑目标从最新聚合解析(改名/勾选后卡片仍活);行没了(被删)自动收卡。
  const target = useMemo<CardTarget | null>(() => {
    if (!card) return null
    const m = groups.find((g) => g.db.path === card.dbPath)
    const row = m?.db.rows.find((r) => r.rowId === card.rowId)
    if (!m || !row) return null
    const raw = typeof row.cells[m.dateCol] === 'string' ? (row.cells[m.dateCol] as string) : ''
    return { db: m.db, row, colId: m.dateCol, title: row.name, raw }
  }, [card, groups])

  // 每组:时间窗筛选(无日期的待办始终显示)+ 隐藏已完成 + 排序。
  const rowsOf = (m: CalMemberDb): AggRow[] => {
    const checkCol = m.checkboxCol as string
    const done = (r: AggRow): boolean => r.cells[checkCol] === true
    return m.db.rows
      .filter((r) => {
        if (prefs.hideDone && done(r)) return false
        const raw = typeof r.cells[m.dateCol] === 'string' ? (r.cells[m.dateCol] as string) : ''
        if (!raw) return true // 无日期的待办不受时间窗约束,始终显示
        const cd = parseCalDate(raw)
        if (!cd) return true
        const day = cd.start.slice(0, 10)
        return day >= startStr && day <= endStr
      })
      .sort((a, b) => {
        if (prefs.sort === 'date') {
          const rawA = typeof a.cells[m.dateCol] === 'string' ? (a.cells[m.dateCol] as string) : ''
          const rawB = typeof b.cells[m.dateCol] === 'string' ? (b.cells[m.dateCol] as string) : ''
          const timeA = todoDueMeta(rawA, today).sortTime
          const timeB = todoDueMeta(rawB, today).sortTime
          return (timeA === timeB ? 0 : timeA < timeB ? -1 : 1) || a.name.localeCompare(b.name, 'zh')
        }
        if (prefs.sort === 'done-first') return (done(b) ? 1 : 0) - (done(a) ? 1 : 0) || a.name.localeCompare(b.name, 'zh')
        if (prefs.sort === 'undone-first') return (done(a) ? 1 : 0) - (done(b) ? 1 : 0) || a.name.localeCompare(b.name, 'zh')
        return a.name.localeCompare(b.name, 'zh')
      })
  }

  return (
    <AstryxScope>
    <div className="amx-todo">
      {groups.length > 0 && (
        <div className="amx-todo-bar">
          <span className="amx-todo-range-label">范围</span>
          <DropdownMenu button={{ label: prefs.win === 'custom' ? `自定义 ${prefs.customDays} 天` : MODE_LABEL[prefs.win], variant: 'secondary', size: 'sm' }} menuWidth={150}>
            {ALL_MODES.map((w) => (
              <DropdownMenuItem key={w} label={MODE_LABEL[w]} endContent={prefs.win === w ? '✓' : undefined} onClick={() => setPref(vault, { win: w })} />
            ))}
          </DropdownMenu>
          {prefs.win === 'custom' && (
            <input
              className="amx-todo-custom"
              type="number"
              min={1}
              value={prefs.customDays}
              onChange={(e) => setPref(vault, { customDays: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              title="以今天为中心的总天数"
            />
          )}
          <span className="amx-todo-bar-sp" />
          <button className="amx-todo-set" title="待办设置" aria-label="待办设置" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setSetPos({ x: Math.min(r.right - 184, window.innerWidth - 192), y: r.bottom + 4 })
          }}>⚙</button>
        </div>
      )}

      {groups.length === 0 && (
        <div className="amx-todo-empty">还没有待办。给日历里的某个多维表指定一个「完成」勾选列即可。</div>
      )}
      {groups.map((m) => {
        const db = m.db
        const checkCol = m.checkboxCol as string
        const isCollapsed = collapsed.has(db.path)
        const rows = rowsOf(m)
        const done = rows.filter((r) => r.cells[checkCol] === true).length
        return (
          <section className="amx-todo-group" key={db.path}>
            <button className="amx-todo-ghead" onClick={() => toggle(db.path)}>
              <span className="amx-todo-caret">{isCollapsed ? '▸' : '▾'}</span>
              <span className="amx-todo-gname">{db.name}</span>
              <span className="amx-todo-gcount">{done}/{rows.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="amx-todo-list">
                {rows.map((r) => {
                  const checked = r.cells[checkCol] === true
                  const raw = typeof r.cells[m.dateCol] === 'string' ? (r.cells[m.dateCol] as string) : ''
                  const due = todoDueMeta(raw, today)
                  return (
                    <li className="amx-todo-item" key={r.rowId}>
                      <CheckboxInput
                        label={r.name || '未命名'}
                        isLabelHidden
                        size="sm"
                        value={checked}
                        onChange={(next) => setAggCell(db, r.rowId, checkCol, next ? true : undefined)}
                      />
                      <button
                        className="amx-todo-main"
                        title="点击编辑"
                        onClick={(e) => {
                          const rc = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          setCard({ dbPath: db.path, rowId: r.rowId, at: { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom } })
                        }}
                      >
                        <span className={`amx-todo-name${checked ? ' done' : ''}`}>{r.name || '未命名'}</span>
                        <span className={`amx-todo-due ${due.tone}`}>{due.label}</span>
                      </button>
                    </li>
                  )
                })}
                {rows.length === 0 && <li className="amx-todo-blank">（此时间窗内无待办）</li>}
              </ul>
            )}
          </section>
        )
      })}

      {setPos && (
        <div className="amx-db-popwrap" onMouseDown={() => setSetPos(null)}>
          <OverlayAt className="amx-db-pop amx-todo-setpop" x={setPos.x} y={setPos.y} onMouseDown={(e) => e.stopPropagation()}>
            <label className="amx-todo-setrow"><input type="checkbox" checked={prefs.hideDone} onChange={(e) => setPref(vault, { hideDone: e.target.checked })} /> 隐藏已完成</label>
            <div className="amx-db-pop-sec">排序</div>
            {([['date', '按日期'], ['name', '按字母'], ['undone-first', '未完成优先'], ['done-first', '已完成优先']] as const).map(([v, label]) => (
              <label key={v} className="amx-todo-setrow"><input type="radio" name="todo-sort" checked={prefs.sort === v} onChange={() => setPref(vault, { sort: v })} /> {label}</label>
            ))}
          </OverlayAt>
        </div>
      )}
      {target && card && <EventCard ev={target} at={card.at} onClose={() => setCard(null)} />}
    </div>
    </AstryxScope>
  )
}
