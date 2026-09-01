/**
 * 结构化网格版 Dashboard(2026-08-27 拍板:「用户能简单拼凑出一个统一、美观的复合 view」)。
 *
 * 与画布版同一份 `.dashboard.md`、同一套块与 widget 围栏,**只换几何语义**——布局键 `dashboard3:`
 * 记 `[order, w, h]`,没有坐标(见 shared/amadeus/dashboard3.ts 顶注)。这一条决定了本文件的全部形状:
 *
 *  · **没有画布**。没有视口、没有平移缩放、没有小地图、没有点阵、没有手势状态机 —— 卡片流进
 *    CSS Grid,位置由排版算出来。旧版第一张锁定态截图那个「拉伸海报 + 大片空洞」的根因就在这:
 *    它按 x/w 与 y/h 各自的百分比映射,那是拉伸;这里是**重排**。
 *  · **两态语义与画布版同源(2026-08-28 用户拍板)**:锁定 = 成品页,内容单击直达;解锁 = 排版台,
 *    **整卡罩层起拖、双击进入卡片**(dash2-shield 同款)。交互态那张卡撤罩,内容恢复原生 ——
 *    「拖哪儿都能拖」与「配置内容」由双击分层,不再靠小把手分面。
 *  · **外壳由本文件画**,不由每个 view 自己画:标题、图标、圆角、内边距、描边、打开按钮全在这层。
 *    这是「统一」的唯一来源(Apple widget 那条:容器归系统,widget 只管内容)。
 *
 * 落盘防线与前两版同源:换页不写 / 坏 YAML 冻结 / 布局与块全不相交停手 / 迁移绝不自动跑。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  BarChart3, Check, Clock, CloudSun, ExternalLink, Hash, Heading, LayoutGrid,
  MoreHorizontal, Pencil, Pin, Plus, Trash2, Type,
} from 'lucide-react'
import type { DashboardCardSize, DashboardCardSurface, ViewProps } from '@lcl/engine'
import { allViews, getView, label, useEdgeNudge, useWorkspace } from '@lcl/engine'
import {
  DndContext, DragOverlay, MeasuringStrategy, MouseSensor, TouchSensor, pointerWithin, useSensor, useSensors,
  type DragMoveEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, type SortingStrategy } from '@dnd-kit/sortable'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useQuickFind } from '../quickFind'
import { fileMatchViewType } from '../viewFileMatch'
import { PageScopeCtx, setActivePageScope, usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { BlockHost } from '@amadeus/components/BlockHost'
import { askString } from '@amadeus/components/askString'
import { dashBaseName, parseWidget, webviewUrlAllowed, widgetSource } from '@amadeus-shared/dashboard'
import {
  DASH3_COLS, DASH3_DEFAULT, DASH3_DEFAULT_MINI, DASH3_DEFAULT_TEXT, DASH3_GAP_PX,
  DASH3_MAX_ROWS, DASH3_ROW_PX, DASH3_SIZES, colsForWidth, dash3BucketOf, dash3MinCell, dash3Size,
  dropIntoRow, grid3IsStale, layoutDash3Rows, nextPinRow, orderedIds, readDash3Layout, readDash3Pins,
  reconcileGrid, reconcilePins, renumber, setDash3InFm, setDash3PinsInFm, setDashModeInFm, spanFor,
  type Cell, type Dash3Layout, type Dash3Pins, type Dash3SizeKey,
} from '@amadeus-shared/dashboard3'
import { DashFiltersCtx } from '@amadeus/dashboard/dashFiltersCtx'
import { useTheme } from '../stores/themeStore'
import { useApp } from '../stores/appStore'
import { useAmadeusPrefs } from '../amadeusPrefs'
import { Breadcrumb } from '../amadeusViews'
import { importToPage } from '../amadeusImport'
import { WidgetCard, localTimeZone } from '@amadeus/dashboard/widgets'
import { readDashFilters, setDashFiltersInFm, type DashFilter } from '@amadeus-shared/dashboardData'
import { EMBED_DENY, ViewCard, ensureChartView, pickSpecOf, viewCardTitle } from './dashboardViewCard'
import { DashFilterBar } from './dashFilterBar'
import '@amadeus/blocks'
import './dashGrid.css'

const ADD_MENU = [
  { key: 'section', label: '分区标题', icon: Heading },
  { key: 'stat', label: '数字卡…', icon: Hash },
  { key: 'chart', label: '图表(多维表)…', icon: BarChart3 },
  { key: 'text', label: '文本块', icon: Type },
  { key: 'clock', label: '时钟', icon: Clock },
  { key: 'weather', label: '天气', icon: CloudSun },
  { key: 'webview', label: '网页', icon: LayoutGrid },
] as const

/** 开箱模板。只用**不需要挑文件**的全局视图 —— 模板要一键就成型,中途弹选择器就不是模板了。 */
const TEMPLATES: Array<{ key: string; name: string; hint: string; cards: Array<{ content: string; w: number; h: number }> }> = [
  {
    key: 'today',
    name: '今日',
    hint: '时钟 · 天气 · 待办 · 日历',
    // 视图卡由 Dashboard 卡片面负责摘要；受控分行会把不同高度族自然拆行。
    cards: [
      { content: widgetSource('section', { title: '今天' }), w: 12, h: 1 },
      { content: widgetSource('clock', {}), w: 6, h: 2 },
      { content: widgetSource('weather', { city: '上海' }), w: 6, h: 2 },
      { content: widgetSource('view', { type: 'todo-list' }), w: 6, h: 5 },
      { content: widgetSource('view', { type: 'calendar' }), w: 6, h: 5 },
    ],
  },
  {
    key: 'work',
    name: '工作台',
    hint: '收件箱 · 待办 · 活动日志',
    cards: [
      { content: widgetSource('section', { title: '在办' }), w: 12, h: 1 },
      { content: widgetSource('view', { type: 'inbox-list' }), w: 6, h: 5 },
      { content: widgetSource('view', { type: 'todo-list' }), w: 6, h: 5 },
      { content: widgetSource('section', { title: '最近' }), w: 12, h: 1 },
      { content: widgetSource('view', { type: 'activity-log' }), w: 12, h: 5 },
    ],
  },
  { key: 'blank', name: '空白', hint: '自己拼', cards: [] },
]

/** 分区标题不是卡片,是页面的排版元素 —— 不给外壳、不给描边、恒整行。 */
const isChrome = (kind: string | undefined): boolean => kind === 'section'

type CardSurface = DashboardCardSurface | 'note' | 'chrome'
interface CardProfile {
  sizes: readonly Dash3SizeKey[]
  defaultSize: Dash3SizeKey
  surface: CardSurface
  /** resize 每轴下界覆盖;缺省 = 声明档各轴最小(dash3MinCell)。 */
  min?: { w: number; h: number }
}

/** 视图卡的通用下界 = 4 格(≈1/3 宽)。判据:整个渲染层本就支持移动端 ~380px 宽,
 *  嵌进 4 格的视图与手机上是同一量级 —— 半宽下界(6)是 08-31 首轮的保守值,用户要更窄。 */
const VIEW_MIN = { w: 4, h: 3 }
const DEFAULT_VIEW_PROFILE: CardProfile = { sizes: ['lg', 'full'], defaultSize: 'lg', surface: 'workspace', min: VIEW_MIN }
const WIDGET_PROFILES: Record<string, CardProfile> = {
  section: { sizes: ['full'], defaultSize: 'full', surface: 'chrome' },
  clock: { sizes: ['sm', 'wide'], defaultSize: 'sm', surface: 'metric' },
  weather: { sizes: ['sm', 'wide'], defaultSize: 'sm', surface: 'metric' },
  stat: { sizes: ['sm', 'md', 'wide'], defaultSize: 'sm', surface: 'metric' },
  chart: { sizes: ['wide', 'lg', 'full'], defaultSize: 'wide', surface: 'summary', min: { w: 4, h: 2 } },
  webview: { sizes: ['lg', 'full'], defaultSize: 'lg', surface: 'workspace', min: VIEW_MIN },
  text: { sizes: ['md', 'wide', 'lg', 'full'], defaultSize: 'wide', surface: 'note' },
}

/** 该卡 resize 的每轴下界:registry/profile 显式覆盖优先,否则取声明档各轴最小。 */
const minOf = (profile: CardProfile): { w: number; h: number } => profile.min ?? dash3MinCell(profile.sizes)

/** 卡片类型 → 真正支持的尺寸与视觉表面。未知 view 缺省 lg/full 两档 + 视图通用下界。 */
function profileOf(content: string): CardProfile {
  const widget = parseWidget(content)
  if (widget?.kind === 'view') {
    const card = getView(widget.opts.type ?? '')?.dashboard
    return card
      ? { sizes: card.sizes, defaultSize: card.defaultSize, surface: card.surface ?? 'workspace', min: card.min ?? VIEW_MIN }
      : DEFAULT_VIEW_PROFILE
  }
  return WIDGET_PROFILES[widget?.kind ?? 'text'] ?? WIDGET_PROFILES.text
}

const cellForSize = (key: Dash3SizeKey, order = 0): Cell => {
  const size = dash3Size(key)
  return { order, w: size.w, h: size.h }
}

/** dnd-kit 的排序 strategy 一律关掉:`rectSortingStrategy` 假设「等尺寸槽位换座」,对
 *  变尺寸卡片 + DP 行编排的预测精度是零(上游 issue #720 的场景)。让位动画的真身是
 *  「onDragOver 实时改预览序 → 重跑编排 → framer layout FLIP」,与 RGL/HA 同一条路。 */
const NO_SORT: SortingStrategy = () => null

/** 列表拖拽的通用直觉:往后拖 = 落在目标之后,往前拖 = 落在目标之前。预览与落笔共用这一个函数。 */
function reorderSeq(seq: string[], from: string, over: string): string[] {
  const a = seq.indexOf(from)
  const b = seq.indexOf(over)
  if (a < 0 || b < 0 || a === b) return seq
  const next = seq.filter((x) => x !== from)
  next.splice(a < b ? next.indexOf(over) + 1 : next.indexOf(over), 0, from)
  return next
}

/** 几何 → 摘要面 bucket:自由格下尺寸多半不等于任何具名档,取**最近**那档喂给卡片面。 */
const sizeOfCell = (cell: Cell, allowed: readonly Dash3SizeKey[]): Dash3SizeKey =>
  dash3BucketOf(cell, allowed) ?? allowed[0] ?? 'lg'

/** 页面级筛选的稳定空值:别让 `?? []` 每帧换身份把全部图表卡拖着重渲染。 */
const NO_FILTERS: DashFilter[] = []
const NO_PINS: Dash3Pins = {}

const samePins = (a: Dash3Pins | null, b: Dash3Pins): boolean => {
  if (!a) return false
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] && a[k].row === b[k].row && a[k].col === b[k].col)
}

export function DashboardGridView(props: ViewProps) {
  return (
    <PageScopeCtx.Provider value={props.leaf.id}>
      <GridInner {...props} />
    </PageScopeCtx.Provider>
  )
}

function GridInner({ leaf }: ViewProps) {
  const store = useScopedPageStore()
  const dashPath = typeof leaf.params.dashPath === 'string' ? leaf.params.dashPath : ''
  const locked = leaf.params.locked !== false
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  const manifest = usePageStore((s) => s.manifest)
  const blocks = usePageStore((s) => s.blocks)
  const activePage = usePageStore((s) => s.activePage)
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  const pinned = useAmadeusPrefs((s) => !!dashPath && s.pins.includes(dashPath))
  const reduceMotion = useReducedMotion()

  const [addMenu, setAddMenu] = useState(false)
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number } | null>(null)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const addMenuFix = useEdgeNudge(addMenu)
  const noteMenuFix = useEdgeNudge(noteMenu ? `${noteMenu.x},${noteMenu.y}` : '')
  const cardMenuFix = useEdgeNudge(cardMenu ? `${cardMenu.x},${cardMenu.y}` : '')
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => { if (dashPath) leaf.setTitle(dashBaseName(dashPath)) }, [dashPath]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dashPath && dashPath !== store.getState().activePage) void store.getState().loadPage(dashPath)
  }, [dashPath]) // eslint-disable-line react-hooks/exhaustive-deps
  const isActiveLeaf = useWorkspace((s) => s.mainTabs.find((t) => t.id === leaf.id)?.active ?? false)
  useEffect(() => { if (isActiveLeaf) setActivePageScope(leaf.id) }, [isActiveLeaf, leaf.id])
  // ⚠️ scope 的**销毁**归路由(DashboardView),不归这里:grid ↔ canvas 互换时两个子视图管同一个
  //    scope,旧的 cleanup 会把新的正在用的 store 摘成孤儿(Codex 2026-08-27 评审 P1)。

  const ids = useMemo(() => {
    if (!manifest) return []
    const out: string[] = []
    for (const row of manifest.root.children) for (const col of row.columns) for (const r of col.children) out.push(r.ref)
    return out
  }, [manifest])

  const read3 = useMemo(() => readDash3Layout(fmExtra), [fmExtra])
  const layout: Dash3Layout = read3.ok ? read3.layout : {}
  // 「自由摆位 → 自动排版」的迁移横幅住在**画布版**里(路由把带 dashboard2: 的老文件送去那边),
  // 这里不会遇到待迁移的文件。
  const stale = read3.ok && grid3IsStale(layout, ids)
  /** 手工行位。读不懂只**停掉 pin 的写入**、整页按自动排版渲染 —— 卡一张不少,不像布局键那样必须冻结。 */
  const readPins = useMemo(() => readDash3Pins(fmExtra), [fmExtra])
  const pins: Dash3Pins = readPins.ok ? readPins.pins : NO_PINS
  /** 页面级筛选:一处改、全页跟随。读不懂就当没有筛选 —— 它只影响取数,不像布局那样丢了就回不来。 */
  const readFilters = useMemo(() => readDashFilters(fmExtra), [fmExtra])
  const dashFilters: DashFilter[] = readFilters.ok ? readFilters.filters : NO_FILTERS

  /** 这一笔改动归谁 = **这一份文档的整页装载身份**(`pageStore.loadNonce`,每次整页 hydrate ——
   *  换页 / 改名 / 外部回灌 —— 都换新对象)。
   *  ⚠️ 只比 `activePage === dashPath` 挡不住:A→B→A 往返、或云同步把同一路径整页回灌之后,
   *  路径相同、块 id 也都从 1 起,「路径对不对 / id 在不在」两道检查**都会通过**,在途手势的旧几何
   *  就写进了新文档。画布版早有这条防线,网格版一开始漏了(Codex 2026-08-27 评审)。 */
  const identity = (): unknown => {
    const st = store.getState()
    return st.activePage === dashPath ? st.loadNonce : null
  }

  /** `expect` 在场 = 这是一笔**在途手势的落笔**,必须与起手时的身份逐字一致,否则整笔作废。 */
  const writeFm = (next: string | null, expect?: unknown): boolean => {
    const st = store.getState()
    if (st.activePage !== dashPath) return false // 换页/已删 → 绝不写进别人的笔记
    if (expect !== undefined && (expect === null || st.loadNonce !== expect)) return false
    const cur = st.manifest?.fmExtra ?? ''
    if (next === null || next === cur) return false
    st.setFmExtra(next)
    return true
  }
  const applyLayout = (next: Dash3Layout, expect?: unknown): boolean =>
    writeFm(setDash3InFm(store.getState().manifest?.fmExtra ?? '', next), expect)
  /** 布局现读:落笔要对**当下**磁盘那份判,不能用渲染闭包里的旧值(画布版同源纪律)。 */
  const freshLayout = (): Dash3Layout | null => {
    const r = readDash3Layout(store.getState().manifest?.fmExtra ?? '')
    return r.ok ? r.layout : null
  }

  // 自愈:补新块(接末尾)、清孤儿、稠密重编号。迁移待决 / 坏 YAML / 布局对不上 → 一律停手。
  // 布局与 pin 串在**同一份 fmExtra** 上一次写完:两笔会拆两个 undo 步,中间态还会被外部回灌撞上。
  useEffect(() => {
    if (!manifest || activePage !== dashPath || !ids.length) return
    if (!read3.ok || stale) return
    const nextLayout = reconcileGrid(layout, ids)
    const nextPins = readPins.ok ? reconcilePins(pins, ids) : null
    if (!nextLayout && !nextPins) return
    let fm = store.getState().manifest?.fmExtra ?? ''
    if (nextLayout) fm = setDash3InFm(fm, nextLayout) ?? fm
    if (nextPins) fm = setDash3PinsInFm(fm, nextPins) ?? fm
    writeFm(fm)
  }, [ids, layout, pins, manifest, activePage, dashPath, read3.ok, readPins.ok, stale]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 响应式列数:唯一的「几何计算」。窗口宽度 → 12 的偶因数里放得下的最大那档。
  const hostRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridW, setGridW] = useState(0)
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    // ⚠️ 量的是**内容宽**:`.dash3-grid` 两侧有页面留白,拿 clientWidth 会把 padding 也算成列宽,
    //    列数档位与把手的量化阈值都会漂(Codex 2026-08-27 评审)。ResizeObserver 的 contentRect 已扣掉。
    const ro = new ResizeObserver(([entry]) => setGridW(entry.contentRect.width))
    ro.observe(el)
    const cs = getComputedStyle(el)
    setGridW(el.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0'))
    return () => ro.disconnect()
  }, [])
  const cols = colsForWidth(gridW)
  const cellW = cols > 0 ? (gridW - DASH3_GAP_PX * (cols - 1)) / cols : 0

  const ordered = useMemo(() => orderedIds(layout, ids), [layout, ids])

  // ── 调整大小:右下角把手,按格量化。无级 resize 是「统一」的敌人,量化后任意组合天然对齐。
  const [sizing, setSizing] = useState<{ id: string; w: number; h: number } | null>(null)
  const visualCellsRef = useRef(new Map<string, Cell>())
  /** ⚠️ 在途尺寸必须同时进 ref:松手那一下如果与最后一次 move 同批,从 state 闭包里读到的还是上一格
   *  (Codex 2026-08-27 评审)。state 只用来驱动渲染,**落笔一律读 ref**。 */
  const sizingRef = useRef<{ id: string; w: number; h: number } | null>(null)
  const sizeRef = useRef<{ id: string; pointerId: number; nonce: unknown; x: number; y: number; w: number; h: number } | null>(null)
  const onGripDown = (e: React.PointerEvent, id: string): void => {
    if (locked || sizeRef.current) return // 已有一笔在途 → 第二根指头不许插队
    e.preventDefault()
    e.stopPropagation()
    const profile = profileOf(blocks[id]?.content ?? '')
    // 自动编排可能让「存下的偏好」临时换成更合群的一档；resize 必须从屏幕上这档起步，
    // 否则按下把手的一瞬间卡片会先跳回存储尺寸，再开始拖。
    const min = minOf(profile)
    const base = layout[id] ?? cellForSize(profile.defaultSize)
    const cur = visualCellsRef.current.get(id) ?? { ...base, w: Math.max(min.w, base.w), h: Math.max(min.h, base.h) }
    sizeRef.current = { id, pointerId: e.pointerId, nonce: identity(), x: e.clientX, y: e.clientY, w: cur.w, h: cur.h }
    sizingRef.current = { id, w: cur.w, h: cur.h }
    setSizing({ id, w: cur.w, h: cur.h })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onGripMove = (e: React.PointerEvent): void => {
    const s = sizeRef.current
    if (!s || s.pointerId !== e.pointerId || cellW <= 0) return // 别的指头别来推进这一笔
    const startSpan = spanFor(s.w, cols)
    const pxW = startSpan * cellW + (startSpan - 1) * DASH3_GAP_PX + (e.clientX - s.x)
    const span = Math.max(1, Math.min(cols, Math.round((pxW + DASH3_GAP_PX) / (cellW + DASH3_GAP_PX))))
    // 实际跨度 → 12 列参考跨度(存的永远是参考系,换个窗宽比例才守得住)
    const w = Math.max(1, Math.min(DASH3_COLS, Math.round((span * DASH3_COLS) / cols)))
    const pxH = s.h * DASH3_ROW_PX + (s.h - 1) * DASH3_GAP_PX + (e.clientY - s.y)
    const h = Math.max(1, Math.min(DASH3_MAX_ROWS, Math.round((pxH + DASH3_GAP_PX) / (DASH3_ROW_PX + DASH3_GAP_PX))))
    const profile = profileOf(blocks[s.id]?.content ?? '')
    // 自由格(2026-08-31 拍板):把手可停任意整数格,只保每轴下界 —— 比最小声明档更小的
    // 形状,这张卡的内容面没有承诺能装下。不再吸具名档。
    const min = minOf(profile)
    const fitted = { w: Math.max(min.w, w), h: Math.max(min.h, h) }
    sizingRef.current = { id: s.id, w: fitted.w, h: fitted.h }
    setSizing((cur) => (cur && cur.w === fitted.w && cur.h === fitted.h ? cur : { id: s.id, w: fitted.w, h: fitted.h }))
  }
  const onGripUp = (e?: React.PointerEvent): void => {
    const s = sizeRef.current
    if (s && e && s.pointerId !== e.pointerId) return
    const live = sizingRef.current // ⚠️ 读 ref 不读 state(见 sizingRef 的注释)
    sizeRef.current = null
    sizingRef.current = null
    setSizing(null)
    if (!s || !live) return
    if (live.w === s.w && live.h === s.h) return
    const cur = freshLayout()
    if (!cur || !cur[s.id]) return // 手势期间这张卡没了 → 别把它写回来
    applyLayout({ ...cur, [s.id]: { ...cur[s.id], w: live.w, h: live.h } }, s.nonce)
  }

  /** 手工行的回头路(pin 否则是单行道):把这一行整行交回自动编排器。 */
  const releaseRow = (id: string): void => {
    const cur = readDash3Pins(store.getState().manifest?.fmExtra ?? '')
    if (!cur.ok || !cur.pins[id]) return
    const row = cur.pins[id].row
    const next: Dash3Pins = {}
    for (const [k, v] of Object.entries(cur.pins)) if (v.row !== row) next[k] = v
    writeFm(setDash3PinsInFm(store.getState().manifest?.fmExtra ?? '', next))
  }

  const setCardSize = (id: string, w: number, h: number): void => {
    const cur = freshLayout()
    if (!cur || !cur[id]) return
    applyLayout({ ...cur, [id]: { ...cur[id], w, h } })
  }

  // ── 拖拽重排:拖动中 onDragOver 实时改**预览序**,编排重跑、其它卡由 framer layout FLIP
  //    真实让位(RGL/Home Assistant 同款);跟手的是 DragOverlay 里的壳,原卡降透明度当落点
  //    占位。松手才落盘 —— 预览与最终布局同源,零跳变。
  // 鼠标 4px 起拖;触屏按住 150ms 才起拖(Home Assistant 的 delayOnTouchOnly 口径)——
  // 手指第一职责是滚页面,不加延迟就会和滚动抢手指。
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  )
  const [dragId, setDragId] = useState<string | null>(null)
  /** 排版台的交互态(画布同款):罩层整卡可拖,**双击**才进卡片;interactId 那张卡撤罩、内容原生。 */
  const [interactId, setInteractId] = useState<string | null>(null)
  // 锁定翻真必须 useLayoutEffect 清交互态(画布版同一条纪律,勿改成普通 effect)。
  useLayoutEffect(() => { if (locked) setInteractId(null) }, [locked])
  const [previewSeq, setPreviewSeq] = useState<string[] | null>(null)
  const previewRef = useRef<string[] | null>(null)
  const [previewPins, setPreviewPins] = useState<Dash3Pins | null>(null)
  const previewPinsRef = useRef<Dash3Pins | null>(null)
  /** 这一笔拖拽新占的行号(拖动全程恒定,否则每帧换号 = pin 抖动);落点格的滞回也在这。 */
  const dragRowKeyRef = useRef(0)
  const dropRef = useRef<{ band: number; col: number } | null>(null)
  /** 渲染算好的行带与各卡的 12 列参考位 —— 坐标路要读它把指针换成 (行, 列)。 */
  const geomRef = useRef<{ bands: Array<{ top: number; h: number; ids: string[] }>; byId: Map<string, { col: number; w: number }> }>({ bands: [], byId: new Map() })
  /** 拖起那一刻冻结各卡的观感档位当 preferred:预览重排时 DP 少改档,画面噪声小。 */
  const dragCellsRef = useRef<Map<string, Cell> | null>(null)
  const dragNonce = useRef<unknown>(null)
  /** ⚠️ body 端级 zoom ≠ 1 时 DragOverlay 的 fixed 坐标整体被再乘一次 zoom(壳脱离指针,
   *  探针实测 ×1.25 漂移)。反补偿 = 给 overlay 包一层 1/zoom;倍率用实测 rect/offsetWidth
   *  比值(本仓惯用法,勿用 zoomOf)。 */
  const overlayZoomRef = useRef(1)
  const onDragStart = (e: DragStartEvent): void => {
    dragNonce.current = identity()
    setInteractId(null) // 起拖 = 回到排版语境,别让一张卡还开着交互态
    dragCellsRef.current = new Map(visualCellsRef.current)
    const el = gridRef.current
    const z = el && el.offsetWidth > 0 ? el.getBoundingClientRect().width / el.offsetWidth : 1
    overlayZoomRef.current = Math.abs(z - 1) < 0.005 ? 1 : z
    dragRowKeyRef.current = nextPinRow(pins)
    dropRef.current = null
    previewPinsRef.current = null
    setDragId(String(e.active.id))
  }
  const setPreviewPinsIfNew = (next: Dash3Pins): void => {
    if (samePins(previewPinsRef.current, next)) return
    previewPinsRef.current = next
    setPreviewPins(next)
  }
  const onDragOver = (e: DragOverEvent): void => {
    const from = String(e.active.id)
    const over = e.over ? String(e.over.id) : null
    if (!over || over === from) return
    // 落在别的卡身上 = 老的顺序重排语义(G19 七条押着,一个字节不改)。被拖的那张顺势
    // **退出手工行**回自动流 —— 它已经离开原来那一行了,留着 pin 就是两条路打架。
    dropRef.current = null
    const cleared = { ...pins }
    delete cleared[from]
    setPreviewPinsIfNew(cleared)
    // diff 短路:目标序没变就不 setState(实时重排的 re-render 风暴由这一行挡住)。
    const seq = previewRef.current ?? ordered
    const next = reorderSeq(seq, from, over)
    if (next.join('\n') === seq.join('\n')) return
    previewRef.current = next
    setPreviewSeq(next)
  }
  /** 空白落点(这轮新增):指针不在任何卡上时,把它换算成 (行带, 列) 摆进那一行,同行邻居
   *  实时让位、行尾放不下的退回自动流 = 视觉上挤到下一行(用户拍板三条)。
   *  ⚠️ 两个坐标系:cellW 来自 contentRect(CSS px),rect 来自 getBoundingClientRect(视觉 px)。
   *  端级 zoom ≠ 1 时混算就是 DragOverlay 那次 ×1.25 漂移的同族 —— 一律先除掉起手实测的倍率。 */
  const onDragMove = (e: DragMoveEvent): void => {
    const id = String(e.active.id)
    if (e.over && String(e.over.id) !== id) return // 卡上归 order 路(自己的占位不算)
    if (isChrome(parseWidget(blocks[id]?.content ?? '')?.kind)) return // 分区标题恒整行,给它记行位是死键
    if (!readPins.ok) return // 行位读不懂 = 这一笔落不了盘;别让手势看着能用、松手弹回
    const rect = e.active.rect.current.translated
    const host = gridRef.current
    const grid = host?.getBoundingClientRect()
    const self = geomRef.current.byId.get(id)
    if (!rect || !host || !grid || !self || cellW <= 0) return
    // 行/列的原点是**内容盒**,不是边框盒:`.dash3-grid` 两侧有页面留白(gridW 也是扣掉它量的)。
    const cs = getComputedStyle(host)
    const z = overlayZoomRef.current
    // 列锚 = 卡片左沿(它就是要落进的那一格),行锚 = **指针**:高卡的几何中心离手指能有两百多像素,
    // 拿中心判行会挑中手指根本没在的那一行(探针实证)。指针也正是 pointerWithin 判「在不在卡上」
    // 用的点 —— 两条路同一个锚才不会互相打架。
    const act = e.activatorEvent as { clientY?: number; touches?: ArrayLike<{ clientY: number }> } | null
    const startY = typeof act?.clientY === 'number' ? act.clientY : act?.touches?.[0]?.clientY // 触屏是 TouchEvent
    const pointerY = typeof startY === 'number' ? startY + e.delta.y : rect.top + rect.height / 2
    const x = (rect.left - grid.left) / z - parseFloat(cs.paddingLeft || '0')
    const y = (pointerY - grid.top) / z - parseFloat(cs.paddingTop || '0')
    const unit = DASH3_ROW_PX + DASH3_GAP_PX
    const band = geomRef.current.bands.findIndex((b) => y >= b.top && y < b.top + b.h * unit)
    if (band < 0) return
    const actual = Math.round(x / (cellW + DASH3_GAP_PX))
    const col = Math.max(0, Math.min(DASH3_COLS - self.w, Math.round((actual * DASH3_COLS) / cols)))
    // 滞回:落点格没变就不重算(band 边界会随预览重排移动,不挡就是 A↔B 振荡 —— closestCenter
    // 当年 Maximum update depth 的同族,坐标路里没有 pointerWithin 的自稳性可借)。
    if (dropRef.current && dropRef.current.band === band && dropRef.current.col === col) return
    dropRef.current = { band, col }
    const members = geomRef.current.bands[band].ids.filter((m) => m !== id)
    if (members.some((m) => isChrome(parseWidget(blocks[m]?.content ?? '')?.kind))) return // 分区标题恒整行
    // ⚠️ 基线取**上一帧的预览**而不是磁盘那份:被顶出行尾的卡下一帧就不在这个 band 里了,
    //    拿磁盘基线重算等于把它的旧行位又发回去 —— 渲染上它已经在下一行,存的却还是老列位
    //    (仪器实证:pin 该没了却还是 [1,6])。逐出是累积的,与「松手即定」同向。
    const next = dropIntoRow(previewRef.current ?? ordered, previewPinsRef.current ?? pins, [
      { id, col, w: self.w }, // 正在拖的放首位:平手时「我挤进来、你让开」
      ...members.map((m) => ({ id: m, col: geomRef.current.byId.get(m)?.col ?? 0, w: geomRef.current.byId.get(m)?.w ?? 1 })),
    ], dragRowKeyRef.current)
    setPreviewPinsIfNew(next.pins)
    if (next.ids.join('\n') === (previewRef.current ?? ordered).join('\n')) return
    previewRef.current = next.ids
    setPreviewSeq(next.ids)
  }
  /** Esc 取消拖拽:预览序整份丢弃,卡片 FLIP 回原位;不清 dragId 的话那张卡会一直挂着
   *  data-dragging 的透明度与层级(Codex 评审)。 */
  const endDrag = (): { nonce: unknown; seq: string[] | null; pins: Dash3Pins | null } => {
    const out = { nonce: dragNonce.current, seq: previewRef.current, pins: previewPinsRef.current }
    dragNonce.current = null
    previewRef.current = null
    previewPinsRef.current = null
    dragCellsRef.current = null
    dropRef.current = null
    setDragId(null)
    setPreviewSeq(null)
    setPreviewPins(null)
    return out
  }
  const onDragCancel = (): void => { endDrag() }
  const onDragEnd = (): void => {
    const { nonce, seq, pins: nextPins } = endDrag()
    // ⚠️ 「行内平移」这一支顺序压根没变(previewSeq 恒 null),不能被 `if (!seq) return` 吞掉 ——
    //    实证:第一版就是这样把 pin 落盘整个丢了(探针里 frontmatter 一个字节没动)。
    if (!seq && !nextPins) return // 没经过任何 over / 空白落点 → 什么都没动
    const cur = freshLayout()
    if (!cur) return
    // 预览序 → 落盘:只认当下真实存在的块,拖拽期间新出现的块接末尾,renumber 保 order 稠密。
    const present = (seq ?? ordered).filter((id) => ids.includes(id))
    for (const id of ids) if (!present.includes(id)) present.push(id)
    const orderMoved = present.join('\n') !== ordered.join('\n')
    // 行内平移不改顺序,只改 pin —— 这一支不能被 order 短路吞掉。
    const pinMoved = !!nextPins && readPins.ok && !samePins(nextPins, pins)
    if (!orderMoved && !pinMoved) return
    let fm = store.getState().manifest?.fmExtra ?? ''
    if (orderMoved) fm = setDash3InFm(fm, renumber(cur, present)) ?? fm
    if (pinMoved) fm = setDash3PinsInFm(fm, nextPins!) ?? fm
    writeFm(fm, nonce) // 两个键一次落笔:一个 undo 步,没有能被回灌撞上的中间态
  }

  // ── 加卡
  const insertCard = (content: string, size: Cell): string | null => {
    const st = store.getState()
    if (st.activePage !== dashPath) return null
    const last = ids[ids.length - 1] ?? null
    const id = st.insertBlockAfter(last, undefined, content)
    if (!id) return null
    const fresh = readDash3Layout(store.getState().manifest?.fmExtra ?? '')
    if (fresh.ok) {
      const order = Object.values(fresh.layout).reduce((m, c) => Math.max(m, c.order + 1), 0)
      applyLayout({ ...fresh.layout, [id]: { order, w: size.w, h: size.h } })
    }
    return id
  }

  const addCard = (kindKey: (typeof ADD_MENU)[number]['key']): void => {
    setAddMenu(false)
    void (async () => {
      if (kindKey === 'text') { insertCard('', DASH3_DEFAULT_TEXT); return }
      if (kindKey === 'section') {
        const title = await askString('分区标题', '新分区')
        if (!title?.trim()) return
        insertCard(widgetSource('section', { title: title.trim() }), { order: 0, w: 12, h: 1 })
        return
      }
      if (kindKey === 'clock') { insertCard(widgetSource('clock', { tz: localTimeZone() }), DASH3_DEFAULT_MINI); return }
      if (kindKey === 'weather') {
        const city = await askString('天气卡片 — 城市', '上海')
        if (!city?.trim()) return
        insertCard(widgetSource('weather', { city: city.trim() }), DASH3_DEFAULT_MINI)
        return
      }
      if (kindKey === 'stat') { await addDataCard(); return }
      if (kindKey === 'chart') { await addChartCard(); return }
      const url = await askString('网页卡片 — 地址', 'https://')
      if (!url?.trim()) return
      if (!webviewUrlAllowed(url.trim())) {
        useApp.getState().toast('只允许公网 http(s) 地址(拒绝 file/data、localhost 与内网)', true)
        return
      }
      insertCard(widgetSource('webview', { url: url.trim() }), DASH3_DEFAULT)
    })()
  }

  /** 挑一份 `.db`(复用快速查找,勿另造 picker)。 */
  const pickDb = (title: string): Promise<string | null> =>
    new Promise((resolve) => {
      useQuickFind.getState().openPicker({
        title,
        accept: (_k: string, p: string) => fileMatchViewType(p) === 'amadeus-db',
        onPick: (p: string) => resolve(p),
      })
    })

  /** 数字卡:挑 `.db` 后只问必填项;更细的配置去笔记里改那段围栏 —— 给人读的纯文本。 */
  const addDataCard = async (): Promise<void> => {
    const path = await pickDb('数字卡 — 选一份多维表(.db)…')
    if (!path) return
    const col = (await askString('统计哪一列?(留空 = 数行数)', ''))?.trim() ?? ''
    if (!col) { insertCard(widgetSource('stat', { source: path }), DASH3_DEFAULT_MINI); return }
    const stat = (await askString('统计方式(count/sum/avg/min/max)', 'sum'))?.trim()
    if (!stat) return
    insertCard(widgetSource('stat', { source: path, col, stat }), DASH3_DEFAULT_MINI)
  }

  /** 图表 = 多维表的 chart 视图(Notion 模型,2026-08-31 拍板):挑 `.db` → 保证其上有一个
   *  图表视图 → 插一张 db 视图卡并激活该视图。配置(分组/聚合/图形)在卡里用真实下拉改,
   *  告别盲打列名;旧 chart 围栏卡照常渲染,只从加卡菜单退场。 */
  const addChartCard = async (): Promise<void> => {
    const path = await pickDb('图表 — 选一份多维表(.db)…')
    if (!path) return
    const viewName = await ensureChartView(path)
    insertCard(
      widgetSource('view', { type: 'amadeus-db', dbPath: path, ...(viewName ? { view: viewName } : {}) }),
      cellForSize('lg'),
    )
  }

  /** 可嵌视图清单:宿主 `embeddable` 白名单(插件自声明不足信 → 插件 view 目前恒不在列)。 */
  const viewItems = useMemo(
    () => allViews()
      .filter((v) => v.embeddable && !EMBED_DENY.has(v.type))
      .map((v) => ({ type: v.type, name: label(v.displayName), Icon: v.icon ?? LayoutGrid, spec: pickSpecOf(v, fileMatchViewType) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [addMenu], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const addViewCard = (item: (typeof viewItems)[number]): void => {
    setAddMenu(false)
    const def = getView(item.type)
    const initial = cellForSize((def?.dashboard?.defaultSize ?? DEFAULT_VIEW_PROFILE.defaultSize) as Dash3SizeKey)
    if (!item.spec) { insertCard(widgetSource('view', { type: item.type }), initial); return }
    const { param, accept } = item.spec
    useQuickFind.getState().openPicker({
      title: `选择要放进「${item.name}」卡片的文件…`,
      accept,
      onPick: (path) => { insertCard(widgetSource('view', { type: item.type, [param]: path }), initial) },
    })
  }

  const applyTemplate = (t: (typeof TEMPLATES)[number]): void => {
    const st = store.getState()
    if (st.activePage !== dashPath || !t.cards.length) return
    // ⚠️ 读不懂就**停手**。`freshLayout() ?? {}` 会把「合法 YAML 的坏布局」当成空布局,插完块再整份
    //    重写 —— 用户原来的布局当场永久丢失,正是三态冻结要挡的那件事(Codex 2026-08-27 评审)。
    const base = freshLayout()
    if (!base) { useApp.getState().toast('这份笔记的布局读不出来,已停手 —— 请先修好 frontmatter', true); return }
    let after: string | null = ids[ids.length - 1] ?? null
    const next: Dash3Layout = { ...base }
    let order = Object.values(next).reduce((m, c) => Math.max(m, c.order + 1), 0)
    for (const card of t.cards) {
      const id = st.insertBlockAfter(after, undefined, card.content)
      if (!id) break
      next[id] = { order: order++, w: card.w, h: card.h }
      after = id
    }
    applyLayout(next)
  }

  const removeCard = (id: string): void => {
    if (store.getState().activePage !== dashPath) return
    void store.getState().deleteBlock(id) // 布局键交给自愈清(deleteBlock 有反链二次确认)
  }

  const setFilters = (next: DashFilter[]): void => {
    writeFm(setDashFiltersInFm(store.getState().manifest?.fmExtra ?? '', next))
  }

  /** 退回自由摆位(高级)。写模式键即可 —— dashboard2: 一直在文件里,没丢过。 */
  const switchToCanvas = (): void => {
    setNoteMenu(null)
    writeFm(setDashModeInFm(store.getState().manifest?.fmExtra ?? '', 'canvas'))
  }

  if (!dashPath) return <div className="amx-draw-state">未指定仪表盘文件。</div>

  const cardOf = (id: string): { widget: ReturnType<typeof parseWidget>; title: string | null; Icon: typeof LayoutGrid | null; openable: null | (() => void) } => {
    const widget = parseWidget(blocks[id]?.content ?? '')
    if (widget?.kind !== 'view') return { widget, title: null, Icon: null, openable: null }
    const t = widget.opts.type ?? ''
    const def = getView(t)
    if (!def) return { widget, title: `视图「${t}」不可用`, Icon: LayoutGrid, openable: null }
    const { type: _t, ...params } = widget.opts
    return {
      widget,
      title: viewCardTitle(widget.opts, label(def.displayName)),
      Icon: def.icon ?? LayoutGrid,
      openable: () => useWorkspace.getState().openView(t, params, 'main', { newTab: true }),
    }
  }

  const renderBody = (id: string, size: DashboardCardSize): ReactNode => {
    const widget = parseWidget(blocks[id]?.content ?? '')
    if (widget?.kind === 'view') {
      const t = widget.opts.type ?? ''
      // ⚠️ 白名单必须在**渲染入口**复查:卡片源码是 md 文本,同步/共享/手写都能塞任意注册键。
      const def = getView(t)
      if (!def || EMBED_DENY.has(t) || !def.embeddable) {
        return <div className="dash-widget"><div className="dash-widget-note">视图「{t}」不支持嵌入卡片</div></div>
      }
      return <ViewCard dashLeafId={leaf.id} dashPath={dashPath} blockId={id} opts={widget.opts} size={size} onClose={() => removeCard(id)} />
    }
    if (widget) return <WidgetCard widget={widget} filters={dashFilters} />
    // 布局锁只控制排版控件；内容在两态里都可编辑。拖拽只从专用把手开始，不再覆盖正文。
    return <BlockHost blockId={id} />
  }

  // 拖动中按预览序渲染;预览里缺的块(拖拽期间新插的)接末尾,保证一个都不丢。
  const displaySeq = ((): string[] => {
    if (!previewSeq) return ordered
    const present = previewSeq.filter((id) => ids.includes(id))
    for (const id of ordered) if (!present.includes(id)) present.push(id)
    return present
  })()

  const effPins = previewPins ?? pins
  const composedRows = layoutDash3Rows(displaySeq.map((id) => {
    const profile = profileOf(blocks[id]?.content ?? '')
    const stored = layout[id] ?? cellForSize(profile.defaultSize)
    const frozen = dragCellsRef.current?.get(id)
    const base = frozen ? { ...stored, w: frozen.w, h: frozen.h } : stored
    const live = sizing?.id === id ? { ...base, ...sizing } : base
    const chrome = isChrome(parseWidget(blocks[id]?.content ?? '')?.kind)
    // ⚠️ 自定义档必须夹每轴下界:存量布局里低于最小声明档的尺寸(旧文件/手写)不许被
    //    「合法化」,否则内容面没承诺装下的形状会渲染出来,把手还会在起拖瞬间幽灵进档。
    const min = minOf(profile)
    const custom = { key: sizeOfCell(live, profile.sizes), w: Math.max(min.w, live.w), h: Math.max(min.h, live.h) }
    // **手调过的卡,尺寸是铁的**(2026-08-31 打回后收窄):存值 ≠ 该卡默认档 = 用户表过态,
    // choices 只剩它自己 —— DP 只排版,绝不把手调宽高换成「更合群」的档(此前空列代价 2.25/列
    // vs 距离 2/格,拼行几乎恒赢 → 松手弹回,resize 形同虚设 = 用户实报)。
    // 还在默认档的卡(从没动过/模板刚落)保留具名档备选,自动拼行照旧(拍板保留的 DP 观感)。
    // 摆过位置(有 pin)同样蕴含「尺寸是铁的」:DP 换档会当场把手工行的列位算错。
    const def = dash3Size(profile.defaultSize)
    const untouched = !effPins[id] && (!layout[id] || (layout[id].w === def.w && layout[id].h === def.h))
    const choices = sizing?.id === id || !untouched
      ? [custom]
      : [custom, ...profile.sizes.map((key) => dash3Size(key)).filter((s) => s.w !== custom.w || s.h !== custom.h)]
    return { id, preferred: live, choices, chrome }
  }), effPins, cols)

  /** 编排行 → 单一 CSS Grid 的显式坐标。**只有一个 grid 容器、卡片永不换父** —— 跨行移动
   *  因此是同一实例的位移,framer layout FLIP 天然成立(多行容器时代的「淡出+淡入」与
   *  退场残影都是 reparent 的产物)。两轴都显式定位,不留任何 auto-flow。 */
  const placed: Array<{ id: string; rowStart: number; rowSpan: number; colStart: number; colSpan: number; size: DashboardCardSize; cell: Cell; chrome?: boolean }> = []
  {
    let unit = 1
    const bands: Array<{ top: number; h: number; ids: string[] }> = []
    const byId = new Map<string, { col: number; w: number }>()
    for (const row of composedRows) {
      let cursor = 1
      const members: string[] = []
      for (const item of row.items) {
        const colStart = item.start ?? cursor
        // ⚠️ rowSpan 用**每卡自己的** h,不是行高:手工行允许不等高并排(band 高 = 最高那张,
        //    矮卡下方留白),这一条是「6×5 大卡右边塞得下 3×2 小挂件」的全部落点。
        placed.push({ id: item.id, rowStart: unit, rowSpan: item.h, colStart, colSpan: item.span, size: item.size, cell: item.cell, chrome: item.chrome })
        cursor = colStart + item.span
        members.push(item.id)
        byId.set(item.id, { col: Math.round(((colStart - 1) * DASH3_COLS) / cols), w: item.cell.w })
      }
      bands.push({ top: (unit - 1) * (DASH3_ROW_PX + DASH3_GAP_PX), h: row.h, ids: members })
      unit += row.h
    }
    geomRef.current = { bands, byId }
  }
  visualCellsRef.current = new Map(placed.map((f) => [f.id, f.cell]))

  /** DragOverlay 的跟手壳:只画外壳与标题,**绝不二次挂载活视图**(嵌卡带 PageScope/loadPage
   *  语义,克隆一份就是双挂载)。原卡留在预览槽位里当落点占位。 */
  const overlayShell = ((): ReactNode => {
    if (!dragId) return null
    const widget = parseWidget(blocks[dragId]?.content ?? '')
    const kind = widget?.kind ?? 'text'
    if (widget && isChrome(kind)) {
      return (
        <div className="dash3-card dash3-card--chrome dash3-card--lift">
          <div className="dash3-card-body"><WidgetCard widget={widget} /></div>
        </div>
      )
    }
    const meta = cardOf(dragId)
    return (
      <div className="dash3-card dash3-card--lift" data-kind={kind} data-surface={profileOf(blocks[dragId]?.content ?? '').surface}>
        {meta.title && (
          <div className="dash3-card-head">
            {meta.Icon && <meta.Icon size={13} className="dash3-card-icon" />}
            <span className="dash3-card-title">{meta.title}</span>
          </div>
        )}
        <div className="dash3-card-body dash3-overlay-ghost" />
      </div>
    )
  })()

  return (
    <div
      className={`am-app tangu-lovable amx-pane amx-editor dash3${dragOver ? ' amx-dragover' : ''}`}
      data-mode={mode}
      data-flat={flat ? '1' : '0'}
      onPointerDownCapture={(e) => {
        setActivePageScope(leaf.id)
        // 点到交互中那张卡之外的任何地方 → 退出交互态(画布「点空白清选」的网格版对应物)
        if (interactId && !(e.target as HTMLElement).closest?.(`.dash3-card[data-key="${CSS.escape(interactId)}"]`)) {
          setInteractId(null)
        }
      }}
      onDragOver={(e) => {
        if (locked || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false) }}
      onDrop={(e) => {
        setDragOver(false)
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (locked || !files.length) return
        e.preventDefault()
        setActivePageScope(leaf.id)
        void importToPage(files, dashPath)
      }}
    >
      <div className="amx-toolbar">
        <Breadcrumb />
        <button
          className={`amx-mode-btn amx-pin-btn${pinned ? ' amx-pin-on' : ''}`}
          title={pinned ? '取消置顶' : '置顶'}
          onClick={() => useAmadeusPrefs.getState().togglePin(dashPath)}
        >
          <Pin size={14} />
        </button>
        <button
          className={`amx-mode-btn dash3-mode-btn${locked ? '' : ' amx-pin-on'}`}
          title={locked ? '编辑布局(拖动排序 / 改大小 / 增删卡片)' : '完成'}
          onClick={() => leaf.setParams({ ...leaf.params, locked: !locked })}
        >
          {locked ? <Pencil size={13} /> : <Check size={14} />}
          <span>{locked ? '编辑布局' : '完成'}</span>
        </button>
        <AnimatePresence initial={false}>
          {!locked && (
          <motion.div
            className="dash-add-wrap"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.9, x: -4 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, x: -4 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            <button className="amx-mode-btn" title="添加卡片" onClick={(e) => { e.stopPropagation(); setAddMenu((v) => !v) }}>
              <Plus size={14} />
            </button>
            {addMenu && (
              <>
                <div className="dash-menu-scrim" onClick={() => setAddMenu(false)} />
                <div ref={addMenuFix.ref} className="dash-add-menu" style={addMenuFix.style}>
                  {ADD_MENU.map((a) => (
                    <button key={a.key} onClick={() => addCard(a.key)}>
                      <a.icon size={13} /> {a.label}
                    </button>
                  ))}
                  {viewItems.length > 0 && <div className="dash-menu-sep">视图</div>}
                  {viewItems.map((v) => (
                    <button key={v.type} onClick={() => addViewCard(v)} title={v.type}>
                      <v.Icon size={13} /> {v.name}{v.spec ? '…' : ''}
                    </button>
                  ))}
                </div>
              </>
            )}
          </motion.div>
          )}
        </AnimatePresence>
        <button
          className="amx-mode-btn amx-more-btn"
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            setNoteMenu({ x: Math.max(8, Math.min(r.right - 180, window.innerWidth - 196)), y: r.bottom + 4 })
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>

      {!read3.ok && (
        <div className="dash-banner dash-banner-warn">
          这份笔记的 frontmatter 无法解析({read3.error}),布局已冻结、不会自动改写。请先修好 YAML。
        </div>
      )}
      {stale && (
        <div className="dash-banner">
          布局记录的块 id 与当前块对不上(笔记可能被重编号过),已停止自动重排以免丢失布局。
          <button onClick={() => applyLayout(reconcileGrid({}, ids) ?? {})}>按当前顺序重排</button>
        </div>
      )}

      <DashFilterBar filters={dashFilters} editable={!locked} onChange={setFilters} />

      {/* 页面级筛选下发接缝:卡里的多维表 chart 视图经 DashFiltersCtx 消费(围栏数据卡走
          WidgetCard 的 filters prop,两条都吃 —— 一处改、全页跟随)。 */}
      <DashFiltersCtx.Provider value={dashFilters}>
      <motion.div layoutScroll ref={hostRef} className="dash3-host" data-locked={locked || undefined} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}>
        <DndContext
          sensors={sensors}
          // ⚠️ 必须 pointerWithin,不是 closestCenter:预览让位后各卡中心全变,closestCenter 会在
          //    两个邻居间来回翻转 → 布局 A↔B 振荡直到 React 掐死(Maximum update depth,实测)。
          //    「指针落在谁身上才算 over」则重排后指针落在占位卡自己身上,天然自稳。
          collisionDetection={pointerWithin}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SortableContext items={displaySeq} strategy={NO_SORT}>
            <div
              ref={gridRef}
              className="dash3-grid"
              style={{ ['--dash3-cols' as string]: cols, ['--dash3-row' as string]: `${DASH3_ROW_PX}px`, ['--dash3-gap' as string]: `${DASH3_GAP_PX}px` }}
            >
              {/* 列数未测得前不挂卡片:首帧按 1 列编排再跳 12 列,framer 会把这次校正当成
                  真位移放大成开屏乱飞(交互面板里复现过的「永久残影」正出自这里)。 */}
              {gridW > 0 && (
                <AnimatePresence initial={false} mode="popLayout">
                  {placed.map(({ id, rowStart, rowSpan, colStart, colSpan, size }) => {
                    const meta = cardOf(id)
                    return (
                      <GridCard
                        key={id}
                        id={id}
                        rowStart={rowStart}
                        rowSpan={rowSpan}
                        colStart={colStart}
                        colSpan={colSpan}
                        locked={locked}
                        chrome={isChrome(meta.widget?.kind)}
                        kind={meta.widget?.kind ?? 'text'}
                        surface={profileOf(blocks[id]?.content ?? '').surface}
                        size={size}
                        dragging={dragId === id}
                        sizing={sizing?.id === id}
                        interact={interactId === id}
                        reduceMotion={!!reduceMotion}
                        title={meta.title}
                        Icon={meta.Icon}
                        onOpen={meta.openable}
                        onInteract={() => setInteractId(id)}
                        onDelete={() => removeCard(id)}
                        onMenu={(x, y) => setCardMenu({ x, y, id })}
                        onGripDown={(e) => onGripDown(e, id)}
                      >
                        {renderBody(id, size)}
                      </GridCard>
                    )
                  })}
                </AnimatePresence>
              )}
            </div>
          </SortableContext>
          {/* 不 portal:留在 .dash3 子树里才吃得到主题 token(浮层双类纪律)。 */}
          <DragOverlay
            zIndex={30}
            style={overlayZoomRef.current !== 1 ? { zoom: 1 / overlayZoomRef.current } : undefined}
            dropAnimation={reduceMotion ? null : { duration: 200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
          >
            {overlayShell}
          </DragOverlay>
        </DndContext>

        {!ids.length && (
          <div className="dash3-empty">
            <div className="dash3-empty-panel">
              <div className="dash3-empty-mark" aria-hidden="true"><LayoutGrid size={18} /></div>
              <div className="dash3-empty-copy">
                <div className="dash3-empty-title">从模板开始</div>
                <div className="dash3-empty-sub">先放下常用组合,再拖动排序、按格调整大小。</div>
              </div>
              <div className="dash3-templates" aria-label="仪表盘模板">
                {TEMPLATES.filter((t) => t.cards.length).map((t) => {
                  const TemplateIcon = t.key === 'today' ? Clock : LayoutGrid
                  return (
                    <button key={t.key} type="button" className="dash3-template" onClick={() => applyTemplate(t)}>
                      <span className="dash3-template-icon" aria-hidden="true"><TemplateIcon size={16} /></span>
                      <span className="dash3-template-copy">
                        <span className="dash3-template-name">{t.name}</span>
                        <span className="dash3-template-hint">{t.hint}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </motion.div>
      </DashFiltersCtx.Provider>

      {cardMenu && !locked && (
        <>
          <div className="dash-menu-scrim" onClick={() => setCardMenu(null)} />
          <div ref={cardMenuFix.ref} className="dash-add-menu" style={{ position: 'fixed', left: cardMenu.x, top: cardMenu.y, ...cardMenuFix.style }}>
            <div className="dash-menu-sep">大小</div>
            {DASH3_SIZES.filter((s) => profileOf(blocks[cardMenu.id]?.content ?? '').sizes.includes(s.key)).map((s) => (
              <button key={s.key} onClick={() => { setCardSize(cardMenu.id, s.w, s.h); setCardMenu(null) }}>
                {s.label} <span className="dash3-size-dim">{s.w}×{s.h}</span>
              </button>
            ))}
            {pins[cardMenu.id] && (
              <>
                <div className="dash-menu-sep" />
                <button onClick={() => { releaseRow(cardMenu.id); setCardMenu(null) }}>恢复自动排版</button>
              </>
            )}
            <div className="dash-menu-sep" />
            <button className="dash-danger" onClick={() => { removeCard(cardMenu.id); setCardMenu(null) }}>删除卡片</button>
          </div>
        </>
      )}

      {noteMenu && (
        <>
          <div className="dash-menu-scrim" onClick={() => setNoteMenu(null)} />
          <div ref={noteMenuFix.ref} className="dash-add-menu" style={{ position: 'fixed', left: noteMenu.x, top: noteMenu.y, ...noteMenuFix.style }}>
            <button onClick={switchToCanvas}>切换到自由摆位(高级)</button>
            <button
              onClick={() => {
                setNoteMenu(null)
                void (async () => {
                  const name = (await askString('重命名仪表盘', dashBaseName(dashPath)))?.trim().replace(/[\\/]/g, '')
                  if (!name) return
                  const ok = await store.getState().renamePage(`${name}.dashboard`)
                  const next = store.getState().activePage
                  if (ok && next && next !== dashPath) leaf.setParams({ ...leaf.params, dashPath: next })
                })()
              }}
            >
              重命名
            </button>
            <button
              className="dash-danger"
              onClick={() => {
                setNoteMenu(null)
                if (!window.confirm(`删除仪表盘「${dashBaseName(dashPath)}」?`)) return
                void store.getState().deletePage(dashPath).then(() => {
                  const err = store.getState().error
                  if (err) { useApp.getState().toast(`删除失败:${err}`, true); return }
                  useApp.getState().toast('已删除')
                  useWorkspace.getState().closeLeaf(leaf.id) // leaf 攥着已删路径必须关
                })
              }}
            >
              删除
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** 统一外壳。**卡片长什么样只由这里决定** —— 圆角、描边、内边距、标题条、把手全在这一层,
 *  卡里装的是日历还是笔记都一个样。这是「统一」的唯一来源。 */
function GridCard({
  id, rowStart, rowSpan, colStart, colSpan, locked, chrome, kind, surface, size, dragging, sizing, interact, reduceMotion, title, Icon, children,
  onOpen, onInteract, onDelete, onMenu, onGripDown,
}: {
  id: string
  rowStart: number
  rowSpan: number
  colStart: number
  colSpan: number
  locked: boolean
  chrome: boolean
  kind: string
  surface: CardSurface
  size: DashboardCardSize
  dragging: boolean
  sizing: boolean
  interact: boolean
  reduceMotion: boolean
  title: string | null
  Icon: typeof LayoutGrid | null
  children: ReactNode
  onOpen: null | (() => void)
  onInteract: () => void
  onDelete: () => void
  onMenu: (x: number, y: number) => void
  onGripDown: (e: React.PointerEvent) => void
}) {
  // transition: null = 把 transform 的主权整个交给 framer(dnd-kit 官方混用示例的铁律);
  // strategy 恒 null,所以这里也不再消费 transform —— 位移一律是真实布局变化 + layout FLIP。
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id, disabled: locked, transition: null })
  const slotStyle: React.CSSProperties = {
    gridRow: `${rowStart} / span ${rowSpan}`,
    gridColumn: `${colStart} / span ${colSpan}`,
  }
  return (
    <motion.div
      ref={setNodeRef}
      // 一切几何变化(重排/改档/在途 resize 的每次落格)都走 FLIP。在途 resize 用更短的补间:
      // 首版「瞬时落格」被用户报「太生硬」(2026-08-31)—— 指针数学始终对起手几何算(onGripMove
      // 不读 DOM rect),补间不会形成反馈环。
      layout
      className="dash3-card-slot"
      style={slotStyle}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.97, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -6 }}
      transition={{ duration: reduceMotion ? 0 : sizing ? 0.16 : 0.28, ease: [0.16, 1, 0.3, 1] }}
    >
      <div
        className={`dash3-card${chrome ? ' dash3-card--chrome' : ''}`}
        data-key={id}
        data-kind={kind}
        data-surface={surface}
        data-size={size}
        data-dragging={isDragging || dragging || undefined}
        data-sizing={sizing || undefined}
        data-interact={interact || undefined}
      >
        {title && !chrome && (
          <div className="dash3-card-head">
            {Icon && <Icon size={13} className="dash3-card-icon" />}
            <span className="dash3-card-title">{title}</span>
            {locked && onOpen && (
              <button type="button" className="dash3-card-open" title="在标签页里打开" aria-label={`在标签页里打开${title}`} onClick={onOpen}>
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        )}
        <div className="dash3-card-body">{children}</div>
        {!locked && (
          <>
              {/* 排版台与画布同一套拖拽语汇(2026-08-28 用户拍板):**整卡罩层起拖,双击进入卡片**
                  —— dash2-shield 的网格版对应物。交互态那张卡撤罩,内容恢复原生;按钮与右下把手
                  z 位高于罩层,照常可点。 */}
              {!interact && (
                <div
                  className="dash3-shield"
                  {...attributes}
                  {...listeners}
                  onDoubleClick={chrome ? undefined : onInteract}
                  title={chrome ? '拖动排序' : '拖动排序;双击进入卡片'}
                />
              )}
              <button type="button" className="dash3-card-btn dash3-card-more" title="大小与更多" aria-label="设置卡片大小" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onMenu(Math.max(8, Math.min(r.left - 60, window.innerWidth - 196)), r.bottom + 4) }}>
                <MoreHorizontal size={12} />
              </button>
              <button type="button" className="dash3-card-btn dash3-card-del" title="删除这张卡片" aria-label="删除这张卡片" onClick={(e) => { e.stopPropagation(); onDelete() }}>
                <Trash2 size={12} />
              </button>
              {!chrome && <div className="dash3-grip" title="调整大小" onPointerDown={onGripDown} />}
          </>
        )}
      </div>
    </motion.div>
  )
}
