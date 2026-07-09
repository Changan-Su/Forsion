/** Database 嵌入(![[xxx.db]]):Notion 式可编辑表格,数据存 vault 内独立 .db JSON 文件。
 *  数据经 dbStore 按 ref 共享 → 同一 db 的多处嵌入(同页多块/多标签)实时互通、写穿防抖落盘。
 *  排序仅视图态不写盘(文件 rows 顺序即规范顺序);列类型切换非破坏(coerceForDisplay 宽容显示)。
 *  弹层(选项/列菜单)用 fixed 定位:表格外层是 overflow 滚动层,absolute 会被裁剪。 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  COLUMN_TYPES,
  coerceForDisplay,
  dbId,
  type CellValue,
  type ColumnType,
  type DbColumn,
  type DbFile,
  type DbRow,
} from '@amadeus-shared/db/schema'
import { deriveColumns, fmValueToCell } from '@amadeus-shared/db/pageFrontmatter'
import { allPropertyTypes, getPropertyType, resolveBaseType, usePropertyTypesVersion } from './propertyTypes'
import { linkTarget, resolvePageName } from '@amadeus-shared/links'
import { useDbStore } from '../../store/dbStore'
import { renameDb } from '../../lib/dbFileOps'
import { useNoteViewStore } from '../../store/noteViewStore'
import { usePageStore } from '../../store/pageStore'
import { amadeus } from '../../api'

const TYPE_META: Record<ColumnType, { icon: string; label: string }> = {
  text: { icon: '¶', label: '文本' },
  number: { icon: '#', label: '数字' },
  checkbox: { icon: '☑', label: '勾选' },
  date: { icon: '📅', label: '日期' },
  select: { icon: '◉', label: '单选' },
  multiselect: { icon: '⊞', label: '多选' },
  url: { icon: '🔗', label: '链接' },
  page: { icon: '📄', label: 'Page Name' },
}

/** 列元数据(图标/名):自定义注册类型优先,否则 primitive TYPE_META,再否则回退显示 type 字符串。 */
const colMeta = (type: string): { icon: string; label: string } => {
  const custom = getPropertyType(type)
  if (custom) return { icon: custom.icon, label: custom.label }
  return TYPE_META[type as ColumnType] ?? { icon: '·', label: type }
}

interface Pop {
  kind: 'options' | 'colmenu' | 'folder'
  colId?: string
  rowId?: string
  x: number
  y: number
}

export function DatabaseEmbed({ target, pagePath }: { target: string; pagePath: string }) {
  const entry = useDbStore((s) => s.entries[target])
  useEffect(() => {
    void useDbStore.getState().load(pagePath, target)
  }, [pagePath, target])

  if (!entry || entry.status === 'loading') {
    return <div className="amx-db amx-db-state">读取数据库…</div>
  }
  if (entry.status === 'missing') {
    return (
      <div className="amx-db amx-db-state">
        数据库文件缺失:<code>{target}</code>
        <button className="amx-db-linkbtn" onClick={() => void useDbStore.getState().reload(pagePath, target)}>重试</button>
      </div>
    )
  }
  if (entry.status === 'corrupt' || !entry.data) {
    return (
      <div className="amx-db amx-db-state">
        数据库文件已损坏{entry.message ? `(${entry.message})` : ''},已进入只读保护。
        {entry.path && (
          <button className="amx-db-linkbtn" onClick={() => void amadeus.revealInFileManager(entry.path!)}>
            在文件管理器中显示
          </button>
        )}
        <button className="amx-db-linkbtn" onClick={() => void useDbStore.getState().reload(pagePath, target)}>重试</button>
      </div>
    )
  }
  return <DbTable dbRef={target} db={entry.data} pagePath={pagePath} />
}

function DbTable({ dbRef, db, pagePath }: { dbRef: string; db: DbFile; pagePath: string }) {
  const [sort, setSort] = useState<{ colId: string; dir: 'asc' | 'desc' } | null>(null)
  const [pop, setPop] = useState<Pop | null>(null)
  usePropertyTypesVersion() // 三方插件注册/卸载属性类型 → 列菜单与单元格分发即时刷新

  // 笔记视图(Bases):db.source.folder 存在 → 行 = 该文件夹里的笔记(实时,来自 noteViewStore),
  // 不走 .db rows;列(视图定义)仍存 .db。首列恒为不可删的 Name 身份列(普通表=text,笔记视图=page)。
  const noteFolder = db.source?.folder
  const isNoteView = noteFolder !== undefined
  const nv = (): ReturnType<typeof useNoteViewStore.getState> => useNoteViewStore.getState()
  const nvProps = useNoteViewStore((s) => (isNoteView ? s.folders[noteFolder as string]?.props : undefined))
  useEffect(() => {
    if (isNoteView) void useNoteViewStore.getState().load(noteFolder as string)
  }, [isNoteView, noteFolder])

  const m = (fn: (d: DbFile) => DbFile): void => useDbStore.getState().mutate(dbRef, fn)

  const identityId = db.columns[0]?.id
  const isIdentity = (colId: string): boolean => colId === identityId

  // 行数据源:笔记视图从 store 合成(cell key = 列 id = frontmatter 键;page 列 = 笔记标题)。
  const baseRows: DbRow[] = useMemo(() => {
    if (!isNoteView) return db.rows
    return (nvProps ?? []).map((p) => ({
      id: p.path,
      cells: Object.fromEntries(db.columns.map((c) => [c.id, c.type === 'page' ? p.title : fmValueToCell(p.fm[c.id], resolveBaseType(c.type))])),
    }))
  }, [isNoteView, db.rows, db.columns, nvProps])

  const setCell = (rowId: string, colId: string, v: CellValue | undefined): void => {
    if (isNoteView) {
      const col = db.columns.find((c) => c.id === colId)
      if (col?.type === 'page') {
        // Page Name = 文件名:提交即重命名笔记(不落 frontmatter)。
        if (v != null && String(v).trim()) void nv().renameNote(noteFolder as string, rowId, String(v))
        return
      }
      nv().setProp(noteFolder as string, rowId, colId, v, resolveBaseType(col?.type ?? 'text'))
      return
    }
    m((d) => ({
      ...d,
      rows: d.rows.map((r) => {
        if (r.id !== rowId) return r
        const cells = { ...r.cells }
        if (v === undefined) delete cells[colId]
        else cells[colId] = v
        return { ...r, cells }
      }),
    }))
  }
  const addRow = (): void => {
    if (isNoteView) return void nv().addNote(noteFolder as string)
    m((d) => ({ ...d, rows: [...d.rows, { id: dbId(), cells: {} }] }))
  }
  const delRow = (rowId: string): void => {
    if (isNoteView) {
      if (window.confirm('删除此行会一并删除对应的笔记文件,确定?')) void nv().deleteNote(noteFolder as string, rowId)
      return
    }
    m((d) => ({ ...d, rows: d.rows.filter((r) => r.id !== rowId) }))
  }
  const addCol = (): void =>
    m((d) => {
      // 笔记视图:新列 id = frontmatter 键(取唯一默认键);普通表:随机 id + 显示名。
      if (!isNoteView) return { ...d, columns: [...d.columns, { id: dbId(), name: `列 ${d.columns.length + 1}`, type: 'text' }] }
      const have = new Set(d.columns.map((c) => c.id))
      let id = '属性'
      let i = 1
      while (have.has(id)) id = `属性${++i}`
      return { ...d, columns: [...d.columns, { id, name: id, type: 'text' }] }
    })
  const patchCol = (colId: string, patch: Partial<DbColumn>): void =>
    m((d) => ({ ...d, columns: d.columns.map((c) => (c.id === colId ? { ...c, ...patch } : c)) }))
  // 列改名:笔记视图的属性列 → 跨该文件夹所有笔记重写 frontmatter 键(列 id = 键);其余仅改显示名。
  const renameCol = (col: DbColumn, name: string): void => {
    if (isNoteView && col.type !== 'page' && name !== col.id) {
      if (db.columns.some((c) => c.id === name)) return // 目标键已是某列,避免撞键覆盖 + 重复列 id
      void nv().renameProp(noteFolder as string, col.id, name)
      m((d) => ({ ...d, columns: d.columns.map((c) => (c.id === col.id ? { ...c, id: name, name } : c)) }))
    } else {
      patchCol(col.id, { name })
    }
  }
  const delCol = (colId: string): void => {
    if (isIdentity(colId)) return // 首列(Name)不可删除
    m((d) => ({
      ...d,
      columns: d.columns.filter((c) => c.id !== colId),
      rows: d.rows.map((r) => {
        if (!(colId in r.cells)) return r
        const cells = { ...r.cells }
        delete cells[colId]
        return { ...r, cells }
      }),
    }))
  }
  const createOption = (colId: string, label: string): void =>
    m((d) => ({
      ...d,
      columns: d.columns.map((c) =>
        c.id === colId && !(c.options ?? []).includes(label) ? { ...c, options: [...(c.options ?? []), label] } : c,
      ),
    }))

  // 笔记视图:切换数据来源文件夹 → 并集推导列(导入该文件夹笔记的 frontmatter 键)。
  const setFolder = async (folder: string): Promise<void> => {
    const props = await amadeus.listPageProps(folder)
    m((d) => ({ ...d, source: { folder }, columns: deriveColumns(d.columns, props.map((p) => p.fm)) }))
    void nv().refresh(folder)
    setPop(null)
  }

  const setColSort = (colId: string, dir: 'asc' | 'desc' | null): void =>
    setSort(dir === null ? null : { colId, dir })

  // 仅视图态排序:不动文件里的 rows 顺序。
  const rows = useMemo(() => {
    if (!sort) return baseRows
    const col = db.columns.find((c) => c.id === sort.colId)
    if (!col) return baseRows
    const custom = getPropertyType(col.type)
    const base = resolveBaseType(col.type)
    const key = (r: DbRow): string | number => {
      if (custom?.sortValue) return custom.sortValue(r.cells[col.id] ?? null)
      const v = coerceForDisplay(r.cells[col.id], base)
      if (base === 'number') return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY
      if (base === 'checkbox') return v === true ? 1 : 0
      return Array.isArray(v) ? v.join(', ') : String(v ?? '')
    }
    return [...baseRows].sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      const cmp = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), 'zh')
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [baseRows, db.columns, sort])

  const openPop = (e: ReactMouseEvent, p: Omit<Pop, 'x' | 'y'>): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPop({ ...p, x: Math.min(r.left, window.innerWidth - 250), y: Math.min(r.bottom + 4, window.innerHeight - 260) })
  }

  /** title 提交(blur/Enter)→ 文件名跟随(renameDb:文件+内部name+全库引用+日历配置一起动)。
   *  onChange 仍只走内存防抖;空名/同名 no-op(空名=文件留旧名,title 显示空由 placeholder 兜)。 */
  const commitTitleRename = (): void => {
    const path = useDbStore.getState().entries[dbRef]?.path
    if (!path) return
    const name = db.name.trim().replace(/[\\/]/g, '')
    const curBase = (path.split(/[\\/]/).pop() || path).replace(/\.db$/i, '')
    if (!name || name === curBase) return
    void renameDb(path, name).catch((e: unknown) => window.alert(`重命名失败:${e instanceof Error ? e.message : String(e)}`))
  }

  const gridCols = `28px repeat(${db.columns.length}, minmax(140px, 1fr)) 36px`
  const popCol = pop ? db.columns.find((c) => c.id === pop.colId) : undefined
  const popRow = pop?.rowId ? db.rows.find((r) => r.id === pop.rowId) : undefined

  return (
    <div className="amx-db">
      <div className="amx-db-head">
        <span aria-hidden>{isNoteView ? '🗂' : '𝄜'}</span>
        <input
          className="amx-db-name"
          value={db.name}
          placeholder={isNoteView ? '未命名视图' : '未命名数据库'}
          onChange={(e) => m((d) => ({ ...d, name: e.target.value }))}
          onBlur={commitTitleRename}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
        {isNoteView && (
          <button className="amx-db-linkbtn" onClick={(e) => openPop(e, { kind: 'folder' })} title="选择数据来源文件夹(行 = 该文件夹里的笔记)">
            📁 {noteFolder || '整库'}
          </button>
        )}
        <span className="amx-db-count">{rows.length} 行</span>
      </div>

      {db.columns.length === 0 ? (
        <div className="amx-db-state">
          没有列。
          <button className="amx-db-linkbtn" onClick={addCol}>＋ 添加列</button>
        </div>
      ) : (
        <div className="amx-db-scroll">
          <div className="amx-db-row amx-db-hrow" style={{ gridTemplateColumns: gridCols }}>
            <div />
            {db.columns.map((col) => (
              <div className="amx-db-th" key={col.id}>
                <button className="amx-db-thbtn" onClick={(e) => openPop(e, { kind: 'colmenu', colId: col.id })} title={`${colMeta(col.type).label} · 点击打开列菜单`}>
                  <span className="amx-db-th-icon" aria-hidden>{colMeta(col.type).icon}</span>
                  <span className="amx-db-th-name">{col.name}</span>
                  {sort?.colId === col.id && <span className="amx-db-th-sort">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              </div>
            ))}
            <button className="amx-db-addcol" onClick={addCol} title="添加列">＋</button>
          </div>

          {rows.map((row) => (
            <div className="amx-db-row" key={row.id} style={{ gridTemplateColumns: gridCols }}>
              <button className="amx-db-rowdel" onClick={() => delRow(row.id)} title="删除行" aria-label="delete row">✕</button>
              {db.columns.map((col) => (
                <div className="amx-db-cell" key={col.id}>
                  <Cell row={row} col={col} pagePath={pagePath} setCell={setCell} openOptions={(e) => openPop(e, { kind: 'options', colId: col.id, rowId: row.id })} />
                </div>
              ))}
              <div />
            </div>
          ))}

          <button className="amx-db-addrow" onClick={addRow}>＋ 新行</button>
        </div>
      )}

      {pop && popCol && pop.kind === 'colmenu' && (
        <PopShell x={pop.x} y={pop.y} onClose={() => setPop(null)}>
          <ColMenu
            col={popCol}
            sort={sort?.colId === popCol.id ? sort.dir : null}
            onSort={(dir) => { setColSort(popCol.id, dir); setPop(null) }}
            onRename={(name) => renameCol(popCol, name)}
            onSetType={(type) => patchCol(popCol.id, { type })}
            onDelete={() => { delCol(popCol.id); setPop(null) }}
            locked={isIdentity(popCol.id)}
          />
        </PopShell>
      )}
      {pop && popCol && popRow && pop.kind === 'options' && (
        <PopShell x={pop.x} y={pop.y} onClose={() => setPop(null)}>
          <OptionPopover
            col={popCol}
            value={coerceForDisplay(popRow.cells[popCol.id], resolveBaseType(popCol.type))}
            multi={popCol.type === 'multiselect'}
            onPick={(label) => {
              setCell(popRow.id, popCol.id, label === '' ? undefined : label)
              setPop(null)
            }}
            onToggle={(label) => {
              const cur = coerceForDisplay(popRow.cells[popCol.id], 'multiselect') as string[]
              const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
              setCell(popRow.id, popCol.id, next.length ? next : undefined)
            }}
            onCreate={(label) => {
              createOption(popCol.id, label)
              if (popCol.type === 'multiselect') {
                const cur = coerceForDisplay(popRow.cells[popCol.id], 'multiselect') as string[]
                if (!cur.includes(label)) setCell(popRow.id, popCol.id, [...cur, label])
              } else {
                setCell(popRow.id, popCol.id, label)
                setPop(null)
              }
            }}
          />
        </PopShell>
      )}
      {pop && pop.kind === 'folder' && (
        <PopShell x={pop.x} y={pop.y} onClose={() => setPop(null)}>
          <FolderPopover current={noteFolder ?? ''} onPick={(f) => void setFolder(f)} />
        </PopShell>
      )}
    </div>
  )
}

// ── 单元格(七/八类型) ────────────────────────────────────────────────────────

const CELL_WIKI_RE = /(\[\[[^\]\n]+\]\])/

function Cell({
  row,
  col,
  pagePath,
  setCell,
  openOptions,
}: {
  row: DbRow
  col: DbColumn
  pagePath: string
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
  openOptions: (e: ReactMouseEvent) => void
}) {
  const [editing, setEditing] = useState(false) // text 含 [[ ]] 时的展示/编辑切换 + url 编辑态
  const cancelRef = useRef(false)
  const custom = getPropertyType(col.type)
  const v = coerceForDisplay(row.cells[col.id], resolveBaseType(col.type))

  /** [[目标]] 点击:linkTarget 剥 |别名 与 #锚点(与 Markdown 块同语义);已存在页面优先
   *  (v2.1 这类带点号页名不被误判为附件),未命中且带非 .md 扩展名才当附件系统打开。 */
  const openLink = (raw: string): void => {
    const t = linkTarget(raw)
    const st = usePageStore.getState()
    if (resolvePageName(t, st.pages)) return void st.openWikiLink(t.replace(/\.md$/i, ''))
    if (/\.[a-z0-9]{1,8}$/i.test(t) && !/\.md$/i.test(t)) return void amadeus.openAttachment(pagePath, t)
    st.openWikiLink(t.replace(/\.md$/i, ''))
  }

  // 自定义注册类型:交给注册表的 Cell(value 已按 baseType 折算)。
  if (custom) {
    const Custom = custom.Cell
    return <Custom value={v} onChange={(nv) => setCell(row.id, col.id, nv)} />
  }

  switch (col.type) {
    case 'text': {
      const s = v as string
      // 含 [[链接]] 且非编辑态 → 富文本展示(链接可点);点击其余区域 / ✎ 进入编辑。
      if (!editing && CELL_WIKI_RE.test(s)) {
        return (
          <div className="amx-db-urlcell" onClick={() => setEditing(true)}>
            <span className="amx-db-richtext">
              {s.split(CELL_WIKI_RE).map((seg, i) => {
                const m = /^\[\[([^\]\n]+)\]\]$/.exec(seg)
                if (!m) return <span key={i}>{seg}</span>
                const inner = m[1]
                const label = (inner.split('|')[1] ?? inner.split('|')[0]).trim()
                return (
                  <button key={i} className="amx-db-wikilink" onClick={(e) => { e.stopPropagation(); openLink(inner) }} title={inner}>
                    {label}
                  </button>
                )
              })}
            </span>
            <button className="amx-db-edit" onClick={(e) => { e.stopPropagation(); setEditing(true) }} title="编辑" aria-label="edit cell">✎</button>
          </div>
        )
      }
      return (
        <input
          className="amx-db-input"
          autoFocus={editing || undefined}
          value={s}
          onChange={(e) => setCell(row.id, col.id, e.target.value === '' ? undefined : e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
        />
      )
    }
    case 'number': {
      const n = v as number | null
      return (
        <input
          className="amx-db-input"
          type="number"
          inputMode="decimal"
          value={n ?? ''}
          onChange={(e) => {
            const s = e.target.value
            if (s === '') return setCell(row.id, col.id, undefined)
            const num = Number(s)
            if (Number.isFinite(num)) setCell(row.id, col.id, num)
          }}
        />
      )
    }
    case 'checkbox':
      return (
        <input
          className="amx-db-checkbox"
          type="checkbox"
          checked={v === true}
          onChange={(e) => setCell(row.id, col.id, e.target.checked ? true : undefined)}
        />
      )
    case 'date':
      return (
        <input
          className="amx-db-input"
          type="date"
          value={v as string}
          onChange={(e) => setCell(row.id, col.id, e.target.value === '' ? undefined : e.target.value)}
        />
      )
    case 'select': {
      const s = v as string
      return (
        <button className="amx-db-cellbtn" onClick={openOptions}>
          {s ? <span className="amx-db-chip">{s}</span> : <span className="amx-db-blank">空</span>}
        </button>
      )
    }
    case 'multiselect': {
      const arr = v as string[]
      return (
        <button className="amx-db-cellbtn" onClick={openOptions}>
          {arr.length ? arr.map((t) => <span key={t} className="amx-db-chip">{t}</span>) : <span className="amx-db-blank">空</span>}
        </button>
      )
    }
    case 'url': {
      const s = v as string
      if (editing) {
        const commit = (raw: string): void => {
          setEditing(false)
          if (cancelRef.current) { cancelRef.current = false; return }
          let t = raw.trim()
          // 形如域名(a.b)且无 scheme → 便利补 https://
          if (t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[\w-]+(\.[\w-]+)+/.test(t)) t = `https://${t}`
          setCell(row.id, col.id, t === '' ? undefined : t)
        }
        return (
          <input
            className="amx-db-input"
            autoFocus
            defaultValue={s}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') { cancelRef.current = true; (e.target as HTMLInputElement).blur() }
            }}
          />
        )
      }
      // 只 linkify http(s)(恶意 scheme 双保险:这里不放行 + 主进程 windowOpenHandler 只放 http/https)
      const href = /^https?:\/\//i.test(s) ? s : ''
      return (
        <div className="amx-db-urlcell">
          {href ? (
            <a className="amx-db-url" href={href} target="_blank" rel="noreferrer" title={s}>{s}</a>
          ) : (
            <span className="amx-db-urltext">{s}</span>
          )}
          <button className="amx-db-edit" onClick={() => setEditing(true)} title="编辑链接" aria-label="edit url">✎</button>
        </div>
      )
    }
    case 'page': {
      // 笔记视图身份列:显示 = 笔记名(点开笔记);✎ 进入编辑 → 提交即重命名文件。
      const s = v as string
      if (editing) {
        const commit = (raw: string): void => {
          setEditing(false)
          if (cancelRef.current) { cancelRef.current = false; return }
          const t = raw.trim()
          if (t && t !== s) setCell(row.id, col.id, t)
        }
        return (
          <input
            className="amx-db-input"
            autoFocus
            defaultValue={s}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') { cancelRef.current = true; (e.target as HTMLInputElement).blur() }
            }}
          />
        )
      }
      return (
        <div className="amx-db-urlcell">
          <button className="amx-db-wikilink amx-db-pagename" onClick={() => void usePageStore.getState().loadPage(row.id)} title={`打开 ${s}`}>
            {s || '未命名'}
          </button>
          <button className="amx-db-edit" onClick={() => setEditing(true)} title="重命名笔记" aria-label="rename note">✎</button>
        </div>
      )
    }
    default:
      // 未知类型(无注册项 + 非 primitive):按文本兜底,永不空白/丢数据。
      return (
        <input
          className="amx-db-input"
          value={typeof v === 'string' ? v : v == null ? '' : String(v)}
          onChange={(e) => setCell(row.id, col.id, e.target.value === '' ? undefined : e.target.value)}
        />
      )
  }
}

// ── 弹层(fixed;点外关闭) ────────────────────────────────────────────────────

function PopShell({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  // 关闭前先 blur 聚焦元素:React 同步卸载会赶在浏览器焦点转移前,被卸载的 input 不派发 blur,
  // ColMenu 重命名这类「onBlur 提交」的草稿会静默丢失——手动 blur 让 focusout 在卸载前发出。
  const close = (): void => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    onClose()
  }
  return (
    <div className="amx-db-popwrap" onMouseDown={close}>
      <div className="amx-db-pop" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

/** select / multiselect 共用:共享 column.options 选项池,底部输入回车就地新增。 */
function OptionPopover({
  col,
  value,
  multi,
  onPick,
  onToggle,
  onCreate,
}: {
  col: DbColumn
  value: CellValue
  multi: boolean
  onPick: (label: string) => void
  onToggle: (label: string) => void
  onCreate: (label: string) => void
}) {
  const [draft, setDraft] = useState('')
  const opts = col.options ?? []
  const selected = multi ? (value as string[]) : []
  return (
    <>
      <div className="amx-db-pop-sec">{multi ? '多选(点击切换)' : '选择一项'}</div>
      <div className="amx-db-pop-list">
        {opts.map((o) =>
          multi ? (
            <label key={o} className="amx-db-opt">
              <input type="checkbox" checked={selected.includes(o)} onChange={() => onToggle(o)} />
              <span className="amx-db-chip">{o}</span>
            </label>
          ) : (
            <button key={o} className="amx-db-opt" onClick={() => onPick(o)}>
              <span className="amx-db-chip">{o}</span>
              {value === o && <span className="amx-db-opt-check">✓</span>}
            </button>
          ),
        )}
        {opts.length === 0 && <div className="amx-db-blank">还没有选项,在下面输入并回车创建。</div>}
        {!multi && typeof value === 'string' && value !== '' && (
          <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPick('')}>清空</button>
        )}
      </div>
      <input
        className="amx-db-pop-input"
        autoFocus
        placeholder="回车新增选项…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            onCreate(draft.trim())
            setDraft('')
          }
        }}
      />
    </>
  )
}

function ColMenu({
  col,
  sort,
  onSort,
  onRename,
  onSetType,
  onDelete,
  locked,
}: {
  col: DbColumn
  sort: 'asc' | 'desc' | null
  onSort: (dir: 'asc' | 'desc' | null) => void
  onRename: (name: string) => void
  onSetType: (t: string) => void
  onDelete: () => void
  /** 首列(Name)身份列:锁定类型 + 禁删。 */
  locked: boolean
}) {
  return (
    <>
      <input
        className="amx-db-pop-input"
        autoFocus
        defaultValue={col.name}
        onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== col.name) onRename(n) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      <div className="amx-db-pop-sec">排序(仅视图,不改文件顺序)</div>
      <div className="amx-db-pop-list">
        <button className="amx-db-opt" onClick={() => onSort('asc')}>
          ↑ 升序{sort === 'asc' && <span className="amx-db-opt-check">✓</span>}
        </button>
        <button className="amx-db-opt" onClick={() => onSort('desc')}>
          ↓ 降序{sort === 'desc' && <span className="amx-db-opt-check">✓</span>}
        </button>
        {sort !== null && (
          <button className="amx-db-opt amx-db-opt-clear" onClick={() => onSort(null)}>清除排序</button>
        )}
      </div>
      {locked ? (
        <div className="amx-db-pop-sec">首列(Name)不可删除 · 不可改类型</div>
      ) : (
        <>
          <div className="amx-db-pop-sec">类型</div>
          <div className="amx-db-pop-list">
            {[...COLUMN_TYPES, ...allPropertyTypes().map((p) => p.type)].map((t) => (
              <button key={t} className="amx-db-opt" onClick={() => onSetType(t)}>
                <span className="amx-db-th-icon" aria-hidden>{colMeta(t).icon}</span>
                {colMeta(t).label}
                {col.type === t && <span className="amx-db-opt-check">✓</span>}
              </button>
            ))}
          </div>
          <button className="amx-db-opt amx-db-opt-danger" onClick={onDelete}>删除列</button>
        </>
      )}
    </>
  )
}

/** 笔记视图数据来源文件夹选择:列出全库子文件夹(+ 整库顶层)。切换即并集导入其笔记的属性。 */
function FolderPopover({ current, onPick }: { current: string; onPick: (f: string) => void }) {
  const [folders, setFolders] = useState<string[] | null>(null)
  useEffect(() => {
    void amadeus.listFolders().then((f) => setFolders(['', ...f]))
  }, [])
  return (
    <>
      <div className="amx-db-pop-sec">数据来源文件夹(行 = 其中的笔记)</div>
      <div className="amx-db-pop-list">
        {folders === null && <div className="amx-db-blank">读取中…</div>}
        {folders?.map((f) => (
          <button key={f || '__root'} className="amx-db-opt" onClick={() => onPick(f)}>
            <span aria-hidden>📁</span> {f || '整库(顶层笔记)'}
            {f === current && <span className="amx-db-opt-check">✓</span>}
          </button>
        ))}
      </div>
    </>
  )
}
