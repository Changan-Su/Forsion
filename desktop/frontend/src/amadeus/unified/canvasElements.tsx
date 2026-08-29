// 画布白板层(2026-08-17):把 `amadeus_canvas.elements` 里的连线/形状/文本画出来并**可编辑**。
// 数据从 2026-08-14 的插件时代就一直在盘上(canvasMigrate 逐字带过来了)。
//
// 分工:本文件只管**画**(几何 → DOM)与**量**(DOM → 几何);一切手势、选中、菜单在 canvasStage,
// 一切写操作在 canvasEdit(纯函数,吃原始条目)。
//
// 为什么元素能编辑而**不进 PM 撤销栈**(已知天花板,不是没写完):
// AFFiNE 的图元(shape/connector/brush/text/group)同样不是块,它们住在 `affine:surface.elements`
// 的 Y.Map 里 —— 与我们的 fm `elements` 完全同构。它那边撤销之所以统一,是因为那个 Y.Map 嵌在
// `yBlocks` 这一个**事务根**里,而 UndoManager 捕不捕获看的是 transaction origin、不是子树。
// 我们的事务根是 PM doc,fm 在它之外。把容器搬进 doc(尾部原子节点)是唯一能拿到统一撤销的形状,
// 但对抗评审列了六条 P0,头一条是那个节点**删得掉**(`selectable:false` 挡得住 NodeSelection、
// 挡不住 AllSelection,Cmd+A 后一个删除键就让整块白板静默蒸发)。所以元素自带一条**独立的**
// 会话级撤销栈(canvasStage 的 elHistory),卡片仍走 PM 撤销 —— 两条栈,各自正确。
//
// 两条渲染纪律:
//  1. **`.amx-el-layer` 整层 pointer-events:none,只有形状/文本自己 auto**。连线是 SVG 大矩形,
//     让它吃指针就等于在画布上糊一层看不见的挡板(挡拖卡、挡选字、挡 ⠿),所以连线的命中一律
//     由 `hitEdge` 在舞台层用数学做。仪器 C12 钉的就是这条。
//  2. **逐项容错只在本层**。读侧 parseCanvasJson 的整键 fail-closed 绝不放宽(canvas.ts:85):
//     一条手改坏的形状不许带走全部卡片几何。反过来,一条坏形状也不该让别的元素跟着不画。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'

export interface ElBox { x: number; y: number; w: number; h: number }
interface Pt { x: number; y: number }

/** 拖卡认亲的手势预告。source/node 都是层级节点键：卡锚或主卡哨兵 `m:`。 */
export interface AttachPreview {
  source: string
  /** 同一笔被挂接的卡片数；连线只从主拖拽卡画出，标签负责说明整批语义。 */
  count?: number
  node: string
  side: 'e' | 'w' | 'n' | 's'
  rel: 'child' | 'sibling'
}

/** 端点:`{ref}` = 卡锚(卡片),`{id}` = 本层的形状 id,`{main}` = 主卡(2026-08-18,唯一实例
 *  不需要名字)。三个形态靠键名消歧;老端认不出 `{main}` → 那条连线不画但数据一个字节不动。 */
export interface EndRef { ref?: string; id?: string; main?: boolean }

/** 主卡的选中键(单实例,冒号后无 id)。与 `c:`/`e:` 同一命名空间语法,舞台的选中集合直接混用。
 *  ⚠️ 真源在 canvasEdit(数据层)—— 它同时是**层级里的主卡父键**,而剪枝住在 canvas.ts,
 *  那边不可能 import 一个 .tsx 渲染模块。这里只是转出,别在本文件里另写一份字面量。 */
export { MAIN_KEY } from './canvasEdit'
import { MAIN_KEY } from './canvasEdit'

export interface ShapeEl extends ElBox { kind: 'shape' | 'text'; id: string; shape: 'rect' | 'ellipse'; text: string | null }
export interface ConnEl { kind: 'connector'; id: string; from: EndRef; to: EndRef; label: string | null }
/** Frame(AFFiNE 同名同义,2026-08-18):一个带标题的区域,拖标题条 = 连内容整体搬走。
 *  ⚠️ 它**不是容器**:辖域是「完全落在框内」的几何判定,现算现用,盘上不存成员表 ——
 *  存成员表就要在每次移动/删除/回灌后维护它,而几何判定永远与眼睛看到的一致。 */
export interface FrameEl extends ElBox { kind: 'frame'; id: string; title: string | null }
export type El = ShapeEl | ConnEl | FrameEl

/** 选中键:卡片 `c:<锚>`,元素 `e:<id>`。卡锚与元素 id 的字符集重叠,裸值会歧义。 */
export const cardKey = (anchor: string): string => `c:${anchor}`
export const elKey = (id: string): string => `e:${id}`
/** 层级线的选中键(2026-08-19 晚,用户拍板「关系箭头可以选中直接删除」):`t:<子锚>` ——
 *  一个子节点只有一个父,子锚就是那条关系的唯一名字。⚠️ 仍然**不物化**成 elements 里的连线条目:
 *  这只是关系的引用键,盘上一个字节都没多(同一件事存两份必然分叉,见 canvasEdit 那一节)。 */
export const treeKey = (child: string): string => `t:${child}`
export const keyId = (k: string): string => k.slice(2)

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function endOf(v: unknown): EndRef | null {
  if (!v || typeof v !== 'object') return null
  const o = v as EndRef
  const ref = str(o.ref)
  if (ref) return { ref }
  const id = str(o.id)
  if (id) return { id }
  return o.main === true ? { main: true } : null
}

/** 端点 → 选中键(供连线命中后反查两端)。 */
export const endKey = (r: EndRef): string | null => (r.ref ? cardKey(r.ref) : r.id ? elKey(r.id) : r.main ? MAIN_KEY : null)

/** 逐项容错:认不出的条目**跳过这一条**,绝不上升成整键失效(见文件头纪律 2)。 */
export function safeElements(raw: unknown): El[] {
  if (!Array.isArray(raw)) return []
  const out: El[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = str(o.id)
    if (!id || seen.has(id)) continue // 重复 id:后到的丢(与插件 parseCv 同口径)
    if (o.type === 'connector') {
      const from = endOf(o.from)
      const to = endOf(o.to)
      if (!from || !to) continue
      seen.add(id)
      out.push({ kind: 'connector', id, from, to, label: str(o.label) })
      continue
    }
    if (o.type !== 'shape' && o.type !== 'text' && o.type !== 'frame') continue
    const x = num(o.x)
    const y = num(o.y)
    const w = num(o.w)
    const h = num(o.h)
    if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) continue
    seen.add(id)
    if (o.type === 'frame') {
      out.push({ kind: 'frame', id, x, y, w, h, title: str(o.title) })
      continue
    }
    out.push({ kind: o.type === 'text' ? 'text' : 'shape', id, x, y, w, h, shape: o.shape === 'ellipse' ? 'ellipse' : 'rect', text: str(o.text) })
  }
  return out
}

// ── 几何(从退休插件 forsion-plugin-canvas/src/model.ts 原样搬来:纯函数、零宿主依赖)──────

/** 连线锚点:从 from 盒中心指向 to 盒中心,交在盒边上(水平优先取左右缘,竖直取上下缘)。 */
function edgeAnchor(from: ElBox, to: ElBox): Pt {
  const cx = from.x + from.w / 2
  const cy = from.y + from.h / 2
  const dx = to.x + to.w / 2 - cx
  const dy = to.y + to.h / 2 - cy
  if (Math.abs(dx) * from.h >= Math.abs(dy) * from.w) return { x: dx >= 0 ? from.x + from.w : from.x, y: cy }
  return { x: cx, y: dy >= 0 ? from.y + from.h : from.y }
}

/** 两盒之间贝塞尔的四个控制点(路径、命中、包围盒三处必须用同一份,否则画的和点的不是一条线)。 */
function edgeCtl(a: ElBox, b: ElBox): { p1: Pt; c1: Pt; c2: Pt; p2: Pt } {
  const p1 = edgeAnchor(a, b)
  const p2 = edgeAnchor(b, a)
  const horiz = Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y)
  const pull = Math.max(24, (horiz ? Math.abs(p2.x - p1.x) : Math.abs(p2.y - p1.y)) / 2)
  const sx = Math.sign(p2.x - p1.x || 1)
  const sy = Math.sign(p2.y - p1.y || 1)
  return {
    p1,
    c1: horiz ? { x: p1.x + sx * pull, y: p1.y } : { x: p1.x, y: p1.y + sy * pull },
    c2: horiz ? { x: p2.x - sx * pull, y: p2.y } : { x: p2.x, y: p2.y - sy * pull },
    p2,
  }
}

/** `box` = 四个控制点的包围盒(贝塞尔恒在控制点凸包内,拿它当画布尺寸够且不多)。 */
function edgePath(a: ElBox, b: ElBox): { d: string; mid: Pt; tip: Pt; ang: number; box: ElBox } {
  const { p1, c1, c2, p2 } = edgeCtl(a, b)
  const xs = [p1.x, c1.x, c2.x, p2.x]
  const ys = [p1.y, c1.y, c2.y, p2.y]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`,
    mid: { x: (p1.x + p2.x) / 2 + (c1.x + c2.x - p1.x - p2.x) / 8, y: (p1.y + p2.y) / 2 + (c1.y + c2.y - p1.y - p2.y) / 8 },
    tip: p2,
    ang: Math.atan2(p2.y - c2.y, p2.x - c2.x),
    box: { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) },
  }
}

/** 点到连线的命中(24 段折线的**线段距离**,不是采样点距离 —— 长边上纯采样点会在两点之间
 *  留出 tol 打不到的死区,插件时代评审抓的;折线对该曲线族的偏差亚像素级)。 */
export function hitEdge(a: ElBox, b: ElBox, p: Pt, tol = 8): boolean {
  const { p1, c1, c2, p2 } = edgeCtl(a, b)
  let qx = p1.x
  let qy = p1.y
  for (let i = 1; i <= 24; i++) {
    const t = i / 24
    const u = 1 - t
    const x = u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x
    const y = u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y
    const dx = x - qx
    const dy = y - qy
    const len2 = dx * dx + dy * dy
    const s = len2 ? Math.max(0, Math.min(1, ((p.x - qx) * dx + (p.y - qy) * dy) / len2)) : 0
    if (Math.hypot(qx + s * dx - p.x, qy + s * dy - p.y) <= tol) return true
    qx = x
    qy = y
  }
  return false
}

/** 节点层级 → `[子, 父]` 列表(渲染用的收窄视图,与 safeElements 同待遇:逐条容错,认不出就跳过)。
 *  ⚠️ 这是**只读**视图,写侧一律用 canvasEdit 的 rawTree/setParent/pruneTree。 */
export function safeTree(raw: unknown): Array<[string, string]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: Array<[string, string]> = []
  for (const [child, parent] of Object.entries(raw as Record<string, unknown>)) {
    if (!child || typeof parent !== 'string' || !parent || parent === child) continue
    out.push([child, parent])
  }
  return out
}

/** 两盒相交(框选判定)。 */
export const boxHits = (a: ElBox, b: ElBox): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

// ── 量卡片盒 ────────────────────────────────────────────────────────────────────────

/** 卡锚 → 舞台坐标盒。
 *  ⚠️ 用 offsetLeft/offsetTop 而不是 data-x/data-y:拖拽期间只有内联 style 在动(方案 §5「过程只动
 *  CSS」),读 dataset 会让连线整场拖拽都钉在旧位置、松手才跳。offset* 系是**未缩放的局部 px**,
 *  与舞台坐标同一空间(舞台的 scale 挂在祖先 transform 上,不进 offset*)。
 *  前提:画布模式下 `.milkdown` 是 static(styles.css),卡片的 offsetParent 因此是 `.amx-stage-inner`。
 *  仪器 C12 直接钉这条 —— 哪天有人给中间层加了 position,连线会整体偏一个容器位。 */
export function measureCards(host: HTMLElement | null): Map<string, ElBox> {
  const out = new Map<string, ElBox>()
  if (!host) return out
  for (const el of host.querySelectorAll<HTMLElement>('.amx-ucard[data-anchor]')) {
    const a = el.dataset.anchor
    if (a) out.set(a, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight })
  }
  return out
}

/** 主卡盒(舞台坐标)。同一条 offset* 契约:margin 偏移进 offsetLeft/Top,拖拽期的内联 margin
 *  也进(过程只动 CSS 的通道对主卡而言就是 margin —— position/transform 会建立包含块,见文件头)。 */
export function measureMain(host: HTMLElement | null): ElBox | null {
  const pm = host?.querySelector<HTMLElement>('.ProseMirror')
  if (!pm) return null
  return { x: pm.offsetLeft, y: pm.offsetTop, w: pm.offsetWidth, h: pm.offsetHeight }
}

type OverviewItem = { key: string; anchor: string; title: string; detail: string | null; h: number; autoHeight: boolean }

function summaryOf(root: HTMLElement, outsideCards = false): { title: string; detail: string | null } | null {
  const allowed = (el: HTMLElement): boolean => !outsideCards || !el.closest('.amx-ucard')
  const lineOf = (el: HTMLElement): string | null =>
    (el.innerText || el.textContent || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null
  const headings = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].filter(allowed).map(lineOf).filter((s): s is string => !!s)
  const body = [...root.querySelectorAll<HTMLElement>('p,li,blockquote,pre')].filter(allowed).map(lineOf).filter((s): s is string => !!s)
  const title = headings[0] ?? body[0]
  if (!title) return null
  const detail = body.find((line, i) => line !== title && (headings.length > 0 || i > 0)) ?? null
  return { title, detail }
}

/** 从已提交的编辑器 DOM 抽概览快照。直接以记忆低倍率打开时，overview class 会先把 PM 子树
 * display:none；在 layout effect 中短暂摘掉 class 才能量到自然卡高，恢复发生在浏览器绘制前。 */
function captureOverview(host: HTMLElement, mainAutoHeight: boolean): OverviewItem[] {
  const wasOverview = host.classList.contains('amx-stage-overview')
  if (wasOverview) host.classList.remove('amx-stage-overview')
  try {
    const next: OverviewItem[] = []
    for (const [anchor, box] of measureCards(host)) {
      const card = host.querySelector<HTMLElement>(`.amx-ucard[data-anchor="${CSS.escape(anchor)}"]`)
      const summary = card ? summaryOf(card) : null
      if (card && summary) next.push({ key: cardKey(anchor), anchor, ...summary, h: box.h, autoHeight: Number(card.dataset.h) <= 0 })
    }
    const pm = host.querySelector<HTMLElement>('.ProseMirror')
    const mainBox = measureMain(host)
    const mainSummary = pm ? summaryOf(pm, true) : null
    if (mainBox && mainSummary) next.push({ key: MAIN_KEY, anchor: MAIN_KEY, ...mainSummary, h: mainBox.h, autoHeight: mainAutoHeight })
    return next
  } finally {
    if (wasOverview) host.classList.add('amx-stage-overview')
  }
}

function sameOverviewItems(a: OverviewItem[], b: OverviewItem[]): boolean {
  return a.length === b.length && a.every((item, i) => {
    const other = b[i]
    return item.key === other?.key && item.anchor === other.anchor && item.title === other.title
      && item.detail === other.detail && item.h === other.h && item.autoHeight === other.autoHeight
  })
}

/** 手势期的幽灵位移/缩放:只作用在渲染上,松手才落盘(与卡片的「过程只动 CSS」同一条纪律)。
 *  ⚠️ size 带 dx/dy(2026-08-19 四角塑型):拖左上角要**同时**改左上角与尺寸。方向数学一次性在
 *  舞台的 onMove 里按「对角固定点」算完(夹住 MIN_EL 之后再回推 dx/dy),这里只做加法 ——
 *  否则拖到最小尺寸后继续拖,元素会顺着指针整体走位。 */
export interface ElGhost {
  move: { ids: ReadonlySet<string>; dx: number; dy: number } | null
  size: { id: string; dx: number; dy: number; dw: number; dh: number } | null
}
export const MIN_EL = 24

/** 元素 id → 盒(已叠加幽灵)。舞台的框选/连线命中都吃这一份 —— 与屏幕上看到的必须是同一个盒。 */
export function shapeBoxes(els: El[], ghost?: ElGhost | null): Map<string, ElBox> {
  const m = new Map<string, ElBox>()
  for (const e of els) {
    if (e.kind === 'connector') continue
    let b: ElBox = { x: e.x, y: e.y, w: e.w, h: e.h }
    if (ghost?.move && ghost.move.ids.has(elKey(e.id))) b = { ...b, x: b.x + ghost.move.dx, y: b.y + ghost.move.dy }
    if (ghost?.size && ghost.size.id === e.id) {
      b = { x: b.x + ghost.size.dx, y: b.y + ghost.size.dy, w: Math.max(MIN_EL, b.w + ghost.size.dw), h: Math.max(MIN_EL, b.h + ghost.size.dh) }
    }
    m.set(e.id, b)
  }
  return m
}

export interface CanvasElementsProps {
  /** `amadeus_canvas.elements` 原值(未校验)。 */
  elements: unknown
  /** 舞台根。ref 对象**本身**传下来(不传 `() => ref.current`):行内箭头每渲染换身份,
   *  挂进 effect 依赖会把观察者拆了重装,这个仓在同一个坑上栽过两次(见 canvasStage 顶注)。 */
  hostRef: RefObject<HTMLDivElement | null>
  /** 当前画布身份。记忆倍率下换页会复用/重建舞台，概览快照必须与文档绑定，不能沿用上一页。 */
  documentKey: string
  sel: ReadonlySet<string>
  /** 正在编辑的卡锚(两段式的第二段)。选中框换成「编辑中」的那一套描边 —— 见下面为什么画在本层。 */
  editing?: string | null
  /** `amadeus_canvas.tree` 原值(未校验)。层级线由它**现算**,盘上没有对应的连线条目。 */
  tree?: unknown
  ghost: ElGhost | null
  /** 框选矩形(舞台坐标);null = 没在框选。 */
  marquee: ElBox | null
  /** 拖到边缘认亲的当前候选(2026-08-19 晚):在目标卡的那条边上画一道粗高亮。
   *  ⚠️ 只是**手势期的意图预告**,不是数据 —— 松手才由舞台落笔。 */
  attach?: AttachPreview | null
  /** 缩到正文不可读时传当前倍率，渲染轻量标题/摘要替身；null = 常规正文。 */
  overviewScale?: number | null
  /** 主卡没有显式 h 时，概览模式要用切换前实测高度撑住卡壳。 */
  mainAutoHeight?: boolean
  /** 连线橡皮筋(2026-08-18):第一击之后跟随指针的预览线 + 有效目标高亮。
   *  from = 起点选中键,x/y = 指针舞台坐标,over = 指针下的可连对象(高亮用)。 */
  preview?: { from: string; x: number; y: number; over: string | null } | null
}

export function CanvasElements({ elements, hostRef, documentKey, sel, editing, tree, ghost, marquee, attach, overviewScale, mainAutoHeight = true, preview }: CanvasElementsProps): React.ReactElement | null {
  const els = useMemo(() => safeElements(elements), [elements])
  const edges = useMemo(() => safeTree(tree), [tree])
  const [ver, setVer] = useState(0)
  const n = els.length + edges.length
  /** 选中的卡锚。⚠️ 卡片的选中框**画在本层**,不是给卡片 DOM 加 class —— 卡片 DOM 归 PM 所有,
   *  它任何一次重绘(别处打字、外部回灌、框选顺带设选区)都会按 toDOM 重写 class 属性,把外科挂上去的
   *  选中框静默抹掉(实测:框选后卡片一个框都不显示,而形状的框好好的)。画在本层则完全归 React。 */
  const selCards = [...sel].filter((k) => k.startsWith('c:')).map(keyId)
  const mainSel = sel.has(MAIN_KEY)
  const live = n + selCards.length + (mainSel ? 1 : 0)
  const overviewActive = overviewScale != null && overviewScale > 0
  const [overviewSnapshot, setOverviewSnapshot] = useState<{ documentKey: string; items: OverviewItem[] }>({ documentKey: '', items: [] })

  // 卡片/主卡一动(搬/调宽/打字改高)连线与主卡选中框就得跟着走。本层只在画布模式挂载,而画布
  // 模式恒有主卡几何要跟(选中框/连线端点都读 mainBox)—— 观察者常开(2026-08-18 起;此前按
  // 「有元素才装」门控,主卡成为一等节点后那个门控只会让这些浮层停在旧位置)。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let raf = 0
    const ro = new ResizeObserver(() => bump())
    // ⚠️ 只观察舞台不够:卡片**只变尺寸、不动 DOM** 的路径没有任何 mutation ——
    //    卡内图片加载完、Web Font 生效、主题换行高,连线会永远吸在旧边缘上(Codex 评审 P1)。
    //    所以每次 bump 顺手把观察集合与当前卡片对齐(observe 新卡会自发一次首帧回调,自然收敛)。
    const watched = new Set<Element>()
    const syncTargets = (): void => {
      const now = new Set<Element>(host.querySelectorAll('.amx-ucard'))
      const pm = host.querySelector('.ProseMirror')
      if (pm) now.add(pm) // 主卡:连线端点虽然还够不到它,但它变高会顶动整个版面
      // ⚠️ 必须 border-box:RO 默认量 content-box,而 measureCards 用的是 offsetHeight(border-box)。
      //    口径不一致的现象是「只改 padding/border 的尺寸变化收不到通知」—— 磁盘主题包换装改
      //    `.amx-ucard` 的内衬就会让连线停在旧边缘(对抗评审 P2)。
      for (const el of now) if (!watched.has(el)) { ro.observe(el, { box: 'border-box' }); watched.add(el) }
      for (const el of [...watched]) if (!now.has(el)) { ro.unobserve(el); watched.delete(el) }
    }
    const bump = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { syncTargets(); setVer((v) => v + 1) })
    }
    bump() // 挂载即量一次:观察者不会为「已经在那儿的 DOM」补发通知
    const mo = new MutationObserver(bump)
    mo.observe(host, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'data-x', 'data-y', 'data-w', 'data-h'] })
    ro.observe(host)
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      ro.disconnect()
    }
  }, [hostRef])

  // ⚠️ ghost 必须进依赖:拖拽期卡片几何走舞台的 dragCss 样式表(不碰 PM DOM → 零 mutation →
  //    观察者收不到任何通知),选中框/连线要跟手只能靠「每帧幽灵变化时重量一次」。量的就是
  //    样式表作用后的 offset*,与屏幕恒一致。
  const boxes = useMemo(() => measureCards(hostRef.current), [hostRef, documentKey, overviewSnapshot.documentKey, ver, live, ghost])
  const shapes = useMemo(() => shapeBoxes(els, ghost), [els, ghost])
  // 主卡盒不进 memo:它的位置随 --amx-main-* 变(props 流,不经 ver),一次 querySelector 量它不值一个缓存。
  const mainBox = measureMain(hostRef.current)

  /** 低倍率不是在完整正文上盖一行字：从已提交的 PM DOM 抽轻量快照，CSS 再把原块子树
   * display:none。Milkdown 换页后异步创建 EditorView，所以不能在 render 里把第一次空结果永久
   * 冻结；DOM 观察器的 ver 到来时继续补抽。内容没变化时保持同一份 state，平移/缩放不遍历 PM。 */
  useLayoutEffect(() => {
    if (!overviewActive) return
    const host = hostRef.current
    const pm = host?.querySelector<HTMLElement>('.ProseMirror')
    if (!host || !pm || pm.childElementCount === 0) return
    const next = captureOverview(host, mainAutoHeight)
    setOverviewSnapshot((prev) =>
      prev.documentKey === documentKey && sameOverviewItems(prev.items, next)
        ? prev
        : { documentKey, items: next })
  }, [documentKey, hostRef, mainAutoHeight, overviewActive, ver])
  const overviewItems = overviewSnapshot.documentKey === documentKey ? overviewSnapshot.items : []
  const fullOverviewAnchors = new Set<string>([
    ...selCards,
    ...(mainSel ? [MAIN_KEY] : []),
  ])
  const overview = overviewActive
    ? overviewItems.flatMap((item) => {
        // 选中的卡必须保留真实 PM 子树，既能读全量内容也能继续进入编辑；它不再画轻量替身。
        if (fullOverviewAnchors.has(item.anchor)) return []
        const box = item.anchor === MAIN_KEY ? mainBox : boxes.get(item.anchor)
        return box ? [{ ...item, box }] : []
      })
    : []
  const overviewScope = hostRef.current?.dataset.amxDragscope
  const overviewCss = overviewActive && overviewScope
    ? overviewItems.flatMap((item) => {
        const root = `.amx-stage[data-amx-dragscope="${CSS.escape(overviewScope)}"].amx-stage-overview`
        if (fullOverviewAnchors.has(item.anchor)) return []
        if (item.anchor === MAIN_KEY) return [
          `${root} .ProseMirror:not(.unified-embed .ProseMirror) > :not(.amx-ucard){display:none!important;}`,
          ...(mainAutoHeight ? [`${root} .ProseMirror:not(.unified-embed .ProseMirror){height:${item.h}px;}`] : []),
        ]
        const card = `${root} .amx-ucard[data-anchor="${CSS.escape(item.anchor)}"]`
        return [
          `${card} > *{display:none!important;}`,
          ...(item.autoHeight ? [`${card}[data-h="0"]{height:${item.h}px;}`] : []),
        ]
      }).join('\n')
    : ''

  const boxOf = (r: EndRef): ElBox | null =>
    r.ref != null ? boxes.get(r.ref) ?? null : r.id != null ? shapes.get(r.id) ?? null : r.main ? mainBox : null
  /** 选中键 → 盒(橡皮筋起点与目标高亮用;与 boxOf 同一份几何)。 */
  const keyBox = (k: string): ElBox | null => (k === MAIN_KEY ? mainBox : k.startsWith('c:') ? boxes.get(keyId(k)) ?? null : shapes.get(keyId(k)) ?? null)
  return (
    <div className="amx-el-layer">
      {overviewCss ? <style data-amx-overview-rules>{overviewCss}</style> : null}
      {/* Frame 先画 = 垫在最底下(同为 absolute 且都没 z-index,绘制序即 DOM 序)。 */}
      {els.filter((e): e is FrameEl => e.kind === 'frame').map((e) => (
        <Frame key={e.id} el={e} box={shapes.get(e.id)!} sel={sel.has(elKey(e.id))} />
      ))}
      {els.filter((e) => e.kind !== 'frame').map((e) =>
        e.kind === 'connector'
          ? <Connector key={e.id} el={e} a={boxOf(e.from)} b={boxOf(e.to)} sel={sel.has(elKey(e.id))} />
          : <Shape key={e.id} el={e} box={shapes.get(e.id)!} sel={sel.has(elKey(e.id))} />,
      )}
      {/* 四角塑型把手(2026-08-19,单选一个元素时)。⚠️ 画在**本层**而不是元素内部:形状是
          `overflow: hidden`(要裁文字),塞在里面的把手无论正偏负偏都被裁掉 —— 修前 rect 的把手
          肉眼看不见、elementFromPoint 也命中不到,形状根本调不了尺寸(用户 08-19 实报「都应该
          能够塑型」)。椭圆更狠:圆角 50% 会把整个角都裁没。 */}
      {sel.size === 1 && [...sel][0].startsWith('e:') && shapes.has(keyId([...sel][0]))
        ? <Grips id={keyId([...sel][0])} box={shapes.get(keyId([...sel][0]))!} />
        : null}
      {/* 层级线:由 tree **现算**,盘上没有对应的连线条目(见 canvasEdit 那一节)。故意不可选中 ——
          它不是一个对象,是父子关系的影子;要断开就改层级,不是删线。 */}
      {edges.map(([child, parent]) => {
        // 父位可以是主卡的哨兵 `m:`(2026-08-19):主卡也能长子节点,层级线得画到正文那一盒上。
        const a = parent === MAIN_KEY ? mainBox : boxes.get(parent)
        const b = boxes.get(child)
        const from: EndRef = parent === MAIN_KEY ? { main: true } : { ref: parent }
        return a && b ? <Connector key={`t:${child}`} el={{ kind: 'connector', id: `t:${child}`, from, to: { ref: child }, label: null }} a={a} b={b} sel={sel.has(treeKey(child))} tree /> : null
      })}
      {selCards.map((a) => {
        const b = boxes.get(a)
        return b ? (
          <div key={`sel:${a}`} className={`amx-el-selbox${editing === a ? ' is-editing' : ''}`} data-anchor={a} style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }}>
            {sel.size === 1 && editing !== a ? <><CardResizeHandles anchor={a} /><AddButtons node={a} /></> : null}
          </div>
        ) : null
      })}
      {/* 主卡**完全等同卡片**(2026-08-18 晚,用户拍板;「正文」标题条已移除,别加回来):
          选中/拖动手柄 = padding 圈(事件目标==.ProseMirror 本身),正文区单击选中/拖动、
          空格进入编辑,命中逻辑全在 canvasStage.onDown。 */}
      {mainSel && mainBox ? (
        <div className={`amx-el-selbox${editing === MAIN_KEY ? ' is-editing' : ''}`} data-main-sel style={{ left: `${mainBox.x}px`, top: `${mainBox.y}px`, width: `${mainBox.w}px`, height: `${mainBox.h}px` }}>
          {sel.size === 1 && editing !== MAIN_KEY ? <><CardResizeHandles anchor={MAIN_KEY} /><AddButtons node={MAIN_KEY} /></> : null}
        </div>
      ) : null}
      {/* 原 PM 内容已经由 overview 状态从渲染树中摘下；这里是唯一可见的轻量标题/摘要替身。 */}
      {overview.map((item) => {
        // 概览文字按屏幕 px 保持可读，但卡壳仍随舞台缩小：若永远硬塞标题+两行摘要，约 40% 时
        // 一张 67px 高的卡在屏幕上只剩 27px，flex 只好把每行压扁。按**屏幕卡高**降密度，极小卡
        // 只留完整标题；到 MIN_Z 时再轻微缩小标题，而不是裁字或撑大卡壳改变连线几何。
        const screenH = item.box.h * overviewScale!
        const density = screenH < 44 ? 'title' : screenH < 60 ? 'summary' : 'full'
        const titleScreenPx = density === 'title'
          ? Math.max(8, Math.min(12, (screenH - 3) / 1.2))
          : 12
        return (
          <div
            key={`overview:${item.key}`}
            className="amx-card-overview"
            data-card-label={item.anchor}
            data-overview-density={density}
            style={{
              left: `${item.box.x}px`,
              top: `${item.box.y}px`,
              width: `${item.box.w}px`,
              height: `${item.box.h}px`,
              ['--amx-overview-inv' as string]: String(1 / overviewScale!),
              ['--amx-overview-title-screen' as string]: `${titleScreenPx}px`,
            }}
          >
            <span className="amx-card-overview-title">{item.title}</span>
            {item.detail ? <span className="amx-card-overview-detail">{item.detail}</span> : null}
          </div>
        )
      })}
      {/* 连线橡皮筋:起点/目标描边 + 跟随指针的预览线(悬到有效目标上就吸附到它的盒)。 */}
      {preview
        ? (() => {
            const a = keyBox(preview.from)
            if (!a) return null
            const overBox = preview.over ? keyBox(preview.over) : null
            const b: ElBox = overBox ?? { x: preview.x, y: preview.y, w: 1, h: 1 }
            return (
              <>
                <Connector el={{ kind: 'connector', id: '~preview', from: {}, to: {}, label: null }} a={a} b={b} sel={false} preview />
                <div className="amx-conn-target" style={{ left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` }} />
                {overBox ? <div className="amx-conn-target" style={{ left: `${overBox.x}px`, top: `${overBox.y}px`, width: `${overBox.w}px`, height: `${overBox.h}px` }} /> : null}
              </>
            )
          })()
        : null}
      {/* ⚠️ 类名不能叫 `.amx-marquee` —— blockLayer 的块框选用的就是那个名字(挂在 body 上、client
          坐标),同名会让仪器把两个框数成一个东西,而它们连坐标系都不同。 */}
      {/* 认亲预告只说明目标与关系：目标整卡起环、源→目标画细线、边口给关系标签。
          最终落点由松手后的自动布局决定，不再另画幽灵占位卡。 */}
      {attach ? (() => {
        const b = attach.node === MAIN_KEY ? mainBox : boxes.get(attach.node)
        const source = boxes.get(attach.source)
        if (!b) return null
        const T = 3
        const MARK = 22
        const horiz = attach.side === 'n' || attach.side === 's'
        const lx = attach.side === 'w' ? b.x : attach.side === 'e' ? b.x + b.w : b.x + b.w / 2
        const ly = attach.side === 'n' ? b.y : attach.side === 's' ? b.y + b.h : b.y + b.h / 2
        return (
          <>
            {source ? (
              <Connector
                el={{ kind: 'connector', id: '~attach', from: { ref: attach.source }, to: attach.node === MAIN_KEY ? { main: true } : { ref: attach.node }, label: null }}
                a={source}
                b={b}
                sel={false}
                preview
              />
            ) : null}
            <div className={`amx-el-attach-target is-${attach.rel}`} style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }} />
            <div
              className={`amx-el-attach is-${attach.rel}`}
              data-attach={attach.side}
              style={{
                left: `${attach.side === 'e' ? b.x + b.w - T : attach.side === 'w' ? b.x : b.x + (b.w - MARK) / 2}px`,
                top: `${attach.side === 's' ? b.y + b.h - T : attach.side === 'n' ? b.y : b.y + (b.h - MARK) / 2}px`,
                width: `${horiz ? MARK : T}px`,
                height: `${horiz ? T : MARK}px`,
              }}
            />
            <div className={`amx-el-attach-label is-${attach.rel}`} style={{ left: `${lx}px`, top: `${ly}px` }}>
              {attach.count && attach.count > 1 ? `${attach.count} 张 · ` : ''}{attach.rel === 'child' ? '设为子节点' : '设为同级节点'}
            </div>
          </>
        )
      })() : null}
      {marquee ? (
        <div className="amx-el-marquee" style={{ left: `${marquee.x}px`, top: `${marquee.y}px`, width: `${marquee.w}px`, height: `${marquee.h}px` }} />
      ) : null}
    </div>
  )
}

/** 四角塑型把手。`data-grip` 是舞台 pointerdown 的判据,`data-corner` 决定哪个角**不动**。
 *  ⚠️ 必须显式 `pointer-events: auto`(CSS 里配套):它住在 `.amx-el-layer` 之内,而那一层整片
 *  是 `pointer-events: none`(文件头纪律 1,C12 钉着)—— 少这一条把手就是画上去的贴纸。 */
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const
const CARD_EDGES = ['n', 'e', 's', 'w', ...CORNERS] as const

/** 卡片选中后四边与四角都是尺寸热区。它们住在选中浮层里，不改 PM 管辖的卡片 DOM。 */
function CardResizeHandles({ anchor }: { anchor: string }): React.ReactElement {
  return (
    <>
      {CARD_EDGES.map((edge) => (
        <div key={edge} className={`amx-card-size-grip is-${edge}`} data-card-grip={anchor} data-card-edge={edge} />
      ))}
    </>
  )
}

function Grips({ id, box }: { id: string; box: ElBox }): React.ReactElement {
  return (
    <>
      {CORNERS.map((c) => (
        <div
          key={c}
          className={`amx-el-grip is-free is-${c}`}
          data-grip={id}
          data-corner={c}
          style={{ left: `${(c[1] === 'e' ? box.x + box.w : box.x) - 5}px`, top: `${(c[0] === 's' ? box.y + box.h : box.y) - 5}px` }}
        />
      ))}
    </>
  )
}

/** 卡片/主卡侧边的 ⊕(AFFiNE autocomplete 同款):右=子节点,下=兄弟节点 —— 与键盘的
 *  Tab/回车**同一条 addRelated**,摆位启发式也同一份。只在单选且不在编辑态时出。
 *  ⚠️ 点击不走 React onClick:舞台的 pointerdown 在冒泡路上会把这一下当「点空白」→ 清选中 →
 *  选中框连同按钮当场卸载,click 永远等不到。判据交给 `data-add`,由 onDown 优先认领。 */
function AddButtons({ node }: { node: string }): React.ReactElement {
  return (
    <>
      <div className="amx-el-add is-child" data-add="child" data-node={node} title="新建子卡片(Tab)">+</div>
      <div className="amx-el-add is-sibling" data-add="sibling" data-node={node} title="新建兄弟卡片(回车)">+</div>
    </>
  )
}

/** Frame。⚠️ **框体整片 pointer-events:none**,只有标题条与四角把手 auto —— 一个满屏大的
 *  可点矩形就是糊在画布上的看不见的挡板(挡拖卡、挡选字、挡 ⠿),文件头纪律 1 说的就是这件事。
 *  代价是「点框内空白不会选中 Frame」,那与 Figma/AFFiNE 一致(那两家也是点标题选框)。 */
function Frame({ el, box, sel }: { el: FrameEl; box: ElBox; sel: boolean }): React.ReactElement {
  return (
    <div
      className={`amx-el-frame${sel ? ' is-sel' : ''}`}
      style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }}
    >
      <div className="amx-el-frame-bar" data-el={el.id}>{el.title ?? 'Frame'}</div>
    </div>
  )
}

function Shape({ el, box, sel }: { el: ShapeEl; box: ElBox; sel: boolean }): React.ReactElement {
  const cls = el.kind === 'text' ? 'amx-el-text' : el.shape === 'ellipse' ? 'amx-el-ellipse' : 'amx-el-rect'
  return (
    <div
      className={`amx-el-shape ${cls}${sel ? ' is-sel' : ''}`}
      data-el={el.id}
      style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }}
    >
      {el.text}
    </div>
  )
}

/** 端点解析不了(卡片被删了 / 连的是迁移前留在主卡里的块)→ **不画,但数据一个字节不动**:
 *  剪枝是写侧的活,而且必须与删除同属一笔事务(否则撤销删卡时连线不会回来)—— 只读渲染
 *  越权去剪,等于让「看一眼」变成一次静默改档。(删**形状**时的剪枝在 canvasEdit.removeElements,
 *  那一笔与删除同进同出,所以那边剪是对的。) */
function Connector({ el, a, b, sel, tree, preview }: { el: ConnEl; a: ElBox | null; b: ElBox | null; sel: boolean; tree?: boolean; preview?: boolean }): React.ReactElement | null {
  if (!a || !b) return null
  const p = edgePath(a, b)
  const PAD = 14 // 箭头与描边要在画布内,不然被 svg 视口裁掉
  const box = { x: p.box.x - PAD, y: p.box.y - PAD, w: p.box.w + PAD * 2, h: p.box.h + PAD * 2 }
  // 箭头直接画成三角形,不用 <marker>:marker 要 `url(#id)`,而 id 在整篇 document 里共享 ——
  // 同时开两篇画布笔记、元素 id 又都是迁移生成的 e1/e2 时就会撞。三角形零 id。
  const L = 9
  const W = 4.5
  const cos = Math.cos(p.ang)
  const sin = Math.sin(p.ang)
  const tri = [
    `${p.tip.x},${p.tip.y}`,
    `${p.tip.x - L * cos + W * sin},${p.tip.y - L * sin - W * cos}`,
    `${p.tip.x - L * cos - W * sin},${p.tip.y - L * sin + W * cos}`,
  ].join(' ')
  return (
    <>
      {/* viewBox 直接吃舞台坐标 → path 的 d 不用做任何平移换算。 */}
      <svg
        className={`amx-el-conn${sel ? ' is-sel' : ''}${tree ? ' is-tree' : ''}${preview ? ' is-preview' : ''}`}
        data-el={el.id}
        style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      >
        <path d={p.d} />
        {/* 层级线不带箭头(mindmap 惯例:父子关系靠位置读,不靠指向) */}
        {tree ? null : <polygon points={tri} />}
      </svg>
      {el.label ? (
        <div className={`amx-el-label${sel ? ' is-sel' : ''}`} style={{ left: `${p.mid.x}px`, top: `${p.mid.y}px` }}>
          {el.label}
        </div>
      ) : null}
    </>
  )
}
