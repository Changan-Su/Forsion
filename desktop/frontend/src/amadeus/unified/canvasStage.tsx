// 画布模式的舞台层(2026-08-16 Phase 1 几何 / 2026-08-17 Phase 2 白板可编辑)。
// 数据层在 canvas.ts(卡片)与 canvasEdit.ts(白板元素),渲染在 canvasElements.tsx,
// 这里只管「怎么摆、怎么拖、怎么选」。
//
// 渲染模型:舞台(relative)> stage-inner(absolute + `translate(px,py) scale(z)`)> 编辑器。
// 主卡 = 未入卡的自然流,用 **margin** 偏移(margin 不建立包含块,卡片的绝对定位才能继续落在
// stage-inner 的坐标系里 —— 换成 position/transform 偏移,卡片坐标会当场变成「相对主卡」)。
//
// ⚠️ 没抄 AFFiNE 的两段式(手势期 transform 近似 → 手势结束逐卡按真实坐标重排 + 每卡自身 scale)。
// 那套是为它们的 canvas2d 渲染器省重绘的;我们的 Spike(scripts/unified-scale.check.cjs,13/13,
// k=0.5/1/2)已经实测「整片 transform: scale(k) 底下 PM 的点击落点/IME/⠿ 把手/拖拽落点全部成立」——
// 前提是 blockLayer 的 visualScale + overlayOrigin 那套补偿(2026-08-15 落地)。既然直的可行,
// 就不引入两段式的状态机。真遇到卡片数量级上来的重绘问题再回来抄,接口不用改。
//
// 卡片手柄不另建 DOM:卡片在画布模式下带一圈 padding,**事件目标恰好是卡片 div 本身**(而不是
// 内部的 p/h1/…)就说明指针落在这圈 chrome 上 → 靠右缘 10px 内 = 调宽,其余 = 搬卡。
// 好处是零额外节点、零 NodeView —— PM 的文档结构完全不知道有画布这回事。
//
// **两条撤销栈 + 一条统一时间线**(2026-08-18 收口,底座理由见 canvasElements 顶注):卡片的
// 几何/正文走 PM history,白板元素/层级/主卡住 fm、走会话级快照栈 —— 两条栈都不动,动的是仲裁:
// createHistoryTimeline(canvas.ts)在编辑器里记每个新 PM 撤销组,fm 写点记每笔 fm 快照,
// Cmd+Z(捕获期拦,卡内卡外一律)按时间线退「最近发生的那件事」;Tab 这类跨域动作并成 'pair'
// 一击双退。陈旧条目(编辑器重建/深度截断)由 histStep 丢弃自愈,绝不卡死撤销链。
import { useCallback, useEffect, useRef, useState } from 'react'
import { NodeSelection, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { closeHistory, undo as pmUndo, redo as pmRedo, undoDepth, redoDepth } from '@milkdown/kit/prose/history'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Fragment, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { MousePointer2, Hand, Square, Circle, Type, Spline, StickyNote, Frame, Minus, Plus, Maximize2 } from 'lucide-react'
import { zoomOf } from '@lcl/engine'
import { CARD_W, MAIN_W, type CanvasMain, type UndoTimeline } from './canvas'
import {
  CanvasElements, cardKey, elKey, treeKey, keyId, safeElements, safeTree, shapeBoxes, measureCards, measureMain, hitEdge, boxHits, endKey,
  MAIN_KEY, MIN_EL, type El, type ElBox, type ElGhost, type FrameEl,
} from './canvasElements'
import { rawList, patchElement, removeElements, moveElements, freshElId, newShape, newShapeBox, newFrame, FRAME_SIZE, addConnector, setElementText, rawTree, setParent, childrenOf, isUnder, type ShapeKind } from './canvasEdit'
import { freshAnchorId } from './columns'
import { askString } from '../components/askString'
import { OverlayPortal } from '../lib/overlayPortal'
import { OverlayAt } from '../lib/clampMenu'

const MIN_Z = 0.25
const MAX_Z = 2.5
const MIN_W = 160
const MAIN_MIN_W = 320 // 主卡调宽下限(比卡片宽:它是正文,压太窄就不是「文档优先」了)
const GRIP = 12 // 右缘调宽热区(舞台像素)
const NUDGE = 8
/** 指针一次都没真正移动过(纯点击)的判据。落笔前必须问这一句 —— 见 onUp 的告警。 */
const CLICK_SLOP = 3
/** 元素的可点面:形状本体,以及 Frame 的**标题条**(框体整片 pointer-events:none,见 canvasElements
 *  的 Frame 顶注 —— 一个满屏大的可点矩形就是糊在画布上的隐形挡板)。 */
const EL_HIT = '.amx-el-shape, .amx-el-frame-bar'
/** 元素的文字键与弹窗抬头:连线=label、Frame=title、其余=text。四处调用共用,别再各写一遍三元。 */
const textKeyOf = (el: El): 'text' | 'label' | 'title' => (el.kind === 'connector' ? 'label' : el.kind === 'frame' ? 'title' : 'text')
const textTitleOf = (el: El): string => (el.kind === 'connector' ? '连线标签' : el.kind === 'frame' ? 'Frame 标题' : '元素文字')

export interface Viewport { x: number; y: number; z: number }

/** 会话级视口(方案 §3.1:平移/缩放**不落盘**,AFFiNE 同款;落 fm 会让每次平移都触发写盘)。 */
const viewports = new Map<string, Viewport>()

/** fm 侧(elements+tree+main)的撤销栈。存的是三键合影的 JSON 快照 —— 表本来就小,存整份比记
 *  差分省心得多,而且天然免疫「差分基底漂移」。
 *  ⚠️ **每个实例一份(useRef),不是模块级按 path 存**。按 path 存的话同一篇开两个标签就共用一条栈:
 *  A 标签连改两次、B 标签还没回灌完就按 Cmd+Z,B 会弹出 A 的快照、把整份元素表写成别人的历史
 *  (Codex 评审 P0-2)。作用域跟 PM 自己的撤销栈对齐 = 跟编辑器实例同生共死;舞台在切模式时不重挂,
 *  所以「切到文档再切回来」栈还在,而换页/关页就该清零。 */
interface ElHistory { past: string[]; future: string[] }
const HIST_CAP = 50

type Tool = 'select' | 'pan' | 'card' | 'rect' | 'ellipse' | 'text' | 'frame' | 'conn'
/** 按下拖出尺寸的工具(2026-08-19 用户实报「都应该能够塑型」)。文本不在里面 —— 它的高随字号,
 *  AFFiNE 同样只给点击建。拖不动 CLICK_SLOP 就回落成默认尺寸,与修前的一击建完全一致。 */
const DRAW_TOOLS = new Set<Tool>(['rect', 'ellipse', 'frame'])
const SHAPE_TOOLS: Record<string, ShapeKind> = { rect: 'rect', ellipse: 'ellipse', text: 'text' }
/** 拖拽样式表的舞台作用域序号(见手势 effect 里 dragCss 的告警)。 */
let dragScopeSeq = 0

/** `idx` = 它在 doc 顶层子节点里的**序号**(不是卡片序号)。⚠️ 有了它才判得出「两张卡之间夹没夹
 *  别的东西」—— cards 是过滤后的数组,相邻两项在文档里可能隔着好几段正文(Codex 2026-08-20 critical
 *  实证:少这一条,重排子树会把夹在中间的正文整段删掉)。 */
interface CardBox { anchor: string; pos: number; idx: number; node: ProseNode }

/** doc 顶层的卡片节点(锚 → 位置)。锚唯一,按锚找比 posAtDOM 稳(卡内 DOM 结构随内容变)。 */
function cardsOfDoc(doc: ProseNode): CardBox[] {
  const out: CardBox[] = []
  doc.forEach((node, offset, index) => {
    if (node.type.name === 'amadeusCanvasCard') out.push({ anchor: String(node.attrs.anchor), pos: offset, idx: index, node })
  })
  return out
}
function cardsOf(view: EditorView): CardBox[] {
  return cardsOfDoc(view.state.doc)
}

// ── 「排序始终在父 Card 内」(2026-08-19 用户拍板)。────────────────────────────────────────
// 文档模式的层级呈现由两半组成:**源码相邻**在这里(认爹 / 建子节点时把子卡那一段整体搬到父段
// 之后),**缩进**在 canvas.ts 的 createCardDepthDeco。为什么不是真嵌套见那边的顶注。
// 只在**用户改层级的那一刻**搬,不设常驻 normalizer —— 本周全部毁档都出自「每笔事务都重排一遍
// 文档」那类补丁(canvas.ts 顶注:勿把拆壳/吸收加回来),这里不许重蹈。

/** 卡片子树在 doc 顶层的**连续段**:从 cards[i] 起,把**紧邻其后**、且确实是它后代的卡一并算进来。
 *  段是被「认爹即搬到父段末尾」构造出来的,正常路径下恒连续;中间隔了正文或别人的卡就在那里
 *  收边 —— 宁可少搬一截,绝不吞不属于它的内容。返回结束下标(不含)。
 *  ⚠️ `idx` 那一条是**毁数据防线**,不是优化:cards 是过滤后的数组,只判后代关系的话
 *  `[子卡, 正文, 孙卡]` 会被算成一整段,而 orderUnder 按首尾位置删区间、只把卡片插回去 ——
 *  夹在中间的正文当场永久消失(Codex 2026-08-20 critical,同形 PM 文档实证)。注释里写过
 *  「遇正文收边」但代码里没有,正是本仓栽过多次的那一族。 */
function runEnd(cards: CardBox[], i: number, tree: Record<string, unknown>): number {
  let end = i + 1
  while (end < cards.length
    && cards[end].idx === cards[end - 1].idx + 1
    && isUnder(tree, cards[end].anchor, cards[i].anchor)) end++
  return end
}

/** 「插在这张卡的子树之后」的 doc 位置。父不是本篇的卡(主卡哨兵 `m:` / 外部改坏)→ 文末。 */
function tailPosUnder(doc: ProseNode, tree: Record<string, unknown>, parent: string): number {
  const cards = cardsOfDoc(doc)
  const i = cards.findIndex((c) => c.anchor === parent)
  if (i < 0) return doc.content.size
  const last = cards[runEnd(cards, i, tree) - 1]
  return last.pos + last.node.nodeSize
}

/** 把 child 的卡片段搬到 parent 段之后;`parent` 空 = **摘爹**,整段搬到文末。只搬**顶层整节点**,
 *  正文一个字不动;已经到位就零 step 返回(幂等)。
 *  ⚠️ `tree` 必须传**认爹之后**的那份:段的归属按新关系算,拿旧表算出来的段会把新子卡漏在外面。
 *  ⚠️ 摘爹**必须也搬**(Codex 2026-08-20 high):`[P,A,B]` 里 A、B 都挂 P,把 A 摘成自由卡却留在
 *     原地的话,P 的段被 A 劈成两半 —— 此后 runEnd(P) 走到 A 就停,B 明明还认 P 却落在父段之外,
 *     再搬 P 就会把 B 丢下,「排序始终在父 Card 内」当场破。搬到文末 = 与双击建自由卡同一落点。
 *  ⚠️ 删除后的落点偏移**手算**:两段都在顶层且不重叠,减掉被删长度即可 —— 走 tr.mapping 会把同
 *     一笔里的几何 setNodeMarkup 也算进去(它的 StepMap 覆盖卡的开闭边界),落点会偏一格。 */
function orderUnder(tr: Transaction, tree: Record<string, unknown>, child: string, parent: string): Transaction {
  const cards = cardsOfDoc(tr.doc)
  const ci = cards.findIndex((c) => c.anchor === child)
  if (ci < 0) return tr
  const cEnd = runEnd(cards, ci, tree)
  const from = cards[ci].pos
  const last = cards[cEnd - 1]
  const to = last.pos + last.node.nodeSize
  let target: number
  if (!parent) {
    target = tr.doc.content.size
    if (to === target) return tr // 已经在文末
  } else {
    const pi = cards.findIndex((c) => c.anchor === parent)
    if (pi < 0) return tr // 父是主卡哨兵 / 不在本篇:主卡的子卡本来就住在正文里,不排
    if (pi >= ci && pi < cEnd) return tr // 父落在子段内 = 环(setParent 已拒,这里兜底)
    const pEnd = runEnd(cards, pi, tree)
    if (ci > pi && ci < pEnd) return tr // 已经在父段里
    const pLast = cards[pEnd - 1]
    target = pLast.pos + pLast.node.nodeSize
  }
  const frag = Fragment.fromArray(cards.slice(ci, cEnd).map((c) => c.node))
  return tr.delete(from, to).insert(target > to ? target - (to - from) : target, frag)
}

/** 几何事务的落笔:单笔(方案 §5:过程只动 CSS,drop 才落一笔 —— 否则 PM history 被拖拽灌成上千步)
 *  + 撤销步隔断(AFFiNE 的 default-tool 在拖拽两端各调一次 `captureSync()`,同一件事)。
 *
 *  ⚠️ **实测结论,别照直觉改**(2026-08-17,拿仓内 prosemirror-history 1.5.0 跑的四组内存复现):
 *   · 真正需要隔断的是「**500ms 内连拖同一张卡两次**」—— 两笔 `setNodeMarkup` 的 step 范围恰好重叠,
 *     `isAdjacentTo` 判为相邻 → 合成一个撤销步,一次 Cmd+Z 把两次位移一起退掉(实测 x 直接回 0)。
 *   · 「拖完立刻在卡里打字」「打完字立刻拖」**都不会**合并:`setNodeMarkup` 的 StepMap 只覆盖卡节点的
 *     开/闭边界,与卡内文本位置不重叠。第一版据此在松手后补了一笔空事务做「后沿封口」——
 *     四组实测(前沿×后沿全排列)证明它一步都没改变,已删。Codex 评审独立复现了同一结论。
 *  仪器 C14 钉的就是连拖两次那条(它能区分有无本行;而原来那条「拖完打字」的写法去掉 closeHistory
 *  照样绿 = 假绿)。 */
function commitGeo(view: EditorView, tr: Transaction): void {
  view.dispatch(closeHistory(tr).setMeta('amxCanvas', true))
}

/** 一批卡片的几何**合成一笔**事务:多选整批搬时若逐卡 dispatch,一次拖拽会攒出 N 个撤销步。
 *  ⚠️ 位置从同一份快照取,且 setNodeMarkup 不改变节点尺寸 → 后面的 pos 不需要映射。 */
function setCardAttrs(view: EditorView, patches: Map<string, Record<string, number>>): void {
  const cards = cardsOf(view)
  let tr = view.state.tr
  let any = false
  for (const c of cards) {
    const patch = patches.get(c.anchor)
    if (!patch) continue
    tr = tr.setNodeMarkup(c.pos, undefined, { ...c.node.attrs, ...patch })
    any = true
  }
  if (any) commitGeo(view, tr)
}

export interface CanvasStageProps {
  path: string
  active: boolean
  getView: () => EditorView | null
  /** 主卡几何(舞台坐标)。 */
  main: CanvasMain
  /** 磁盘那行里真的存了 main(区分「默认位形」与「用户摆过」——fm 快照的 m 用它定 null 语义)。 */
  mainStored: boolean
  /** `amadeus_canvas.elements` 原值(未校验)。 */
  elements: unknown
  /** `amadeus_canvas.tree` 原值(未校验)。 */
  tree: unknown
  /** 白板元素落盘(**原始条目**,见 canvasEdit 顶注)。宿主负责写 fm + 排防抖。 */
  onElements: (next: unknown[]) => void
  /** 节点层级落盘。与 onElements 同一条防抖单写者,真源同为磁盘那行。 */
  onTree: (next: Record<string, unknown>) => void
  /** 主卡几何落盘(2026-08-18 一等公民)。同一条防抖单写者。 */
  onMain: (next: CanvasMain) => void
  /** 统一撤销时间线 —— 与编辑器插件 createHistoryTimeline **共享同一个对象**(宿主建、两头用)。 */
  timeline: UndoTimeline
  /** 卡片几何变了(搬卡/调宽落定)→ 让宿主重新派生 fm。newCardRef = 本次新建的卡锚,
   *  宿主必须把它并进归属集合(见 deriveCanvasJson)。 */
  onCommit: (newCardRef?: string) => void
  children: React.ReactNode
}

export function CanvasStage({ path, active, getView, main, mainStored, elements, tree, onElements, onTree, onMain, timeline, onCommit, children }: CanvasStageProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [vp, setVp] = useState<Viewport>(() => viewports.get(path) ?? { x: 0, y: 0, z: 1 })
  const vpRef = useRef(vp)
  vpRef.current = vp
  // ⚠️ 工具 / 选中 / 连线起点这三样**必须 ref 与 state 同写**。指针处理器住在只依赖 [active] 的
  //    effect 里,读 state 拿到的是**上一次渲染**那份 —— 同一帧里发生两下(连线工具的两次点击、
  //    框选完立刻按删除)时后一下会看到前一下之前的值:实测现象是连线永远连不上(第二次点击
  //    把自己当成了起点),以及框选后按删除什么都没删。渲染仍读 state(ref 变了不会触发重渲)。
  const [tool, setToolState] = useState<Tool>('select')
  const toolRef = useRef<Tool>('select')
  const setTool = useCallback((v: Tool): void => { toolRef.current = v; setToolState(v) }, [])
  const [sel, setSelState] = useState<string[]>([])
  const selRef = useRef<string[]>([])
  const setSel = useCallback((next: string[] | ((old: string[]) => string[])): void => {
    const v = typeof next === 'function' ? next(selRef.current) : next
    selRef.current = v
    setSelState(v)
  }, [])
  const [connFrom, setConnFromState] = useState<string | null>(null)
  const connFromRef = useRef<string | null>(null)
  const setConnFrom = useCallback((v: string | null): void => { connFromRef.current = v; setConnFromState(v) }, [])
  // ⚠️ 两段式(用户 2026-08-18 拍板,AFFiNE 同款):**一击选中、二击进编辑**。`editing` = 当前允许
  //    落光标的那张卡的锚;其余卡的正文点击一律 preventDefault(PM 拿不到 mousedown 就不会聚焦)。
  //    同样 ref+state 同写 —— 手势 effect 只依赖 [active],读 state 拿的是上一次渲染那份。
  const [editing, setEditingState] = useState<string | null>(null)
  const editingRef = useRef<string | null>(null)
  const setEditing = useCallback((v: string | null): void => { editingRef.current = v; setEditingState(v) }, [])

  /** 编辑态光标(2026-08-19 用户实报:双击进编辑后鼠标还是抓手)。与 dragCss 同一条纪律:
   *  PM 的 DOM 一个属性都不碰,走按 data-anchor 命中的独立样式表;只写单元素规则(不写通配),
   *  卡内嵌入/图片自己的光标不受牵连,**其余卡片保持抓手**。作用域钉本舞台(amxDragscope)。 */
  useEffect(() => {
    const host = hostRef.current
    if (!editing || !host) return
    const scope = host.dataset.amxDragscope
    if (!scope) return
    const st = document.createElement('style')
    st.textContent = editing === MAIN_KEY
      ? `.amx-stage[data-amx-dragscope="${scope}"] .ProseMirror{cursor:text;}`
      : `.amx-stage[data-amx-dragscope="${scope}"] .amx-ucard[data-anchor="${CSS.escape(editing)}"]{cursor:text;}`
    document.head.appendChild(st)
    return () => st.remove()
  }, [editing])
  const [ghost, setGhost] = useState<ElGhost | null>(null)
  const [marquee, setMarquee] = useState<ElBox | null>(null)
  /** 拖到边缘认亲的当前候选(手势期高亮用;落笔在 onUp)。 */
  const [attach, setAttach] = useState<{ node: string; side: 'e' | 'w' | 'n' | 's'; rel: 'child' | 'sibling' } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; key: string | null; at: { x: number; y: number } } | null>(null)
  /** 连线橡皮筋:第一击之后指针的舞台坐标 + 悬停的有效目标(渲染在 CanvasElements)。 */
  const [connPt, setConnPt] = useState<{ x: number; y: number; over: string | null } | null>(null)
  useEffect(() => {
    if (!connFrom) setConnPt(null)
  }, [connFrom])
  const selSet = new Set(sel)
  // ⚠️「这次要不要自动 fit」必须在**渲染期**定,不能留到 effect 里查 viewports ——
  //   下面那个存视口的 effect 声明在前、也就先跑,查的时候 viewports 里早就有本页了,
  //   自动 fit 于是永远不触发:实测现象是打开画布只看得见主卡,卡片全在视野外(截图才发现的)。
  const shouldFit = useRef(!viewports.has(path))
  useEffect(() => {
    viewports.set(path, vp)
  }, [path, vp])

  // ── fm 三键(elements / tree / main)的读写 ────────────────────────────────────────
  // 一切回调经 ref 现读:下面那个手势 effect 只依赖 [active],闭包里拿的必须是**此刻**的值
  // (理由见 effect 顶注)。
  const cbRef = useRef({ getView, onCommit, onElements, onTree, onMain, timeline, elements, tree, main, mainStored })
  cbRef.current = { getView, onCommit, onElements, onTree, onMain, timeline, elements, tree, main, mainStored }
  const els = safeElements(elements)
  /** 主卡几何的**正则形**:默认位形(0,0,MAIN_W)与「盘上没存」合并成 null —— 二者对用户不可分
   *  (materialize 恒补默认 main,派生又会在卡/元素清空时把整行剥掉),分开记会让「首次拖动主卡
   *  再撤销」这类往返在合影比对里被误判成外部回灌(Codex 评审 F3 的另一半)。 */
  const canonMain = (m: CanvasMain | null): CanvasMain | null =>
    m && (m.x !== 0 || m.y !== 0 || m.w !== MAIN_W) ? m : null
  /** 此刻的 fm 三键合影(快照/回灌判别都吃这一份;m 恒为正则形)。 */
  const fmNow = (): { e: unknown[]; t: Record<string, unknown>; m: CanvasMain | null } => {
    const cb = cbRef.current
    return { e: rawList(cb.elements), t: rawTree(cb.tree), m: canonMain(cb.mainStored ? cb.main : null) }
  }
  /** 本实例最后一次写出去的三键合影。用来分辨「这次变化是我写的」还是外部回灌 ——
   *  后者必须把撤销栈清掉,否则一次 Cmd+Z 会拿陈旧快照把外部的修改整片盖掉。 */
  const lastWritten = useRef<string | null>(null)
  const histRef = useRef<ElHistory>({ past: [], future: [] })
  const hist = (): ElHistory => histRef.current
  useEffect(() => {
    const now = fmNow()
    const nowS = JSON.stringify(now)
    if (lastWritten.current !== null && nowS === lastWritten.current) return
    // ⚠️ 派生侧的层级剪枝**不算外部回灌**(C41 仪器抓的:删卡时 deriveCanvasJson 同步剪 tree,
    //    那次写不经 writeFm、不更新基线 —— 这里曾把它误判成外部改动,刚合成的 pair 连同整条
    //    时间线当场被清,撤销退化成裸 PM、层级永失)。剪枝的指纹很窄:elements/main 逐字不变,
    //    tree 只会**变少或不变**、留下的条目逐字保留 —— 命中就静默换基线,不清史。
    if (lastWritten.current !== null) {
      try {
        const prev = JSON.parse(lastWritten.current) as { e: unknown[]; t: Record<string, unknown>; m: CanvasMain | null }
        // 剪枝允许两种形变:条目整个消失,或「认祖父」—— 新父必须是旧树里顺着 parent 链能走到的
        // 祖先(pruneTree 只会沿被剪的链上跳,绝不横跳)。横跳/新增条目一律不算剪枝。
        const wasAncestor = (child: string, cand: unknown): boolean => {
          let p = prev.t[child]
          const seen = new Set<string>([child])
          while (typeof p === 'string' && p && !seen.has(p)) {
            if (p === cand) return true
            seen.add(p)
            p = prev.t[p]
          }
          return false
        }
        const pruneOnly =
          JSON.stringify(now.e) === JSON.stringify(prev.e)
          && JSON.stringify(now.m) === JSON.stringify(prev.m)
          && Object.keys(now.t).length <= Object.keys(prev.t).length
          && Object.keys(now.t).every((k) =>
            typeof prev.t[k] !== 'undefined'
            && (JSON.stringify(now.t[k]) === JSON.stringify(prev.t[k]) || wasAncestor(k, now.t[k])))
        if (pruneOnly) {
          lastWritten.current = nowS
          return
        }
      } catch { /* 基线损坏:按外部回灌处理 */ }
    }
    lastWritten.current = nowS
    // 外部回灌 / 换页:栈里的快照已经不是这份文件的历史了,再撤销就是拿陈旧数据整片盖掉别人的修改。
    // 时间线一并清零(fm 条目全部作废;'pm' 也许还活着 —— histStep 的枯竭兜底会直接问 PM)。
    histRef.current = { past: [], future: [] }
    cbRef.current.timeline.log.length = 0
    cbRef.current.timeline.future.length = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, elements, tree, main, mainStored])

  /** fm 三键的**唯一写点**:一次手势的多键变更合成一笔快照 + 一格时间线('fm')。
   *  没点名的键原样保留;整体无变化时一个字节不写、一格不记。 */
  const writeFm = useCallback((next: { e?: unknown[]; t?: Record<string, unknown>; m?: CanvasMain }, opts?: { snap?: false }): void => {
    const cb = cbRef.current
    const cur = fmNow()
    const snap = JSON.stringify(cur)
    const after = JSON.stringify({ e: next.e ?? cur.e, t: next.t ?? cur.t, m: next.m ? canonMain(next.m) : cur.m })
    if (after === snap) return
    // snap:false = 调用方已用 pushFmCheckpoint 存过「更早」的档(删卡把元素/层级并进同一格 pair),
    // 这里只写不记账 —— 再记就是一格空快照,一次删除要按两次 Cmd+Z。
    if (opts?.snap !== false) {
      const h = hist()
      h.past.push(snap)
      if (h.past.length > HIST_CAP) h.past.shift()
      h.future.length = 0
      cb.timeline.log.push('fm')
      cb.timeline.future.length = 0
      // 断组:fm 写入前后的打字必须分属两个 PM 撤销组,时间线的次序才与撤销粒度对齐
      // (500ms 内「打字→动画布→接着打」会被 PM 并成一组,一次 Cmd+Z 连同 fm 之前的字一起退)。
      const v = cb.getView()
      if (v) v.dispatch(closeHistory(v.state.tr))
    }
    lastWritten.current = after
    if (next.e) cb.onElements(next.e)
    if (next.t) cb.onTree(next.t)
    if (next.m) cb.onMain(next.m)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  /** 元素表的便捷写点(既有调用面):fn 原样回吐(无变化)时一个字节都不写。 */
  const mutate = useCallback((fn: (cur: unknown[]) => unknown[]): void => {
    const cur = rawList(cbRef.current.elements)
    const next = fn(cur)
    if (next === cur) return
    writeFm({ e: next })
  }, [writeFm])

  /** fm 栈的撤销/重做(elements+tree+main 一体还原)。返回 false = 栈空(时间线自愈用)。 */
  const elUndo = useCallback((dir: 'undo' | 'redo'): boolean => {
    const h = hist()
    const from = dir === 'undo' ? h.past : h.future
    const to = dir === 'undo' ? h.future : h.past
    const snap = from.pop()
    if (snap == null) return false
    const cb = cbRef.current
    to.push(JSON.stringify(fmNow()))
    const s = JSON.parse(snap) as { e: unknown[]; t: Record<string, unknown>; m: CanvasMain | null }
    lastWritten.current = snap // 快照是正则形,fmNow 也是 —— 合影比对两边同构
    cb.onElements(s.e)
    cb.onTree(s.t)
    // m=null = 那时主卡在默认位形(或整行不存在,正则化后同一回事)。**显式还原默认几何** ——
    // 首次拖动主卡后的 Cmd+Z 必须真的把它拖回去(Codex 评审 F3:跳过 onMain = 假撤销,时间线
    // 消耗了、屏幕一动不动)。行若因此只剩空 cards,下一次派生会自然把整行剥掉(懒物化闭环)。
    cb.onMain(s.m ?? { x: 0, y: 0, w: MAIN_W })
    return true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  /** 把 fm 现状推成一笔可撤销快照(**本身不写盘** —— 随后的写由 PM 事务的派生完成)。用途:
   *  删卡/收回会让 deriveCanvasJson 同步剪层级,而那条剪枝**必须**留在派生里当唯一入口(文档模式
   *  的删除根本不经过舞台);这里只负责把「剪之前」存档,与随后的 PM 笔合成 'pair',撤销时层级
   *  才跟卡片一起回来(Codex 评审 F1:此前撤销删卡,卡回来了、父子关系永久丢失)。 */
  const pushFmCheckpoint = useCallback((): void => {
    const h = hist()
    h.past.push(JSON.stringify(fmNow()))
    if (h.past.length > HIST_CAP) h.past.shift()
    h.future.length = 0
    const tl = cbRef.current.timeline
    tl.log.push('fm')
    tl.future.length = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  /** 被删/被收回的锚牵不牵层级(牵才值得记检查点,否则每次删卡都多一格空 'fm')。 */
  const treeTouches = useCallback((anchors: string[]): boolean => {
    const t = rawTree(cbRef.current.tree)
    return anchors.some((a) => typeof t[a] !== 'undefined' || Object.keys(t).some((c) => t[c] === a))
  }, [])

  /** 一次用户动作横跨两域(PM 建卡/搬卡/删卡 + fm 写层级/元素/主卡)→ 时间线尾部相邻的
   *  ['pm','fm'] / ['fm','pm'](检查点在 PM 笔**之前**推,次序反过来)并成一格 'pair',一次 Cmd+Z
   *  两域各退一步。⚠️ 只在**同一同步序列**里紧跟着两笔写入之后调用。 */
  const mergePair = useCallback((): void => {
    const tl = cbRef.current.timeline
    const n = tl.log.length
    if (n < 2) return
    const a = tl.log[n - 2]
    const b = tl.log[n - 1]
    if ((a === 'pm' && b === 'fm') || (a === 'fm' && b === 'pm')) tl.log.splice(n - 2, 2, 'pair')
  }, [])

  /** 统一撤销仲裁(文件头「两条撤销栈」的 2026-08-18 收口):按时间线退「最近那件事」。
   *  自愈:指向已不存在历史的条目(编辑器重建 / PM 深度截断 / 回灌清零)当场丢弃、继续找下一条;
   *  时间线枯竭后直接问 PM —— 绝不让一枚陈旧条目卡死整条撤销链。
   *  ⚠️ 'pair' 必须**两侧都可执行才动手**,缺一侧就整条丢弃(Codex 评审 F2:编辑器重建后 PM 栈
   *  是空的,只退 fm 半边 = 半撤销,还把残废 pair 推进 redo)。 */
  const histStep = useCallback((dir: 'undo' | 'redo'): boolean => {
    const tl = cbRef.current.timeline
    const from = dir === 'undo' ? tl.log : tl.future
    const to = dir === 'undo' ? tl.future : tl.log
    const pmAvail = (): boolean => {
      const view = cbRef.current.getView()
      return !!view && (dir === 'undo' ? undoDepth(view.state) : redoDepth(view.state)) > 0
    }
    const fmAvail = (): boolean => (dir === 'undo' ? hist().past : hist().future).length > 0
    const pmStep = (): boolean => {
      const view = cbRef.current.getView()
      return !!view && (dir === 'undo' ? pmUndo : pmRedo)(view.state, view.dispatch)
    }
    while (from.length) {
      const top = from[from.length - 1]
      from.pop()
      if (top === 'pair') {
        if (!pmAvail() || !fmAvail()) continue // 半边失效:整条丢弃,绝不半撤销
        // fm 在前(两个方向都是):还原出来的层级可能引用「还没回来」的卡,紧随其后的 PM 步把卡
        // 补回来,随之而来的派生看到卡活着就不会再剪 —— 反过来先 PM 的话,派生在 fm 还原前跑,
        // 会拿旧层级把刚回来的卡的关系又剪一遍。
        elUndo(dir)
        pmStep()
        to.push(top)
        return true
      }
      if (top === 'fm') {
        if (elUndo(dir)) {
          to.push(top)
          return true
        }
        continue
      }
      if (pmStep()) {
        to.push('pm')
        return true
      }
    }
    return pmStep()
  }, [elUndo])

  /** 视口坐标 → 舞台坐标。
   *  ⚠️ 两级缩放,顺序不能错(仓里在 zoom×浮层坐标上栽过一整轮,见 DESIGN.md / blockLayer 顶注):
   *  `clientX - rect.left` 是**视口**量(已经过应用级 CSS zoom),而 pan 的 x/y 与卡片的 x/y/w 都是
   *  **未缩放的局部 px**。所以先 ÷ zoomOf(应用 zoom,80%/125% 的设置真会用)回到局部坐标系,
   *  再减 pan、÷ 舞台 z。只除 z 的话,应用 zoom 一旦不是 100%,落点与调宽会按比例整体偏。 */
  const toStage = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const host = hostRef.current
    const r = host?.getBoundingClientRect()
    const { x, y, z } = vpRef.current
    if (!host || !r) return { x: 0, y: 0 }
    const u = zoomOf(host) || 1
    return { x: ((clientX - r.left) / u - x) / z, y: ((clientY - r.top) / u - y) / z }
  }, [])

  /** 首次进画布:把全部内容框进视野(方案 §3.1「开卷默认 fit 全部内容」)。 */
  const fit = useCallback(() => {
    const host = hostRef.current
    const view = getView()
    if (!host || !view) return
    // ⚠️ 白板元素也算内容。只量卡片和主卡的话,右边的形状/连线会被裁在舞台外 —— 几何断言全绿,
    //    截图一看就露(DESIGN.md §8 说的就是这种)。
    const boxes = [...host.querySelectorAll('.amx-ucard, .amx-el-shape, .amx-el-conn, .amx-el-label'), view.dom].map((el) => (el as HTMLElement).getBoundingClientRect())
    if (!boxes.length) return
    const { x, y, z } = vpRef.current
    const hr = host.getBoundingClientRect()
    const u = zoomOf(host) || 1 // 应用级 CSS zoom,见 toStage 的告警
    const toS = (v: number, off: number) => (v / u - off) / z
    const minX = Math.min(...boxes.map((b) => toS(b.left - hr.left, x)))
    const minY = Math.min(...boxes.map((b) => toS(b.top - hr.top, y)))
    const maxX = Math.max(...boxes.map((b) => toS(b.right - hr.left, x)))
    const maxY = Math.max(...boxes.map((b) => toS(b.bottom - hr.top, y)))
    const w = maxX - minX
    const h = maxY - minY
    if (w <= 0 || h <= 0) return
    const pad = 48
    const nz = Math.max(MIN_Z, Math.min(1, Math.min((hr.width / u - pad * 2) / w, (hr.height / u - pad * 2) / h)))
    // **居中**,不是钉在左上角的 pad 上。满铺之后舞台比内容大得多,钉左上会把整篇挤在角落、
    // 右下留一大片空白(截图才看得出来,几何断言不管构图)。内容比视野大时 nz 已经把它缩到刚好,
    // 居中与 pad 等价;缩到 MIN_Z 还装不下时居中=看中段,也比看左上角合理。
    setVp({ z: nz, x: (hr.width / u - w * nz) / 2 - minX * nz, y: (hr.height / u - h * nz) / 2 - minY * nz })
  }, [getView])

  /** 以舞台中心为锚的定倍缩放(HUD 的 −/+)。 */
  const zoomBy = useCallback((factor: number) => {
    const host = hostRef.current
    if (!host) return
    const { x, y, z } = vpRef.current
    const nz = Math.max(MIN_Z, Math.min(MAX_Z, z * factor))
    if (nz === z) return
    const u = zoomOf(host) || 1
    const cx = host.getBoundingClientRect().width / u / 2
    const cy = host.getBoundingClientRect().height / u / 2
    setVp({ z: nz, x: cx - ((cx - x) * nz) / z, y: cy - ((cy - y) * nz) / z })
  }, [])

  // ⚠️ 这个 effect **只能依赖 active**。挂 fit 进依赖数组会死:fit 的 useCallback 依赖 getView,
  //    而宿主传下来的 getView 是行内箭头函数(每次渲染换身份)→ effect 每渲染一次就重建一次 →
  //    cleanup 把刚排的定时器清掉,而重建后的那次因为 shouldFit 已置 false 直接 return。
  //    净效果:自动 fit 永远不触发,打开画布只看得见主卡(第二张截图才发现,几何断言全绿)。
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    if (!active || !shouldFit.current) return // 本会话来过:保留上次的视口,别每次切模式都跳回 fit
    shouldFit.current = false
    // 等编辑器真正排完版再量:量早了卡片还是 0 宽,fit 出来的缩放是垃圾。
    const t = setTimeout(() => fitRef.current(), 220)
    return () => clearTimeout(t)
  }, [active])

  // 退出画布模式 = 清掉一切画布态选中/工具(回来时从干净状态开始;残留的选中框会画在文档模式上)。
  useEffect(() => {
    if (active) return
    setSel([])
    setTool('select')
    setConnFrom(null)
    setMenu(null)
    setEditing(null)
  }, [active])

  // 右键菜单的关闭必须挂在 **window 捕获期**(与 UnifiedPage 的块菜单同一道):舞台自己的
  // pointerdown 只盖得住舞台内部,点侧栏/顶栏时菜单会一直挂在那儿。捕获期是因为菜单自己
  // stopPropagation 了,冒泡到不了 window。
  useEffect(() => {
    if (!menu) return
    const close = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.ctx-menu')) return
      setMenu(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('contextmenu', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('contextmenu', close, true)
    }
  }, [menu])

  /** 元素/卡片/主卡的当前盒(含幽灵)。框选与连线命中都吃这一份。 */
  const boxesNow = useCallback((g: ElGhost | null): Map<string, ElBox> => {
    const m = new Map<string, ElBox>()
    for (const [a, b] of measureCards(hostRef.current)) m.set(cardKey(a), b)
    for (const [id, b] of shapeBoxes(safeElements(cbRef.current.elements), g)) m.set(elKey(id), b)
    const mb = measureMain(hostRef.current)
    if (mb) m.set(MAIN_KEY, mb)
    return m
  }, [])

  // ── 元素文字(异步弹窗:回来时必须重新确认这一条还在)──────────────────────────────
  const deadRef = useRef(false)
  useEffect(() => () => { deadRef.current = true }, [])
  const editText = useCallback(async (id: string, key: 'text' | 'label' | 'title', title: string): Promise<void> => {
    const cur = safeElements(cbRef.current.elements).find((e) => e.id === id)
    if (!cur) return
    const old = (cur.kind === 'connector' ? cur.label : cur.kind === 'frame' ? cur.title : cur.text) ?? ''
    const next = await askString(title, old)
    if (next == null || deadRef.current) return
    // 弹窗期间这一条可能已被删/被外部回灌换掉:不重新确认就会把它凭空写回来(插件时代的令牌守卫同源)。
    if (!safeElements(cbRef.current.elements).some((e) => e.id === id)) return
    mutate((l) => setElementText(l, id, key, next.trim()))
  }, [mutate])

  // ── 新建 ──────────────────────────────────────────────────────────────────────────
  /** 新建卡片:空段落卡插在文末(x/y 是**左上角**,调用方自己让开指针中心)。返回新卡锚。
   *  `under` = 这张卡的爹:给了就插在那张卡的子树**之后**而不是文末 —— 建子节点一步到位,
   *  省掉「先插文末再搬过去」的第二笔事务(两笔 = 一次 Tab 要按两次 Cmd+Z)。 */
  const addCardAt = useCallback((x: number, y: number, under?: string): string | null => {
    const view = cbRef.current.getView()
    const card = view?.state.schema.nodes.amadeusCanvasCard
    const paragraph = view?.state.schema.nodes.paragraph
    if (!view || !card || !paragraph) return null
    const anchor = freshAnchorId(view.state.doc)
    const made = card.createAndFill({ anchor, x: Math.round(x), y: Math.round(y), w: CARD_W, h: 0 }, paragraph.create())
    if (!made) return null
    const at = under ? tailPosUnder(view.state.doc, rawTree(cbRef.current.tree), under) : view.state.doc.content.size
    commitGeo(view, view.state.tr.insert(at, made))
    cbRef.current.onCommit(anchor) // ⚠️ 必须报锚:不进归属集合的话派生会把这张卡当「代表不了全貌」
    setSel([cardKey(anchor)])
    return anchor
  }, [])

  /** 层级写入的便捷写点(经 writeFm,进 fm 快照/时间线)。⚠️ 必须**排在 onCommit 之后**调用:
   *  onCommit 里的 syncFromEditor 会同步重写 fm 那一行(cards 派生),先写 tree 的话下一句就被
   *  它整行盖掉。 */
  /** 返回值 = **这一笔到底写没写**。调用方靠它决定要不要 mergePair:成环被 setParent 拒掉时
   *  只有 PM 那一格、没有 fm 那一格,无条件并对的话会把上一件不相干的事拽进同一次 Cmd+Z
   *  (Codex 2026-08-20 medium)。 */
  const mutTree = useCallback((fn: (cur: Record<string, unknown>) => Record<string, unknown>): boolean => {
    const cur = rawTree(cbRef.current.tree)
    const next = fn(cur)
    if (next === cur) return false
    writeFm({ t: next })
    return true
  }, [writeFm])

  /** 层级键 → 盒。主卡不在 measureCards 里(它是自然流,不是卡片 DOM),单独量。 */
  const nodeBox = useCallback((k: string): ElBox | null =>
    (k === MAIN_KEY ? measureMain(hostRef.current) : measureCards(hostRef.current).get(k) ?? null), [])

  /** 摆位启发式**单源**:Tab/回车、卡侧 ⊕、拖到边缘认爹三条入口共用同一份心智
   *  (2026-08-19 晚:用户拍板「松手自动吸附到父卡旁的队列」,drop 之后不再保留落点)。
   *  `side` 决定队列在目标的哪一侧:'e'/'w' = 子节点的左右列,'n'/'s' = 兄弟排在队列首/尾。
   *  返回 `parent` = 应该认的爹(空串 = 顶层,不写层级);`x/y` = 新位置。
   *  ⚠️ 只摆**被操作的那一张**:其余既有节点的 x/y 归用户所有,绝不重排(AFFiNE 同款)。 */
  const slotFor = useCallback((selfNode: string, rel: 'child' | 'sibling', side: 'e' | 'w' | 'n' | 's', w: number, h = 0): { parent: string; x: number; y: number } | null => {
    const me = nodeBox(selfNode)
    if (!me) return null
    const cur = rawTree(cbRef.current.tree)
    // ⚠️ 盘上的父值不保证是字符串(tree 与 elements 同待遇:读侧不校验)。认不出就当「没有父」。
    const own = cur[selfNode]
    const parent = rel === 'child' ? selfNode : (typeof own === 'string' && own ? own : '')
    // 兄弟:与自己同一个父的都算(自己没父 = 顶层节点,兄弟就并排放在它下面)。
    const sibs = (parent ? childrenOf(cur, parent) : [selfNode]).map(nodeBox).filter(Boolean) as ElBox[]
    const GAP_X = 80
    const GAP_Y = 32
    const west = side === 'w'
    const x = rel === 'child'
      ? (west ? me.x - w - GAP_X : me.x + me.w + GAP_X)
      : (sibs.length ? Math.min(...sibs.map((b) => b.x)) : me.x)
    // 队列纵向:'n' = 排到最上面(整体在现有队列之上),其余排到最下面。
    const top = sibs.length ? Math.min(...sibs.map((b) => b.y)) - GAP_Y - h : me.y
    const below = sibs.length ? Math.max(...sibs.map((b) => b.y + b.h)) + GAP_Y : me.y
    const queue = side === 'n' ? top : below
    const y = rel === 'child' ? (childrenOf(cur, selfNode).length ? queue : me.y) : queue
    return { parent, x: Math.round(x), y: Math.round(y) }
  }, [nodeBox])

  /** Tab = 加子节点,回车 = 加兄弟节点(用户 2026-08-18 拍板,mindmap 惯例)。
   *  `selfNode` 是**层级键**:卡片 = 锚,主卡 = `MAIN_KEY`(2026-08-19 用户实报「正文卡片不支持」——
   *  主卡自 08-18 起完全等同卡片,长子节点也不该例外;哨兵为什么撞不上真锚见 canvasEdit 那一节)。
   *  摆位是**启发式**且只作用于新卡:既有节点的 x/y 归用户所有,绝不重排(AFFiNE 也不重排)。
   *  建卡走 PM、层级走 fm,两笔在时间线上并成 'pair' —— 一次 Cmd+Z 卡与层级一起退
   *  (2026-08-18 统一时间线收口;此前要按两次,评审 P0-1 点名的就是这个)。 */
  const addRelated = useCallback((selfNode: string, rel: 'child' | 'sibling'): void => {
    const slot = slotFor(selfNode, rel, 'e', CARD_W)
    if (!slot) return
    // slot.parent 就是新卡的爹(建子节点=自己,建兄弟=自己的爹):直接插进那一段的末尾,
    // 源码顺序一次成型(空串=顶层 → 文末)。
    const made = addCardAt(slot.x, slot.y, slot.parent || undefined)
    if (!made) return
    // ⚠️ 只有层级**真写进去**才并格。盘上那份 tree 是用户可手改的,里头若已有环,setParent 会
    //    原样返回(拒绝)→ 只有建卡那一格 'pm',这时并格会把上一件不相干的事拽进同一次 Cmd+Z。
    if (slot.parent && mutTree((t) => setParent(t, made, slot.parent))) {
      mergePair() // 建卡('pm')+ 记层级('fm')= 一次用户动作,时间线并成一格
    }
  }, [slotFor, addCardAt, mutTree, mergePair])
  /** 拖到边缘认亲(2026-08-19 晚,用户拍板;思维导图同款 drop-to-attach):把一张**已有**卡拖到
   *  另一张卡/主卡的边缘 → 左右缘 = 当它的子节点,上下缘 = 与它同父(兄弟)。
   *  ⚠️ 环形目标必须先排掉:setParent 遇环只是「拒绝写入」静默返回,那样卡会被吸附摆位却没有关系,
   *     用户看到的是「吸过去了但线没出来」。这里连高亮都不给,手势期就说清楚。 */
  const attachHit = useCallback((self: string, at: { x: number; y: number }): { node: string; side: 'e' | 'w' | 'n' | 's'; rel: 'child' | 'sibling' } | null => {
    // ⚠️ 判据是**指针**落在目标卡的边缘带,不是「两个盒子离得近」。按盒距离判的第一版被 C32/C34
    //    当场抓住:把卡停在另一张卡下方 23px(纯粹是挪个位置)就被静默收成了兄弟并吸走 ——
    //    盒子挨得近是常态,指针指过去才是意图。想认亲就把指针推到那张卡的边上,边会亮起来。
    const BAND = 24 // 目标盒外扩的感应带(舞台 px)
    // 指针离某条边多近才算「在边缘上」—— 用户的原话就是「在另一个卡片**边缘**的时候」。
    //   ⚠️ 必须**按盒尺寸取比例**(每边最多吃 30%),不能只用固定 28px:一行字的卡才 58px 高,
    //   28+28 直接把它整片吃光,所谓「卡心中立区」只剩 2px —— 从卡上横着拖过去就被静默收编
    //   (Codex 08-19 深夜 medium;我自己在文档里写了中立区,代码里却没有)。
    const EDGE = 28
    const strip = (len: number): number => Math.min(EDGE, len * 0.3)
    const cur = rawTree(cbRef.current.tree)
    const descends = (node: string): boolean => { // node 是不是 self 的后代(含 self)
      let p: unknown = node
      const seen = new Set<string>()
      while (typeof p === 'string' && p && !seen.has(p)) {
        if (p === self) return true
        seen.add(p)
        p = cur[p]
      }
      return false
    }
    // ⚠️ 拖拽期的几何来自 measureCards(offset* 反映 dragCss 的过程位置),不是 dataset ——
    //    读 dataset 会让感应带整场拖拽都按**起点**判定(方案 §5「过程只动 CSS」的同一条坑)。
    const boxes = measureCards(hostRef.current)
    const targets: Array<[string, ElBox]> = [...boxes].filter(([a]) => a !== self && !descends(a))
    const mb = measureMain(hostRef.current)
    if (mb) targets.push([MAIN_KEY, mb])
    let best: { node: string; side: 'e' | 'w' | 'n' | 's'; rel: 'child' | 'sibling'; d: number } | null = null
    for (const [node, t] of targets) {
      if (at.x < t.x - BAND || at.x > t.x + t.w + BAND || at.y < t.y - BAND || at.y > t.y + t.h + BAND) continue
      // 指针离哪条边最近就是哪条边(左右=子、上下=兄弟,用户 2026-08-19 拍板)。
      const sx = strip(t.w)
      const sy = strip(t.h)
      const cand: Array<['e' | 'w' | 'n' | 's', number, number]> = [
        ['e', Math.abs(t.x + t.w - at.x), sx],
        ['w', Math.abs(at.x - t.x), sx],
        ['s', Math.abs(t.y + t.h - at.y), sy],
        ['n', Math.abs(at.y - t.y), sy],
      ]
      for (const [side, d, band] of cand) {
        if (d > band) continue
        if (!best || d < best.d) best = { node, side, rel: side === 'e' || side === 'w' ? 'child' : 'sibling', d }
      }
    }
    return best ? { node: best.node, side: best.side, rel: best.rel } : null
  }, [])

  /** 认亲落笔:位置吸附进队列(PM 一笔)+ 层级(fm 一笔),并成 'pair' 一击撤销。
   *  ⚠️ 兄弟且目标是顶层节点 = 自己也成顶层 → **主动摘掉旧爹**(否则卡排进了别人的队列、关系却还
   *  挂在原处,线与位置对不上)。这条同时也是唯一一个「拖拽即可解除关系」的口子。 */
  const applyAttach = useCallback((self: string, hit: { node: string; side: 'e' | 'w' | 'n' | 's'; rel: 'child' | 'sibling' }): boolean => {
    const view = cbRef.current.getView()
    const box = measureCards(hostRef.current).get(self)
    if (!view || !box) return false
    const slot = slotFor(hit.node, hit.rel, hit.side, box.w, box.h)
    if (!slot) return false
    const cur = rawTree(cbRef.current.tree)
    const had = typeof cur[self] === 'string' ? (cur[self] as string) : ''
    if (slot.parent === self) return false // 自环:上面 descends 已排掉,这里兜底
    // 认爹之后的表先算一份**只给排序用**:几何与源码顺序要合成同一笔 PM 事务(一次 Cmd+Z 全退),
    // 而「谁是谁的后代」必须按新关系算。落盘那笔仍在下面照旧现读现写(不拿这份陈的去覆盖)。
    const next = rawTree(cur)
    if (slot.parent) delete next[self] // 先摘干净,免得旧父值混进 orderUnder 的后代判定
    const relinked = slot.parent ? setParent(cur, self, slot.parent) : next
    let tr = view.state.tr
    for (const c of cardsOf(view)) {
      if (c.anchor === self) tr = tr.setNodeMarkup(c.pos, undefined, { ...c.node.attrs, x: slot.x, y: slot.y })
    }
    // 认爹搬到父段之后;摘爹搬到文末(**也得搬** —— 留在原地会把老父亲那一段劈成两半,
    // 后面还认着它的兄弟从此掉在父段之外,见 orderUnder 的告警)。
    if (slot.parent !== had && (slot.parent ? relinked !== cur : true)) {
      tr = orderUnder(tr, relinked, self, slot.parent)
    }
    commitGeo(view, tr)
    cbRef.current.onCommit(self)
    if (slot.parent !== had) {
      const wrote = mutTree((t) => {
        if (!slot.parent) { // 认顶层 = 摘爹
          const out = rawTree(t)
          delete out[self]
          return out
        }
        return setParent(t, self, slot.parent)
      })
      if (wrote) mergePair()
    }
    return true
  }, [slotFor, mutTree, mergePair])

  /** 只认爹、不挪位置(箭头工具用)。与 applyAttach 的差别就在这:那条是拖拽手势,用户已经把卡
   *  拖到位了所以顺手吸附进队列;这条是隔空指定关系,把人家的卡凭空挪走反而莫名其妙。
   *  ⚠️ 成环由 setParent 自己拒绝(返回原表),这里据此判断有没有真写进去。 */
  const setNodeParent = useCallback((child: string, parent: string): void => {
    const cur = rawTree(cbRef.current.tree)
    if (cur[child] === parent) return
    const next = setParent(cur, child, parent)
    if (next === cur) return // 自环/成环:拒绝
    // 源码顺序跟着层级走(与 applyAttach 同口径)。真搬动了才有 'pm' 那一格,才需要并 pair ——
    // 目标是主卡/已经在父段里时一步没走,无条件 mergePair 会把上一件不相干的事拽进来。
    const view = cbRef.current.getView()
    let moved = false
    if (view) {
      const tr = orderUnder(view.state.tr, next, child, parent)
      if (tr.steps.length) {
        commitGeo(view, tr)
        moved = true
      }
    }
    writeFm({ t: next })
    if (moved) mergePair()
  }, [writeFm, mergePair])

  /** 新形状:id 必须在 mutate 的闭包里取(现读现算,并发写不会撞号)。
   *  `box` 给了就是**拖出来的尺寸**(x/y 是左上角),没给就是点击建(x/y 当中心、取默认尺寸)。 */
  const addShapeAt = useCallback((kind: ShapeKind, x: number, y: number, box?: ElBox): void => {
    let id = ''
    mutate((l) => {
      id = freshElId(l, 's')
      return [...l, box ? newShapeBox(id, kind, box) : newShape(id, kind, x, y)]
    })
    if (id) setSel([elKey(id)])
  }, [mutate])
  /** 新建 Frame:给定框(成组)或默认尺寸(空白右键)。 */
  const addFrame = useCallback((x: number, y: number, w = 480, h = 320): void => {
    let id = ''
    mutate((l) => {
      id = freshElId(l, 'f')
      return [...l, newFrame(id, x, y, w, h)]
    })
    if (id) setSel([elKey(id)])
  }, [mutate])
  /** 选中的一批 → 框住它们的 Frame(bbox + 留白)。AFFiNE 的「Frame section」同款入口。 */
  const groupIntoFrame = useCallback((keys: string[]): void => {
    const boxes = boxesNow(null)
    const bs = keys.map((k) => boxes.get(k)).filter((b): b is ElBox => !!b)
    if (!bs.length) return
    const PAD = 32
    const x = Math.min(...bs.map((b) => b.x)) - PAD
    const y = Math.min(...bs.map((b) => b.y)) - PAD
    addFrame(x, y, Math.max(...bs.map((b) => b.x + b.w)) + PAD - x, Math.max(...bs.map((b) => b.y + b.h)) + PAD - y)
  }, [boxesNow, addFrame])

  /** 选中集合 → **真正要搬的**集合:选中的 Frame 把完全落在框内的卡片/元素一并带走。
   *  ⚠️ 辖域在**按下这一刻**算死,不在 onMove 里逐帧重算 —— 边搬边判会让成员在半路「掉出框」。
   *  ⚠️ 判据是「完全落在框内」(AFFiNE 同款):部分重叠不算,否则拖一个大框会顺手拽走半屏东西。 */
  const expandFrames = useCallback((keys: string[]): string[] => {
    const els = safeElements(cbRef.current.elements)
    const frames = keys
      .filter((k) => k.startsWith('e:'))
      .map((k) => els.find((e) => e.id === keyId(k)))
      .filter((e): e is FrameEl => e?.kind === 'frame')
    if (!frames.length) return keys
    const boxes = boxesNow(null)
    const out = new Set(keys)
    for (const f of frames) {
      for (const [k, b] of boxes) {
        if (out.has(k)) continue
        if (b.x >= f.x && b.y >= f.y && b.x + b.w <= f.x + f.w && b.y + b.h <= f.y + f.h) out.add(k)
      }
    }
    return [...out]
  }, [boxesNow])

  // ── 选中集合的删除 ────────────────────────────────────────────────────────────────
  const removeSel = useCallback((keys: string[]): void => {
    const elIds = keys.filter((k) => k.startsWith('e:')).map(keyId)
    const anchors = keys.filter((k) => k.startsWith('c:')).map(keyId)
    // 选中的层级线:删掉 = 解除那条父子关系(卡片一张都不动)。
    const rels = keys.filter((k) => k.startsWith('t:')).map(keyId)
    const view = anchors.length ? cbRef.current.getView() : null
    const gone = new Set(anchors)
    const hits = view ? cardsOf(view).filter((c) => gone.has(c.anchor)).sort((a, b) => b.pos - a.pos) : []
    // 一次删除 = 一格撤销:有卡有 fm 侧(元素被删,或层级将被派生剪掉)时,先把 fm 现状存成
    // 检查点,元素删除**只写不记账**(snap:false),随后的 PM 删卡笔与检查点并成 'pair'。
    const ckpt = hits.length > 0 && (elIds.length > 0 || rels.length > 0 || treeTouches(anchors))
    if (ckpt) pushFmCheckpoint()
    if (rels.length) {
      const cur = rawTree(cbRef.current.tree)
      const next = rawTree(cur)
      let touched = false
      for (const c of rels) if (typeof next[c] !== 'undefined') { delete next[c]; touched = true }
      if (touched) writeFm({ t: next }, ckpt ? { snap: false } : undefined)
    }
    if (elIds.length) {
      const cur = rawList(cbRef.current.elements)
      const next = removeElements(cur, new Set(elIds))
      if (next !== cur) writeFm({ e: next }, ckpt ? { snap: false } : undefined)
    }
    if (view && hits.length) {
      // 卡片走 PM(可 Cmd+Z);从后往前删,前面的 pos 不受影响。
      let tr = view.state.tr
      for (const c of hits) tr = tr.delete(c.pos, c.pos + c.node.nodeSize)
      commitGeo(view, tr)
      cbRef.current.onCommit()
      // 层级剪枝不在这里做:唯一入口在 deriveCanvasJson(cards 权威)。文档模式下用块菜单
      // 删卡/收回文档根本不经过这条路,逐个入口挂剪枝必漏(Codex 评审 P1)。检查点只负责
      // 把「剪之前」存档,与这笔 PM 合成 pair —— 撤销时层级跟卡一起回来(Codex 评审 F1)。
      if (ckpt) mergePair()
    }
    setSel([])
  }, [writeFm, pushFmCheckpoint, treeTouches, mergePair])

  // ── 手势 ────────────────────────────────────────────────────────────────────
  // 同样**只依赖 active**(理由见上面 fitRef 的注释)。这里的代价更重:宿主每渲染一次就把整个
  // effect 拆了重装,进行中的那次拖拽(闭包里的 drag 局部量)当场归零 —— 松手时 onUp 拿到 null,
  // 卡片弹回原位、事务不落。回调一律经 ref 现读。
  const actRef = useRef({ mutate, writeFm, mergePair, pushFmCheckpoint, treeTouches, removeSel, editText, boxesNow, fit, zoomBy, addCardAt, addShapeAt, addFrame, addRelated, attachHit, applyAttach, setNodeParent, expandFrames })
  actRef.current = { mutate, writeFm, mergePair, pushFmCheckpoint, treeTouches, removeSel, editText, boxesNow, fit, zoomBy, addCardAt, addShapeAt, addFrame, addRelated, attachHit, applyAttach, setNodeParent, expandFrames }
  useEffect(() => {
    const host = hostRef.current
    if (!host || !active) return
    const getView = (): EditorView | null => cbRef.current.getView()
    const onCommit = (newCardRef?: string): void => cbRef.current.onCommit(newCardRef)
    const focusStage = (): void => host.focus({ preventScroll: true })

    // ⚠️ 手势期的卡片几何走**这张动态样式表**,绝不往卡片 DOM 上写 inline style / class ——
    // 卡片 DOM 归 PM 所有,它的 DOMObserver 一察觉陌生属性就按 toDOM 把节点整个重画,拖拽过程
    // 样式当场蒸发:实测(2026-08-18 C34 真实输入取证)点一下卡片元素就被换掉,拖拽全程卡钉在
    // 原地、松手才跳 —— 用户实报的「拖拽没有过程显示」就是它。合成事件仪器测不到(从没断言过
    // 中途位置),真实输入 + 中途采样才现形。样式表对 PM 完全不可见,选择器按 data-anchor 命中。
    // 作用域钉在本舞台(data-amx-dragscope):同一篇在两个标签页同开时,别把对方的卡也拖走。
    const scope = `s${++dragScopeSeq}`
    host.dataset.amxDragscope = scope
    const dragCss = document.createElement('style')
    document.head.appendChild(dragCss)
    /** 拖拽期几何规则。lift = 抬起观感(影子加深 + grabbing),与几何同一条规则免得两处拼。 */
    const setDragRule = (rules: Array<{ anchor: string; decl: string }>): void => {
      dragCss.textContent = rules
        .map((r) => `.amx-stage[data-amx-dragscope="${scope}"] .amx-ucard[data-anchor="${CSS.escape(r.anchor)}"]{${r.decl}}`)
        .join('\n')
    }
    const LIFT = 'cursor:grabbing;opacity:.94;box-shadow:0 12px 32px rgb(0 0 0 / 24%);'
    const clearDragRule = (): void => { dragCss.textContent = '' }

    // Cmd/Ctrl+滚轮 = 以指针为锚缩放;普通滚轮 = 平移(trackpad 双指同款)。
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const { x, y, z } = vpRef.current
      const u = zoomOf(host) || 1 // 应用级 CSS zoom,见 toStage 的告警
      if (e.metaKey || e.ctrlKey) {
        const nz = Math.max(MIN_Z, Math.min(MAX_Z, z * Math.exp(-e.deltaY / 300)))
        const r = host.getBoundingClientRect()
        const cx = (e.clientX - r.left) / u
        const cy = (e.clientY - r.top) / u
        // 指针下的舞台点保持不动:x' = cx - (cx - x) * nz/z
        setVp({ z: nz, x: cx - ((cx - x) * nz) / z, y: cy - ((cy - y) * nz) / z })
      } else {
        // Shift+滚轮 = 横向平移(用户 2026-08-18 实报缺这条)。mac 上浏览器多半已把轴换好
        // (deltaX 非 0),那就直接用;没换的平台(deltaY 原样)才拿 deltaY 当横向量。
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey ? 0 : e.deltaY
        setVp({ z, x: x - dx / u, y: y - dy / u })
      }
    }
    host.addEventListener('wheel', onWheel, { passive: false })

    type Drag =
      | { kind: 'pan'; x0: number; y0: number; vx: number; vy: number }
      | { kind: 'width'; anchor: string; x0: number; w0: number; live?: boolean }
      | { kind: 'mwidth'; el: HTMLElement; x0: number; w0: number; live?: boolean }
      | { kind: 'move'; cards: Array<{ anchor: string; ox: number; oy: number }>; ids: Set<string>; hit: string; x0: number; y0: number; dx: number; dy: number; mainStart: { x: number; y: number } | null; mainEl: HTMLElement | null; live?: boolean; enterEdit?: string }
      | { kind: 'size'; id: string; corner: string; b0: ElBox; dx: number; dy: number; dw: number; dh: number; live?: boolean }
      | { kind: 'marquee'; x0: number; y0: number; additive: boolean; live?: boolean }
      | { kind: 'create'; tool: Tool; x0: number; y0: number; x1: number; y1: number; live?: boolean }
    let drag: Drag | null = null
    // 指针捕获拿不到就算了(合成事件、pointerId 已失效、外设拔掉都会抛)——**绝不能让它把
    // 后面的拖拽状态一起带走**:这一句抛出去的话,onDown 里它之后的语句全不执行。
    const capture = (id: number): void => { try { host.setPointerCapture(id) } catch { /* 无所谓 */ } }
    const release = (id: number): void => { try { if (host.hasPointerCapture(id)) host.releasePointerCapture(id) } catch { /* 同上 */ } }

    /** 舞台空白(不含卡片正文、不含形状、不含浮层 chrome)。 */
    const isBlank = (t: HTMLElement): boolean =>
      t === host || t.classList.contains('amx-stage-inner') || t.classList.contains('amx-el-layer')

    const onDown = (e: PointerEvent): void => {
      setMenu(null)
      const target = e.target as HTMLElement
      if (target.closest('.amx-stage-tools, .amx-stage-hud, .ctx-menu')) return // chrome 自己的按钮
      const middle = e.button === 1
      if (e.button !== 0 && !middle) return
      const t = toolRef.current
      const at = toStage(e.clientX, e.clientY)
      // ⚠️ 退出编辑必须排在下面**所有早退分支之前**(平移/建形状/建卡那几支原本带着陈旧的
      //    editing 就 return 了 —— 之后再点那张卡会直接落光标,两段式的第一段被绕过,Codex P2-3)。
      // ⚠️ 判据**分两种,混成一条就是真机第四轮 G5 那个洞**:
      //  · 非 select 工具 / Alt / 中键 = 明确的「我现在要做别的事」,**落在哪都退出编辑**。
      //    只按位置判的话,矩形恰好放在正在编辑的那张卡上时 `closest` 认为「还在卡里」→ 不退出 →
      //    下一次单击那张卡直接落光标(实测:`a` 打成 `ax`)。
      //  · select 工具下才按位置判:点回正在编辑的那张卡是继续编辑,点别处才退出。
      const cur = editingRef.current
      const otherIntent = t !== 'select' || e.altKey || middle
      // 「还在原地」判据分身份:卡=还在那张卡里;主卡=还在正文里(在 .ProseMirror 内**且不在任何
      // 卡里** —— 卡片的 DOM 就住在 PM 根之内,少了后半句,编辑主卡时点卡片会被当成「还在主卡」)。
      const stillIn = cur === MAIN_KEY
        ? !!target.closest('.ProseMirror') && !target.closest('.amx-ucard')
        : !!target.closest(`.amx-ucard[data-anchor="${CSS.escape(cur ?? '')}"]`)
      if (cur && (otherIntent || !stillIn)) setEditing(null)

      // 平移**先于一切空间命中**:抓手/Alt/中键的意图就是移视口,压在什么上面都不该变成选中。
      if (t === 'pan' || e.altKey || middle) {
        e.preventDefault()
        drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, vx: vpRef.current.x, vy: vpRef.current.y }
        capture(e.pointerId)
        return
      }
      // 创建工具:建完回选择工具(AFFiNE 同款「一次性工具」)。矩形/椭圆/Frame 是**按下拖出尺寸**
      // (拖不动就回落默认尺寸,见 onUp);文本只给点击建。
      if (DRAW_TOOLS.has(t)) {
        e.preventDefault()
        drag = { kind: 'create', tool: t, x0: at.x, y0: at.y, x1: at.x, y1: at.y }
        capture(e.pointerId)
        return
      }
      if (SHAPE_TOOLS[t]) {
        e.preventDefault()
        actRef.current.addShapeAt(SHAPE_TOOLS[t], at.x, at.y)
        setTool('select')
        focusStage()
        return
      }
      if (t === 'card') {
        e.preventDefault()
        actRef.current.addCardAt(at.x - CARD_W / 2, at.y - 24)
        setTool('select')
        focusStage()
        return
      }

      const gripEl = target.closest<HTMLElement>('[data-grip]')
      const shape = target.closest<HTMLElement>(EL_HIT)
      const card = target.closest<HTMLElement>('.amx-ucard')
      // 主卡**完全等同卡片**(2026-08-18 晚,用户拍板;此前的「正文」标题条已移除,别加回来):
      // chrome 圈 = .ProseMirror 自己的 padding(事件目标==根节点;段落间距的缝也算,与卡片的
      // padding 手柄同一条纪律),正文区 = 根之内、任何卡之外。「选字 vs 搬正文」的歧义由两段式
      // 消解:一击选中(不落光标),二击才进编辑 —— 与卡片完全同款,见下面两个分支。
      const pmEl = target.closest<HTMLElement>('.ProseMirror')
      const onMainChrome = !card && !shape && !!pmEl && target === pmEl
      const onMainBody = !card && !shape && !!pmEl && target !== pmEl
      // 事件目标 == 卡片本身 ⇒ 落在卡的 chrome 圈上(落在正文里时 target 是内部的 p/h1/…)。
      const onCardChrome = !!card && target === card
      const anchor = card?.dataset.anchor ?? null

      // ── 两段式:一击选中,二击进编辑(AFFiNE 同款)────────────────────────────────
      // 这一段必须排在下面的 `key` 之前:两段式让**正文区**也成为卡片的命中面(第一击),
      // 而正文区原本是直接让位给 PM 的。
      if (card && anchor && !onCardChrome && t === 'select') {
        if (editingRef.current === anchor) return // 已在编辑这张卡:整片让位给 PM(选字/IME/⠿ 全常规)
        // ⚠️ 第二击**不能立刻进编辑然后 return**(第一版就是,真机 A7/A10 实测打回):
        //    那样「已选中的卡按住正文拖」会整片让给 PM,变成选文字,卡一动不动。
        //    正解是两击都起拖,只把「这一下要不要进编辑」记在手势上 —— 纯点击(没越过 CLICK_SLOP)
        //    才在 onUp 进编辑并**补落光标**(preventDefault 之后 PM 拿不到 mousedown,得自己送)。
        const only = selRef.current.length === 1 && selRef.current[0] === cardKey(anchor)
        e.preventDefault()
        focusStage()
        if (!only) setEditing(null)
        const add = e.shiftKey || e.metaKey || e.ctrlKey
        const keys = add ? [...new Set([...selRef.current, cardKey(anchor)])] : [cardKey(anchor)]
        setSel(keys)
        const cards: Array<{ anchor: string; ox: number; oy: number }> = []
        for (const k of keys) {
          if (!k.startsWith('c:')) continue
          const el = host.querySelector<HTMLElement>(`.amx-ucard[data-anchor="${CSS.escape(keyId(k))}"]`)
          if (el) cards.push({ anchor: keyId(k), ox: Number(el.dataset.x) || 0, oy: Number(el.dataset.y) || 0 })
        }
        drag = { kind: 'move', cards, ids: new Set(keys), hit: cardKey(anchor), x0: at.x, y0: at.y, dx: 0, dy: 0, mainStart: null, mainEl: null, ...(only ? { enterEdit: anchor } : {}) }
        capture(e.pointerId)
        return
      }

      // ── 主卡的两段式(与上面的卡片分支完全同构;enterEdit 记 MAIN_KEY,onUp 里同一条路进编辑)──
      if (onMainBody && t === 'select') {
        if (editingRef.current === MAIN_KEY) return // 已在编辑正文:整片让位给 PM(选字/IME/⠿ 全常规)
        const only = selRef.current.length === 1 && selRef.current[0] === MAIN_KEY
        e.preventDefault()
        focusStage()
        if (!only) setEditing(null)
        const add = e.shiftKey || e.metaKey || e.ctrlKey
        const keys = add ? [...new Set([...selRef.current, MAIN_KEY])] : [MAIN_KEY]
        setSel(keys)
        const cards: Array<{ anchor: string; ox: number; oy: number }> = []
        for (const k of keys) {
          if (!k.startsWith('c:')) continue
          const el = host.querySelector<HTMLElement>(`.amx-ucard[data-anchor="${CSS.escape(keyId(k))}"]`)
          if (el) cards.push({ anchor: keyId(k), ox: Number(el.dataset.x) || 0, oy: Number(el.dataset.y) || 0 })
        }
        drag = {
          kind: 'move', cards, ids: new Set(keys), hit: MAIN_KEY, x0: at.x, y0: at.y, dx: 0, dy: 0,
          mainStart: { x: cbRef.current.main.x, y: cbRef.current.main.y }, mainEl: pmEl,
          ...(only ? { enterEdit: MAIN_KEY } : {}),
        }
        capture(e.pointerId)
        return
      }

      // ⚠️ 卡片的命中面是**整张卡**,不再只是那圈 padding。原来只认 chrome 圈的后果是连线工具几乎
      //    没法用:要连两张卡得分别点中 16px 的边框(用户实报「连线功能没做进来」——其实做了,
      //    只是命中面细得找不到)。走到这里的卡片点击只剩两种:chrome 圈,或非 select 工具下的正文,
      //    两种都该给卡键;select + 正文的第一/二击已在上面的两段式里消费掉了。
      const key = shape?.dataset.el ? elKey(shape.dataset.el) : anchor ? cardKey(anchor) : onMainChrome ? MAIN_KEY : null

      // 连线工具:点两个对象成一条线;点空白 = 放弃。
      if (t === 'conn') {
        e.preventDefault()
        focusStage()
        // 连线工具下主卡的命中面是**整个正文**:工具意图明确,不存在与选字的歧义。
        const ck = key ?? (!card && !shape && target.closest('.ProseMirror') ? MAIN_KEY : null)
        if (!ck) {
          setConnFrom(null)
          return
        }
        const from = connFromRef.current
        if (!from) setConnFrom(ck)
        else {
          // 箭头工具升级(2026-08-19 晚,用户拍板「工具栏的箭头按钮升级成指向子节点的功能」):
          // **两端都是节点(卡片/主卡)= 建父子关系**(先点父、后点子),这才是画布上「一条箭头」
          // 最常见的意思;任一端是形状/Frame 就仍然画自由连线(层级只在节点之间成立,形状进不了
          // tree)。两条路共存 = 既拿到 mindmap 的表达力,又没砍掉图形之间连线的能力。
          // ⚠️ 按住 Shift 落第二击 = 强制画**自由连线**(Codex 08-19 深夜 medium:卡↔卡的关联连线是
          //    既有能力,升级成层级不该把它整条砍掉;数据层与渲染层一直支持卡锚端点)。
          //    用 Shift 不用 Alt —— Alt 在 onDown 顶上就被平移分支吃掉了。
          const nodeOf = (k: string): string | null => (k === MAIN_KEY ? MAIN_KEY : k.startsWith('c:') ? keyId(k) : null)
          const pa = nodeOf(from)
          const ch = nodeOf(ck)
          if (pa && ch && ch !== MAIN_KEY && !e.shiftKey) actRef.current.setNodeParent(ch, pa) // 主卡是根,不认爹
          else actRef.current.mutate((l) => addConnector(l, from, ck))
          setConnFrom(null)
          setTool('select')
        }
        return
      }

      // 卡侧 ⊕(AFFiNE autocomplete 同款,2026-08-19):与 Tab/回车同一条 addRelated。必须在
      // 这里认领 —— 它住在元素层,底下所有分支都认不出它,一路掉到「点空白」= 清选中 + 起框选。
      const addEl = target.closest<HTMLElement>('[data-add]')
      if (addEl?.dataset.add && addEl.dataset.node) {
        e.preventDefault()
        focusStage() // 建完焦点留在舞台:接着按 Tab/回车能继续长下一枚
        actRef.current.addRelated(addEl.dataset.node, addEl.dataset.add === 'child' ? 'child' : 'sibling')
        return
      }

      if (gripEl?.dataset.grip) {
        e.preventDefault()
        // 主卡的调宽把手(选中框右下角,data-grip="m:"):只吃横向,高随内容。
        if (gripEl.dataset.grip === MAIN_KEY) {
          const pm = host.querySelector<HTMLElement>('.ProseMirror')
          if (pm) {
            drag = { kind: 'mwidth', el: pm, x0: e.clientX, w0: cbRef.current.main.w }
            capture(e.pointerId)
          }
          return
        }
        const b0 = shapeBoxes(safeElements(cbRef.current.elements), null).get(gripEl.dataset.grip)
        if (!b0) return
        drag = { kind: 'size', id: gripEl.dataset.grip, corner: gripEl.dataset.corner ?? 'se', b0, dx: 0, dy: 0, dw: 0, dh: 0 }
        capture(e.pointerId)
        return
      }

      if (key) {
        e.preventDefault()
        focusStage()
        const additive = e.shiftKey || e.metaKey || e.ctrlKey
        const cur = selRef.current
        let keys = cur
        if (additive) {
          keys = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
          setSel(keys)
          if (!keys.includes(key)) return // 刚被取消选中的对象不该起拖
        } else if (!cur.includes(key)) {
          keys = [key]
          setSel(keys)
        }
        // 卡片右缘 = 调宽(只在单选一张卡时给,免得多选整批搬时误触)。
        if (onCardChrome && keys.length === 1 && card.dataset.anchor) {
          const r = card.getBoundingClientRect()
          if (e.clientX > r.right - GRIP * vpRef.current.z * (zoomOf(host) || 1)) {
            drag = { kind: 'width', anchor: card.dataset.anchor, x0: e.clientX, w0: Number(card.dataset.w) || CARD_W }
            capture(e.pointerId)
            return
          }
        }
        // 主卡右缘同款调宽(chrome 圈直点;选中框右下把手仍在,两条路等价)。
        if (key === MAIN_KEY && keys.length === 1 && pmEl) {
          const r = pmEl.getBoundingClientRect()
          if (e.clientX > r.right - GRIP * vpRef.current.z * (zoomOf(host) || 1)) {
            drag = { kind: 'mwidth', el: pmEl, x0: e.clientX, w0: cbRef.current.main.w }
            capture(e.pointerId)
            return
          }
        }
        // 拖 Frame 的标题条 = 连辖域一起搬(选中集合仍只有 Frame 自己,见 expandFrames)。
        const moving = actRef.current.expandFrames(keys)
        const cards: Array<{ anchor: string; ox: number; oy: number }> = []
        for (const k of moving) {
          if (!k.startsWith('c:')) continue
          const el = host.querySelector<HTMLElement>(`.amx-ucard[data-anchor="${CSS.escape(keyId(k))}"]`)
          if (el) cards.push({ anchor: keyId(k), ox: Number(el.dataset.x) || 0, oy: Number(el.dataset.y) || 0 })
        }
        // 主卡入列(chrome 圈直点,或被 Frame 辖域带上):起点取 props 的权威几何,不读测量盒 ——
        // 与卡片读 dataset 同一条纪律(拖拽期间测量盒里是过程值)。
        const withMainMove = moving.includes(MAIN_KEY)
        drag = {
          kind: 'move', cards, ids: new Set(moving), hit: key, x0: at.x, y0: at.y, dx: 0, dy: 0,
          mainStart: withMainMove ? { x: cbRef.current.main.x, y: cbRef.current.main.y } : null,
          mainEl: withMainMove ? host.querySelector<HTMLElement>('.ProseMirror') : null,
        }
        capture(e.pointerId)
        return
      }

      if (!isBlank(target)) return // 卡片正文/嵌入卡内部:让位给 PM 的选字

      // 空白:先命中连线(线是细的,给容差),否则框选。
      const boxes = actRef.current.boxesNow(null)
      const hit = safeElements(cbRef.current.elements).find((el) => {
        if (el.kind !== 'connector') return false
        const a = endKey(el.from)
        const b = endKey(el.to)
        const ba = a ? boxes.get(a) : null
        const bb = b ? boxes.get(b) : null
        return !!ba && !!bb && hitEdge(ba, bb, at, 8 / vpRef.current.z)
      })
      // 层级线也可命中(2026-08-19 晚用户拍板,**推翻** 08-18「层级线故意不可选中」那条):
      // 选中它 = 选中那条父子关系本身,Delete = 解除关系。命中同样是数学做的(元素层不吃指针)。
      const tHit = hit ? null : safeTree(cbRef.current.tree).find(([child, parent]) => {
        const bc = boxes.get(cardKey(child))
        const bp = boxes.get(parent === MAIN_KEY ? MAIN_KEY : cardKey(parent))
        return !!bc && !!bp && hitEdge(bp, bc, at, 8 / vpRef.current.z)
      })
      e.preventDefault()
      focusStage()
      if (hit) {
        setSel([elKey(hit.id)])
        return
      }
      if (tHit) {
        setSel([treeKey(tHit[0])])
        return
      }
      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      if (!additive) setSel([])
      drag = { kind: 'marquee', x0: at.x, y0: at.y, additive }
      capture(e.pointerId)
    }

    const onMove = (e: PointerEvent): void => {
      // 连线橡皮筋:第一击之后、第二击之前的**悬停**(没有 drag)也要出预览 —— 只有底部一行字
      // 提示的连线是盲连(评审 P1)。悬到有效目标上预览线吸附到它的盒(渲染在 CanvasElements)。
      if (!drag && toolRef.current === 'conn' && connFromRef.current) {
        const t2 = e.target as HTMLElement
        const overShape = t2.closest?.<HTMLElement>(EL_HIT)
        const overCard = t2.closest?.<HTMLElement>('.amx-ucard')
        let over: string | null = overShape?.dataset.el
          ? elKey(overShape.dataset.el)
          : overCard?.dataset.anchor
            ? cardKey(overCard.dataset.anchor)
            : !overCard && t2.closest?.('.ProseMirror')
              ? MAIN_KEY
              : null
        if (over === connFromRef.current) over = null // 自连无效,别高亮
        const at = toStage(e.clientX, e.clientY)
        setConnPt({ x: at.x, y: at.y, over })
        return
      }
      if (!drag) return
      const u = zoomOf(host) || 1 // 应用级 CSS zoom,见 toStage 的告警
      if (drag.kind === 'pan') {
        setVp({ ...vpRef.current, x: drag.vx + (e.clientX - drag.x0) / u, y: drag.vy + (e.clientY - drag.y0) / u })
        return
      }
      // 过程只动 CSS / 渲染层幽灵:PM 事务与 fm 写入都留到松手那一笔(§5 防 history 灌水)。
      // 卡片的过程通道是 dragCss(舞台样式表),见 effect 顶部的告警 —— PM 的 DOM 一个属性都不碰。
      if (drag.kind === 'width') {
        const w = Math.max(MIN_W, Math.round(drag.w0 + (e.clientX - drag.x0) / (vpRef.current.z * u)))
        if (Math.abs(w - drag.w0) > CLICK_SLOP) drag.live = true
        setDragRule([{ anchor: drag.anchor, decl: `width:${w}px;${LIFT}` }])
        return
      }
      if (drag.kind === 'mwidth') {
        const w = Math.max(MAIN_MIN_W, Math.round(drag.w0 + (e.clientX - drag.x0) / (vpRef.current.z * u)))
        if (Math.abs(w - drag.w0) > CLICK_SLOP) drag.live = true
        drag.el.style.width = `${w}px`
        return
      }
      const s = toStage(e.clientX, e.clientY)
      if (drag.kind === 'size') {
        // 四角塑型:**对角固定**,尺寸由「固定角 → 指针」算,MIN_EL 夹在算完之后再回推左上角
        // —— 拿增量硬夹(w = max(MIN, w0+dw))的话,缩到最小之后继续往里拖,元素会跟着指针整体走位。
        const b = drag.b0
        const east = drag.corner.includes('e')
        const south = drag.corner.includes('s')
        const w = Math.max(MIN_EL, Math.round(east ? s.x - b.x : b.x + b.w - s.x))
        const h = Math.max(MIN_EL, Math.round(south ? s.y - b.y : b.y + b.h - s.y))
        drag.dx = east ? 0 : b.w - w
        drag.dy = south ? 0 : b.h - h
        drag.dw = w - b.w
        drag.dh = h - b.h
        if (Math.abs(drag.dw) > CLICK_SLOP || Math.abs(drag.dh) > CLICK_SLOP) drag.live = true
        setGhost({ move: null, size: { id: drag.id, dx: drag.dx, dy: drag.dy, dw: drag.dw, dh: drag.dh } })
        return
      }
      if (drag.kind === 'create') {
        drag.x1 = s.x
        drag.y1 = s.y
        if (Math.abs(drag.x1 - drag.x0) > CLICK_SLOP || Math.abs(drag.y1 - drag.y0) > CLICK_SLOP) drag.live = true
        // 预览借框选那个虚线框(同一个坐标系、同一种「正在圈一块地」的语义,不值一个新浮层)。
        setMarquee({ x: Math.min(drag.x0, s.x), y: Math.min(drag.y0, s.y), w: Math.abs(s.x - drag.x0), h: Math.abs(s.y - drag.y0) })
        return
      }
      if (drag.kind === 'marquee') {
        drag.live = true
        setMarquee({ x: Math.min(drag.x0, s.x), y: Math.min(drag.y0, s.y), w: Math.abs(s.x - drag.x0), h: Math.abs(s.y - drag.y0) })
        return
      }
      drag.dx = Math.round(s.x - drag.x0)
      drag.dy = Math.round(s.y - drag.y0)
      if (Math.abs(drag.dx) > CLICK_SLOP || Math.abs(drag.dy) > CLICK_SLOP) drag.live = true
      const { dx, dy } = drag
      setDragRule(drag.cards.map((c) => ({ anchor: c.anchor, decl: `left:${c.ox + dx}px;top:${c.oy + dy}px;${LIFT}` })))
      // 主卡的过程通道是 **margin**(position/transform 会建立包含块,坐标系当场塌掉,见文件头)。
      // 内联写在 view.dom(PM 根)上没事 —— DOMObserver 重画的是**内容节点**,根自身的样式它不管
      // (C39 真实输入实测跟手)。卡片不行,理由见 dragCss 顶注。
      if (drag.mainStart && drag.mainEl) {
        drag.mainEl.style.marginLeft = `${drag.mainStart.x + drag.dx}px`
        drag.mainEl.style.marginTop = `${drag.mainStart.y + drag.dy}px`
      }
      setGhost({ move: { ids: drag.ids, dx: drag.dx, dy: drag.dy }, size: null })
      // 单张卡拖动时找「贴到谁的边上了」——多选整批搬不给认亲(拖的是一堆,认谁当爹没有语义);
      // 主卡入列时也不给(主卡是根,不认爹)。
      const solo = drag.cards.length === 1 && drag.ids.size === 1 && !drag.mainStart ? drag.cards[0].anchor : null
      setAttach(solo && drag.live ? actRef.current.attachHit(solo, s) : null)
    }

    /** 手势外观回滚(取消 / 纯点击 / 落笔后让位给数据驱动的渲染)。 */
    const clearVisuals = (d: Drag): void => {
      clearDragRule()
      if (d.kind === 'mwidth') d.el.style.width = ''
      if (d.kind === 'move' && d.mainEl) {
        d.mainEl.style.marginLeft = ''
        d.mainEl.style.marginTop = ''
      }
      setGhost(null)
      setMarquee(null)
      setAttach(null)
    }

    const onUp = (e: PointerEvent): void => {
      const d = drag
      drag = null
      release(e.pointerId)
      if (!d || d.kind === 'pan') return
      // 建形状/Frame:拖出了框就用框,没拖动(或框比 MIN_EL 还小)回落成默认尺寸的一击建 ——
      // 所以这一支排在下面的 `!d.live` **之前**:那道闸拦的是「落笔会给撤销栈灌垃圾」的手势,
      // 而一击建本来就是修前的既有行为,不能被当成取消吞掉。
      if (d.kind === 'create') {
        const w = Math.abs(d.x1 - d.x0)
        const h = Math.abs(d.y1 - d.y0)
        const box = w >= MIN_EL && h >= MIN_EL ? { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w, h } : null
        if (d.tool === 'frame') {
          if (box) actRef.current.addFrame(box.x, box.y, box.w, box.h)
          else actRef.current.addFrame(d.x0 - FRAME_SIZE.w / 2, d.y0 - FRAME_SIZE.h / 2)
        } else if (SHAPE_TOOLS[d.tool]) {
          actRef.current.addShapeAt(SHAPE_TOOLS[d.tool], d.x0, d.y0, box ?? undefined)
        }
        setTool('select')
        focusStage()
        clearVisuals(d)
        return
      }
      // ⚠️ 纯点击(指针一次都没越过 CLICK_SLOP)必须**什么都不落**,直接当取消处理。
      //    早先取值用的是内联样式,而没跑过 onMove 时它是空串 —— `parseFloat('') || 0` 会把卡片
      //    写到 (0,0),调宽那支的 `|| CARD_W` 把一张 250px 的卡变成 400。都是真事务、进撤销栈、
      //    照常落盘:在卡片那圈 padding 手柄上点一下就毁一次几何。更狠的第三态:卡一旦被打到
      //    (0,0) 就压在主卡上,下一次静止点击命中 inMain → 整张卡被拆回正文(对抗评审 P1)。
      //    现在位移量全部来自手势自身的 dx/dy(不再回读 DOM),但 live 这道闸照留:纯点击落笔
      //    等于给撤销栈灌垃圾。
      if (!d.live) {
        // 第二击且没拖 = 进编辑。光标由我们自己送到点击处 —— pointerdown 已经 preventDefault,
        // PM 那边不会收到 mousedown,不补这一下就是「进了编辑态但光标不知道在哪」。
        if (d.kind === 'move' && d.enterEdit) {
          setEditing(d.enterEdit)
          const view = getView()
          const at = view?.posAtCoords({ left: e.clientX, top: e.clientY })
          if (view && at) {
            try {
              view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))))
            } catch { /* 位置刚被改掉:退化成只聚焦 */ }
            view.focus()
          }
          clearVisuals(d)
          return
        }
        // 多选状态下点中其中一个但**没拖**:收敛成只选它(Figma/AFFiNE 同款)。按下时之所以保留整批,
        // 是为了让「点住组里任意一个就能整批拖走」成立;不拖就意味着用户在重新指定目标,不收敛的话
        // 下一个动作(删除/微移)会连着整批一起走 —— 实测:框选全部后点一下形状再按删除,三张卡陪葬。
        if (d.kind === 'move' && d.ids.size > 1) setSel([d.hit])
        clearVisuals(d)
        return
      }
      const view = getView()
      if (d.kind === 'marquee') {
        const s = toStage(e.clientX, e.clientY)
        const rect = { x: Math.min(d.x0, s.x), y: Math.min(d.y0, s.y), w: Math.abs(s.x - d.x0), h: Math.abs(s.y - d.y0) }
        const hits: string[] = []
        for (const [k, b] of actRef.current.boxesNow(null)) if (boxHits(rect, b)) hits.push(k)
        setSel((old) => (d.additive ? [...new Set([...old, ...hits])] : hits))
        clearVisuals(d)
        return
      }
      if (!view) {
        clearVisuals(d)
        return
      }
      if (d.kind === 'width') {
        setCardAttrs(view, new Map([[d.anchor, { w: Math.max(MIN_W, Math.round(d.w0 + (e.clientX - d.x0) / (vpRef.current.z * (zoomOf(host) || 1)))) }]]))
      } else if (d.kind === 'mwidth') {
        const w = Math.max(MAIN_MIN_W, Math.round(d.w0 + (e.clientX - d.x0) / (vpRef.current.z * (zoomOf(host) || 1))))
        actRef.current.writeFm({ m: { ...cbRef.current.main, w } })
      } else if (d.kind === 'size') {
        const cur = safeElements(cbRef.current.elements).find((x) => x.id === d.id)
        if (cur && cur.kind !== 'connector') {
          // x/y 也要落:拖左/上两个角是「对角不动、左上角跟手」,只落 w/h 的话元素会向右下方长出去。
          actRef.current.mutate((l) => patchElement(l, d.id, {
            x: Math.round(cur.x + d.dx),
            y: Math.round(cur.y + d.dy),
            w: Math.max(MIN_EL, Math.round(cur.w + d.dw)),
            h: Math.max(MIN_EL, Math.round(cur.h + d.dh)),
          }))
        }
      } else {
        // (2026-08-19 用户拍板「拖=整卡搬家」:原「单卡拖到主卡上=隐式收回拆壳」已删 ——
        //  拆壳只走块菜单「收回文档」这一个显式入口,拖到哪都只是搬位置。别加回来:闭合锚
        //  之后卡住哪都合法,按位置隐式拆壳既不可预期又和菜单入口双轨。)
        {
          // 认亲优先(2026-08-19 晚):贴到某张卡的边上松手 = 认爹/成兄弟,位置由队列决定而不是落点
          // (用户拍板「自动吸附到父卡旁的队列」)。⚠️ 必须在下面的位置落笔**之前**——两笔都写
          // x/y 的话撤销栈里就是两格,而这是一个动作。认亲失败(几何没了)照旧走普通搬家。
          const solo = d.cards.length === 1 && d.ids.size === 1 && !d.mainStart ? d.cards[0].anchor : null
          const hit = solo ? actRef.current.attachHit(solo, toStage(e.clientX, e.clientY)) : null
          if (solo && hit && actRef.current.applyAttach(solo, hit)) {
            clearVisuals(d)
            return
          }
          if (d.cards.length) {
            setCardAttrs(view, new Map(d.cards.map((c) => [c.anchor, { x: Math.round(c.ox + d.dx), y: Math.round(c.oy + d.dy) }])))
          }
          // 元素与主卡合成**一笔** fm 快照(整批搬走本来就是一个动作);还牵着卡片(PM 那笔)时
          // 时间线并成 'pair' —— 一次框选整批拖,Cmd+Z 一击全还原。
          const elIds = new Set([...d.ids].filter((k) => k.startsWith('e:')).map(keyId))
          const m = d.mainStart ? { x: Math.round(d.mainStart.x + d.dx), y: Math.round(d.mainStart.y + d.dy), w: cbRef.current.main.w } : undefined
          if (elIds.size || m) {
            actRef.current.writeFm({
              ...(elIds.size ? { e: moveElements(rawList(cbRef.current.elements), elIds, d.dx, d.dy) } : {}),
              ...(m ? { m } : {}),
            })
            if (d.cards.length) actRef.current.mergePair()
          }
        }
      }
      clearVisuals(d)
      onCommit()
    }

    // 双击:形状 = 改文字;连线 = 改标签;空白 = 新建卡片(插件同款,用户熟)。
    const onDblClick = (e: MouseEvent): void => {
      // ⚠️ e.target 不可信:两段式在 pointerdown 里 setPointerCapture,派生的 click/dblclick 被
      // 重定向到 host —— 「双击卡片」于是被 isBlank 误判成「双击空白」,凭空建卡;双击形状同族,
      // 该进文字编辑的也建了卡(2026-08-18 用户实报,复现 R1/R1b)。按坐标现场取真实命中,
      // capture 重定向影响不到 elementFromPoint;selbox 整层 pointer-events:none,不会挡视线。
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) ?? (e.target as HTMLElement)
      if (target.closest('.amx-stage-tools, .amx-stage-hud, .ctx-menu')) return
      const shape = target.closest<HTMLElement>(EL_HIT)
      if (shape?.dataset.el) {
        e.preventDefault()
        e.stopPropagation()
        const el = safeElements(cbRef.current.elements).find((x) => x.id === shape.dataset.el)
        if (el) void actRef.current.editText(el.id, textKeyOf(el), textTitleOf(el))
        return
      }
      if (!isBlank(target)) return
      const at = toStage(e.clientX, e.clientY)
      const boxes = actRef.current.boxesNow(null)
      const hit = safeElements(cbRef.current.elements).find((el) => {
        if (el.kind !== 'connector') return false
        const a = endKey(el.from)
        const b = endKey(el.to)
        const ba = a ? boxes.get(a) : null
        const bb = b ? boxes.get(b) : null
        return !!ba && !!bb && hitEdge(ba, bb, at, 8 / vpRef.current.z)
      })
      e.preventDefault()
      if (hit) void actRef.current.editText(hit.id, 'label', '连线标签')
      else actRef.current.addCardAt(at.x - CARD_W / 2, at.y - 24)
    }

    // ⚠️ 右键仲裁**必须在捕获期**(Codex 评审 2026-08-18 晚,high):blockLayer 的 contextmenu
    // 挂在 .ProseMirror(舞台的后代)上,冒泡期它先拿到事件 —— preventDefault + 设块级
    // NodeSelection + 开块菜单,舞台随后又开画布菜单 = 双菜单;而且那枚块级选中绕过了两段式
    // (非编辑态就能对主卡/卡片正文做块级删除)。捕获期规则:编辑中的卡/正文 = 掐断传播
    // (块菜单别抢)但**不取消默认** → 原生文本菜单;其余 = 掐断传播 + 取消默认 → 只开画布菜单。
    // 文档模式不受影响:本 effect 只在画布模式挂(!active 早退),块菜单在文档模式照常。
    const onCtxMenu = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('.amx-stage-tools, .amx-stage-hud')) return
      const shape = target.closest<HTMLElement>(EL_HIT)
      const card = target.closest<HTMLElement>('.amx-ucard')
      const inMain = !card && !shape && !!target.closest('.ProseMirror')
      // 正在编辑的卡/正文让位给 PM/原生菜单(复制粘贴、拼写检查都在那儿)。
      if ((card?.dataset.anchor && editingRef.current === card.dataset.anchor) || (inMain && editingRef.current === MAIN_KEY)) {
        e.stopPropagation()
        return
      }
      const key = shape?.dataset.el
        ? elKey(shape.dataset.el)
        : card?.dataset.anchor
          ? cardKey(card.dataset.anchor)
          : inMain
            ? MAIN_KEY
            : null
      if (!key && !isBlank(target)) return // 浮层 chrome(把手等,不在 PM 内):原生菜单
      e.preventDefault()
      e.stopPropagation()
      if (key && !selRef.current.includes(key)) setSel([key])
      setMenu({ x: e.clientX, y: e.clientY, key, at: toStage(e.clientX, e.clientY) })
    }

    // 从 ⠿ 把块拖到舞台空白 → 成卡(AFFiNE 的 drag-handle drop 到 edgeless 空白同款)。
    // 落点在编辑器 DOM 之内时一律不接管:那是 PM 自己的块重排,blockLayer 已经管着。
    const onStageDragOver = (e: DragEvent): void => {
      const view = getView()
      if (!view?.dragging || (e.target as HTMLElement)?.closest?.('.ProseMirror')) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      host.classList.add('amx-dropzone')
    }
    const onStageDragLeave = (): void => host.classList.remove('amx-dropzone')
    const onStageDrop = (e: DragEvent): void => {
      host.classList.remove('amx-dropzone')
      const view = getView()
      if (!view?.dragging || (e.target as HTMLElement)?.closest?.('.ProseMirror')) return
      e.preventDefault()
      e.stopPropagation()
      const at = toStage(e.clientX, e.clientY)
      // ⠿ 拖的是**已有的卡片** → 搬到落点(2026-08-18 用户实报「拖拽没有过程显示」的实锤根因:
      // blockToCard 对卡片节点返回 null,而事件已被接管 —— 用户学会的唯一拖法被静默吞掉,
      // HTML5 拖影 Electron 上还常常不画,看起来就是「拖了没反应」)。
      const sel = view.state.selection
      if (sel instanceof NodeSelection && sel.node.type.name === 'amadeusCanvasCard') {
        setCardAttrs(view, new Map([[String(sel.node.attrs.anchor), { x: Math.round(at.x), y: Math.round(at.y) }]]))
        onCommit()
      } else {
        const made = blockToCard(view, Math.round(at.x), Math.round(at.y))
        if (made) onCommit(made)
      }
      view.dragging = null
      view.dom.dataset.dragging = 'false'
    }

    // pointercancel ≠ 松手:系统手势接管 / 失焦 / 设备断连都会发它。当成松手的话,用户**取消**的
    // 那次拖拽会把最后一帧的临时坐标提交进 history 和磁盘(Codex P2-2)。这里只回滚外观。
    const onCancel = (e: PointerEvent): void => {
      const d = drag
      drag = null
      release(e.pointerId)
      if (!d || d.kind === 'pan') return
      clearVisuals(d)
    }

    host.addEventListener('pointerdown', onDown)
    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerup', onUp)
    host.addEventListener('pointercancel', onCancel)
    host.addEventListener('dblclick', onDblClick)
    host.addEventListener('contextmenu', onCtxMenu, true) // 捕获期:必须先于 blockLayer,见 onCtxMenu 顶注
    host.addEventListener('dragover', onStageDragOver)
    host.addEventListener('dragleave', onStageDragLeave)
    host.addEventListener('drop', onStageDrop)
    return () => {
      dragCss.remove()
      delete host.dataset.amxDragscope
      host.removeEventListener('wheel', onWheel)
      host.removeEventListener('pointerdown', onDown)
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerup', onUp)
      host.removeEventListener('pointercancel', onCancel)
      host.removeEventListener('dblclick', onDblClick)
      host.removeEventListener('contextmenu', onCtxMenu, true)
      host.removeEventListener('dragover', onStageDragOver)
      host.removeEventListener('dragleave', onStageDragLeave)
      host.removeEventListener('drop', onStageDrop)
    }
  }, [active, toStage])

  /** 捕获期键盘:统一撤销 + 编辑中的 Esc。
   *  ⚠️ 必须挂**捕获期**的两个理由:Esc 那条是 PM 的 escKeymap 会抢(冒泡期拦不到);Cmd+Z 那条
   *  是**卡内打字时**焦点在 PM 里,冒泡期第一句就让路了 —— 而统一时间线的意义恰恰是「卡内卡外
   *  一条时序」,在卡里按 Cmd+Z 也必须先问时间线(评审 P0-1 的「交替操作」场景就在卡内)。 */
  const onKeyDownCapture = (e: React.KeyboardEvent): void => {
    if (!active || e.nativeEvent.isComposing) return // 组字中的键归输入法(Codex P2-4)
    const t = e.target as HTMLElement
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return // 弹窗输入框的撤销归原生
      e.preventDefault()
      e.stopPropagation()
      histStep(e.shiftKey ? 'redo' : 'undo')
      return
    }
    if (e.key !== 'Escape') return
    const cur = editingRef.current
    if (!cur || !t.closest('.ProseMirror')) return
    e.preventDefault()
    e.stopPropagation()
    setEditing(null)
    setSel([cur === MAIN_KEY ? MAIN_KEY : cardKey(cur)]) // ⚠️ cardKey('m:') 会拼出 'c:m:' 幽灵键
    hostRef.current?.focus({ preventScroll: true })
  }

  /** 画布态键盘(冒泡期)。⚠️ 第一句就得放行卡内打字 —— keydown 从 PM 冒泡到舞台,不挡的话在
   *  卡里按 Backspace 会把「选中的形状」删掉。(Cmd+Z 已在捕获期由统一时间线接管,这里没有它。) */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!active) return
    const t = e.target as HTMLElement
    if (t.closest('.ProseMirror') || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
    const mod = e.metaKey || e.ctrlKey
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      setSel([...measureCards(hostRef.current).keys()].map(cardKey).concat(els.filter((x) => x.kind !== 'connector').map((x) => elKey(x.id)), [MAIN_KEY]))
      return
    }
    // Esc 逐级退出:菜单 → 连线中 → 非默认工具 → 选中。菜单排在最前 —— 打开着菜单按 Esc 却先
    // 清了选中、菜单还挂在那儿,是最莫名其妙的一种。
    if (e.key === 'Escape') {
      e.preventDefault()
      if (menu) setMenu(null)
      else if (connFrom) setConnFrom(null)
      else if (tool !== 'select') setTool('select')
      else setSel([])
      return
    }
    if (!sel.length) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      removeSel(sel)
      return
    }
    if ((e.key === 'Enter' || e.key === 'F2') && sel.length === 1 && sel[0].startsWith('e:')) {
      e.preventDefault()
      const el = els.find((x) => x.id === keyId(sel[0]))
      if (el) void editText(el.id, textKeyOf(el), textTitleOf(el))
      return
    }
    // 选中一张卡:Tab = 新建子节点,回车 = 新建兄弟节点(mindmap 惯例;层级存 tree,不进正文)。
    // **主卡同样吃这一条**(2026-08-19 用户实报;主卡自 08-18 起完全等同卡片)。
    // ⚠️ 只在**焦点在舞台上**时生效 —— 卡内打字的 Tab/回车早在本函数第一句就让位给 PM 了
    //    (那边 Tab=缩进档、回车=新段落,是 08-19 上午刚落地的两条,不能被这里抢走)。
    if ((e.key === 'Tab' || e.key === 'Enter') && sel.length === 1 && (sel[0].startsWith('c:') || sel[0] === MAIN_KEY)) {
      e.preventDefault()
      addRelated(sel[0] === MAIN_KEY ? MAIN_KEY : keyId(sel[0]), e.key === 'Tab' ? 'child' : 'sibling')
      return
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault()
      const step = e.shiftKey ? 1 : NUDGE
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      if (!dx && !dy) return
      const view = getView()
      const anchors = sel.filter((k) => k.startsWith('c:')).map(keyId)
      if (view && anchors.length) {
        const boxes = measureCards(hostRef.current)
        setCardAttrs(view, new Map(anchors.map((a) => {
          const b = boxes.get(a)
          return [a, { x: Math.round((b?.x ?? 0) + dx), y: Math.round((b?.y ?? 0) + dy) }] as const
        })))
        onCommit()
      }
      // 元素 + 主卡合成一笔;还牵着卡片(上面那笔 PM)时并成 'pair'(与拖拽落笔同一口径)。
      const ids = new Set(sel.filter((k) => k.startsWith('e:')).map(keyId))
      const m = sel.includes(MAIN_KEY) ? { x: Math.round(main.x + dx), y: Math.round(main.y + dy), w: main.w } : undefined
      if (ids.size || m) {
        writeFm({
          ...(ids.size ? { e: moveElements(rawList(elements), ids, dx, dy) } : {}),
          ...(m ? { m } : {}),
        })
        if (anchors.length) mergePair()
      }
    }
  }

  const TOOLS: Array<{ id: Tool; icon: React.ReactNode; title: string }> = [
    { id: 'select', icon: <MousePointer2 size={14} />, title: '选择 (Esc)' },
    { id: 'pan', icon: <Hand size={14} />, title: '抓手(或按住 Alt 拖)' },
    { id: 'card', icon: <StickyNote size={14} />, title: '新建卡片(双击空白同)' },
    { id: 'rect', icon: <Square size={14} />, title: '矩形' },
    { id: 'ellipse', icon: <Circle size={14} />, title: '椭圆' },
    { id: 'text', icon: <Type size={14} />, title: '文本' },
    { id: 'frame', icon: <Frame size={14} />, title: 'Frame:拖出范围(或点一下取默认大小)' },
    { id: 'conn', icon: <Spline size={14} />, title: '箭头:依次点父节点、子节点(Shift 或形状=自由连线)' },
  ]

  // ⚠️ 文档模式下**不能**换成 `<>{children}</>`。那样这一槽位的元素类型在 Fragment 与 div 之间跳变,
  //    React 判定为不同类型 → 整棵子树卸载重挂 → **MilkdownProvider 重建,PM 的撤销栈当场销毁**:
  //    切一次模式,Cmd+Z 的历史就全没了(顺带白触发一次 onFinalFlush)。所以两种模式渲染同一棵树,
  //    差别只由 class 表达;`.amx-stage-off` 用 `display: contents` 把两层包裹整个摘出布局
  //    (盒子没了,DOM 还在 → 零重挂、零布局影响)。
  //    那条 CSS 里的 `position: static` 是配套的、删不得:display:contents 的元素没有盒子,
  //    getBoundingClientRect() 恒为 0,而 blockLayer 的 overlayOrigin 是按 `position !== 'static'`
  //    往上找包含块的 —— 留着 relative 就会挑中这个没有盒子的祖先,浮层整体偏一个容器位。
  return (
    <div
      className={`amx-stage${active ? '' : ' amx-stage-off'}${active ? ` amx-tool-${tool}` : ''}`}
      ref={hostRef}
      // 点阵底纹跟着视口走(AFFiNE 同款:格子是画布的一部分,不是背板贴纸)。背景只能画在这一层
      // —— stage-inner 是 0×0 的定位原点,给它画背景等于没画。所以把 viewport 三个量下发成自定义
      // 属性,由 CSS 自己换算 background-position/size(重渲频率与 stage-inner 的 transform 同源)。
      style={
        active
          ? {
              ['--amx-vpx' as string]: `${vp.x}px`,
              ['--amx-vpy' as string]: `${vp.y}px`,
              ['--amx-vpz' as string]: String(vp.z),
            }
          : undefined
      }
      tabIndex={-1}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
    >
      <div
        className="amx-stage-inner"
        style={
          active
            ? {
                transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.z})`,
                ['--amx-main-x' as string]: `${main.x}px`,
                ['--amx-main-y' as string]: `${main.y}px`,
                ['--amx-main-w' as string]: `${main.w}px`,
              }
            : undefined
        }
      >
        {/* 白板层排在正文之前 = 画在卡片底下(同为 absolute 且都没 z-index,绘制序即 DOM 序)。 */}
        {active ? (
          <CanvasElements
            elements={elements}
            hostRef={hostRef}
            sel={selSet}
            editing={editing}
            tree={tree}
            ghost={ghost}
            marquee={marquee}
            attach={attach}
            preview={connFrom && connPt ? { from: connFrom, x: connPt.x, y: connPt.y, over: connPt.over } : null}
          />
        ) : null}
        {children}
      </div>
      {/* 浮层一律排在 stage-inner **之后**:它们是舞台的 chrome,不吃 pan/zoom 的 transform。 */}
      {active ? (
        <div className="amx-stage-tools" role="toolbar" aria-label="画布工具">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.title}
              className={tool === t.id ? 'on' : ''}
              aria-pressed={tool === t.id}
              onClick={() => {
                setTool(t.id)
                setConnFrom(null)
                hostRef.current?.focus({ preventScroll: true })
              }}
            >
              {t.icon}
            </button>
          ))}
        </div>
      ) : null}
      {active && connFrom ? <div className="amx-stage-hint">再点一个对象:卡片/正文 = 收它作子节点(按住 Shift = 改画自由连线),形状 = 自由连线;Esc 取消</div> : null}
      {active ? (
        <div className="amx-stage-hud">
          <button type="button" onClick={() => zoomBy(1 / 1.2)} title="缩小"><Minus size={12} /></button>
          <span>{Math.round(vp.z * 100)}%</span>
          <button type="button" onClick={() => zoomBy(1.2)} title="放大"><Plus size={12} /></button>
          <button type="button" onClick={fit} title="适应内容"><Maximize2 size={12} /></button>
        </div>
      ) : null}
      {active && menu ? (
        <OverlayPortal>
          <OverlayAt className="ctx-menu amx-canvas-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
            {menu.key ? (
              <>
                {menu.key.startsWith('e:') && (
                  <button onClick={() => {
                    const el = els.find((x) => x.id === keyId(menu.key!))
                    setMenu(null)
                    if (el) void editText(el.id, textKeyOf(el), textTitleOf(el))
                  }}>编辑文字</button>
                )}
                <button onClick={() => { setConnFrom(menu.key); setTool('conn'); setMenu(null) }}>连线到…</button>
                <button onClick={() => { const keys = sel.length ? sel : [menu.key!]; setMenu(null); groupIntoFrame(keys) }}>成组为 Frame</button>
                {menu.key.startsWith('c:') && (
                  <button onClick={() => {
                    const a = keyId(menu.key!)
                    setMenu(null)
                    const view = getView()
                    if (!view) return
                    const ckpt = treeTouches([a])
                    if (ckpt) pushFmCheckpoint() // 撤销收回时层级要跟卡一起回来(评审 F1)
                    unwrapCard(view, a)
                    setSel([])
                    onCommit()
                    if (ckpt) mergePair()
                  }}>收回文档</button>
                )}
                {/* 选中集合优先:右键那一下已经把没选中的对象设成了唯一选中,所以两者恒一致。
                    主卡没有「删除」—— 它就是文档本身。 */}
                {menu.key !== MAIN_KEY && (
                  <button className="danger" onClick={() => { const keys = sel.length ? sel : [menu.key!]; setMenu(null); removeSel(keys) }}>删除</button>
                )}
              </>
            ) : (
              <>
                <button onClick={() => { const at = menu.at; setMenu(null); addCardAt(at.x - CARD_W / 2, at.y - 24) }}>新建卡片</button>
                <button onClick={() => { const at = menu.at; setMenu(null); addShapeAt('rect', at.x, at.y) }}>矩形</button>
                <button onClick={() => { const at = menu.at; setMenu(null); addShapeAt('ellipse', at.x, at.y) }}>椭圆</button>
                <button onClick={() => { const at = menu.at; setMenu(null); addShapeAt('text', at.x, at.y) }}>文本</button>
                <button onClick={() => { const at = menu.at; setMenu(null); addFrame(at.x, at.y) }}>Frame</button>
                <button onClick={() => { setMenu(null); fit() }}>适应内容</button>
              </>
            )}
          </OverlayAt>
        </OverlayPortal>
      ) : null}
    </div>
  )
}

/** 当前 NodeSelection 的块 → 文末新卡片(单笔事务:搬迁 + 建卡,undo 一击整体还原)。
 *  返回新锚 / null(= 这一块不给成卡,调用方放行默认行为)。宿主必须把返回的锚并进归属集合,
 *  否则「本实例建的这张卡」在 deriveCanvasJson 眼里不算数,当场收回它会失效(见那边的告警)。
 *  ⚠️ v1 不收:list_item(做不了 `block+` 的根级子节点,得先规范化成完整列表 —— 分栏 B9 同一个坑)、
 *  卡片自身、分栏结构节点,以及**任何位于分栏 cell 之内**的块 —— 后者要把 layout 修复(cell 收缩/
 *  行解散/tail 维护)放进同一笔事务才合规(方案 §3.2),不做就会留下空列。都留给 Phase 2。 */
export function blockToCard(view: EditorView, x: number, y: number): string | null {
  const sel = view.state.selection
  const card = view.state.schema.nodes.amadeusCanvasCard
  if (!card || !(sel instanceof NodeSelection)) return null
  const node = sel.node
  if (!node.isBlock) return null
  if (['amadeusCanvasCard', 'amadeusColumnRow', 'amadeusColumnCell', 'list_item'].includes(node.type.name)) return null
  const $at = view.state.doc.resolve(sel.from)
  for (let d = $at.depth; d >= 1; d--) if ($at.node(d).type.name === 'amadeusColumnCell') return null
  const anchor = freshAnchorId(view.state.doc)
  const made = card.createAndFill({ anchor, x, y, w: CARD_W, h: 0 }, node)
  if (!made) return null
  let tr = view.state.tr.delete(sel.from, sel.to)
  tr = tr.insert(tr.doc.content.size, made)
  commitGeo(view, tr.scrollIntoView())
  return anchor
}

/** 卡片拆壳还原成自然流(菜单「收回文档」—— 唯一拆壳入口,2026-08-19 起拖拽不再隐式触发)。
 *  锚**不回收**,转成惰性字面标记 —— 既有的 `![[note#anchor]]` 引用照「紧随其后的块级节点」
 *  继续解析,不会因为收回卡片而断链。落点=**原位**(闭合锚后卡与正文自由交错,原位才不重排
 *  正文;旧「搬到卡片区之前」是尾部连续不变式时代的补丁,那条 normalizer 连坐拆壳已退役)。
 *  整件事一笔事务,undo 一击还原。 */
export function unwrapCard(view: EditorView, anchor: string): void {
  const cards = cardsOf(view)
  const hit = cards.find((c) => c.anchor === anchor)
  if (!hit) return
  const { paragraph, html } = view.state.schema.nodes
  const inner: ProseNode[] = []
  hit.node.forEach((child) => inner.push(child))
  const marker = anchor && paragraph && html ? [paragraph.create(null, html.create({ value: `<!-- a ${anchor} -->` }))] : []
  const content = [...marker, ...(inner.length ? inner : [paragraph.create()])]
  // 就地拆(2026-08-19 Codex high):闭合锚之后卡与正文自由交错,原位=唯一不重排正文的落点。
  // 旧「搬到卡片区之前」是给尾部连续卡区不变式让路的补丁(就地拆会让 normalizer 把前面的卡
  // 连坐拆光)——那条 normalizer 分支已随闭合锚退役,搬前面反而成了无提示的语义重排。
  const tr = view.state.tr.delete(hit.pos, hit.pos + hit.node.nodeSize)
  commitGeo(view, tr.insert(hit.pos, content).scrollIntoView())
}
