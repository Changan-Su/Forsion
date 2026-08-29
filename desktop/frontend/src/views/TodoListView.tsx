/** ToDo List View —— 全库待办的统一投影。
 *
 *  两个来源合流:①「日历成员多维表」里带勾选列的行(可原地勾、点开旁弹卡编辑);
 *  ② 笔记正文里的 GFM 任务 `- [ ]`(只读投影 —— 点一行打开该笔记并定位到它所在的标题,
 *  在编辑器里勾。**刻意不在这里回写正文**:那要走渲染层安全保存 + 三级定位防线,另立一轮)。
 *
 *  分桶(逾期/今天/明天/本周/以后/未排期)判据与桶序单源 `calendar/todoGroups.ts`,**空桶不渲染**。
 *  已完成收进底部一个默认折叠的段(提醒事项的 Show Completed 语义)—— 取代了旧的「隐藏已完成」开关,
 *  连同旧的「范围」时间窗下拉与四种排序一起删掉:分桶已经逐字回答了它们能回答的一切,
 *  而那个 ±N 天窗口会把用户仅有的数据滤光(实测:生产库三条种子全被滤掉)。
 */
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { ChevronRight, ExternalLink, Plus } from 'lucide-react'
import { AstryxScope } from '../theme/astryxBridge'
import { createAggEvent, setAggCell } from '../amadeus/store/dbAggregateStore'
import { useCalendarMembers, type CalMemberDb } from '../amadeus/store/calendarMembers'
import { useMdTasks } from '../amadeus/store/mdTaskStore'
import { openNoteAtHeading } from '../amadeusNav'
import { fmtStamp, startOfDay } from './calendar/dateUtils'
import { EventCard, type Anchor, type CardTarget } from './calendar/EventCard'
import { todoDueMeta } from './calendar/todoMeta'
import { BUCKET_LABEL, COLLAPSED_BY_DEFAULT, ORDER, bucketOf, sortTimeOf, type TodoBucket } from './calendar/todoGroups'
import { zoomOf } from '@lcl/engine'

const DONE_KEY = 'done'

export interface TodoParams {
  /** 只看这一个来源库(vault 相对 .db 路径);缺省 = 全部。 */
  db?: string
  /** 数据源:多维表行 / 笔记正文任务 / 全部(缺省)。 */
  src: 'db' | 'md' | 'all'
}

/** params 读端 —— **只许有这一个**。
 *  Dashboard 卡片(dashboardViewCard)只落标量且一律 `String(v)`,所以到这里的值可能是
 *  `'true'` 这种字符串;侧栏/主区 openView 传的则是原类型。两侧都得能吃。 */
export function readTodoParams(p?: Record<string, unknown>): TodoParams {
  const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
  const src = str(p?.src)
  return { db: str(p?.db) || undefined, src: src === 'db' || src === 'md' ? src : 'all' }
}

/** 列表里的一行 —— 多维表行与正文任务合流后的统一形态。 */
interface Row {
  key: string
  name: string
  checked: boolean
  /** 日期原文(`''` = 未排期) */
  raw: string
  /** 二级分组标签:正文任务 = `笔记 › 标题`,多维表 = 表名 */
  source: string
  db?: CalMemberDb
  rowId?: string
  /** 正文任务的落点 */
  note?: { path: string; heading: string }
}

export function TodoListView({ params }: { params?: Record<string, unknown> } = {}) {
  const opts = readTodoParams(params)
  const members = useCalendarMembers()
  const mdTasks = useMdTasks()

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set([...COLLAPSED_BY_DEFAULT, DONE_KEY]))
  const [card, setCard] = useState<{ dbPath: string; rowId: string; at: Anchor } | null>(null)
  const [draft, setDraft] = useState('')

  const today = useMemo(() => startOfDay(new Date()), [])
  const sources = useMemo(
    () => members.filter((m) => m.checkboxCol && (!opts.db || m.db.path === opts.db)),
    [members, opts.db],
  )

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    if (opts.src !== 'md') {
      for (const m of sources) {
        const checkCol = m.checkboxCol as string
        for (const r of m.db.rows) {
          const raw = typeof r.cells[m.dateCol] === 'string' ? (r.cells[m.dateCol] as string) : ''
          out.push({ key: `db:${m.db.path}:${r.rowId}`, name: r.name || '未命名', checked: r.cells[checkCol] === true, raw, source: m.db.name, db: m, rowId: r.rowId })
        }
      }
    }
    // 正文任务只在「全部来源」或显式指定单库之外露出:限定了某个 .db 就只看那张表。
    if (opts.src !== 'db' && !opts.db) {
      for (const t of mdTasks) {
        out.push({ key: `md:${t.path}:${t.line}`, name: t.text, checked: t.checked, raw: '', source: t.heading ? `${t.title} › ${t.heading}` : t.title, note: { path: t.path, heading: t.heading } })
      }
    }
    return out
  }, [sources, mdTasks, opts.src, opts.db])

  const done = useMemo(() => rows.filter((r) => r.checked), [rows])
  const buckets = useMemo(() => {
    const by = new Map<TodoBucket, Row[]>()
    for (const r of rows) {
      if (r.checked) continue
      const b = bucketOf(r.raw, today)
      const list = by.get(b)
      if (list) list.push(r)
      else by.set(b, [r])
    }
    for (const list of by.values()) {
      list.sort((a, b) => {
        const ta = sortTimeOf(a.raw)
        const tb = sortTimeOf(b.raw)
        return (ta === tb ? 0 : ta < tb ? -1 : 1) || a.source.localeCompare(b.source, 'zh') || a.name.localeCompare(b.name, 'zh')
      })
    }
    return by
  }, [rows, today])

  const openCount = rows.length - done.length
  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  // 编辑目标从最新聚合解析(改名/勾选后卡片仍活);行没了(被删)自动收卡。
  const target = useMemo<CardTarget | null>(() => {
    if (!card) return null
    const m = sources.find((g) => g.db.path === card.dbPath)
    const row = m?.db.rows.find((r) => r.rowId === card.rowId)
    if (!m || !row) return null
    const raw = typeof row.cells[m.dateCol] === 'string' ? (row.cells[m.dateCol] as string) : ''
    return { db: m.db, row, colId: m.dateCol, title: row.name, raw }
  }, [card, sources])

  // 快速添加的落点:可写的经典表。笔记视图库会新建一个笔记文件、只读源不可写,都排除;
  // 一个候选都没有就不渲染输入行 —— 建错地方比建不了更糟(症状是「建了但列表里没有」)。
  const addTarget = useMemo(() => sources.find((m) => !m.db.readonly && !m.db.isNoteView), [sources])
  const submitDraft = (): void => {
    const name = draft.trim()
    if (!name || !addTarget) return
    void createAggEvent(addTarget.db, addTarget.dateCol, fmtStamp(today, true), name)
    setDraft('')
  }

  const openRow = (r: Row, e: MouseEvent<HTMLElement>): void => {
    if (r.note) { void openNoteAtHeading(r.note.path, r.note.heading); return }
    if (!r.db || !r.rowId) return
    const rc = e.currentTarget.getBoundingClientRect()
    setCard({ dbPath: r.db.db.path, rowId: r.rowId, at: { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom, zoom: zoomOf(e.currentTarget) || 1 } })
  }

  const renderRow = (r: Row): ReactNode => {
    const due = todoDueMeta(r.raw, today)
    return (
      <li className="amx-todo-item" key={r.key}>
        {r.db && r.rowId ? (
          <CheckboxInput
            label={r.name}
            isLabelHidden
            size="sm"
            value={r.checked}
            onChange={(next) => setAggCell(r.db!.db, r.rowId!, r.db!.checkboxCol as string, next ? true : undefined)}
          />
        ) : (
          // 正文任务:画同样的方框但**不做成可点的勾选框** —— 这里不回写笔记原文,
          // 给一个勾不动的勾选框比不给更糟。整行点击 = 打开笔记定位到它,在那儿勾。
          <span className={`amx-todo-box${r.checked ? ' on' : ''}`} aria-hidden="true" />
        )}
        <button className="amx-todo-main" title={r.note ? '在笔记中打开并勾选' : '点击编辑'} onClick={(e) => openRow(r, e)}>
          <span className={`amx-todo-name${r.checked ? ' done' : ''}`}>{r.name}</span>
          {r.raw ? <span className={`amx-todo-due ${due.tone}`}>{due.label}</span> : null}
          {r.note ? <ExternalLink className="amx-todo-jump" size={12} /> : null}
        </button>
      </li>
    )
  }

  /** 未排期桶会很大(正文任务全落这儿)→ 按来源二级分组;其余桶平铺。 */
  const renderBucketBody = (b: TodoBucket, list: Row[]): ReactNode => {
    if (b !== 'undated') return <ul className="amx-todo-list">{list.map(renderRow)}</ul>
    const groups: Array<{ source: string; items: Row[] }> = []
    for (const r of list) {
      const last = groups[groups.length - 1]
      if (last && last.source === r.source) last.items.push(r)
      else groups.push({ source: r.source, items: [r] })
    }
    return (
      <>
        {groups.map((g) => (
          <div key={g.source}>
            <div className="amx-todo-src">{g.source}<span className="amx-todo-srcn">{g.items.length}</span></div>
            <ul className="amx-todo-list">{g.items.map(renderRow)}</ul>
          </div>
        ))}
      </>
    )
  }

  /** 折叠走 CSS 的 `grid-template-rows: 0fr→1fr`(与 base.css 的 .cm-advanced-reveal 同一惯用法)——
   *  所以内容**恒在 DOM 里**,只是被收成 0 高:条件渲染没有可插值的中间态,一定是瞬跳。
   *  代价是折起来的段仍占 DOM 节点(本视图量级是几十到几百行,可接受);真到几千行再谈虚拟化。 */
  const section = (key: string, label: string, list: Row[], body: ReactNode): ReactNode => {
    const open = !collapsed.has(key)
    return (
      <section className="amx-todo-group" key={key}>
        <button className={`amx-todo-ghead${open ? ' is-open' : ''}`} onClick={() => toggle(key)} aria-expanded={open}>
          <ChevronRight className="amx-todo-caret" size={12} />
          <span className="amx-todo-gname">{label}</span>
          <span className="amx-todo-gcount">{list.length}</span>
        </button>
        <div className={`amx-todo-reveal${open ? ' is-open' : ''}`}>
          <div className="amx-todo-reveal-in">{body}</div>
        </div>
      </section>
    )
  }

  return (
    <AstryxScope>
    <div className="amx-todo">
      <div className="amx-todo-bar">
        <span className="amx-todo-title">待办</span>
        {openCount > 0 && <span className="amx-todo-total">{openCount}</span>}
      </div>

      {rows.length === 0 && (
        <div className="amx-todo-empty">
          还没有待办。<br />在笔记里写 <code>- [ ]</code>,或在下面直接加一条。
        </div>
      )}
      {rows.length > 0 && openCount === 0 && (
        <div className="amx-todo-empty">全部完成了。</div>
      )}

      {ORDER.map((b) => {
        const list = buckets.get(b)
        return list && list.length ? section(b, BUCKET_LABEL[b], list, renderBucketBody(b, list)) : null
      })}
      {done.length > 0 && section(DONE_KEY, '已完成', done, <ul className="amx-todo-list">{done.map(renderRow)}</ul>)}

      {addTarget && (
        <div className="amx-todo-add">
          <Plus className="amx-todo-addicon" size={13} />
          <input
            className="amx-todo-addinput"
            placeholder="新建待办"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return // 中文输入法选词的回车不算提交(台架抓不到)
              if (e.key === 'Enter') { e.preventDefault(); submitDraft() }
              if (e.key === 'Escape') setDraft('')
            }}
          />
        </div>
      )}

      {target && card && <EventCard ev={target} at={card.at} onClose={() => setCard(null)} />}
    </div>
    </AstryxScope>
  )
}
