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
 *
 *  2026-10-16(日历方案 B,docs/ToBeImproved/Calendar交互与待办右栏方案_2026-10-16/):快速添加挪到顶部、认自然语言日期;
 *  在日历右栏里(params.side)按 N 聚焦它;多维表行能拖进日历排时段;勾完那一行留 1 秒再收进「已完成」。
 *
 *  2026-10-17(待办视图方案 A,docs/ToBeImproved/待办视图方案_2026-10-17/):单独打开(主区标签 / Mini 窗)也完整。
 *  · 宽窄两档按**自身宽度**(≥ 480px 为宽)切,不按放在哪:宽 = 列表最宽 720px 居中、顶栏「今天 / 计划 / 全部」分段 +
 *    清单菜单、来源一列;窄(日历右栏、Mini 窗、手机抽屉)= 分段与清单合成标题旁一个菜单、来源缩成日期前的色点。
 *  · 筛选写回视图参数(view / db / src),这个标签记这个标签的;没有 leaf 的宿主(日历右栏、Mini)只记在组件里。
 *  · 新建框可选落到哪张表(≥ 2 张可写表才出现);点开的浮卡贴着标题文字,不按整行算(整行算右边永远放不下)。
 *  · 拖一行到「今天 / 明天 / 未排期」组头 = 改日期,只换日子不换钟点,带撤销;键盘 N / ↑↓ / 空格 / 回车。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { Check, ChevronRight, Clock, ExternalLink, FileText, List, Plus } from 'lucide-react'
import { AstryxScope } from '../theme/astryxBridge'
import { createAggEvent, setAggCell } from '../amadeus/store/dbAggregateStore'
import { useCalendarMembers, type CalMemberDb } from '../amadeus/store/calendarMembers'
import { patchMark, useMdMarks } from '../amadeus/store/mdMarkStore'
import type { MdMark } from '@amadeus-shared/mdMarks'
import { openNoteAtHeading } from '../amadeusNav'
import { amadeus } from '../amadeus/api'
import { fmtStamp, startOfDay } from './calendar/dateUtils'
import { parseQuickAdd } from './calendar/nlDate'
import { TODO_DRAG_MIME } from './calendar/draft'
import { usePageStore } from '../amadeus/store/pageStore'
import { colorForDb, useCalendarConfig, defaultDbPath } from '../amadeus/store/calendarConfigStore'
import { EventCard, type Anchor, type CardTarget } from './calendar/EventCard'
import { rescheduleCalendarRow, rescheduleNoteTask } from './calendar/eventActions'
import { todoDueMeta } from './calendar/todoMeta'
import { BUCKET_LABEL, COLLAPSED_BY_DEFAULT, ORDER, VIEWS, bucketOf, dropDay, inView, moveToDay, sortTimeOf, type TodoBucket, type TodoView } from './calendar/todoGroups'
import { zoomOf, type Leaf } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'

registerMessages({
  'todolist.title': { zh: '待办', en: 'To-dos' },
  'todolist.untitled': { zh: '未命名', en: 'Untitled' },
  'todolist.done': { zh: '已完成', en: 'Completed' },
  'todolist.openInNote': { zh: '在笔记中打开', en: 'Open in note' },
  'todolist.clickToEdit': { zh: '点击编辑', en: 'Click to edit' },
  'todolist.addPlaceholder': { zh: '新建待办，如「明天下午3点」', en: 'New to-do, e.g. "tomorrow 3pm"' },
  'todolist.addPlaceholderShort': { zh: '新建待办', en: 'New to-do' },
  'todolist.addTo': { zh: '加到「{name}」', en: 'Adds to "{name}"' },
  'todolist.addTarget': { zh: '加到哪张表', en: 'Add to' },
  'todolist.dragHint': { zh: '拖进日历排时段', en: 'Drag into the calendar to schedule' },
  'todolist.dragHintGroups': { zh: '拖到「今天」「明天」或「未排期」上改日期', en: 'Drag onto Today, Tomorrow or Unscheduled to change the date' },
  'todolist.allDone': { zh: '全部完成了。', en: 'All done.' },
  'todolist.emptyTitle': { zh: '还没有待办。', en: 'No to-dos yet.' },
  'todolist.emptyHintA': { zh: '在笔记里写 ', en: 'Write ' },
  'todolist.emptyExample': { zh: '- [ ] 事项 @2026-09-01', en: '- [ ] Task @2026-09-01' },
  'todolist.emptyHintB': { zh: '（打 ', en: ' in a note (type ' },
  'todolist.emptyHintC': { zh: ' 有候选），或在上面直接加一条。', en: ' for suggestions), or add one above.' },
  'todolist.emptyHintCNoAdd': { zh: ' 有候选）。', en: ' for suggestions).' },
  'todolist.view.today': { zh: '今天', en: 'Today' },
  'todolist.view.plan': { zh: '计划', en: 'Scheduled' },
  'todolist.view.all': { zh: '全部', en: 'All' },
  'todolist.viewsLabel': { zh: '筛选', en: 'Filter' },
  'todolist.allLists': { zh: '所有清单', en: 'All lists' },
  'todolist.noteTasks': { zh: '笔记里的任务', en: 'Tasks in notes' },
  'todolist.filterLabel': { zh: '{view} · {list}', en: '{view} · {list}' },
  'todolist.mdAddHint': { zh: '笔记里的任务在笔记里写：', en: 'Write tasks in a note: ' },
  'todolist.todayDone': { zh: '今天的都做完了。', en: 'Nothing left for today.' },
  'todolist.planEmpty': { zh: '没有排了日期的待办。', en: 'No scheduled to-dos.' },
  'todolist.listEmpty': { zh: '这张清单里没有待办。', en: 'No to-dos in this list.' },
  'todolist.restItem': { zh: '{label} {n} 条', en: '{label} {n}' },
  'todolist.restSep': { zh: '、', en: ' · ' },
  'todolist.showAll': { zh: '看全部', en: 'Show all' },
})

const DONE_KEY = 'done'
/** 宽档门槛(视图自身宽度,CSS 像素):日历右栏 267、Mini 窗 320 都在下面;主区标签一般在上面。 */
const WIDE_MIN = 480
/** 正文任务拖动的私有载荷:日历不认它(日历只收多维表行),只在本视图的分组头之间用。 */
const MD_DRAG_MIME = 'application/x-forsion-todo-md'

export interface TodoParams {
  /** 只看这一个来源库(vault 相对 .db 路径);缺省 = 全部。 */
  db?: string
  /** 数据源:多维表行 / 笔记正文任务 / 全部(缺省)。 */
  src: 'db' | 'md' | 'all'
  /** 住在日历右栏(calendar-side)里:N 聚焦快速添加、拖进日历排时段。 */
  side?: boolean
  /** 顶栏筛选:今天 / 计划 / 全部(缺省)。 */
  view: TodoView
}

/** params 读端 —— **只许有这一个**。
 *  Dashboard 卡片(dashboardViewCard)只落标量且一律 `String(v)`,所以到这里的值可能是
 *  `'true'` 这种字符串;侧栏/主区 openView 传的则是原类型。两侧都得能吃。 */
export function readTodoParams(p?: Record<string, unknown>): TodoParams {
  const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
  const src = str(p?.src)
  const view = str(p?.view)
  return {
    db: str(p?.db) || undefined,
    src: src === 'db' || src === 'md' ? src : 'all',
    side: p?.side === true || p?.side === 'true',
    view: (VIEWS as string[]).includes(view) ? view as TodoView : 'all',
  }
}

/** 列表里的一行 —— 多维表行与正文任务合流后的统一形态。 */
interface Row {
  key: string
  name: string
  checked: boolean
  /** 日期原文(`''` = 未排期) */
  raw: string
  /** 来源全称:正文任务 = `笔记 › 标题`,多维表 = 表名 */
  source: string
  /** 来源短名(宽档来源列):正文任务 = 笔记名,多维表 = 表名 */
  short: string
  /** 来源色(多维表 = 日历列表里那张表的颜色;正文任务画文件图标,不用色) */
  color?: string
  db?: CalMemberDb
  rowId?: string
  /** 正文任务的落点 */
  note?: { path: string; heading: string }
  /** 正文任务的原始标记(就地勾选 / 改日期时按内容回写那一行) */
  mark?: MdMark
}

/** 视图自身宽度过没过门槛。ResizeObserver 量的是 CSS 像素,界面缩放不影响判定。 */
function useWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    setWide(el.offsetWidth >= WIDE_MIN) // 首帧就定档,别先画一帧窄的再跳宽
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= WIDE_MIN))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return wide
}

export function TodoListView({ params, leaf }: { params?: Record<string, unknown>; leaf?: Leaf } = {}) {
  const opts = readTodoParams(params)
  const { t } = useI18n()
  const members = useCalendarMembers()
  const mdMarks = useMdMarks()
  const rootRef = useRef<HTMLDivElement>(null)
  const wide = useWide(rootRef)

  // 筛选:以参数为初值,改了写回参数(有 leaf 的宿主会存进布局)。
  const [view, setViewState] = useState<TodoView>(opts.view)
  const [list, setListState] = useState<{ db?: string; src: TodoParams['src'] }>({ db: opts.db, src: opts.src })
  const setView = (v: TodoView): void => { setViewState(v); leaf?.setParams({ view: v }) }
  const setList = (l: { db?: string; src: TodoParams['src'] }): void => { setListState(l); setAddTo(null); leaf?.setParams({ db: l.db ?? '', src: l.src }) }

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set([...COLLAPSED_BY_DEFAULT, DONE_KEY]))
  const [card, setCard] = useState<{ dbPath: string; rowId: string; at: Anchor } | null>(null)
  const [draft, setDraft] = useState('')
  const [addTo, setAddTo] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<TodoBucket | null>(null)
  const dragRow = useRef<Row | null>(null)
  // 拖着一行时,「今天 / 明天 / 未排期」即使是空桶也把组头亮出来当落点(空桶平时不渲染)
  const [dragging, setDragging] = useState<Row | null>(null)
  // 刚勾完的行:留在原处 1 秒(期间再点一下就是撤销)再收进「已完成」。
  const [linger, setLinger] = useState<ReadonlySet<string>>(new Set())
  const addRef = useRef<HTMLInputElement>(null)
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const byVault = useCalendarConfig((s) => s.byVault)

  const today = useMemo(() => startOfDay(new Date()), [])
  // 全部可当待办来源的表(带勾选列)—— 清单菜单列的是这一份,不受当前筛选影响。
  const allSources = useMemo(() => members.filter((m) => m.checkboxCol), [members])
  const sources = useMemo(() => allSources.filter((m) => !list.db || m.db.path === list.db), [allSources, list.db])
  const colorOf = (m: CalMemberDb): string => colorForDb(vault, byVault, m.db.path, members.indexOf(m))

  /** 不看清单筛选的全部行(清单菜单的计数用);下面再按清单筛。 */
  const everyRow = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const m of allSources) {
      const checkCol = m.checkboxCol as string
      const color = colorForDb(vault, byVault, m.db.path, members.indexOf(m))
      for (const r of m.db.rows) {
        const raw = typeof r.cells[m.dateCol] === 'string' ? (r.cells[m.dateCol] as string) : ''
        out.push({ key: `db:${m.db.path}:${r.rowId}`, name: r.name || t('todolist.untitled'), checked: r.cells[checkCol] === true, raw, source: m.db.name, short: m.db.name, color, db: m, rowId: r.rowId })
      }
    }
    // 只收带勾选框的标记行:没勾选框的 `@` 行是日程,归日历(useMdCalDbs)。
    // ⚠️ 循环变量不叫 `t`:那会遮住 useI18n 的 `t`(本 memo 里就在用)。
    for (const mk of mdMarks.filter((m) => m.isTask)) {
      out.push({ key: `md:${mk.path}:${mk.line}`, name: mk.text, checked: mk.checked, raw: mk.due, source: mk.heading ? `${mk.title} › ${mk.heading}` : mk.title, short: mk.title, note: { path: mk.path, heading: mk.heading }, mark: mk })
    }
    return out
  }, [allSources, members, mdMarks, vault, byVault, t])
  // 正文任务只在「全部来源」或显式指定单库之外露出:限定了某个 .db 就只看那张表。
  const rows = useMemo(() => everyRow.filter((r) => (r.db
    ? list.src !== 'md' && (!list.db || r.db.db.path === list.db)
    : list.src !== 'db' && !list.db)), [everyRow, list])

  const settled = (r: Row): boolean => r.checked && !linger.has(r.key)
  const done = useMemo(() => rows.filter((r) => r.checked && !linger.has(r.key)), [rows, linger])
  const buckets = useMemo(() => {
    const by = new Map<TodoBucket, Row[]>()
    for (const r of rows) {
      if (settled(r)) continue
      const b = bucketOf(r.raw, today)
      const l = by.get(b)
      if (l) l.push(r)
      else by.set(b, [r])
    }
    for (const l of by.values()) {
      l.sort((a, b) => {
        const ta = sortTimeOf(a.raw)
        const tb = sortTimeOf(b.raw)
        return (ta === tb ? 0 : ta < tb ? -1 : 1) || a.source.localeCompare(b.source, 'zh') || a.name.localeCompare(b.name, 'zh')
      })
    }
    return by
  }, [rows, today, linger]) // eslint-disable-line react-hooks/exhaustive-deps
  const check = (r: Row, next: boolean, write: () => void): void => {
    write()
    if (!next) return
    setLinger((s) => new Set(s).add(r.key))
    setTimeout(() => setLinger((s) => { const n = new Set(s); n.delete(r.key); return n }), 1000)
  }

  const countIn = (v: TodoView): number => ORDER.reduce((n, b) => n + (inView(v, b) ? buckets.get(b)?.length ?? 0 : 0), 0)
  const openCount = countIn(view)
  const openOf = (pred: (r: Row) => boolean): number => everyRow.filter((r) => !r.checked && pred(r)).length
  const hasMd = everyRow.some((r) => r.mark)
  // 来源不止一个才标来源(只有一张表时那一列恒为常量)
  const showSrc = new Set(rows.map((r) => r.db?.db.path ?? 'md')).size > 1
  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  // 编辑目标从最新聚合解析(改名/勾选后卡片仍活);行没了(被删)自动收卡。
  const target = useMemo<CardTarget | null>(() => {
    if (!card) return null
    const m = allSources.find((g) => g.db.path === card.dbPath)
    const row = m?.db.rows.find((r) => r.rowId === card.rowId)
    if (!m || !row) return null
    const raw = typeof row.cells[m.dateCol] === 'string' ? (row.cells[m.dateCol] as string) : ''
    return { db: m.db, row, colId: m.dateCol, title: row.name, raw, color: colorForDb(vault, byVault, m.db.path, members.indexOf(m)) }
  }, [card, allSources, members, vault, byVault])

  // 快速添加的落点:可写的经典表。笔记视图库会新建一个笔记文件、只读源不可写,都排除;
  // 一个候选都没有就不渲染输入行 —— 建错地方比建不了更糟(症状是「建了但列表里没有」)。
  // 缺省:手选的 > 当前筛到的那张 > 左栏标星的默认日历 > 第一张。
  const addTargets = useMemo(() => sources.filter((m) => !m.db.readonly && !m.db.isNoteView), [sources])
  const addTarget = useMemo(() => {
    const def = defaultDbPath(vault, byVault)
    return addTargets.find((m) => m.db.path === addTo) ?? addTargets.find((m) => m.db.path === list.db) ?? addTargets.find((m) => m.db.path === def) ?? addTargets[0]
  }, [addTargets, addTo, list.db, vault, byVault])
  // 打字时就认日期:认出来的写在输入框下面(连同会加到哪张表);没认出 = 今天(原来的缺省)。
  const parsed = useMemo(() => (draft.trim() ? parseQuickAdd(draft) : null), [draft])
  const submitDraft = (): void => {
    if (!parsed || !addTarget) return
    const name = parsed.title || draft.trim()
    void createAggEvent(addTarget.db, addTarget.dateCol, parsed.value ?? fmtStamp(today, true), name)
    setDraft('')
  }
  // N 聚焦快速添加:日历右栏里(焦点在日历上也算),单独打开时焦点在本视图里或没落在任何面板里。
  // 焦点在别的面板的输入框 / 编辑器里不劫持;同一时刻两份待办都看得见时,先登记的那份接。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key !== 'n' && e.key !== 'N') || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, select, [contenteditable]')) return
      const input = addRef.current
      const root = rootRef.current
      if (!input || !root || !input.getClientRects().length) return
      const a = document.activeElement
      const mine = !a || a === document.body || root.contains(a) || (opts.side && !!a.closest('.amx-cal')) || (!opts.side && !a.closest('.dv-react-part'))
      if (!mine) return
      e.preventDefault()
      input.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [opts.side])

  const openRow = (r: Row, e: MouseEvent<HTMLElement>): void => {
    if (r.note) { void openNoteAtHeading(r.note.path, r.note.heading); return }
    if (!r.db || !r.rowId) return
    // 锚点 = 标题文字,不是整行:主区里整行一千多像素宽,按整行算右边永远放不下,卡片就翻到窗口最左(10-17 方案页现状 3)。
    const anchor = e.currentTarget.querySelector('.amx-todo-name') ?? e.currentTarget
    const rc = anchor.getBoundingClientRect()
    setCard({ dbPath: r.db.db.path, rowId: r.rowId, at: { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom, zoom: zoomOf(e.currentTarget) || 1 } })
  }

  // ↑↓ 在行间移焦点,空格勾选(按钮的空格缺省是点击 = 开卡,这里截下来),回车开卡走按钮原生。
  const rowKeys = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const all = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('.amx-todo-reveal.is-open .amx-todo-main') ?? [])]
      const i = all.indexOf(e.currentTarget)
      const next = all[i + (e.key === 'ArrowDown' ? 1 : -1)]
      if (next) { e.preventDefault(); next.focus() }
    } else if (e.key === ' ') {
      e.preventDefault()
      e.currentTarget.closest('li')?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click()
    }
  }

  // 宿主有没有「按内容改写笔记某一行」这条缝(桌面有;web/mobile 壳没有 → 退回跳转)。
  const canPatch = !!amadeus?.patchMark

  const reschedule = (r: Row, b: TodoBucket): void => {
    const day = dropDay(b, today)
    if (day === undefined) return
    const after = moveToDay(r.raw, day)
    if (r.db && r.rowId) {
      const row = r.db.db.rows.find((x) => x.rowId === r.rowId)
      if (row) rescheduleCalendarRow(r.db.db, row, r.db.dateCol, r.raw, after, r.name)
    } else if (r.mark && canPatch) rescheduleNoteTask(r.mark, r.raw, after, r.name)
  }
  /** 这一行能不能放到这个组头上:组头得有确定的日子;正文任务清掉 `@` 就不是待办了,不收「未排期」。 */
  const canDrop = (r: Row | null, b: TodoBucket): boolean => {
    if (!r || dropDay(b, today) === undefined || bucketOf(r.raw, today) === b) return false
    if (r.mark) return canPatch && b !== 'undated'
    return !!(r.db && r.rowId && !r.db.db.readonly)
  }

  const srcTag = (r: Row): ReactNode => !showSrc ? null : wide
    ? <span className="amx-todo-srctag" title={r.source}>{r.mark ? <FileText size={12} /> : <i className="amx-todo-dot" style={{ background: r.color }} />}<span className="amx-todo-srcname">{r.short}</span></span>
    : r.mark ? <FileText className="amx-todo-srcic" size={11} aria-label={r.source} /> : <i className="amx-todo-dot" style={{ background: r.color }} title={r.source} />

  const renderRow = (r: Row): ReactNode => {
    const due = todoDueMeta(r.raw, today)
    const toCal = !!(opts.side && r.db && r.rowId && !r.db.db.readonly)
    const drag = !r.checked && (toCal || canDrop(r, 'today') || canDrop(r, 'tomorrow') || canDrop(r, 'undated'))
    return (
      <li
        className="amx-todo-item"
        key={r.key}
        draggable={drag || undefined}
        title={drag ? t(toCal ? 'todolist.dragHint' : 'todolist.dragHintGroups') : undefined}
        onDragStart={drag ? (e) => {
          dragRow.current = r
          // 下一帧再亮出空组头:同一帧改 DOM 会让 Chromium 当场取消这次拖动
          requestAnimationFrame(() => setDragging(r))
          // 多维表行能拖进日历:时间格 = 排时段(30 分钟),全天行 = 只改日期(CalendarView 接)。正文任务只在本视图里挪。
          if (r.db && r.rowId) e.dataTransfer.setData(TODO_DRAG_MIME, JSON.stringify({ dbPath: r.db.db.path, rowId: r.rowId }))
          else e.dataTransfer.setData(MD_DRAG_MIME, r.key)
          e.dataTransfer.effectAllowed = 'move'
          e.currentTarget.classList.add('dragging')
        } : undefined}
        onDragEnd={drag ? (e) => { e.currentTarget.classList.remove('dragging'); dragRow.current = null; setDragging(null); setDropAt(null) } : undefined}
        // 整行好点:点在来源 / 日期 / 空白上等于点标题(键盘走标题按钮;勾选框自己处理)
        onClick={(e) => { if (!(e.target as HTMLElement).closest('.amx-todo-main, .astryx-checkbox-input, .amx-todo-box')) e.currentTarget.querySelector<HTMLButtonElement>('.amx-todo-main')?.click() }}
      >
        {r.db && r.rowId ? (
          <CheckboxInput
            label={r.name}
            isLabelHidden
            size="sm"
            value={r.checked}
            onChange={(next) => check(r, next, () => setAggCell(r.db!.db, r.rowId!, r.db!.checkboxCol as string, next ? true : undefined))}
          />
        ) : r.mark && canPatch ? (
          // 正文任务**就地勾**:按内容回写笔记里那一行(`- [ ]`→`- [x]`),真源仍只有 markdown 一份。
          <CheckboxInput
            label={r.name}
            isLabelHidden
            size="sm"
            value={r.checked}
            onChange={(next) => check(r, next, () => patchMark(r.mark!, { checked: next }))}
          />
        ) : (
          // 宿主没有回写接缝(web / mobile 壳):画同样的方框但不做成可点的勾选框 ——
          // 给一个勾不动的勾选框比不给更糟。整行点击 = 打开笔记定位到它,在那儿勾。
          <span className={`amx-todo-box${r.checked ? ' on' : ''}`} aria-hidden="true" />
        )}
        <button className="amx-todo-main" title={r.note ? t('todolist.openInNote') : t('todolist.clickToEdit')} onClick={(e) => openRow(r, e)} onKeyDown={rowKeys}>
          <span className={`amx-todo-name${r.checked ? ' done' : ''}`}>{r.name}</span>
          {/* 「在笔记中打开」图标叠在标题后面、悬停才出现,不占日期列的位置(从前占位,笔记行的日期比别的行往左缩一截) */}
          {r.note ? <ExternalLink className="amx-todo-jump" size={12} /> : null}
        </button>
        {wide && srcTag(r)}
        <span className="amx-todo-duecell">
          {!wide && srcTag(r)}
          {r.raw ? <span className={`amx-todo-due ${due.tone}`}>{r.raw.includes('T') && <Clock size={11} />}{due.label}</span> : null}
        </span>
      </li>
    )
  }

  /** 折叠走 CSS 的 `grid-template-rows: 0fr→1fr`(与 base.css 的 .cm-advanced-reveal 同一惯用法)——
   *  所以内容**恒在 DOM 里**,只是被收成 0 高:条件渲染没有可插值的中间态,一定是瞬跳。
   *  代价是折起来的段仍占 DOM 节点(本视图量级是几十到几百行,可接受);真到几千行再谈虚拟化。 */
  const section = (key: string, label: string, items: Row[], body: ReactNode, bucket?: TodoBucket): ReactNode => {
    const open = !collapsed.has(key)
    const drop = bucket ? {
      onDragOver: (e: DragEvent) => { if (canDrop(dragRow.current, bucket)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropAt !== bucket) setDropAt(bucket) } },
      onDragLeave: () => setDropAt((b) => (b === bucket ? null : b)),
      // 放下后这一行换了组(换了父节点 → 重新挂载),原来那个元素收不到 dragend:收尾在这里也做一遍
      onDrop: (e: DragEvent) => { e.preventDefault(); const r = dragRow.current; dragRow.current = null; setDragging(null); setDropAt(null); if (r && canDrop(r, bucket)) reschedule(r, bucket) },
    } : {}
    return (
      <section className="amx-todo-group" key={key}>
        <button className={`amx-todo-ghead${open ? ' is-open' : ''}${dropAt === bucket && bucket ? ' is-drop' : ''}`} onClick={() => toggle(key)} aria-expanded={open} {...drop}>
          <ChevronRight className="amx-todo-caret" size={12} />
          <span className="amx-todo-gname">{label}</span>
          <span className="amx-todo-gcount">{items.length}</span>
        </button>
        <div className={`amx-todo-reveal${open ? ' is-open' : ''}`}>
          <div className="amx-todo-reveal-in">{body}</div>
        </div>
      </section>
    )
  }

  const viewLabel = (v: TodoView): string => t(`todolist.view.${v}`)
  const listName = list.src === 'md' ? t('todolist.noteTasks') : list.db ? (allSources.find((m) => m.db.path === list.db)?.db.name ?? list.db) : ''
  const tick = (on: boolean): ReactNode => (on ? <Check size={14} /> : <span style={{ display: 'inline-block', width: 14 }} />)
  const listItems = (
    <>
      <DropdownMenuItem icon={tick(!list.db && list.src === 'all')} label={t('todolist.allLists')} onClick={() => setList({ src: 'all' })} />
      {allSources.map((m) => (
        <DropdownMenuItem key={m.db.path} icon={list.db === m.db.path ? <Check size={14} /> : <i className="amx-todo-dot amx-todo-menudot" style={{ background: colorOf(m) }} />}
          label={m.db.name} endContent={<span className="amx-todo-menun">{openOf((r) => r.db === m)}</span>} onClick={() => setList({ db: m.db.path, src: 'all' })} />
      ))}
      {hasMd && <DropdownMenuItem icon={list.src === 'md' ? <Check size={14} /> : <FileText size={14} />} label={t('todolist.noteTasks')}
        endContent={<span className="amx-todo-menun">{openOf((r) => !!r.mark)}</span>} onClick={() => setList({ src: 'md' })} />}
    </>
  )
  // 清单菜单只在有得选时出现(不止一个来源)
  const hasLists = allSources.length + (hasMd ? 1 : 0) > 1

  const visible = ORDER.filter((b) => inView(view, b) && (buckets.get(b)?.length || canDrop(dragging, b)))
  const rest = view === 'today' ? ORDER.filter((b) => !inView('today', b) && buckets.get(b)?.length) : []

  return (
    <AstryxScope>
    <div className={`amx-todo${wide ? ' is-wide' : ''}`} ref={rootRef}>
      <div className="amx-todo-col">
      <div className="amx-todo-bar">
        <span className="amx-todo-title">{t('todolist.title')}</span>
        {openCount > 0 && <span className="amx-todo-total">{openCount}</span>}
        <span className="amx-todo-grow" />
        {wide ? (
          <>
            <div className="seg seg-sm amx-todo-seg" role="group" aria-label={t('todolist.viewsLabel')}>
              {VIEWS.map((v) => (
                <button key={v} className={view === v ? 'active' : ''} aria-pressed={view === v} onClick={() => setView(v)}>
                  {viewLabel(v)}<em>{countIn(v)}</em>
                </button>
              ))}
            </div>
            {hasLists && (
              <DropdownMenu button={{ label: listName || t('todolist.allLists'), variant: 'ghost', size: 'sm', icon: <List size={13} /> }} menuWidth={220}>
                {listItems}
              </DropdownMenu>
            )}
          </>
        ) : (
          // 窄档:分段与清单合成一个菜单,按钮写当前的筛选
          <DropdownMenu button={{ label: listName ? t('todolist.filterLabel', { view: viewLabel(view), list: listName }) : viewLabel(view), variant: 'ghost', size: 'sm' }} menuWidth={220}>
            {VIEWS.map((v) => <DropdownMenuItem key={v} icon={tick(view === v)} label={viewLabel(v)} endContent={<span className="amx-todo-menun">{countIn(v)}</span>} onClick={() => setView(v)} />)}
            {hasLists && <div className="amx-cal-menusep" role="separator" />}
            {hasLists && listItems}
          </DropdownMenu>
        )}
      </div>

      {list.src === 'md' ? (
        <div className="amx-todo-addhint">{t('todolist.mdAddHint')}<code>{t('todolist.emptyExample')}</code></div>
      ) : addTarget && (
        <div className={`amx-todo-add${draft ? ' typing' : ''}`}>
          <Plus className="amx-todo-addicon" size={13} />
          <input
            ref={addRef}
            className="amx-todo-addinput"
            placeholder={t(wide ? 'todolist.addPlaceholder' : 'todolist.addPlaceholderShort')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return // 中文输入法选词的回车不算提交(台架抓不到)
              if (e.key === 'Enter') { e.preventDefault(); submitDraft() }
              if (e.key === 'Escape') { setDraft(''); e.currentTarget.blur() }
            }}
          />
          {addTargets.length > 1 && (
            <span className="amx-todo-target">
              <DropdownMenu button={{ label: wide ? addTarget.db.name : t('todolist.addTarget'), isIconOnly: !wide, variant: 'ghost', size: 'sm', icon: <i className="amx-todo-dot" style={{ background: colorOf(addTarget) }} /> }} menuWidth={200}>
                {addTargets.map((m) => (
                  <DropdownMenuItem key={m.db.path} icon={<i className="amx-todo-dot amx-todo-menudot" style={{ background: colorOf(m) }} />} label={m.db.name}
                    endContent={m === addTarget ? <Check size={14} /> : undefined} onClick={() => { setAddTo(m.db.path); addRef.current?.focus() }} />
                ))}
              </DropdownMenu>
            </span>
          )}
          {!draft && <kbd className="amx-cal-panel-kbd">N</kbd>}
          {parsed && (
            <div className="amx-todo-addprev">
              {parsed.value && <span className={`amx-todo-due ${todoDueMeta(parsed.value, today).tone}`}>{parsed.value.includes('T') && <Clock size={11} />}{todoDueMeta(parsed.value, today).label}</span>}
              <span>{t('todolist.addTo', { name: addTarget.db.name })}</span>
            </div>
          )}
        </div>
      )}

      {everyRow.length === 0 && (
        <div className="amx-todo-empty">
          {t('todolist.emptyTitle')}{!params?.miniSurface && <><br />{t('todolist.emptyHintA')}<code>{t('todolist.emptyExample')}</code>{t('todolist.emptyHintB')}<code>@</code>{t(addTarget ? 'todolist.emptyHintC' : 'todolist.emptyHintCNoAdd')}</>}
        </div>
      )}
      {everyRow.length > 0 && openCount === 0 && (
        <div className="amx-todo-empty">
          {view === 'today' ? t('todolist.todayDone') : view === 'plan' ? t('todolist.planEmpty') : rows.length === 0 ? t('todolist.listEmpty') : t('todolist.allDone')}
        </div>
      )}

      {visible.map((b) => section(b, BUCKET_LABEL[b], buckets.get(b) ?? [], <ul className="amx-todo-list">{(buckets.get(b) ?? []).map(renderRow)}</ul>, b))}
      {rest.length > 0 && (
        <div className="amx-todo-rest">
          {rest.map((b) => t('todolist.restItem', { label: BUCKET_LABEL[b], n: buckets.get(b)!.length })).join(t('todolist.restSep'))}
          {' · '}<button className="amx-todo-link" onClick={() => setView('all')}>{t('todolist.showAll')}</button>
        </div>
      )}
      {/* 已完成只在「全部」下面:「今天 / 计划」是往前看的清单,勾完那一行留 1 秒(可撤)再走 */}
      {view === 'all' && done.length > 0 && section(DONE_KEY, t('todolist.done'), done, <ul className="amx-todo-list">{done.map(renderRow)}</ul>)}
      </div>

      {target && card && <EventCard ev={target} at={card.at} onClose={() => setCard(null)} />}
    </div>
    </AstryxScope>
  )
}
