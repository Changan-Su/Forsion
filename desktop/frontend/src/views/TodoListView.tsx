/** ToDo List View —— 汇总全库多维表里 todo 属性列的行,按所属多维表分组(可折叠展开),
 *  每行显示 名称 + 待办勾选(写回落表);点名称打开旁弹编辑卡(与 Calendar 共用 EventCard)。 */
import { useMemo, useState } from 'react'
import { useAggregatedDatabases, setAggCell } from '../amadeus/store/dbAggregateStore'
import { EventCard, type Anchor, type CardTarget } from './calendar/EventCard'

export function TodoListView() {
  const dbs = useAggregatedDatabases('todo')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [card, setCard] = useState<{ dbPath: string; rowId: string; at: Anchor } | null>(null)

  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })

  // 编辑目标从最新聚合解析(改名/勾选后卡片仍活);行没了(被删)自动收卡。
  const target = useMemo<CardTarget | null>(() => {
    if (!card) return null
    const db = dbs.find((d) => d.path === card.dbPath)
    const row = db?.rows.find((r) => r.rowId === card.rowId)
    if (!db || !row) return null
    const calCol = db.columns.find((c) => c.type === 'calendarDate')
    const raw = calCol && typeof row.cells[calCol.id] === 'string' ? (row.cells[calCol.id] as string) : ''
    return { db, row, colId: calCol?.id ?? null, title: row.name, raw }
  }, [card, dbs])

  return (
    <div className="amx-todo">
      {dbs.length === 0 && (
        <div className="amx-todo-empty">还没有待办。给某个多维表加一个「待办」属性列即可。</div>
      )}
      {dbs.map((db) => {
        const col = db.columns.find((c) => c.type === 'todo')
        if (!col) return null
        const isCollapsed = collapsed.has(db.path)
        const done = db.rows.filter((r) => r.cells[col.id] === true).length
        return (
          <section className="amx-todo-group" key={db.path}>
            <button className="amx-todo-ghead" onClick={() => toggle(db.path)}>
              <span className="amx-todo-caret">{isCollapsed ? '▸' : '▾'}</span>
              <span className="amx-todo-gname">{db.name}</span>
              <span className="amx-todo-gcount">{done}/{db.rows.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="amx-todo-list">
                {db.rows.map((r) => {
                  const checked = r.cells[col.id] === true
                  return (
                    <li className="amx-todo-item" key={r.rowId}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setAggCell(db, r.rowId, col.id, e.target.checked ? true : undefined)}
                      />
                      <span
                        className={`amx-todo-name${checked ? ' done' : ''}`}
                        title="点击编辑"
                        onClick={(e) => {
                          const rc = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          setCard({ dbPath: db.path, rowId: r.rowId, at: { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom } })
                        }}
                      >
                        {r.name || '未命名'}
                      </span>
                    </li>
                  )
                })}
                {db.rows.length === 0 && <li className="amx-todo-blank">（空）</li>}
              </ul>
            )}
          </section>
        )
      })}
      {target && card && <EventCard ev={target} at={card.at} onClose={() => setCard(null)} />}
    </div>
  )
}
