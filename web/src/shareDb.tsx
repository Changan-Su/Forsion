/** 公开分享页的只读多维表(![[x.db]] 嵌入)。
 *  引擎纯逻辑 resolveDbTable 折算首视图 → 只读 HTML 表格;笔记视图(source=folder,行=实时笔记)
 *  公开侧拿不到行 → 只出列头 + 提示。db 文本经公开 asset 端点按引用名取(服务端只放行本页显式引用的文件)。 */
import React, { useEffect, useState } from 'react'
import { parseDb } from '@amadeus-shared/db/schema'
import { resolveDbTable, cellDisplay } from '@amadeus-shared/db/readonlyView'

export function ShareDbTable({ text, name }: { text: string; name?: string }): React.ReactElement {
  const parsed = parseDb(text)
  if (!parsed.ok) return <div className="shv-db shv-db-err">📊 {name ?? '数据库'} —— {parsed.error}</div>
  const db = parsed.data
  const { columns, rows, noteView } = resolveDbTable(db)
  return (
    <div className="shv-db">
      <div className="shv-db-head">📊 {db.name || name}</div>
      <div className="shv-db-scroll">
        <table className="shv-db-table">
          <thead><tr>{columns.map((c) => <th key={c.id}>{c.name}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {columns.map((c) => {
                  const d = cellDisplay(r.cells[c.id], c.type)
                  return (
                    <td key={c.id}>
                      {d.checked !== undefined
                        ? <span className="shv-db-check">{d.checked ? '☑' : '☐'}</span>
                        : d.chips
                          ? d.chips.map((s, i) => <span key={i} className="shv-db-chip">{s}</span>)
                          : d.text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {noteView
        ? <div className="shv-db-foot">笔记视图 —— 在 Forsion 中查看完整数据</div>
        : rows.length === 0 ? <div className="shv-db-foot">(空表)</div> : null}
    </div>
  )
}

/** 载入并渲染一个 ![[x.db]] 引用(走公开 asset 端点取 .db 文本)。 */
export function ShareDbEmbed({ base, page, dbRef }: { base: string; page: string; dbRef: string }): React.ReactElement {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const stem = dbRef.replace(/\.db$/i, '')
  useEffect(() => {
    let alive = true
    fetch(`${base}/asset?ref=${encodeURIComponent(dbRef)}&page=${encodeURIComponent(page)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (alive) setText(t) })
      .catch(() => { if (alive) setErr('未包含在此分享中') })
    return () => { alive = false }
  }, [base, page, dbRef])
  if (err) return <span className="shv-chip">📊 {stem}({err})</span>
  if (text === null) return <span className="shv-chip">📊 {stem} 载入中…</span>
  return <ShareDbTable text={text} name={stem} />
}
