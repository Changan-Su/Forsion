/**
 * 画布版 Dashboard(View 基座 P3a,2026-08-25 拍板:直接画布、抛弃旧网格版)。
 *
 * 与旧 `amadeus-dashboard` 同一份 `.dashboard.md`、同一套块与 widget(```clock/weather/webview/view
 * 围栏 + markdown 块),**只换几何**:外来键 `dashboard2:` 记每块自由 px 矩形,舞台可平移缩放。
 * 卡片渲染整体复用旧版(ViewCard 假 Leaf / WidgetCard / BlockHost)——「view 嵌卡」的核心机制
 * 旧版已备,本文件的新东西是:画布几何、浏览/交互双态、窄屏降级卡片流、旧格网一键迁移。
 *
 * 交互模型(08-21 pointerdown/preventDefault 之坑的规避:罩层是独立 DOM,不在卡内容里拦事件):
 *  · 浏览态:每卡覆一层罩(拖动/选中/缩放手柄);**双击进交互态**(罩层撤下,事件直达卡内容);
 *  · 交互态:点卡外任意处退出;同时只有一张卡在交互态 —— 与 08-22「双击进编辑+聚焦」拍板同构。
 *  · 触屏坐标一律 ÷ zoom 再进舞台系(08-23 的教训)。
 * 落盘防线与旧版同源:换页不写 / 坏 YAML 冻结 / 布局与块全不相交停手 / 落点对当下布局判。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Clock, CloudSun, Globe, LayoutGrid, Maximize2, MoreHorizontal, Pencil, Pin, Plus, Trash2, Type } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
// ponytail: 不订阅 viewRegistry —— 能嵌卡的只有宿主 embeddable 白名单里的内置视图,它们在
// installEngine 一次注册完;插件视图恒非 embeddable(宿主不给插件这个字段),不存在「晚注册」窗口。
import { allViews, getView, label, useEdgeNudge, useWorkspace } from '@lcl/engine'
import { useQuickFind } from '../quickFind'
import { fileMatchViewType } from '../viewFileMatch'
import { PageScopeCtx, setActivePageScope, usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { BlockHost } from '@amadeus/components/BlockHost'
import { askString } from '@amadeus/components/askString'
import { DndContext, useSensors } from '@dnd-kit/core'
import {
  DASH2_DEFAULT_H, DASH2_DEFAULT_W, DASH2_MIN_H, DASH2_MIN_W, clampRect2, dashBaseName, layoutIsStale,
  migrateGridToCanvas, parseWidget, readDash2Layout, readDashLayout, reconcileCanvas, setDash2InFm,
  webviewUrlAllowed, widgetSource, type DashLayout, type Rect,
} from '@amadeus-shared/dashboard'
import { migrateCanvasToGrid, readDash3Layout, setDash3InFm, setDashModeInFm } from '@amadeus-shared/dashboard3'
import {
  CanvasChrome, CanvasMiniMap, hostSize, snapGrid, useCanvasGestures, useCanvasViewport, zoomAt,
  type Box, type ResizeEdge, type Viewport,
} from '@amadeus/unified/canvasKit'
import { canvasGridSnapEnabled, canvasMiniMapEnabled, setCanvasGridSnapEnabled, setCanvasMiniMapEnabled } from '@amadeus/unified/canvasPrefs'
import { useTheme } from '../stores/themeStore'
import { useApp } from '../stores/appStore'
import { useAmadeusPrefs } from '../amadeusPrefs'
import { Breadcrumb } from '../amadeusViews'
import { importToPage } from '../amadeusImport'
import { WidgetCard, localTimeZone } from '@amadeus/dashboard/widgets'
// 嵌卡白名单/身份判定/标题取法与网格版共用一份(勿再各写一份)。
import { EMBED_DENY, ViewCard, pickSpecOf } from './dashboardViewCard'
import '@amadeus/blocks'
import './dashCanvas.css'

const NARROW_PX = 720
/** 仪表盘的起始/重置视口；实际 x/y 会按宿主尺寸居中并受固定画板边界约束。 */
const DASH_HOME_VP = { x: 0, y: 0, z: 1 }
/** 八向调整把手(与 Amadeus 画布同一组边)。 */
const RESIZE_EDGES: ResizeEdge[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Dashboard 的逻辑画板是固定 16:9；编辑态任何卡片都不能越过这四条边。展示态把同一份逻辑
 *  几何按 x/w 与 y/h 百分比分别映射到 View，因此铺满容器但不缩放文字。 */
const DASH_BOARD: Readonly<Rect> = { x: 0, y: 0, w: 1152, h: 648 }

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

function clampRectToBoard(rect: Rect): Rect {
  const base = clampRect2(rect)
  const w = Math.min(DASH_BOARD.w, base.w)
  const h = Math.min(DASH_BOARD.h, base.h)
  return {
    x: Math.round(clamp(base.x, DASH_BOARD.x, DASH_BOARD.w - w)),
    y: Math.round(clamp(base.y, DASH_BOARD.y, DASH_BOARD.h - h)),
    w: Math.round(w),
    h: Math.round(h),
  }
}

/** 旧文件里已经越界的几何不迁移格式，只在正常自愈链里安全收回固定画板。 */
function constrainLayoutToBoard(layout: DashLayout): DashLayout | null {
  let changed = false
  const next: DashLayout = {}
  for (const [id, rect] of Object.entries(layout)) {
    const bounded = clampRectToBoard(rect)
    if (bounded.x !== rect.x || bounded.y !== rect.y || bounded.w !== rect.w || bounded.h !== rect.h) changed = true
    next[id] = bounded
  }
  return changed ? next : null
}

/** 移动按整组刚体截边；缩放按正在拉的边截住，避免越界时固定的对边也跟着跳。 */
function constrainBoxesToBoard(
  next: Map<string, Box>,
  op: { kind: 'move' } | { kind: 'resize'; key: string; edge: ResizeEdge },
): Map<string, Box> {
  if (!next.size) return next
  if (op.kind === 'move') {
    const boxes = [...next.values()]
    const left = Math.min(...boxes.map((b) => b.x))
    const top = Math.min(...boxes.map((b) => b.y))
    const right = Math.max(...boxes.map((b) => b.x + b.w))
    const bottom = Math.max(...boxes.map((b) => b.y + b.h))
    const dx = left < 0 ? -left : right > DASH_BOARD.w ? DASH_BOARD.w - right : 0
    const dy = top < 0 ? -top : bottom > DASH_BOARD.h ? DASH_BOARD.h - bottom : 0
    if (!dx && !dy) return next
    return new Map([...next].map(([id, b]) => [id, { ...b, x: b.x + dx, y: b.y + dy }]))
  }

  const raw = next.get(op.key)
  if (!raw) return next
  const box = { ...raw }
  if (op.edge.includes('w') && box.x < 0) { box.w += box.x; box.x = 0 }
  if (op.edge.includes('e') && box.x + box.w > DASH_BOARD.w) box.w = DASH_BOARD.w - box.x
  if (op.edge.includes('n') && box.y < 0) { box.h += box.y; box.y = 0 }
  if (op.edge.includes('s') && box.y + box.h > DASH_BOARD.h) box.h = DASH_BOARD.h - box.y
  return new Map([[op.key, clampRectToBoard(box)]])
}

/** 固定画板的相机边界：画板小于 View 的轴居中锁死；大于 View 的轴只允许在两条边之间浏览。 */
function constrainViewportToBoard(next: Viewport, host: HTMLElement | null): Viewport {
  const { w: viewW, h: viewH } = hostSize(host)
  if (viewW <= 0 || viewH <= 0) return next
  const axis = (position: number, origin: number, extent: number, viewSize: number): number => {
    const scaled = extent * next.z
    if (scaled <= viewSize) return (viewSize - scaled) / 2 - origin * next.z
    const min = viewSize - (origin + extent) * next.z
    const max = -origin * next.z
    return clamp(position, min, max)
  }
  return {
    ...next,
    x: axis(next.x, DASH_BOARD.x, DASH_BOARD.w, viewW),
    y: axis(next.y, DASH_BOARD.y, DASH_BOARD.h, viewH),
  }
}

/** 视图卡默认尺寸。取 24(点阵步长)的整倍数 —— 默认落下来就能与邻居严丝合缝地拼上。 */
const VIEW_CARD_W = 432
const VIEW_CARD_H = 336
/** 小挂件(时钟/天气)默认尺寸,同样对齐点阵。 */
const MINI_CARD_W = 264
const MINI_CARD_H = 144

const ADD_MENU = [
  { key: 'text', label: '文本块', icon: Type },
  { key: 'clock', label: '时钟', icon: Clock },
  { key: 'weather', label: '天气', icon: CloudSun },
  { key: 'webview', label: '网页', icon: Globe },
] as const

export function DashboardCanvasView(props: ViewProps) {
  return (
    <PageScopeCtx.Provider value={props.leaf.id}>
      <CanvasInner {...props} />
    </PageScopeCtx.Provider>
  )
}

function CanvasInner({ leaf }: ViewProps) {
  const store = useScopedPageStore()
  const dashPath = typeof leaf.params.dashPath === 'string' ? leaf.params.dashPath : ''
  const locked = leaf.params.locked !== false // 缺席即锁(旧版同款):锁上=不能拖/加/删,双击看内容照旧
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  const manifest = usePageStore((s) => s.manifest)
  const blocks = usePageStore((s) => s.blocks)
  const activePage = usePageStore((s) => s.activePage)
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  const pinned = useAmadeusPrefs((s) => !!dashPath && s.pins.includes(dashPath))

  const [addMenu, setAddMenu] = useState(false)
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number } | null>(null)
  const addMenuFix = useEdgeNudge(addMenu)
  const noteMenuFix = useEdgeNudge(noteMenu ? `${noteMenu.x},${noteMenu.y}` : '')
  const [dragOver, setDragOver] = useState(false)
  useEffect(() => {
    if (!dragOver) return
    const clear = (): void => setDragOver(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear) }
  }, [dragOver])

  useEffect(() => { if (dashPath) leaf.setTitle(dashBaseName(dashPath)) }, [dashPath]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dashPath && dashPath !== store.getState().activePage) void store.getState().loadPage(dashPath)
  }, [dashPath]) // eslint-disable-line react-hooks/exhaustive-deps
  const isActiveLeaf = useWorkspace((s) => s.mainTabs.find((t) => t.id === leaf.id)?.active ?? false)
  useEffect(() => { if (isActiveLeaf) setActivePageScope(leaf.id) }, [isActiveLeaf, leaf.id])
  // scope 的销毁归路由 DashboardView(与网格版共用同一个 leaf.id 的 scope,不能各销各的)。

  const ids = useMemo(() => {
    if (!manifest) return []
    const out: string[] = []
    for (const row of manifest.root.children) for (const col of row.columns) for (const r of col.children) out.push(r.ref)
    return out
  }, [manifest])

  const read2 = useMemo(() => readDash2Layout(fmExtra), [fmExtra])
  const layout = read2.ok ? read2.layout : {}
  const readLegacy = useMemo(() => readDashLayout(fmExtra), [fmExtra])
  /** 只有旧键有货、新键还空 → 显示一键迁移。 */
  const migratable = read2.ok && !Object.keys(layout).length && readLegacy.ok && Object.keys(readLegacy.layout).length > 0
  const stale = read2.ok && !migratable && layoutIsStale(layout, ids)

  const applyLayout = (next: DashLayout): boolean => {
    const st = store.getState()
    if (st.activePage !== dashPath) return false // 换页/已删 → 绝不写进别人的笔记(旧版 Codex 实证防线)
    const cur = st.manifest?.fmExtra ?? ''
    const text = setDash2InFm(cur, next)
    if (text === null || text === cur) return false
    st.setFmExtra(text)
    return true
  }

  // 自愈:新块排底部、孤儿键清理、旧越界几何收回画板;迁移待决/坏 YAML/布局对不上 → 一律停手。
  useEffect(() => {
    if (!manifest || activePage !== dashPath || !ids.length) return
    if (!read2.ok || migratable || stale) return
    const reconciled = reconcileCanvas(layout, ids)
    const next = constrainLayoutToBoard(reconciled ?? layout) ?? reconciled
    if (next) applyLayout(next)
  }, [ids, layout, manifest, activePage, dashPath, read2.ok, migratable, stale]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 舞台:视口 + 手势,两样都由 canvasKit 提供 —— **与 Amadeus 画布同一份实现**
  //    (View 基座方案 §6.4 S2/S3;此前这里另写了一套 mini 画布,手感对不上 = 用户实报的根因)。
  const hostRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = (): void => setNarrow(el.clientWidth < NARROW_PX)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // 起始视口给一格点阵的偏移:仪表盘的卡常常摆在原点附近,顶着窗口边看着像被裁了。
  const view = useCanvasViewport(hostRef, dashPath, undefined, DASH_HOME_VP, constrainViewportToBoard)
  // 锁定 = **成品页**(用户 2026-08-25 拍板:「锁定之后就变成一个 view 的展示页面」)。
  // 画布只是排版台:锁上就没有平移/缩放/点阵/chrome,只把拼好的版整个铺进面板。

  // 宿主初次到场、窗口改尺寸或从展示态回到编辑态时，重新把记忆中的相机收进固定画板。
  useLayoutEffect(() => {
    if (locked || narrow) return undefined
    const el = hostRef.current
    if (!el) return undefined
    const sync = (): void => view.setVp(view.vpRef.current)
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    sync()
    return () => ro.disconnect()
  }, [locked, narrow, view.setVp]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (locked || narrow) return undefined; return view.bindWheel(hostRef.current) }, [view.bindWheel, locked, narrow])

  const [snap, setSnapState] = useState(canvasGridSnapEnabled)
  const setSnap = (on: boolean): void => { setSnapState(on); setCanvasGridSnapEnabled(on) }
  const [mini, setMiniState] = useState(canvasMiniMapEnabled)
  const setMini = (on: boolean): void => { setMiniState(on); setCanvasMiniMapEnabled(on) }

  /** 交互态 = 事件归卡内容那张卡(画布侧对应 `editing`)。同时只有一张。 */
  const [interactId, setInteractId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; key: string | null } | null>(null)
  const menuFix = useEdgeNudge(menu ? `${menu.x},${menu.y}` : '')

  /** 布局现读(手势落笔要对**当下**磁盘那份判,不能用渲染闭包里的旧值)。 */
  const freshLayout = (): DashLayout | null => {
    const r = readDash2Layout(store.getState().manifest?.fmExtra ?? '')
    return r.ok ? r.layout : null
  }

  const settleRaf = useRef(0)
  const settleAnimations = useRef<Animation[]>([])
  const stopSettle = (): void => {
    cancelAnimationFrame(settleRaf.current)
    settleRaf.current = 0
    for (const animation of settleAnimations.current) animation.cancel()
    settleAnimations.current = []
  }
  useEffect(() => stopSettle, []) // eslint-disable-line react-hooks/exhaustive-deps
  const playSettle = (from: Map<string, Box>, to: Map<string, Box>, kind: 'snap' | 'repel'): void => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    stopSettle()
    settleRaf.current = requestAnimationFrame(() => {
      settleRaf.current = 0
      const root = hostRef.current
      if (!root) return
      for (const [id, target] of to) {
        const source = from.get(id)
        const el = root.querySelector<HTMLElement>(`.dash2-card[data-key="${CSS.escape(id)}"]`)
        if (!source || !el) continue
        const resized = source.w !== target.w || source.h !== target.h
        const frames: Keyframe[] = resized
          ? [
              { left: `${source.x}px`, top: `${source.y}px`, width: `${source.w}px`, height: `${source.h}px` },
              { left: `${target.x}px`, top: `${target.y}px`, width: `${target.w}px`, height: `${target.h}px` },
            ]
          : [
              { transform: `translate(${source.x - target.x}px, ${source.y - target.y}px) scale(1.012)`, opacity: 0.94 },
              { transform: 'translate(0, 0) scale(1)', opacity: 1 },
            ]
        const distance = Math.max(Math.abs(source.x - target.x), Math.abs(source.y - target.y), Math.abs(source.w - target.w), Math.abs(source.h - target.h))
        const animation = el.animate(frames, {
          duration: resized ? 220 : Math.round(Math.max(340, Math.min(480, 320 + distance * 0.55))),
          easing: 'cubic-bezier(0.2, 0.78, 0.28, 1)',
          fill: 'none',
        })
        animation.id = kind === 'repel' ? 'amx-card-repel' : 'amx-card-snap'
        settleAnimations.current.push(animation)
        const done = (): void => { settleAnimations.current = settleAnimations.current.filter((a) => a !== animation) }
        animation.addEventListener('finish', done, { once: true })
        animation.addEventListener('cancel', done, { once: true })
      }
    })
  }

  const gest = useCanvasGestures(hostRef, view, {
    boxes: () => new Map(Object.entries(freshLayout() ?? layout).map(([id, rect]) => [id, clampRectToBoard(rect)])),
    constrain: constrainBoxesToBoard,
    commit: (next) => {
      // 落点对**当下**布局判(手势期间云同步/外部编辑可能改了别的卡;旧版 Codex 实证防线)。
      const cur = freshLayout()
      if (!cur) return
      const merged: DashLayout = { ...cur }
      for (const [id, box] of next) {
        if (!cur[id]) continue // 这张卡在手势期间没了 → 别把它写回来
        merged[id] = clampRectToBoard(box)
      }
      applyLayout(merged)
    },
    // 这一笔手势归谁 = **这一份文档的整页装载身份**。`loadNonce` 每次整页 hydrate(换页 / 改名 /
    // 外部回灌)都换新对象,所以它同时挡住两件事:①拖到一半这个 leaf 换去了另一份仪表盘 ——
    // 松手时 commit 已经是新页那份,而块 id 都从 1 起,「id 在不在 / activePage 对不对」两道检查
    // **都会通过**,旧几何就写进了新页;②A→B→A 往返后路径相同但已是另一份文档(Codex 评审;
    // 与 pageStore 里 deleteBlock 反链确认的那条同源纪律)。
    identity: () => { const st = store.getState(); return st.activePage === dashPath ? st.loadNonce : {} },
    hitKey: (t) => (t.closest('.dash2-card') as HTMLElement | null)?.dataset.key ?? null,
    hitEdge: (t) => ((t.closest('[data-edge]') as HTMLElement | null)?.dataset.edge as ResizeEdge | undefined) ?? null,
    // ⚠️ 这里**不能**加 `!locked`:成品页也有交互态(双击进卡片),加上就等于「进去了也点不动」。
    //    Codex 评审提的「锁定时 isEditing 还是 true」那条,正解是下面那个 **useLayoutEffect**:
    //    locked 一翻真就把 interactId / 选区 / 菜单一次清干净,让这个函数自然回到 false。
    isEditing: (k) => k === interactId,
    locked,
    minW: DASH2_MIN_W,
    minH: DASH2_MIN_H,
    // 与生产 Canvas 同款的防穿透/18px 空气层；有限版额外要求求解出的候选仍在画板内。
    repelBounds: DASH_BOARD,
    onSettle: playSettle,
    onDoubleClick: (key) => { if (key) setInteractId(key) },
    onContextMenu: (key, at) => setMenu({ x: at.clientX, y: at.clientY, key }),
    onDelete: (keys) => keys.forEach(removeCard),
    onEnterEdit: (key) => setInteractId(key),
  }, snap)
  // ⚠️ 依赖只能是 `bind` / `locked` / `narrow`(换宿主元素)。任何每渲染都换身份的东西进了这个
  //    依赖数组,重挂监听就会把闭包里在途的那一笔手势清掉 —— 现象是**拖不动**(见 gestures.ts)。
  //    ⚠️ **锁定态也要挂**:成品页里手势层的活儿是「拦住单击、只放双击」—— 不挂等于单击直接穿透进
  //    卡内容(用户 2026-08-25 实报「怎么直接就点进去了」)。`locked` 交给 adapter,它自己知道
  //    锁定时不选不拖不平移。
  useEffect(() => { if (narrow) return undefined; return gest.bind(hostRef.current) }, [gest.bind, narrow])
  // 选区里没有交互态那张卡了(点了别处 / 框选了别人)→ 退出交互态。
  useEffect(() => {
    if (interactId && !gest.sel.includes(interactId)) setInteractId(null)
  }, [gest.sel]) // eslint-disable-line react-hooks/exhaustive-deps

  // 解锁那一下回到 100%:排版要的是真实尺寸,缩着摆很容易摆歪。
  useEffect(() => { if (!locked) view.reset() }, [locked]) // eslint-disable-line react-hooks/exhaustive-deps
  // 锁定那一下把排版台的残留一次清干净:交互态、选区、右键菜单、加卡菜单。
  // ⚠️ 少了这一句,「双击进卡 → 直接按锁定」会带着 interactId 进成品页,那张卡在成品页里继续
  //    以编辑态让路(Codex 评审)。用 **useLayoutEffect**:普通 effect 在绘制后才跑,中间那一帧
  //    的指针事件仍会按旧的 interactId 让路(与 T43 补全面板那条同源纪律)。
  useLayoutEffect(() => {
    if (!locked) return
    setInteractId(null)
    gest.setSel([])
    setMenu(null)
    setAddMenu(false)
  }, [locked]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 视口中心的舞台坐标(新卡出生点;键盘/菜单落卡没有指针位置,AFFiNE 同款落视野中间)。
   *  开着吸附时**出生点也对齐点阵** —— 否则新卡默认就是歪的,想拼版得先手动挪一下。 */
  const stageCenter = (w = DASH2_DEFAULT_W, h = DASH2_DEFAULT_H): { x: number; y: number } => {
    const el = hostRef.current
    const r = el?.getBoundingClientRect()
    const c = view.toStage((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 600) / 2)
    const x = c.x - w / 2
    const y = c.y - h / 2
    return snap ? { x: snapGrid(x), y: snapGrid(y) } : { x: Math.round(x), y: Math.round(y) }
  }

  const insertCard = (content: string, w = DASH2_DEFAULT_W, h = DASH2_DEFAULT_H): string | null => {
    const st = store.getState()
    if (st.activePage !== dashPath) return null
    const id = st.insertBlockAfter(null, undefined, content)
    if (!id) return null
    const fresh = readDash2Layout(store.getState().manifest?.fmExtra ?? '')
    const c = stageCenter(w, h)
    if (fresh.ok) applyLayout({ ...fresh.layout, [id]: clampRectToBoard({ x: c.x, y: c.y, w, h }) })
    return id
  }

  const addCard = (kindKey: (typeof ADD_MENU)[number]['key']): void => {
    setAddMenu(false)
    void (async () => {
      let content = ''
      if (kindKey === 'clock') content = widgetSource('clock', { tz: localTimeZone() })
      else if (kindKey === 'weather') {
        const city = await askString('天气卡片 — 城市', '上海')
        if (!city?.trim()) return
        content = widgetSource('weather', { city: city.trim() })
      } else if (kindKey === 'webview') {
        const url = await askString('网页卡片 — 地址', 'https://')
        if (!url?.trim()) return
        if (!webviewUrlAllowed(url.trim())) {
          useApp.getState().toast('只允许公网 http(s) 地址(拒绝 file/data、localhost 与内网)', true)
          return
        }
        content = widgetSource('webview', { url: url.trim() })
      }
      const small = kindKey === 'clock' || kindKey === 'weather'
      insertCard(content, small ? MINI_CARD_W : DASH2_DEFAULT_W, small ? MINI_CARD_H : DASH2_DEFAULT_H)
    })()
  }

  /** 添加「视图卡」清单:embeddable 白名单(宿主语义,插件自声明不足信 → 插件 view 目前恒不在列)。
   *  `spec` 在场 = 这张卡需要先挑一个文件(档 1 的 entity 视图 + 大纲);缺省 = 直接落卡(档 2 全局面)。 */
  const viewItems = useMemo(
    () => allViews()
      .filter((v) => v.embeddable && !EMBED_DENY.has(v.type))
      .map((v) => ({ type: v.type, name: label(v.displayName), Icon: v.icon ?? LayoutGrid, spec: pickSpecOf(v, fileMatchViewType) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [addMenu], // eslint-disable-line react-hooks/exhaustive-deps
  )

  /** 落一张视图卡。需要身份的先经快速查找选文件(复用同一个面板的模糊搜索/键盘/样式)。 */
  const addViewCard = (item: (typeof viewItems)[number]): void => {
    setAddMenu(false)
    if (!item.spec) { insertCard(widgetSource('view', { type: item.type }), VIEW_CARD_W, VIEW_CARD_H); return }
    const { param, accept } = item.spec
    useQuickFind.getState().openPicker({
      title: `选择要放进「${item.name}」卡片的文件…`,
      accept,
      onPick: (path) => { insertCard(widgetSource('view', { type: item.type, [param]: path }), VIEW_CARD_W, VIEW_CARD_H) },
    })
  }

  /** 升级到结构化网格(2026-08-27 的新默认)。**只在用户点横幅时跑,绝不自动** —— 这份布局是
   *  用户一格一格摆出来的。`dashboard2:` 原样留在文件里当回滚保险(切回自由摆位就还在)。 */
  const upgradeToGrid = (): void => {
    const st = store.getState()
    if (st.activePage !== dashPath) return
    const cur = st.manifest?.fmExtra ?? ''
    const fresh = readDash2Layout(cur)
    if (!fresh.ok) return
    // ⚠️ 文件里可能已经有一份**读不懂**的 dashboard3(合法 YAML、非法布局)。不先要求它读得通就写,
    //    等于用迁移结果把用户原来的网格布局永久盖掉 —— 与「读不懂即冻结」正好相反(Codex 评审 P1)。
    if (!readDash3Layout(cur).ok) {
      useApp.getState().toast('这份笔记里已有一份读不出来的网格布局,已停手 —— 请先修好 frontmatter', true)
      return
    }
    const withLayout = setDash3InFm(cur, migrateCanvasToGrid(fresh.layout))
    if (withLayout === null) return
    const withMode = setDashModeInFm(withLayout, 'grid')
    if (withMode === null || withMode === cur) return
    st.setFmExtra(withMode)
  }

  /** 「保持自由摆位」= 显式表态,横幅从此不再出现(路由也不用再靠猜)。 */
  const keepCanvas = (): void => {
    const st = store.getState()
    if (st.activePage !== dashPath) return
    const cur = st.manifest?.fmExtra ?? ''
    const next = setDashModeInFm(cur, 'canvas')
    if (next === null || next === cur) return
    st.setFmExtra(next)
  }

  const removeCard = (id: string): void => {
    if (store.getState().activePage !== dashPath) return
    void store.getState().deleteBlock(id) // 布局键交给自愈清(deleteBlock 有反链二次确认,旧版教训)
  }

  const noSensors = useSensors()

  if (!dashPath) return <div className="amx-draw-state">未指定仪表盘文件。</div>

  const orderedIds = narrow
    ? [...ids].sort((a, b) => (layout[a]?.y ?? 0) - (layout[b]?.y ?? 0) || (layout[a]?.x ?? 0) - (layout[b]?.x ?? 0))
    : ids

  const renderBody = (id: string): ReactNode => {
    const widget = parseWidget(blocks[id]?.content ?? '')
    if (widget?.kind === 'view') {
      const t = widget.opts.type ?? ''
      // ⚠️ 白名单必须在**渲染入口**复查,不能只做添加菜单的过滤:卡片源码是 md 文本,同步/共享/
      // 手写都能塞进任意注册键,那样 embeddable 就只是建议而不是安全边界(Codex 评审)。
      const def = getView(t)
      if (!def || EMBED_DENY.has(t) || !def.embeddable) {
        return <div className="dash-widget"><div className="dash-widget-note">视图「{t}」不支持嵌入卡片</div></div>
      }
      return <ViewCard dashLeafId={leaf.id} dashPath={dashPath} blockId={id} opts={widget.opts} onClose={() => removeCard(id)} />
    }
    if (widget) return <WidgetCard widget={widget} />
    return <BlockHost blockId={id} readOnly={locked || interactId !== id} />
  }

  const renderCanvasCard = (id: string, responsive = false): ReactNode => {
    const base = layout[id]
    if (!base) return null // 自愈下一帧补位
    const r = responsive ? clampRectToBoard(base) : gest.live?.get(id) ?? clampRectToBoard(base)
    const widget = parseWidget(blocks[id]?.content ?? '')
    const interacting = interactId === id
    const selected = gest.sel.includes(id)
    return (
      <div
        key={id}
        className="dash2-card"
        data-key={id}
        data-widget={widget?.kind}
        data-selected={selected || undefined}
        data-interact={interacting || undefined}
        data-dragging={(gest.busy && selected) || undefined}
        style={responsive
          ? {
              left: `${(r.x / DASH_BOARD.w) * 100}%`,
              top: `${(r.y / DASH_BOARD.h) * 100}%`,
              width: `${(r.w / DASH_BOARD.w) * 100}%`,
              height: `${(r.h / DASH_BOARD.h) * 100}%`,
            }
          : { left: r.x, top: r.y, width: r.w, height: r.h }}
      >
        {/* 卡内容直接收事件 —— 让不让它收由手势层在 pointerdown **之前**判(canvasKit 的
            `isEditing` / CARD_CTL 放行)。双态都不再另铺一层透明罩。 */}
        <div className="dash-card-body dash2-card-body">{renderBody(id)}</div>
        {!locked && !interacting && (
          <button className="dash-card-del dash2-del" title="删除这张卡片" onClick={() => removeCard(id)}>
            <Trash2 size={12} />
          </button>
        )}
        {/* 八向把手直接复用画布的 `.amx-card-size-grip`。 */}
        {!locked && !interacting && selected && RESIZE_EDGES.map((edge) => (
          <div key={edge} className={`amx-card-size-grip is-${edge}`} data-edge={edge} title="调整大小" />
        ))}
      </div>
    )
  }

  return (
    <div
      className={`am-app tangu-lovable amx-pane amx-editor dash2${dragOver ? ' amx-dragover' : ''}`}
      data-mode={mode}
      data-flat={flat ? '1' : '0'}
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
        {!locked && (
          <button className="amx-mode-btn" title="重置画板视图(100%)" onClick={() => view.reset()}>
            <Maximize2 size={14} />
          </button>
        )}
        <button
          className={`amx-mode-btn dash2-mode-btn${locked ? '' : ' amx-pin-on'}`}
          title={locked ? '解锁编辑(可拖动/缩放/改内容)' : '锁定(浏览模式)'}
          onClick={() => leaf.setParams({ ...leaf.params, locked: !locked })}
        >
          {locked ? <Pencil size={13} /> : <Check size={14} />}
          <span>{locked ? '编辑布局' : '完成'}</span>
        </button>
        {!locked && (
          <div className="dash-add-wrap">
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
          </div>
        )}
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

      {!read2.ok && (
        <div className="dash-banner dash-banner-warn">
          这份笔记的 frontmatter 无法解析({read2.error}),布局已冻结、不会自动改写。请先修好 YAML。
        </div>
      )}
      {migratable && (
        <div className="dash-banner">
          这是旧版(网格)仪表盘。转换为画布版后卡片可自由摆放;原网格布局键保留在文件里作为回滚保险。
          <button onClick={() => { if (readLegacy.ok) applyLayout(migrateGridToCanvas(readLegacy.layout)) }}>转换为画布版</button>
        </div>
      )}
      {read2.ok && Object.keys(layout).length > 0 && (
        <div className="dash-banner">
          这份仪表盘是自由摆位的。转成自动排版后,卡片按顺序流进网格、随窗口重排,不会再出现拉伸和空洞;
          原布局键 <code>dashboard2:</code> 保留在文件里,随时可以从「更多 → 切换到自由摆位」切回来。
          <button onClick={upgradeToGrid}>转成自动排版</button>
          <button onClick={keepCanvas}>保持自由摆位</button>
        </div>
      )}
      {stale && (
        <div className="dash-banner">
          布局记录的块 id 与当前块对不上(笔记可能被重编号过),已停止自动重排以免丢失布局。
          <button onClick={() => applyLayout(reconcileCanvas({}, ids) ?? {})}>按当前顺序重排</button>
        </div>
      )}

      <DndContext sensors={noSensors}>
        {/* 宿主恒在场,ResizeObserver 才能让窄屏卡片流在窗口重新变宽后回到画板。 */}
        <div
          ref={hostRef}
          className="dash2-host"
          data-locked={locked || undefined}
          data-narrow={narrow || undefined}
          tabIndex={0}
        >
          {narrow ? (
            // 窄屏降级:卡片流(按 y,x 线性化;无拖拽,内容直接可交互)。
            <div className="dash2-list" data-locked={locked || undefined}>
              {orderedIds.map((id) => (
                <div key={id} className="dash2-list-card">{renderBody(id)}</div>
              ))}
              {!ids.length && <div className="dash2-empty">空仪表盘 —— 解锁后用 ＋ 添加卡片。</div>}
            </div>
          ) : locked ? (
            /* 成品页直接占满宿主。卡片用逻辑画板百分比定位，宽高随 View 各自响应，文字不被 scale。 */
            <div className="dash2-stage dash2-stage--responsive">
              {ids.map((id) => renderCanvasCard(id, true))}
              {!ids.length && <div className="dash2-empty dash2-empty-stage">空仪表盘 —— 解锁后用 ＋ 添加卡片。</div>}
            </div>
          ) : (
            <>
              <div className="dash2-space">
                <div className="dash2-stage" style={{ transform: `translate(${view.vp.x}px, ${view.vp.y}px) scale(${view.vp.z})` }}>
                  {/* 固定 16:9 有限画板；点阵与卡片都在它的逻辑坐标系里。 */}
                  <div
                    className="dash2-board"
                    data-editing
                    style={{ left: DASH_BOARD.x, top: DASH_BOARD.y, width: DASH_BOARD.w, height: DASH_BOARD.h }}
                    aria-hidden="true"
                  >
                    <div
                      className="amx-stage-grid dash2-board-grid"
                      style={{ ['--amx-grid-step' as string]: '24px' }}
                    />
                  </div>
                  {ids.map((id) => renderCanvasCard(id))}
                  {gest.marquee && (
                    <div className="amx-el-marquee" style={{ left: gest.marquee.x, top: gest.marquee.y, width: gest.marquee.w, height: gest.marquee.h }} />
                  )}
                  {!ids.length && <div className="dash2-empty dash2-empty-stage">空仪表盘 —— 解锁后用 ＋ 添加卡片。</div>}
                </div>
              </div>
              {!locked && mini && (
                <CanvasMiniMap
                  hostRef={hostRef}
                  vp={view.vp}
                  items={[
                    { key: '__dashboard_board__', kind: 'frame' as const, box: DASH_BOARD },
                    ...ids.filter((id) => layout[id]).map((id) => ({ key: id, kind: 'card' as const, box: gest.live?.get(id) ?? clampRectToBoard(layout[id]) })),
                  ]}
                  onCenter={view.centerOn}
                />
              )}
              {!locked && <CanvasChrome
                zoom={view.vp.z}
                onZoomBy={(f) => {
                  const el = hostRef.current
                  const r = el?.getBoundingClientRect()
                  view.setVp(zoomAt(view.vp, view.vp.z * f, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2))
                }}
                onFit={() => view.fitTo([DASH_BOARD])}
                snap={snap}
                onSnap={setSnap}
                mini={mini}
                onMini={setMini}
              />}
            </>
          )}
        </div>
      </DndContext>

      {/* 舞台右键 / 触屏长按菜单(与 Amadeus 画布同一手势入口,canvasKit 统一分派)。 */}
      {menu && !locked && (
        <>
          <div className="dash-menu-scrim" onClick={() => setMenu(null)} />
          <div ref={menuFix.ref} className="dash-add-menu" style={{ position: 'fixed', left: menu.x, top: menu.y, ...menuFix.style }}>
            {menu.key ? (
              <>
                <button onClick={() => { const k = menu.key!; setMenu(null); setInteractId(k); gest.setSel([k]) }}>进入卡片</button>
                <button className="dash-danger" onClick={() => { const keys = gest.sel.includes(menu.key!) ? gest.sel : [menu.key!]; setMenu(null); keys.forEach(removeCard) }}>
                  删除{gest.sel.length > 1 && gest.sel.includes(menu.key) ? ` ${gest.sel.length} 张卡片` : ''}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => { setMenu(null); setAddMenu(true) }}>添加卡片…</button>
                <button onClick={() => { setMenu(null); const boxes = ids.map((id) => layout[id]).filter(Boolean); boxes.length ? view.fitTo(boxes) : view.reset() }}>适应内容</button>
              </>
            )}
          </div>
        </>
      )}

      {noteMenu && (
        <>
          <div className="dash-menu-scrim" onClick={() => setNoteMenu(null)} />
          <div ref={noteMenuFix.ref} className="dash-add-menu" style={{ position: 'fixed', left: noteMenu.x, top: noteMenu.y, ...noteMenuFix.style }}>
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
                  useWorkspace.getState().closeLeaf(leaf.id) // leaf 攥着已删路径必须关(旧版 Codex 实证)
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
