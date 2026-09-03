/** ToDo List View —— 全库待办的统一投影。
 *
 *  两个来源合流:①「日历成员多维表」里带勾选列的行(可原地勾、点开旁弹卡编辑);
 *  ② 笔记正文里**带 `@` 时间标记**的勾选框行 `- [ ] 交周报 @2026-09-01`。**可就地勾** ——
 *  按内容(raw + 同文行序号)回写笔记里那一行,真源始终只有 markdown 一份;点行名仍是打开笔记。
 *  宿主没有 `patchMark` 接缝时(web / mobile 壳)自动退回「只读方框 + 跳转」。
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
import { patchMark, useMdMarks } from '../amadeus/store/mdMarkStore'
import type { MdMark } from '@amadeus-shared/mdMarks'
import { openNoteAtHeading } from '../amadeusNav'
import { amadeus } from '../amadeus/api'
import { fmtStamp, startOfDay } from './calendar/dateUtils'
import { EventCard, type Anchor, type CardTarget } from './calendar/EventCard'
import { todoDueMeta } from './calendar/todoMeta'
import { BUCKET_LABEL, COLLAPSED_BY_DEFAULT, ORDER, bucketOf, sortTimeOf, type TodoBucket } from './calendar/todoGroups'
import { zoomOf } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'

registerMessages({
  'todolist.title': { zh: '待办', en: 'To-dos' },
  'todolist.untitled': { zh: '未命名', en: 'Untitled' },
  'todolist.done': { zh: '已完成', en: 'Completed' },
  'todolist.openInNote': { zh: '在笔记中打开', en: 'Open in note' },
  'todolist.clickToEdit': { zh: '点击编辑', en: 'Click to edit' },
  'todolist.addPlaceholder': { zh: '新建待办', en: 'New to-do' },
  'todolist.allDone': { zh: '全部完成了。', en: 'All done.' },
  'todolist.emptyTitle': { zh: '还没有待办。', en: 'No to-dos yet.' },
  'todolist.emptyHintA': { zh: '在笔记里写 ', en: 'Write ' },
  'todolist.emptyExample': { zh: '- [ ] 事项 @2026-09-01', en: '- [ ] Task @2026-09-01' },
  'todolist.emptyHintB': { zh: '(打 ', en: ' in a note (type ' },
  'todolist.emptyHintC': { zh: ' 有候选),或在下面直接加一条。', en: ' for suggestions), or add one below.' },
})

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
  /** 正文任务的原始标记(就地勾选时按内容回写那一行) */
  mark?: MdMark
}

export function TodoListView({ params }: { params?: Record<string, unknown> } = {}) {
  const opts = readTodoParams(params)
  const { t } = useI18n()
  const members = useCalendarMembers()
  const mdMarks = useMdMarks()

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
          out.push({ key: `db:${m.db.path}:${r.rowId}`, name: r.name || t('todolist.untitled'), checked: r.cells[checkCol] === true, raw, source: m.db.name, db: m, rowId: r.rowId })
        }
      }
    }
    // 正文任务只在「全部来源」或显式指定单库之外露出:限定了某个 .db 就只看那张表。
    if (opts.src !== 'db' && !opts.db) {
      // 只收带勾选框的标记行:没勾选框的 `@` 行是日程,归日历(useMdCalDbs)。
      // ⚠️ 循环变量不叫 `t`:那会遮住 useI18n 的 `t`(本 memo 里就在用)。
      for (const mk of mdMarks.filter((m) => m.isTask)) {
        out.push({ key: `md:${mk.path}:${mk.line}`, name: mk.text, checked: mk.checked, raw: mk.due, source: mk.heading ? `${mk.title} › ${mk.heading}` : mk.title, note: { path: mk.path, heading: mk.heading }, mark: mk })
      }
    }
    return out
  }, [sources, mdMarks, opts.src, opts.db, t])

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

  // 宿主有没有「按内容改写笔记某一行」这条缝(桌面有;web/mobile 壳没有 → 退回跳转)。
  const canPatch = !!amadeus?.patchMark

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
        ) : r.mark && canPatch ? (
          // 正文任务**就地勾**:按内容回写笔记里那一行(`- [ ]`→`- [x]`),真源仍只有 markdown 一份。
          <CheckboxInput
            label={r.name}
            isLabelHidden
            size="sm"
            value={r.checked}
            onChange={(next) => patchMark(r.mark!, { checked: next })}
          />
        ) : (
          // 宿主没有回写接缝(web / mobile 壳):画同样的方框但不做成可点的勾选框 ——
          // 给一个勾不动的勾选框比不给更糟。整行点击 = 打开笔记定位到它,在那儿勾。
          <span className={`amx-todo-box${r.checked ? ' on' : ''}`} aria-hidden="true" />
        )}
        <button className="amx-todo-main" title={r.note ? t('todolist.openInNote') : t('todolist.clickToEdit')} onClick={(e) => openRow(r, e)}>
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
        <span className="amx-todo-title">{t('todolist.title')}</span>
        {openCount > 0 && <span className="amx-todo-total">{openCount}</span>}
      </div>

      {rows.length === 0 && (
        <div className="amx-todo-empty">
          {t('todolist.emptyTitle')}<br />{t('todolist.emptyHintA')}<code>{t('todolist.emptyExample')}</code>{t('todolist.emptyHintB')}<code>@</code>{t('todolist.emptyHintC')}
        </div>
      )}
      {rows.length > 0 && openCount === 0 && (
        <div className="amx-todo-empty">{t('todolist.allDone')}</div>
      )}

      {ORDER.map((b) => {
        const list = buckets.get(b)
        return list && list.length ? section(b, BUCKET_LABEL[b], list, renderBucketBody(b, list)) : null
      })}
      {done.length > 0 && section(DONE_KEY, t('todolist.done'), done, <ul className="amx-todo-list">{done.map(renderRow)}</ul>)}

      {addTarget && (
        <div className="amx-todo-add">
          <Plus className="amx-todo-addicon" size={13} />
          <input
            className="amx-todo-addinput"
            placeholder={t('todolist.addPlaceholder')}
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
