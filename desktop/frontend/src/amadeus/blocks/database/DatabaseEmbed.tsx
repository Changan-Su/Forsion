/** Database 嵌入(![[xxx.db]]):Notion 式可编辑表格,数据存 vault 内独立 .db JSON 文件。
 *  数据经 dbStore 按 ref 共享 → 同一 db 的多处嵌入(同页多块/多标签)实时互通、写穿防抖落盘。
 *  排序仅视图态不写盘(文件 rows 顺序即规范顺序);列类型切换非破坏(coerceForDisplay 宽容显示)。
 *  弹层(选项/列菜单)用 fixed 定位:表格外层是 overflow 滚动层,absolute 会被裁剪。 */
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  COLUMN_TYPES,
  coerceForDisplay,
  dbId,
  type CellValue,
  type ColumnType,
  type DbColumn,
  type DbFile,
  type DbRow,
  type DbView,
  type DbViewFilter,
  type DbViewType,
} from '@amadeus-shared/db/schema'
import { FILTER_OPS, OP_LABEL, STAT_LABEL, UNARY_OPS, applyFilters, computeStat, statOptionsFor } from '@amadeus-shared/db/viewQuery'
import { fmtCalDate, parseCalDate, splitSide } from '@amadeus-shared/db/calDate'
import { deriveColumns, fmValueToCell } from '@amadeus-shared/db/pageFrontmatter'
import { allPropertyTypes, getPropertyType, resolveBaseType, usePropertyTypesVersion } from './propertyTypes'
import { linkTarget, resolvePageName } from '@amadeus-shared/links'
import { useDbStore } from '../../store/dbStore'
import { renameDb } from '../../lib/dbFileOps'
import { useNoteViewStore } from '../../store/noteViewStore'
import { usePageStore, useScopedPageStore } from '../../store/pageStore'
import { amadeus } from '../../api'
import { Settings2, ExternalLink, Plus } from 'lucide-react'
import { openDb } from '../../../amadeusNav'
import { useCalendarConfig, memberOf } from '../../store/calendarConfigStore'
import { MemberColPicker } from '../../../views/calendar/MemberColPicker'
import { act, actDebounced, shortVal } from '../../../activity/log'
import { OverlayAt } from '../../lib/clampMenu'
import { dropAfter, moveRow } from './rowOrder'
import {
  CheckBoxCheckLinearIcon, DatabaseKanbanViewIcon, DatabaseListViewIcon, DatabaseTableViewIcon,
  DateTimeIcon, FilterIcon, FolderIcon, ImageIcon, LinkIcon, MultiSelectIcon, NumberIcon, PageIcon,
  PlusIcon, SingleSelectIcon, TextIcon, TodayIcon,
} from '../../components/icons'

const TYPE_META: Record<ColumnType, { icon: ReactNode; label: string }> = {
  text: { icon: <TextIcon />, label: '文本' },
  number: { icon: <NumberIcon />, label: '数字' },
  checkbox: { icon: <CheckBoxCheckLinearIcon />, label: '勾选' },
  date: { icon: <DateTimeIcon />, label: '日期' },
  select: { icon: <SingleSelectIcon />, label: '单选' },
  multiselect: { icon: <MultiSelectIcon />, label: '多选' },
  url: { icon: <LinkIcon />, label: '链接' },
  page: { icon: <PageIcon />, label: 'Page Name' },
}

/** 列元数据(图标/名):自定义注册类型优先,否则 primitive TYPE_META,再否则回退显示 type 字符串。 */
const colMeta = (type: string): { icon: ReactNode; label: string } => {
  const custom = getPropertyType(type)
  if (custom) return { icon: custom.icon, label: custom.label }
  return TYPE_META[type as ColumnType] ?? { icon: '·', label: type }
}

// ── 多视图(AFFiNE/Notion 式):views 存 .db;缺 = 单「表格」默认视图(旧文件零迁移) ──
const VIEW_META: Record<DbViewType, { icon: ReactNode; label: string }> = {
  table: { icon: <DatabaseTableViewIcon />, label: '表格' },
  kanban: { icon: <DatabaseKanbanViewIcon />, label: '看板' },
  calendar: { icon: <TodayIcon />, label: '日历' },
  gallery: { icon: <ImageIcon />, label: '画廊' },
}
/** 未知视图类型(前向兼容)回退表格观感的元数据。 */
const viewMeta = (t: string): { icon: ReactNode; label: string } => VIEW_META[t as DbViewType] ?? VIEW_META.table
const DEFAULT_VIEW: DbView = { id: 'v-default', name: '表格', type: 'table' }
const viewsOf = (d: DbFile): DbView[] => (d.views?.length ? d.views : [DEFAULT_VIEW])
/** 日历可用的日期列:primitive/自定义 baseType=date,或内置 calendarDate(baseType=text 需点名)。 */
const isDateish = (c: DbColumn): boolean => resolveBaseType(c.type) === 'date' || c.type === 'calendarDate'

/** chip 色板类:label 简单字符串哈希 → 'amx-chip-c0'..'amx-chip-c9',同名恒同色。
 *  色板是内容色(区分选项)而非主题色,10 色定义在 amadeus-host.css 的 .amx-db 段。 */
const chipClass = (label: string): string => {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0
  return `amx-chip-c${Math.abs(h) % 10}`
}

/** 列宽夹取:太窄列头没法点,太宽失控;与 CSS 弹性列 minmax(140px,1fr) 并存。 */
const clampW = (w: number): number => Math.min(800, Math.max(100, w))

interface Pop {
  kind: 'options' | 'colmenu' | 'folder' | 'viewmenu' | 'addview' | 'row' | 'filters' | 'stat' | 'calendar'
  colId?: string
  rowId?: string
  viewId?: string
  x: number
  y: number
  /** 触发按钮的上沿:弹层在下方放不下时翻到它之上(见 engine/menuAnchor)。 */
  anchorTop?: number
}

export function DatabaseEmbed({ target, pagePath, initialView, onViewChange }: {
  target: string
  pagePath: string
  /** 嵌入语法 `![[db|视图名]]` 里的激活视图名(存笔记 md,每处嵌入各记各的;不落 .db、不参与云同步)。 */
  initialView?: string | null
  /** 用户切视图时回写笔记的嵌入块 md(改成 `![[db|新视图名]]`);null = 回到默认(去掉管道段)。 */
  onViewChange?: (viewName: string | null) => void
}) {
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
  return <DbTable dbRef={target} db={entry.data} pagePath={pagePath} initialView={initialView} onViewChange={onViewChange} />
}

function DbTable({ dbRef, db, pagePath, initialView, onViewChange }: {
  dbRef: string
  db: DbFile
  pagePath: string
  initialView?: string | null
  onViewChange?: (viewName: string | null) => void
}) {
  const [pop, setPop] = useState<Pop | null>(null)
  const [q, setQ] = useState('') // 工具栏搜索:按行标题过滤
  // 拖拽改宽的过程态:pointermove 只写这里驱动 gridTemplateColumns 即时反馈,pointerup 才落进 column。
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({})
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
  const dbPath = useDbStore((s) => s.entries[dbRef]?.path) ?? dbRef // 规范文件路径(= 日历成员键 / openDb 用)
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const calByVault = useCalendarConfig((s) => s.byVault)
  const addMember = useCalendarConfig((s) => s.addMember)

  const identityId = db.columns[0]?.id
  const isIdentity = (colId: string): boolean => colId === identityId

  // 视图:激活项是本嵌入的局部态(同 db 多处嵌入各看各的,切 tab 不写盘);视图定义存 .db。
  // 激活视图初值:从嵌入语法的视图名(initialView)按名字解析;找不到=null(回退首个视图)。
  const [viewId, setViewId] = useState<string | null>(() => viewsOf(db).find((v) => v.name === initialView)?.id ?? null)
  const views = viewsOf(db)
  const view = views.find((v) => v.id === viewId) ?? views[0]
  // 用户显式切/建视图:置激活 + 把视图名回写进笔记的嵌入块 md(持久化,每处嵌入各记各的)。
  const pickView = (v: DbView): void => { setViewId(v.id); onViewChange?.(v.name) }
  const addView = (type: DbViewType): void => {
    const v: DbView = { id: dbId(), name: VIEW_META[type].label, type }
    m((d) => ({ ...d, views: [...viewsOf(d), v] }))
    pickView(v)
    setPop(null)
  }
  const patchView = (id: string, patch: Partial<DbView>): void => {
    m((d) => ({ ...d, views: viewsOf(d).map((v) => (v.id === id ? { ...v, ...patch } : v)) }))
    if (id === viewId && patch.name) onViewChange?.(patch.name) // 改名活动视图 → 同步嵌入引用,免下次重挂失配
  }
  const delView = (id: string): void => {
    m((d) => {
      const rest = viewsOf(d).filter((v) => v.id !== id)
      return { ...d, views: rest.length ? rest : [DEFAULT_VIEW] }
    })
    if (viewId === id) { setViewId(null); onViewChange?.(null) } // 删的是活动视图 → 嵌入回到默认(去管道段)
    setPop(null)
  }
  // 排序自 2.7 起落盘在视图上(不再是切页即丢的临时态)。
  const sort = view.sort ?? null
  /** 列的筛选/统计求值语义:日历日期列(基类 text)按 date 求值,其余走 baseType。 */
  const kindOf = (colId: string): ColumnType | null => {
    const c = db.columns.find((x) => x.id === colId)
    if (!c) return null
    return isDateish(c) ? 'date' : resolveBaseType(c.type)
  }
  /** 本视图可见列:首列(身份列)恒可见。 */
  const visCols = db.columns.filter((c, i) => i === 0 || !(view.hidden ?? []).includes(c.id))

  // 行数据源:笔记视图从 store 合成(cell key = 列 id = frontmatter 键;page 列 = 笔记标题)。
  const baseRows: DbRow[] = useMemo(() => {
    if (!isNoteView) return db.rows
    return (nvProps ?? []).map((p) => ({
      id: p.path,
      cells: Object.fromEntries(db.columns.map((c) => [c.id, c.type === 'page' ? p.title : fmValueToCell(p.fm[c.id], resolveBaseType(c.type))])),
    }))
  }, [isNoteView, db.rows, db.columns, nvProps])

  const setCell = (rowId: string, colId: string, v: CellValue | undefined): void => {
    // 活动日志:行属性变更(通用,任何列类型)——row.edit db+p=列名+v=新值+行标题,同格 10s 防抖取末态。
    // 身份列变更 text=新标题;其余列行名从合成 baseRows 取(笔记视图 db.rows 不是显示行)。
    const actCol = db.columns.find((c) => c.id === colId)
    if (actCol) {
      const idColId = db.columns[0]?.id ?? ''
      const name = colId === idColId ? shortVal(v) : shortVal(baseRows.find((r) => r.id === rowId)?.cells[idColId])
      actDebounced('row.edit', { db: dbRef, p: actCol.name, v: shortVal(v), text: name }, `${dbRef}|${rowId}|${colId}`)
    }
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
  /** 新行,可带初值(看板加卡入组/日历日格加行);笔记视图 = 建笔记后逐键写 frontmatter。 */
  const addRow = (initial?: Record<string, CellValue>): void => {
    // 活动日志:含 todo 列=任务、日期列=日程,其余=普通行(标题此刻必空,由 setCell 的 task.name 补)
    act(db.columns.some((c) => c.type === 'todo') ? 'task.new' : db.columns.some(isDateish) ? 'event.new' : 'row.new', { db: dbRef })
    if (isNoteView) {
      void nv().addNote(noteFolder as string).then((p) => {
        if (!initial) return
        for (const [k, v] of Object.entries(initial)) {
          const col = db.columns.find((c) => c.id === k)
          if (col && col.type !== 'page') nv().setProp(noteFolder as string, p, k, v, resolveBaseType(col.type))
        }
      })
      return
    }
    m((d) => ({ ...d, rows: [...d.rows, { id: dbId(), cells: initial ?? {} }] }))
  }
  /** 拖拽重排:把 dragId 挪到 targetId 之前/之后。顺序就是 db.rows 的数组序,直接落盘。 */
  const reorderRow = (dragId: string, targetId: string, after: boolean): void => {
    m((d) => {
      const rows = moveRow(d.rows, dragId, targetId, after)
      return rows === d.rows ? d : { ...d, rows } // 引用没变 = 没动 → 不产生保存/撤销点
    })
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

  /** 卡片/事件标题 = 首列(身份列)显示值。 */
  const rowTitle = (r: DbRow): string => {
    const c0 = db.columns[0]
    if (!c0) return '未命名'
    const v = coerceForDisplay(r.cells[c0.id], resolveBaseType(c0.type))
    const s = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)
    return s.trim() || '未命名'
  }
  /** 弹层落点 = 按钮下沿(放不下时 OverlayAt 自会翻到 anchorTop=按钮上沿之上)。
   *  ⚠️别在这里按「估算高度」预夹 y:预夹过的 y 会被当成真锚点再翻一次面(codex#2)。 */
  const openRow = (e: ReactMouseEvent, rowId: string): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPop({ kind: 'row', rowId, x: r.left, y: r.bottom + 4, anchorTop: r.top })
  }
  /** 看板/日历引导:一键补齐可分组/可上历的列(笔记视图列 id = frontmatter 键,撞键则不动)。 */
  const addStatusCol = (): void =>
    m((d) => {
      const id = isNoteView ? '状态' : dbId()
      if (isNoteView && d.columns.some((c) => c.id === id)) return d
      return { ...d, columns: [...d.columns, { id, name: '状态', type: 'select', options: ['待办', '进行中', '完成'] }] }
    })
  const addDateCol = (): void =>
    m((d) => {
      const id = isNoteView ? '日期' : dbId()
      if (isNoteView && d.columns.some((c) => c.id === id)) return d
      return { ...d, columns: [...d.columns, { id, name: '日期', type: 'calendarDate' }] }
    })

  // 笔记视图:切换数据来源文件夹 → 并集推导列(导入该文件夹笔记的 frontmatter 键)。
  const setFolder = async (folder: string): Promise<void> => {
    const props = await amadeus.listPageProps(folder)
    m((d) => ({ ...d, source: { folder }, columns: deriveColumns(d.columns, props.map((p) => p.fm)) }))
    void nv().refresh(folder)
    setPop(null)
  }

  const setColSort = (colId: string, dir: 'asc' | 'desc' | null): void =>
    patchView(view.id, { sort: dir === null ? undefined : { colId, dir } })

  // 行管道:每视图筛选 → 每视图排序(都存在视图配置里;不动文件 rows 顺序)。
  // 行拖拽重排。⚠️ 只在「无排序、无筛选/搜索」时开放:呈现出来的 rows 是合成结果,
  // 它的相邻关系和 db.rows 的数组序对不上,拿屏幕上的落点去改数组只会把顺序改乱。
  // 笔记视图的行是文件夹里的笔记,没有数组序可言,一并排除。
  const [drag, setDrag] = useState<{ id: string; overId: string; after: boolean } | null>(null)
  const canReorder = !isNoteView && !sort && !q.trim() && !(view.filters ?? []).length

  const rows = useMemo(() => {
    const af = applyFilters(baseRows, view.filters, kindOf)
    const needle = q.trim().toLowerCase()
    const filtered = needle ? af.filter((r) => rowTitle(r).toLowerCase().includes(needle)) : af
    if (!sort) return filtered
    const col = db.columns.find((c) => c.id === sort.colId)
    if (!col) return filtered
    const custom = getPropertyType(col.type)
    const base = resolveBaseType(col.type)
    const key = (r: DbRow): string | number => {
      if (custom?.sortValue) return custom.sortValue(r.cells[col.id] ?? null)
      const v = coerceForDisplay(r.cells[col.id], base)
      if (base === 'number') return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY
      if (base === 'checkbox') return v === true ? 1 : 0
      return Array.isArray(v) ? v.join(', ') : String(v ?? '')
    }
    return [...filtered].sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      const cmp = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), 'zh')
      return sort.dir === 'asc' ? cmp : -cmp
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kindOf/rowTitle 只依赖 db.columns(已在列)
  }, [baseRows, db.columns, sort, view.filters, q])

  const openPop = (e: ReactMouseEvent, p: Omit<Pop, 'x' | 'y' | 'anchorTop'>): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPop({ ...p, x: r.left, y: r.bottom + 4, anchorTop: r.top })
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

  /** 列宽拖拽:实时改宽即反馈(ponytail:不做 AFFiNE 的全局竖直指示线);pointerup 经与列改名
   *  同一条 mutate 写路径把 width 落进 column(复用 500ms 防抖落盘);双击命中区清除 width 恢复弹性。 */
  const startResize = (e: ReactPointerEvent, col: DbColumn): void => {
    e.preventDefault()
    const grip = e.currentTarget as HTMLElement
    // 起点宽:优先已落盘宽,弹性列量 DOM 实际宽 → 首次拖拽从当前观感起步不跳变。
    const startW = liveWidths[col.id] ?? col.width ?? (grip.parentElement?.getBoundingClientRect().width || 140)
    const startX = e.clientX
    grip.setPointerCapture(e.pointerId)
    grip.setAttribute('data-active', '')
    const onMove = (ev: PointerEvent): void =>
      setLiveWidths((m) => ({ ...m, [col.id]: clampW(startW + ev.clientX - startX) }))
    const onUp = (ev: PointerEvent): void => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      grip.removeAttribute('data-active')
      patchCol(col.id, { width: clampW(startW + ev.clientX - startX) })
      setLiveWidths((m) => {
        const n = { ...m }
        delete n[col.id]
        return n
      })
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
  }

  // 拖过的列固定 px(clamp 100~800),没拖过的保持 minmax 弹性 —— 两者可混排。
  const colW = (c: DbColumn): string => {
    const w = liveWidths[c.id] ?? c.width
    return w === undefined ? 'minmax(140px, 1fr)' : `${clampW(w)}px`
  }
  const gridCols = `28px ${visCols.map(colW).join(' ')} 36px`
  const popCol = pop ? db.columns.find((c) => c.id === pop.colId) : undefined
  // 从合成后的 rows 找(而非 db.rows):笔记视图的行 id = 笔记路径,db.rows 恒空,
  // 旧写法让笔记视图的 select 选项弹层永远开不出来。
  const popRow = pop?.rowId ? rows.find((r) => r.id === pop.rowId) : undefined
  const popView = pop?.viewId ? views.find((v) => v.id === pop.viewId) : undefined

  return (
    <div className="amx-db">
      <div className="amx-db-head">
        <span className="amx-db-headicon" aria-hidden>{isNoteView ? <DatabaseListViewIcon /> : <DatabaseTableViewIcon />}</span>
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
            <FolderIcon /> {noteFolder || '整库'}
          </button>
        )}
        <span className="amx-db-count">{rows.length} 行</span>
      </div>

      <div className="amx-db-viewbar" role="tablist">
        {views.map((v) => (
          <button
            key={v.id}
            className="amx-db-viewtab"
            role="tab"
            aria-selected={v.id === view.id}
            data-active={v.id === view.id || undefined}
            onClick={(e) => { if (v.id === view.id) openPop(e, { kind: 'viewmenu', viewId: v.id }); else pickView(v) }}
            onContextMenu={(e) => { e.preventDefault(); openPop(e, { kind: 'viewmenu', viewId: v.id }) }}
            title={v.id === view.id ? '再次点击配置视图(改名/分组/删除)' : v.name}
          >
            {viewMeta(v.type).icon}
            <span>{v.name}</span>
          </button>
        ))}
        <button className="amx-db-viewadd" onClick={(e) => openPop(e, { kind: 'addview' })} title="添加视图" aria-label="add view">
          <PlusIcon />
        </button>
        <span className="amx-db-viewbar-sp" />
        <button
          className="amx-db-filterbtn"
          data-on={(view.filters?.length ?? 0) > 0 || undefined}
          onClick={(e) => openPop(e, { kind: 'filters' })}
          title="筛选(本视图)"
        >
          <FilterIcon />
          筛选{(view.filters?.length ?? 0) > 0 && ` ${view.filters!.length}`}
        </button>
        <input className="amx-db-search" placeholder="搜索…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索行" />
        <button className="amx-db-iconbtn" onClick={() => openDb(dbPath)} title="在新标签打开为页面" aria-label="open as page"><ExternalLink size={15} /></button>
        <button className="amx-db-iconbtn" onClick={(e) => openPop(e, { kind: 'viewmenu', viewId: view.id })} title="视图设置" aria-label="view settings"><Settings2 size={15} /></button>
        <button className="amx-db-newbtn" onClick={() => addRow()} title="新建"><Plus size={14} /> 新建</button>
      </div>

      {db.columns.length === 0 ? (
        <div className="amx-db-state">
          没有列。
          <button className="amx-db-linkbtn" onClick={addCol}>＋ 添加列</button>
        </div>
      ) : view.type === 'kanban' ? (
        <KanbanBody db={db} rows={rows} view={view} visCols={visCols} setCell={setCell} addRow={addRow} openRow={openRow} rowTitle={rowTitle} addStatusCol={addStatusCol} />
      ) : view.type === 'calendar' ? (
        <CalendarBody db={db} rows={rows} view={view} addRow={addRow} openRow={openRow} rowTitle={rowTitle} addDateCol={addDateCol} />
      ) : view.type === 'gallery' ? (
        <GalleryBody db={db} rows={rows} visCols={visCols} addRow={addRow} openRow={openRow} rowTitle={rowTitle} />
      ) : (
        <div className="amx-db-scroll">
          <div className="amx-db-row amx-db-hrow" style={{ gridTemplateColumns: gridCols }}>
            <div />
            {visCols.map((col) => (
              <div className="amx-db-th" key={col.id}>
                <button className="amx-db-thbtn" onClick={(e) => openPop(e, { kind: 'colmenu', colId: col.id })} title={`${colMeta(col.type).label} · 点击打开列菜单`}>
                  <span className="amx-db-th-icon" aria-hidden>{colMeta(col.type).icon}</span>
                  <span className="amx-db-th-name">{col.name}</span>
                  {sort?.colId === col.id && <span className="amx-db-th-sort">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
                <div
                  className="amx-db-resize"
                  onPointerDown={(e) => startResize(e, col)}
                  onDoubleClick={() => patchCol(col.id, { width: undefined })}
                  title="拖拽调整列宽 · 双击恢复弹性"
                />
              </div>
            ))}
            <button className="amx-db-addcol" onClick={addCol} title="添加列">＋</button>
          </div>

          {rows.map((row) => (
            <div
              className="amx-db-row"
              key={row.id}
              style={{ gridTemplateColumns: gridCols }}
              data-drop={drag?.overId === row.id ? (drag.after ? 'below' : 'above') : undefined}
              onDragOver={canReorder ? (e) => {
                if (!drag) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const after = dropAfter(e.clientY, r)
                if (drag.overId !== row.id || drag.after !== after) setDrag({ ...drag, overId: row.id, after })
              } : undefined}
              onDrop={canReorder ? (e) => {
                e.preventDefault()
                if (drag) reorderRow(drag.id, row.id, drag.after)
                setDrag(null)
              } : undefined}
            >
              {/* 手柄和删除同处**一个**网格单元(首列 28px):行首必须只有一个子元素,
                  否则表头/统计行(各自只放一个占位 div)与数据行的列就错开了。
                  手柄单独 draggable、整行不 draggable —— 整行可拖会让单元格里的文字选不中。 */}
              <div className="amx-db-rowgutter">
                <div
                  className="amx-db-rowdrag"
                  draggable={canReorder}
                  title={canReorder ? '拖拽调整行顺序' : '有排序/筛选/搜索时不能手动调顺序 —— 先清掉'}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.id); setDrag({ id: row.id, overId: row.id, after: false }) }}
                  onDragEnd={() => setDrag(null)}
                >
                  ⠿
                </div>
                <button className="amx-db-rowdel" onClick={() => delRow(row.id)} title="删除行" aria-label="delete row">✕</button>
              </div>
              {visCols.map((col) => (
                <div className="amx-db-cell" key={col.id} data-coltype={resolveBaseType(col.type)}>
                  <Cell row={row} col={col} pagePath={pagePath} setCell={setCell} openOptions={(e) => openPop(e, { kind: 'options', colId: col.id, rowId: row.id })} />
                </div>
              ))}
              <div />
            </div>
          ))}

          <button className="amx-db-addrow" onClick={() => addRow()}>＋ 新行</button>

          <div className="amx-db-row amx-db-statsrow" style={{ gridTemplateColumns: gridCols }}>
            <div />
            {visCols.map((col) => {
              const stat = view.stats?.[col.id]
              const kind = kindOf(col.id) ?? 'text'
              return (
                <button
                  key={col.id}
                  className="amx-db-stat"
                  data-on={stat || undefined}
                  onClick={(e) => openPop(e, { kind: 'stat', colId: col.id })}
                  title="页脚统计(本视图,基于筛选后的行)"
                >
                  {stat ? `${STAT_LABEL[stat] ?? stat} ${computeStat(rows, col.id, kind, stat)}` : '统计'}
                </button>
              )
            })}
            <div />
          </div>
        </div>
      )}

      {pop && popCol && pop.kind === 'colmenu' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
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
        <OptionsPop x={pop.x} y={pop.y} col={popCol} row={popRow} setCell={setCell} createOption={createOption} onClose={() => setPop(null)} />
      )}
      {pop && pop.kind === 'folder' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <FolderPopover current={noteFolder ?? ''} onPick={(f) => void setFolder(f)} />
        </PopShell>
      )}
      {pop && pop.kind === 'viewmenu' && popView && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <ViewMenu
            view={popView}
            columns={db.columns}
            sort={sort ?? undefined}
            onSetSort={(colId, dir) => setColSort(colId, dir)}
            onRename={(name) => patchView(popView.id, { name })}
            onPickGroupBy={(id) => patchView(popView.id, { groupBy: id })}
            onPickDateCol={(id) => patchView(popView.id, { dateCol: id })}
            onToggleHidden={(colId) => {
              const cur = popView.hidden ?? []
              const next = cur.includes(colId) ? cur.filter((x) => x !== colId) : [...cur, colId]
              patchView(popView.id, { hidden: next.length ? next : undefined })
            }}
            onOpenFilters={() => setPop({ kind: 'filters', x: pop.x, y: pop.y })}
            onOpenCalendar={() => setPop({ kind: 'calendar', x: pop.x, y: pop.y })}
            calendarActive={!!memberOf(vault, calByVault, dbPath)}
            onDelete={views.length > 1 ? () => delView(popView.id) : undefined}
          />
        </PopShell>
      )}
      {pop && pop.kind === 'calendar' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <MemberColPicker
            dbName={db.name}
            columns={db.columns}
            initial={memberOf(vault, calByVault, dbPath)}
            onCancel={() => setPop(null)}
            onConfirm={(dateCol, checkboxCol) => { addMember(vault, dbPath, dateCol, checkboxCol); setPop(null) }}
          />
        </PopShell>
      )}
      {pop && pop.kind === 'filters' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <FiltersPop
            view={view}
            columns={db.columns}
            kindOf={kindOf}
            onChange={(filters) => patchView(view.id, { filters: filters.length ? filters : undefined })}
          />
        </PopShell>
      )}
      {pop && popCol && pop.kind === 'stat' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <div className="amx-db-pop-sec">页脚统计 · {popCol.name}</div>
          <div className="amx-db-pop-list">
            <button
              className="amx-db-opt"
              onClick={() => {
                const s = { ...view.stats }
                delete s[popCol.id]
                patchView(view.id, { stats: Object.keys(s).length ? s : undefined })
                setPop(null)
              }}
            >
              无
              {!view.stats?.[popCol.id] && <span className="amx-db-opt-check">✓</span>}
            </button>
            {statOptionsFor(kindOf(popCol.id) ?? 'text').map((s) => (
              <button key={s} className="amx-db-opt" onClick={() => { patchView(view.id, { stats: { ...view.stats, [popCol.id]: s } }); setPop(null) }}>
                {STAT_LABEL[s]}
                {view.stats?.[popCol.id] === s && <span className="amx-db-opt-check">✓</span>}
              </button>
            ))}
          </div>
        </PopShell>
      )}
      {pop && pop.kind === 'addview' && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <div className="amx-db-pop-sec">添加视图</div>
          <div className="amx-db-pop-list">
            {(Object.keys(VIEW_META) as DbViewType[]).map((t) => (
              <button key={t} className="amx-db-opt" onClick={() => addView(t)}>
                <span className="amx-db-th-icon" aria-hidden>{VIEW_META[t].icon}</span>
                {VIEW_META[t].label}
              </button>
            ))}
          </div>
        </PopShell>
      )}
      {pop && pop.kind === 'row' && popRow && (
        <PopShell x={pop.x} y={pop.y} anchorTop={pop.anchorTop} onClose={() => setPop(null)}>
          <RowEditor
            db={db}
            row={popRow}
            pagePath={pagePath}
            setCell={setCell}
            createOption={createOption}
            onDelete={() => { delRow(popRow.id); setPop(null) }}
          />
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
  const ps = useScopedPageStore() // 单元格里点双链要落在自己这半屏
  const cancelRef = useRef(false)
  const custom = getPropertyType(col.type)
  const v = coerceForDisplay(row.cells[col.id], resolveBaseType(col.type))

  /** [[目标]] 点击:linkTarget 剥 |别名 与 #锚点(与 Markdown 块同语义);已存在页面优先
   *  (v2.1 这类带点号页名不被误判为附件),未命中且带非 .md/.db 扩展名才当附件系统打开
   *  (.db 落给 openWikiLink 的文件分支 → 应用内 db tab,不再被系统程序打开原始 JSON)。 */
  const openLink = (raw: string): void => {
    const t = linkTarget(raw)
    const st = ps.getState()
    if (resolvePageName(t, st.pages, pagePath)) return void st.openWikiLink(t.replace(/\.md$/i, ''), pagePath)
    if (/\.[a-z0-9]{1,8}$/i.test(t) && !/\.(md|db)$/i.test(t)) return void amadeus.openAttachment(pagePath, t)
    st.openWikiLink(t.replace(/\.md$/i, ''), pagePath) // 未解析 → 询问创建(源 = 本 .db 所在处)
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
          {s ? <span className={`amx-db-chip ${chipClass(s)}`}>{s}</span> : <span className="amx-db-blank">空</span>}
        </button>
      )
    }
    case 'multiselect': {
      const arr = v as string[]
      return (
        <button className="amx-db-cellbtn" onClick={openOptions}>
          {arr.length ? arr.map((t) => <span key={t} className={`amx-db-chip ${chipClass(t)}`}>{t}</span>) : <span className="amx-db-blank">空</span>}
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
          <button className="amx-db-wikilink amx-db-pagename" onClick={() => void ps.getState().loadPage(row.id)} title={`打开 ${s}`}>
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

function PopShell({ x, y, anchorTop, onClose, children }: { x: number; y: number; anchorTop?: number; onClose: () => void; children: ReactNode }) {
  // 关闭前先 blur 聚焦元素:React 同步卸载会赶在浏览器焦点转移前,被卸载的 input 不派发 blur,
  // ColMenu 重命名这类「onBlur 提交」的草稿会静默丢失——手动 blur 让 focusout 在卸载前发出。
  const close = (): void => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    onClose()
  }
  return (
    <div className="amx-db-popwrap" onMouseDown={close}>
      <OverlayAt className="amx-db-pop" x={x} y={y} anchorTop={anchorTop} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </OverlayAt>
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
              <span className={`amx-db-chip ${chipClass(o)}`}>{o}</span>
            </label>
          ) : (
            <button key={o} className="amx-db-opt" onClick={() => onPick(o)}>
              <span className={`amx-db-chip ${chipClass(o)}`}>{o}</span>
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
            {/* 撤下 primitive date 与 todo:日期统一走富类型 calendarDate(标签「日期」),完成标记用普通 checkbox */}
            {[...COLUMN_TYPES, ...allPropertyTypes().map((p) => p.type)].filter((t) => t !== 'date' && t !== 'todo').map((t) => (
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
            <span className="amx-db-th-icon" aria-hidden><FolderIcon /></span> {f || '整库(顶层笔记)'}
            {f === current && <span className="amx-db-opt-check">✓</span>}
          </button>
        ))}
      </div>
    </>
  )
}

// ── 多视图:选项弹层复用 / 视图菜单 / 行编辑器 / 卡片 / 看板 / 日历 / 画廊 ─────────────

/** select/multiselect 选项弹层连同取值/切换/新增语义:表格单元格与行编辑器两处共用。 */
function OptionsPop({ x, y, col, row, setCell, createOption, onClose }: {
  x: number
  y: number
  col: DbColumn
  row: DbRow
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
  createOption: (colId: string, label: string) => void
  onClose: () => void
}) {
  const multi = col.type === 'multiselect'
  return (
    <PopShell x={x} y={y} onClose={onClose}>
      <OptionPopover
        col={col}
        value={coerceForDisplay(row.cells[col.id], resolveBaseType(col.type))}
        multi={multi}
        onPick={(label) => {
          setCell(row.id, col.id, label === '' ? undefined : label)
          onClose()
        }}
        onToggle={(label) => {
          const cur = coerceForDisplay(row.cells[col.id], 'multiselect') as string[]
          const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
          setCell(row.id, col.id, next.length ? next : undefined)
        }}
        onCreate={(label) => {
          createOption(col.id, label)
          if (multi) {
            const cur = coerceForDisplay(row.cells[col.id], 'multiselect') as string[]
            if (!cur.includes(label)) setCell(row.id, col.id, [...cur, label])
          } else {
            setCell(row.id, col.id, label)
            onClose()
          }
        }}
      />
    </PopShell>
  )
}

/** 视图 tab 菜单:改名 + 按类型的配置(看板分组列/日历日期列)+ 列显隐 + 删除(最后一个不可删)。 */
function ViewMenu({ view, columns, sort, onSetSort, onRename, onPickGroupBy, onPickDateCol, onToggleHidden, onOpenFilters, onOpenCalendar, calendarActive, onDelete }: {
  view: DbView
  columns: DbColumn[]
  sort?: { colId: string; dir: 'asc' | 'desc' }
  onSetSort: (colId: string, dir: 'asc' | 'desc' | null) => void
  onRename: (name: string) => void
  onPickGroupBy: (colId: string) => void
  onPickDateCol: (colId: string) => void
  onToggleHidden: (colId: string) => void
  onOpenFilters: () => void
  onOpenCalendar: () => void
  calendarActive: boolean
  onDelete?: () => void
}) {
  const selectCols = columns.filter((c) => resolveBaseType(c.type) === 'select')
  const dateCols = columns.filter(isDateish)
  // 有效选中 = 视图记的列仍存在则用之,否则回落首个可用列(与视图体的解析一致)。
  const effective = (want: string | undefined, cands: DbColumn[]): string | undefined =>
    want && cands.some((c) => c.id === want) ? want : cands[0]?.id
  const pickList = (cands: DbColumn[], picked: string | undefined, onPick: (id: string) => void, empty: string): ReactNode => (
    <div className="amx-db-pop-list">
      {cands.map((c) => (
        <button key={c.id} className="amx-db-opt" onClick={() => onPick(c.id)}>
          <span className="amx-db-th-icon" aria-hidden>{colMeta(c.type).icon}</span>
          {c.name}
          {picked === c.id && <span className="amx-db-opt-check">✓</span>}
        </button>
      ))}
      {cands.length === 0 && <div className="amx-db-blank">{empty}</div>}
    </div>
  )
  return (
    <>
      <input
        className="amx-db-pop-input"
        autoFocus
        defaultValue={view.name}
        onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== view.name) onRename(n) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      {view.type === 'kanban' && (
        <>
          <div className="amx-db-pop-sec">分组列(单选)</div>
          {pickList(selectCols, effective(view.groupBy, selectCols), onPickGroupBy, '还没有单选列')}
        </>
      )}
      {view.type === 'calendar' && (
        <>
          <div className="amx-db-pop-sec">日期列</div>
          {pickList(dateCols, effective(view.dateCol, dateCols), onPickDateCol, '还没有日期列')}
        </>
      )}
      {columns.length > 1 && (
        <>
          <div className="amx-db-pop-sec">列显示(本视图)</div>
          <div className="amx-db-pop-list">
            {columns.slice(1).map((c) => {
              const hidden = (view.hidden ?? []).includes(c.id)
              return (
                <button key={c.id} className="amx-db-opt" onClick={() => onToggleHidden(c.id)} data-dim={hidden || undefined}>
                  <span className="amx-db-th-icon" aria-hidden>{colMeta(c.type).icon}</span>
                  {c.name}
                  {!hidden && <span className="amx-db-opt-check">✓</span>}
                </button>
              )
            })}
          </div>
        </>
      )}
      <div className="amx-db-pop-sec">排序(本视图)</div>
      <div className="amx-db-pop-list">
        {columns.map((c) => {
          const on = sort?.colId === c.id
          return (
            <button key={c.id} className="amx-db-opt" data-dim={!on || undefined} onClick={() => onSetSort(c.id, on && sort!.dir === 'asc' ? 'desc' : 'asc')}>
              <span className="amx-db-th-icon" aria-hidden>{colMeta(c.type).icon}</span>
              {c.name}
              {on && <span className="amx-db-opt-check">{sort!.dir === 'asc' ? '↑' : '↓'}</span>}
            </button>
          )
        })}
        {sort && <button className="amx-db-opt amx-db-opt-clear" onClick={() => onSetSort(sort.colId, null)}>清除排序</button>}
      </div>
      <button className="amx-db-opt" onClick={onOpenFilters}>筛选…{(view.filters?.length ?? 0) > 0 && <span className="amx-db-opt-check">{view.filters!.length}</span>}</button>
      <button className="amx-db-opt" onClick={onOpenCalendar}>{calendarActive ? 'Calendar 设置' : '＋ 添加到 Calendar Space'}</button>
      {onDelete ? (
        <button className="amx-db-opt amx-db-opt-danger" onClick={onDelete}>删除视图</button>
      ) : (
        <div className="amx-db-pop-sec">最后一个视图不可删除</div>
      )}
    </>
  )
}

/** 每视图筛选编辑:扁平 AND 条件列表(列 / op / 值),原生 select 走天下。 */
function FiltersPop({ view, columns, kindOf, onChange }: {
  view: DbView
  columns: DbColumn[]
  kindOf: (colId: string) => ColumnType | null
  onChange: (filters: DbViewFilter[]) => void
}) {
  const filters = view.filters ?? []
  const patch = (i: number, p: Partial<DbViewFilter>): void =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...p } : f)))
  const opsFor = (colId: string): string[] => FILTER_OPS[kindOf(colId) ?? 'text']
  return (
    <>
      <div className="amx-db-pop-sec">筛选(全部满足;本视图)</div>
      {filters.map((f, i) => {
        const kind = kindOf(f.colId) ?? 'text'
        const col = columns.find((c) => c.id === f.colId)
        const unary = UNARY_OPS.has(f.op)
        return (
          <div key={i} className="amx-db-fltrow">
            <select
              className="amx-db-fltsel"
              value={f.colId}
              onChange={(e) => {
                const colId = e.target.value
                onChange(filters.map((x, j) => (j === i ? { colId, op: opsFor(colId)[0], value: undefined } : x)))
              }}
            >
              {columns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              {!col && <option value={f.colId}>({f.colId})</option>}
            </select>
            <select className="amx-db-fltsel" value={f.op} onChange={(e) => patch(i, { op: e.target.value, ...(UNARY_OPS.has(e.target.value) ? { value: undefined } : null) })}>
              {opsFor(f.colId).map((op) => (
                <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>
              ))}
              {!opsFor(f.colId).includes(f.op) && <option value={f.op}>{OP_LABEL[f.op] ?? f.op}</option>}
            </select>
            {!unary && kind === 'select' && (
              <select className="amx-db-fltsel" value={String(f.value ?? '')} onChange={(e) => patch(i, { value: e.target.value })}>
                <option value="">…</option>
                {(col?.options ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            )}
            {!unary && kind === 'multiselect' && (
              <select className="amx-db-fltsel" value={String(f.value ?? '')} onChange={(e) => patch(i, { value: e.target.value })}>
                <option value="">…</option>
                {(col?.options ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            )}
            {!unary && kind === 'date' && (
              <input className="amx-db-fltin" type="date" value={String(f.value ?? '')} onChange={(e) => patch(i, { value: e.target.value || undefined })} />
            )}
            {!unary && kind === 'number' && (
              <input className="amx-db-fltin" type="number" value={f.value == null ? '' : String(f.value)} onChange={(e) => patch(i, { value: e.target.value === '' ? undefined : Number(e.target.value) })} />
            )}
            {!unary && kind !== 'select' && kind !== 'multiselect' && kind !== 'date' && kind !== 'number' && (
              <input className="amx-db-fltin" value={String(f.value ?? '')} placeholder="值…" onChange={(e) => patch(i, { value: e.target.value || undefined })} />
            )}
            <button className="amx-db-fltdel" onClick={() => onChange(filters.filter((_, j) => j !== i))} title="移除条件" aria-label="remove filter">✕</button>
          </div>
        )
      })}
      {filters.length === 0 && <div className="amx-db-blank">还没有条件。</div>}
      <button
        className="amx-db-opt"
        onClick={() => {
          const c = columns[0]
          if (c) onChange([...filters, { colId: c.id, op: opsFor(c.id)[0] }])
        }}
      >
        ＋ 添加条件
      </button>
      {filters.length > 0 && (
        <button className="amx-db-opt amx-db-opt-clear" onClick={() => onChange([])}>清除全部</button>
      )}
    </>
  )
}

/** 行详情编辑:全列纵排,复用表格同款 Cell(看板/日历/画廊点卡即编辑);select 选项开嵌套弹层。 */
function RowEditor({ db, row, pagePath, setCell, createOption, onDelete }: {
  db: DbFile
  row: DbRow
  pagePath: string
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
  createOption: (colId: string, label: string) => void
  onDelete: () => void
}) {
  const [opt, setOpt] = useState<{ colId: string; x: number; y: number } | null>(null)
  const optCol = opt ? db.columns.find((c) => c.id === opt.colId) : undefined
  return (
    <div className="amx-db-roweditor">
      {db.columns.map((col) => (
        <div key={col.id} className="amx-db-rowed-field" data-coltype={resolveBaseType(col.type)}>
          <span className="amx-db-rowed-label">
            <span className="amx-db-th-icon" aria-hidden>{colMeta(col.type).icon}</span>
            {col.name}
          </span>
          <div className="amx-db-rowed-cell">
            <Cell
              row={row}
              col={col}
              pagePath={pagePath}
              setCell={setCell}
              openOptions={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setOpt({ colId: col.id, x: Math.min(r.left, window.innerWidth - 250), y: Math.min(r.bottom + 4, window.innerHeight - 260) })
              }}
            />
          </div>
        </div>
      ))}
      <button className="amx-db-opt amx-db-opt-danger" onClick={onDelete}>删除行</button>
      {opt && optCol && (
        <OptionsPop x={opt.x} y={opt.y} col={optCol} row={row} setCell={setCell} createOption={createOption} onClose={() => setOpt(null)} />
      )}
    </div>
  )
}

/** 卡片上的只读属性预览:空值不占行;select/多选 → chips,勾选 → 只在为真时点名列名,
 *  calendarDate → 人类可读,其余 → 文本。 */
function cellPreview(col: DbColumn, v: CellValue | undefined): ReactNode | null {
  const base = resolveBaseType(col.type)
  const d = coerceForDisplay(v, base)
  if (base === 'checkbox') return d === true ? <span className="amx-db-card-check">✓ {col.name}</span> : null
  if (base === 'select') return d ? <span className={`amx-db-chip ${chipClass(d as string)}`}>{d as string}</span> : null
  if (base === 'multiselect') {
    const arr = d as string[]
    return arr.length ? <>{arr.map((t) => <span key={t} className={`amx-db-chip ${chipClass(t)}`}>{t}</span>)}</> : null
  }
  let s = Array.isArray(d) ? d.join(', ') : d == null ? '' : String(d)
  if (col.type === 'calendarDate') s = fmtCalDate(parseCalDate(s)) || s
  return s ? <span className="amx-db-card-text">{s}</span> : null
}

/** 看板/画廊共用卡片:标题 + 前几个非空属性预览。 */
function RowCard({ db, row, title, onClick, cols, skipColId, max = 3, draggable, onDragStart }: {
  db: DbFile
  row: DbRow
  title: string
  onClick: (e: ReactMouseEvent) => void
  /** 预览用的列集(视图可见列);缺 = 全列。首列(标题)恒跳过。 */
  cols?: DbColumn[]
  /** 不预览的列(看板分组列,泳道本身已表达)。 */
  skipColId?: string
  max?: number
  draggable?: boolean
  onDragStart?: (e: ReactDragEvent) => void
}) {
  const previews: ReactNode[] = []
  for (const col of (cols ?? db.columns).slice(1)) {
    if (previews.length >= max) break
    if (col.id === skipColId) continue
    const node = cellPreview(col, row.cells[col.id])
    if (node) previews.push(<div className="amx-db-card-prop" key={col.id}>{node}</div>)
  }
  return (
    <div className="amx-db-card" role="button" tabIndex={0} draggable={draggable} onDragStart={onDragStart} onClick={onClick}>
      <div className="amx-db-card-title">{title}</div>
      {previews}
    </div>
  )
}

/** 看板:按单选列分组为泳道(选项序 + 未分组),HTML5 拖卡跨道改组值;组内顺序 = 行序。 */
function KanbanBody({ db, rows, view, visCols, setCell, addRow, openRow, rowTitle, addStatusCol }: {
  db: DbFile
  rows: DbRow[]
  view: DbView
  visCols: DbColumn[]
  setCell: (rowId: string, colId: string, v: CellValue | undefined) => void
  addRow: (initial?: Record<string, CellValue>) => void
  openRow: (e: ReactMouseEvent, rowId: string) => void
  rowTitle: (r: DbRow) => string
  addStatusCol: () => void
}) {
  const groupCol =
    db.columns.find((c) => c.id === view.groupBy && resolveBaseType(c.type) === 'select') ??
    db.columns.find((c) => resolveBaseType(c.type) === 'select')
  if (!groupCol) {
    return (
      <div className="amx-db-state">
        看板按单选列分组,这张表还没有单选列。
        <button className="amx-db-linkbtn" onClick={addStatusCol}>＋ 添加「状态」单选列</button>
      </div>
    )
  }
  const opts = groupCol.options ?? []
  const lanes: Array<string | null> = [...opts, null] // null = 未分组(含选项已被删的孤值)
  const laneRows = (opt: string | null): DbRow[] =>
    rows.filter((r) => {
      const v = coerceForDisplay(r.cells[groupCol.id], 'select') as string
      return opt === null ? !v || !opts.includes(v) : v === opt
    })
  const onDrop = (opt: string | null) => (e: ReactDragEvent): void => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (id) setCell(id, groupCol.id, opt ?? undefined)
  }
  return (
    <div className="amx-db-kanban">
      {lanes.map((opt) => {
        const cards = laneRows(opt)
        return (
          <div key={opt ?? '__none'} className="amx-db-lane" onDragOver={(e) => e.preventDefault()} onDrop={onDrop(opt)}>
            <div className="amx-db-lane-head">
              {opt ? <span className={`amx-db-chip ${chipClass(opt)}`}>{opt}</span> : <span className="amx-db-lane-none">未分组</span>}
              <span className="amx-db-lane-count">{cards.length}</span>
            </div>
            <div className="amx-db-lane-cards">
              {cards.map((r) => (
                <RowCard
                  key={r.id}
                  db={db}
                  row={r}
                  title={rowTitle(r)}
                  cols={visCols}
                  skipColId={groupCol.id}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', r.id); e.dataTransfer.effectAllowed = 'move' }}
                  onClick={(e) => openRow(e, r.id)}
                />
              ))}
            </div>
            <button className="amx-db-lane-add" onClick={() => addRow(opt ? { [groupCol.id]: opt } : undefined)}>
              <PlusIcon /> 新卡片
            </button>
          </div>
        )
      })}
    </div>
  )
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const fmtYmd = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 日历:按日期列(date / calendarDate)铺月栅格,周日起始(与 Calendar Space 一致);
 *  区间值逐日铺条;日格 ＋ 新行带当日初值。42 格恒定,月份切换高度不跳。 */
function CalendarBody({ db, rows, view, addRow, openRow, rowTitle, addDateCol }: {
  db: DbFile
  rows: DbRow[]
  view: DbView
  addRow: (initial?: Record<string, CellValue>) => void
  openRow: (e: ReactMouseEvent, rowId: string) => void
  rowTitle: (r: DbRow) => string
  addDateCol: () => void
}) {
  const [ym, setYm] = useState(() => {
    const n = new Date()
    return { y: n.getFullYear(), m: n.getMonth() }
  })
  const dateCol = db.columns.find((c) => c.id === view.dateCol && isDateish(c)) ?? db.columns.find(isDateish)
  if (!dateCol) {
    return (
      <div className="amx-db-state">
        日历需要一个日期列(日期 / 日历日期)。
        <button className="amx-db-linkbtn" onClick={addDateCol}>＋ 添加「日期」列</button>
      </div>
    )
  }
  // 单日与区间统一走 parseCalDate('YYYY-MM-DD' 本身就是合法单日)。
  const spanOf = (r: DbRow): { s: string; e: string } | null => {
    const raw = r.cells[dateCol.id]
    const c = typeof raw === 'string' ? parseCalDate(raw) : null
    if (!c) return null
    const s = splitSide(c.start).date
    const e = c.end ? splitSide(c.end).date : s
    return { s, e: e >= s ? e : s }
  }
  const lead = new Date(ym.y, ym.m, 1).getDay()
  const cells = Array.from({ length: 42 }, (_, i) => new Date(ym.y, ym.m, 1 - lead + i))
  const byDay = new Map<string, DbRow[]>()
  for (const r of rows) {
    const sp = spanOf(r)
    if (!sp) continue
    for (const d of cells) {
      const k = fmtYmd(d)
      if (k >= sp.s && k <= sp.e) {
        const arr = byDay.get(k)
        if (arr) arr.push(r)
        else byDay.set(k, [r])
      }
    }
  }
  const todayK = fmtYmd(new Date())
  return (
    <div className="amx-db-cal">
      <div className="amx-db-cal-nav">
        <button className="amx-db-cal-btn" onClick={() => setYm(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))} aria-label="prev month">‹</button>
        <span className="amx-db-cal-title">{ym.y} 年 {ym.m + 1} 月</span>
        <button className="amx-db-cal-btn" onClick={() => setYm(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))} aria-label="next month">›</button>
        <button className="amx-db-linkbtn" onClick={() => { const n = new Date(); setYm({ y: n.getFullYear(), m: n.getMonth() }) }}>今天</button>
        <span className="amx-db-cal-colhint" title="日历所用的日期列(在视图 tab 菜单里换)">
          <span className="amx-db-th-icon" aria-hidden>{colMeta(dateCol.type).icon}</span>
          {dateCol.name}
        </span>
      </div>
      <div className="amx-db-cal-grid">
        {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
          <div className="amx-db-cal-dow" key={w}>{w}</div>
        ))}
        {cells.map((d) => {
          const k = fmtYmd(d)
          const dayRows = byDay.get(k) ?? []
          const inMonth = d.getMonth() === ym.m
          return (
            <div className={`amx-db-cal-day${inMonth ? '' : ' amx-db-cal-out'}${k === todayK ? ' amx-db-cal-today' : ''}`} key={k}>
              <div className="amx-db-cal-dayhead">
                <span className="amx-db-cal-num">{d.getDate()}</span>
                <button className="amx-db-cal-add" onClick={() => addRow({ [dateCol.id]: k })} title="在这天新建" aria-label={`add row on ${k}`}>
                  <PlusIcon />
                </button>
              </div>
              {dayRows.map((r) => (
                <button className="amx-db-ev" key={r.id} onClick={(e) => openRow(e, r.id)} title={rowTitle(r)}>{rowTitle(r)}</button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 画廊:卡片栅格,点卡开行编辑。 */
function GalleryBody({ db, rows, visCols, addRow, openRow, rowTitle }: {
  db: DbFile
  rows: DbRow[]
  visCols: DbColumn[]
  addRow: (initial?: Record<string, CellValue>) => void
  openRow: (e: ReactMouseEvent, rowId: string) => void
  rowTitle: (r: DbRow) => string
}) {
  return (
    <div className="amx-db-gallery">
      {rows.map((r) => (
        <RowCard key={r.id} db={db} row={r} title={rowTitle(r)} cols={visCols} max={4} onClick={(e) => openRow(e, r.id)} />
      ))}
      <button className="amx-db-card amx-db-card-add" onClick={() => addRow()}>
        <PlusIcon /> 新卡片
      </button>
    </div>
  )
}
