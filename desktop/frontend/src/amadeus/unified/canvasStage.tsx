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
import { MousePointer2, Hand, Square, Circle, Type, Spline, StickyNote, Frame, Minus, Plus, Maximize2, Map as MapIcon } from 'lucide-react'
import { zoomOf } from '@lcl/engine'
import { CARD_W, MAIN_W, type CanvasMain, type UndoTimeline } from './canvas'
import {
  CanvasElements, cardKey, elKey, treeKey, keyId, safeElements, safeTree, shapeBoxes, measureCards, measureMain, hitEdge, boxHits, endKey,
  MAIN_KEY, MIN_EL, type AttachPreview, type El, type ElBox, type ElGhost, type FrameEl,
} from './canvasElements'
import { rawList, patchElement, removeElements, moveElements, freshElId, newShape, newShapeBox, newFrame, FRAME_SIZE, addConnector, setElementText, rawTree, setParent, childrenOf, runEndOf, type ShapeKind } from './canvasEdit'
import { freshAnchorId } from './columns'
import { askString } from '../components/askString'
import { OverlayPortal } from '../lib/overlayPortal'
import { OverlayAt } from '../lib/clampMenu'
import { canvasDoubleClickFocusEnabled, canvasMiniMapEnabled, setCanvasMiniMapEnabled } from './canvasPrefs'
import { resolveCardRepulsion } from './canvasGeometry'
import { hasChatRef, readChatRefs, type ChatRef } from '../../views/chat2/chatDragRef'

const MIN_Z = 0.25
const MAX_Z = 2.5
const GRID_STEP = 24
/** Chromium 把触控板双指捏合作为 `ctrlKey + wheel` 送达；macOS 的 Cmd+滚轮则是
 *  `metaKey + wheel`。前者的原始 delta 很细，按用户实测单独放大 2 倍，后者保持既有手感。 */
const TRACKPAD_PINCH_ZOOM_GAIN = 2
const MIN_W = 160
const MAIN_MIN_W = 320 // 主卡调宽下限(比卡片宽:它是正文,压太窄就不是「文档优先」了)
const GRIP = 12 // 右缘调宽热区(舞台像素)
const NUDGE = 8
/** 指针一次都没真正移动过(纯点击)的判据。落笔前必须问这一句 —— 见 onUp 的告警。 */
const CLICK_SLOP = 3
/** 触屏版的同一道闸。手指的抖动比鼠标大一个数量级,3px 下「点一下卡片」经常被判成真拖动
 *  —— 落一笔几何进撤销栈、进磁盘。
 *  ⚠️ 这个值是**屏幕像素**,进 onDown 时才换算成舞台单位:`live` 的比较全在舞台坐标里做,
 *  而舞台坐标随缩放伸缩 —— 实测自动 fit 后 z≈0.37,6px 的手指抖动到那边是 14 舞台 px,
 *  写死 10 照样判成拖动。(鼠标那档 CLICK_SLOP 仍是舞台单位的老口径,不在本轮动。) */
const TOUCH_SLOP = 10
/** 长按出菜单的时长与作废半径(Excalidraw 的 TOUCH_CTX_MENU_TIMEOUT 同值);半径按**屏幕**像素算。 */
const LONG_PRESS_MS = 500
const PRESS_SLOP = 10
/** 元素的可点面:形状本体,以及 Frame 的**标题条**(框体整片 pointer-events:none,见 canvasElements
 *  的 Frame 顶注 —— 一个满屏大的可点矩形就是糊在画布上的隐形挡板)。 */
const EL_HIT = '.amx-el-shape, .amx-el-frame-bar'
/** 卡内/主卡里的**可交互控件**:点它的语义是「用这个控件」,不是「选中或拖动这张卡」。
 *  `</>` 查看源码、嵌入卡的「打开」、待办勾选框、链接、多维表里的按钮全在这一类。 */
const CARD_CTL = 'button, a[href], input, select, textarea'
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

/** 连续同族段(判据与实现见 canvasEdit.runEndOf —— 与画层级框的那一处共用同一把尺)。 */
const runEnd = (cards: CardBox[], i: number, tree: Record<string, unknown>): number => runEndOf(cards, i, tree)

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
function setCardAttrs(view: EditorView, patches: Map<string, Record<string, number>>, history = true): void {
  const cards = cardsOf(view)
  let tr = view.state.tr
  let any = false
  for (const c of cards) {
    const patch = patches.get(c.anchor)
    if (!patch) continue
    tr = tr.setNodeMarkup(c.pos, undefined, { ...c.node.attrs, ...patch })
    any = true
  }
  if (!any) return
  if (history) commitGeo(view, tr)
  else view.dispatch(tr.setMeta('amxCanvas', true).setMeta('addToHistory', false))
}

/** 把某张卡的正文整体换成一行文本(上传占位 → `![[base]]` 用)。空文本 = 留一个空段。
 *  `expect` 给了就是**乐观锁**:卡里的字已经不是那份占位(用户在上传期间自己改了)就不动它 ——
 *  异步回调整片覆盖用户刚打的字是数据损失(Codex 评审 high)。 */
function setCardText(view: EditorView, anchor: string, text: string, expect?: string): boolean {
  const card = cardsOf(view).find((c) => c.anchor === anchor)
  const paragraph = view.state.schema.nodes.paragraph
  if (!card || !paragraph) return false
  if (expect != null && card.node.textContent !== expect) return false
  const body = paragraph.create(null, text ? view.state.schema.text(text) : undefined)
  view.dispatch(view.state.tr.replaceWith(card.pos + 1, card.pos + card.node.nodeSize - 1, body).setMeta('amxCanvas', true))
  return true
}

/** 解析出来的内容里若含卡节点(粘的是从画布复制走的一段)→ 就地拆壳成它的内容。
 *  卡里套卡是**被 filterTransaction 整笔拒**的形态(C51),不拆的话粘贴静默什么都不发生。 */
function unwrapCards(frag: Fragment | null): Fragment | undefined {
  if (!frag?.childCount) return undefined
  const out: ProseNode[] = []
  frag.forEach((n) => { if (n.type.name === 'amadeusCanvasCard') n.content.forEach((c) => out.push(c)); else out.push(n) })
  return out.length ? Fragment.fromArray(out) : undefined
}

/** 侧栏拖进来的引用 → 卡片正文。笔记走 `[[路径]]`(带目录时是路径限定形,resolvePageName 认;
 *  见 shared/amadeus/links.ts),工作区文件不在库里,只能落路径文本。 */
function refToCardMd(ref: ChatRef): string {
  if (ref.kind === 'note') return `[[${ref.path.replace(/\.md$/i, '')}]]`
  if (ref.kind === 'session') return `[[session:${ref.id}|${ref.title}]]`
  return ref.path
}

/** 剪贴板里给自家整卡载荷盖的戳(Chromium 的 web custom data:只在本 app 内往返,出到别的 app
 *  就只剩 text/plain)。 */
const CLIP_MIME = 'application/x-amx-canvas'

/** 画布自己的剪贴板镜像:系统剪贴板存不下 PM 节点,copy 时把卡原样记在这儿,paste 时**凭令牌**
 *  认领 —— 只比文本的话,用户在别处复制了一模一样的字就会静默粘回旧卡(Codex 评审 medium)。
 *  ponytail: 只记卡片 —— 形状/连线/层级的复制粘贴没做,要的话在这个载荷里加一层。 */
let cardClip: { token: string; nodes: ProseNode[] } | null = null

const growBox = (b: ElBox, n: number): ElBox => ({ x: b.x - n, y: b.y - n, w: b.w + n * 2, h: b.h + n * 2 })
const overlaps = (a: ElBox, b: ElBox): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

const MINI_W = 184
const MINI_H = 112
const MINI_PAD = 7

/** 画布总览缩略图。卡片/主卡/白板元素共用真实舞台盒，视口框可点击或拖动导航。 */
function CanvasMiniMap({
  hostRef,
  vp,
  elements,
  ghost,
  onCenter,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>
  vp: Viewport
  elements: unknown
  ghost: ElGhost | null
  onCenter: (x: number, y: number) => void
}): React.ReactElement | null {
  const [, setVer] = useState(0)
  const dragging = useRef(false)

  // PM 的卡高会因图片加载/换行独立变化；缩略图不能只等 React props，必须观察真实盒。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let raf = 0
    const watched = new Set<Element>()
    const ro = new ResizeObserver(() => bump())
    const sync = (): void => {
      const now = new Set<Element>(host.querySelectorAll('.amx-ucard'))
      const pm = host.querySelector('.ProseMirror')
      if (pm) now.add(pm)
      for (const el of now) if (!watched.has(el)) { ro.observe(el, { box: 'border-box' }); watched.add(el) }
      for (const el of [...watched]) if (!now.has(el)) { ro.unobserve(el); watched.delete(el) }
    }
    const bump = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { sync(); setVer((v) => v + 1) })
    }
    const mo = new MutationObserver(bump)
    mo.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-x', 'data-y', 'data-w'] })
    ro.observe(host)
    bump()
    return () => { cancelAnimationFrame(raf); mo.disconnect(); ro.disconnect() }
  }, [hostRef])

  const host = hostRef.current
  if (!host) return null
  const items: Array<{ key: string; kind: 'card' | 'main' | 'shape' | 'frame'; box: ElBox }> = []
  for (const [anchor, box] of measureCards(host)) items.push({ key: cardKey(anchor), kind: 'card', box })
  const mainBox = measureMain(host)
  if (mainBox) items.push({ key: MAIN_KEY, kind: 'main', box: mainBox })
  const els = safeElements(elements)
  const shapeMap = shapeBoxes(els, ghost)
  for (const el of els) {
    if (el.kind === 'connector') continue
    const box = shapeMap.get(el.id)
    if (box) items.push({ key: elKey(el.id), kind: el.kind === 'frame' ? 'frame' : 'shape', box })
  }
  if (!items.length) return null

  const u = zoomOf(host) || 1
  const hr = host.getBoundingClientRect()
  const visible: ElBox = {
    x: -vp.x / vp.z,
    y: -vp.y / vp.z,
    w: Math.max(1, hr.width / u / vp.z),
    h: Math.max(1, hr.height / u / vp.z),
  }
  // 把视口也并进世界范围：即使用户平移到内容之外，缩略图仍能显示“你现在在哪里”。
  const boxes = [...items.map((i) => i.box), visible]
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  const worldW = Math.max(1, maxX - minX)
  const worldH = Math.max(1, maxY - minY)
  const scale = Math.min((MINI_W - MINI_PAD * 2) / worldW, (MINI_H - MINI_PAD * 2) / worldH)
  const ox = (MINI_W - worldW * scale) / 2 - minX * scale
  const oy = (MINI_H - worldH * scale) / 2 - minY * scale
  const miniBox = (b: ElBox): ElBox => ({ x: ox + b.x * scale, y: oy + b.y * scale, w: Math.max(1.5, b.w * scale), h: Math.max(1.5, b.h * scale) })

  const jump = (e: React.PointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const mx = ((e.clientX - r.left) / Math.max(1, r.width)) * MINI_W
    const my = ((e.clientY - r.top) / Math.max(1, r.height)) * MINI_H
    onCenter((mx - ox) / scale, (my - oy) / scale)
  }

  const vb = miniBox(visible)
  return (
    <div
      className="amx-stage-minimap"
      role="navigation"
      aria-label="画布缩略图"
      title="画布缩略图：点击或拖动以导航"
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        dragging.current = true
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 合成事件可没有有效 id */ }
        jump(e)
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        e.preventDefault()
        e.stopPropagation()
        jump(e)
      }}
      onPointerUp={(e) => {
        dragging.current = false
        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 同上 */ }
      }}
      onPointerCancel={() => { dragging.current = false }}
    >
      <svg viewBox={`0 0 ${MINI_W} ${MINI_H}`} aria-hidden="true">
        {items.map((item) => {
          const b = miniBox(item.box)
          return <rect key={item.key} className={`amx-mini-item is-${item.kind}`} data-mini-key={item.key} x={b.x} y={b.y} width={b.w} height={b.h} rx={item.kind === 'frame' ? 2 : 1.5} />
        })}
        <rect className="amx-mini-viewport" x={vb.x} y={vb.y} width={vb.w} height={vb.h} rx="2" />
      </svg>
    </div>
  )
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
  /** 存一个 OS 文件为附件 → 磁盘形态的引用 md(`![[base]]`),失败给 null。宿主(UnifiedPage)实现;
   *  舞台负责「落点建卡 + 占位 + 换成引用」。缺省(没这个 prop)= 舞台不接管文件拖放。 */
  saveFile?: (file: File) => Promise<string | null>
  /** markdown → 块内容(宿主的 parserCtx)。粘贴/拖入的文字靠它落成真块;缺省则退回纯文本一段。 */
  parseMd?: (md: string) => Fragment | null
  /** 删掉了整张卡(舞台上删卡)→ 宿主据此问「卡里那个引用块牵着的磁盘文件也删吗」。
   *  与块菜单/键盘删块同一条路(见 assetDelete);调用时机在删除事务之后。 */
  onBlocksDeleted?: (content: Fragment) => void
  /** 文档中正编辑着光标时切进画布：递增一次，舞台把同一 PM 选区所属卡带回视野。 */
  revealSelection?: number
  children: React.ReactNode
}

export function CanvasStage({ path, active, getView, main, mainStored, elements, tree, onElements, onTree, onMain, timeline, onCommit, saveFile, parseMd, onBlocksDeleted, revealSelection = 0, children }: CanvasStageProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [vp, setVp] = useState<Viewport>(() => viewports.get(path) ?? { x: 0, y: 0, z: 1 })
  const vpRef = useRef(vp)
  vpRef.current = vp
  /** 本机画布 chrome 偏好：默认显示，HUD 开关即时生效并跨页面/重启记忆，不写进笔记。 */
  const [miniMapVisible, setMiniMapVisible] = useState<boolean>(canvasMiniMapEnabled)
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
  // `editing` = 当前允许落光标的卡锚。画布里单击恒为选择/拖动，选中后按空格才进入编辑；
  // 双击专用于居中聚焦。ref+state 同写 —— 手势 effect 只依赖 [active]，不能读陈旧闭包。
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
  /** 连着粘几次的序号(每次错开 24px);复制一次就归零。 */
  const pasteSeq = useRef(0)
  const [ghost, setGhost] = useState<ElGhost | null>(null)
  const [marquee, setMarquee] = useState<ElBox | null>(null)
  /** 拖到边缘认亲的当前候选(手势期高亮用;落笔在 onUp)。 */
  const [attach, setAttach] = useState<AttachPreview | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; key: string | null; at: { x: number; y: number } } | null>(null)
  /** 双击聚焦的逐帧弹簧。不能给 stage-inner 常驻 transition：滚轮、平移和拖卡都会被拖出尾巴。 */
  const [focusMotion, setFocusMotion] = useState(false)
  const focusRaf = useRef(0)
  const stopFocusMotion = useCallback((): void => {
    cancelAnimationFrame(focusRaf.current)
    focusRaf.current = 0
    setFocusMotion(false)
  }, [])
  useEffect(() => () => cancelAnimationFrame(focusRaf.current), [])
  /** “一键整理”是批量 FLIP：先落最终几何，再从旧位置反向补 transform。这里单独持有 rAF/动画，
   *  这样再次整理、开始拖拽或卸载舞台时都能立刻交还控制权，不会有旧动画把卡拉回去。 */
  const arrangeMotion = useRef<{ raf: number; animations: Animation[] }>({ raf: 0, animations: [] })
  const stopArrangeMotion = useCallback((): void => {
    cancelAnimationFrame(arrangeMotion.current.raf)
    arrangeMotion.current.raf = 0
    const running = arrangeMotion.current.animations.splice(0)
    for (const animation of running) animation.cancel()
  }, [])
  const playArrangeMotion = useCallback((moves: Array<{ anchor: string; x: number; y: number; depth: number }>): void => {
    const host = hostRef.current
    stopArrangeMotion()
    if (!host || !moves.length || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    arrangeMotion.current.raf = requestAnimationFrame(() => {
      arrangeMotion.current.raf = 0
      let total = 0
      const remember = (animation: Animation): void => {
        arrangeMotion.current.animations.push(animation)
        const done = (): void => {
          arrangeMotion.current.animations = arrangeMotion.current.animations.filter((a) => a !== animation)
        }
        animation.addEventListener('finish', done, { once: true })
        animation.addEventListener('cancel', done, { once: true })
      }
      for (const move of moves) {
        const el = host.querySelector<HTMLElement>(`.amx-ucard[data-anchor="${CSS.escape(move.anchor)}"]`)
        const distance = Math.hypot(move.x, move.y)
        if (!el || distance < 1) continue
        // 父层先动、下一层延迟 42ms，最多错峰 126ms；距离只轻量拉长时长，避免远端慢悠悠。
        const delay = Math.min(126, Math.max(0, move.depth - 1) * 42)
        const duration = Math.round(Math.max(420, Math.min(620, 360 + distance * 0.34)))
        total = Math.max(total, delay + duration)
        const animation = el.animate([
          {
            transform: `translate(${-move.x}px, ${-move.y}px) scale(0.988)`,
            opacity: 0.94,
            boxShadow: '0 8px 24px rgb(0 0 0 / 18%)',
            offset: 0,
            easing: 'cubic-bezier(0.16, 0.82, 0.24, 1)',
          },
          {
            transform: `translate(${move.x * 0.035}px, ${move.y * 0.035}px) scale(1.003)`,
            opacity: 1,
            boxShadow: '0 3px 12px rgb(0 0 0 / 14%)',
            offset: 0.72,
            easing: 'ease-out',
          },
          {
            transform: `translate(${-move.x * 0.008}px, ${-move.y * 0.008}px) scale(0.999)`,
            boxShadow: '0 2px 10px rgb(0 0 0 / 12%)',
            offset: 0.9,
            easing: 'ease-out',
          },
          { transform: 'translate(0, 0) scale(1)', opacity: 1, boxShadow: '0 2px 10px rgb(0 0 0 / 12%)', offset: 1 },
        ], { duration, delay, fill: 'backwards' })
        animation.id = 'amx-card-arrange'
        remember(animation)
      }
      // 连线几何会先落到终点；运动期间把它们压低，末段再淡入，避免线与移动中的卡片脱节。
      if (total > 0) {
        for (const el of host.querySelectorAll<HTMLElement>('.amx-el-conn, .amx-el-label')) {
          const animation = el.animate([
            { opacity: 0.12, offset: 0 },
            { opacity: 0.12, offset: 0.68 },
            { opacity: 1, offset: 1, easing: 'ease-out' },
          ], { duration: total, fill: 'backwards' })
          animation.id = 'amx-card-arrange-line'
          remember(animation)
        }
      }
    })
  }, [stopArrangeMotion])
  /** 边缘认亲后的单卡吸附。起点是手指松开处，终点是父/同级队列槽位；层级线到末段再出现。 */
  const playAttachMotion = useCallback((anchor: string, move: { x: number; y: number }): void => {
    const host = hostRef.current
    const distance = Math.hypot(move.x, move.y)
    stopArrangeMotion()
    if (!host || distance < 1 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    arrangeMotion.current.raf = requestAnimationFrame(() => {
      arrangeMotion.current.raf = 0
      const remember = (animation: Animation): void => {
        arrangeMotion.current.animations.push(animation)
        const done = (): void => {
          arrangeMotion.current.animations = arrangeMotion.current.animations.filter((a) => a !== animation)
        }
        animation.addEventListener('finish', done, { once: true })
        animation.addEventListener('cancel', done, { once: true })
      }
      const duration = Math.round(Math.max(400, Math.min(520, 350 + distance * 0.42)))
      const card = host.querySelector<HTMLElement>(`.amx-ucard[data-anchor="${CSS.escape(anchor)}"]`)
      if (card) {
        const animation = card.animate([
          {
            transform: `translate(${-move.x}px, ${-move.y}px) scale(1.012)`,
            opacity: 0.94,
            boxShadow: '0 12px 32px rgb(0 0 0 / 24%)',
            offset: 0,
            easing: 'ease-in',
          },
          {
            transform: `translate(${-move.x * 0.54}px, ${-move.y * 0.54}px) scale(1.007)`,
            opacity: 0.97,
            boxShadow: '0 8px 24px rgb(0 0 0 / 19%)',
            offset: 0.22,
            easing: 'cubic-bezier(0.16, 0.82, 0.24, 1)',
          },
          {
            transform: `translate(${move.x * 0.05}px, ${move.y * 0.05}px) scale(0.998)`,
            opacity: 1,
            boxShadow: '0 3px 12px rgb(0 0 0 / 14%)',
            offset: 0.72,
            easing: 'ease-out',
          },
          {
            transform: `translate(${-move.x * 0.012}px, ${-move.y * 0.012}px) scale(1.001)`,
            boxShadow: '0 2px 10px rgb(0 0 0 / 12%)',
            offset: 0.9,
            easing: 'ease-out',
          },
          { transform: 'translate(0, 0) scale(1)', opacity: 1, boxShadow: '0 2px 10px rgb(0 0 0 / 12%)', offset: 1 },
        ], { duration, fill: 'none' })
        animation.id = 'amx-card-attach'
        remember(animation)
      }
      const line = host.querySelector<HTMLElement>(`.amx-el-conn[data-el="${CSS.escape(`t:${anchor}`)}"]`)
      if (line) {
        const animation = line.animate([
          { opacity: 0, offset: 0 },
          { opacity: 0, offset: 0.56 },
          { opacity: 1, offset: 1, easing: 'ease-out' },
        ], { duration, fill: 'backwards' })
        animation.id = 'amx-card-attach-line'
        remember(animation)
      }
    })
  }, [stopArrangeMotion])
  useEffect(() => stopArrangeMotion, [stopArrangeMotion])
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
  const cbRef = useRef({ getView, onCommit, onElements, onTree, onMain, timeline, elements, tree, main, mainStored, saveFile, parseMd, onBlocksDeleted })
  cbRef.current = { getView, onCommit, onElements, onTree, onMain, timeline, elements, tree, main, mainStored, saveFile, parseMd, onBlocksDeleted }
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
    stopFocusMotion()
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
  }, [getView, stopFocusMotion])

  /** 以舞台中心为锚的定倍缩放(HUD 的 −/+)。 */
  const zoomBy = useCallback((factor: number) => {
    stopFocusMotion()
    const host = hostRef.current
    if (!host) return
    const { x, y, z } = vpRef.current
    const nz = Math.max(MIN_Z, Math.min(MAX_Z, z * factor))
    if (nz === z) return
    const u = zoomOf(host) || 1
    const cx = host.getBoundingClientRect().width / u / 2
    const cy = host.getBoundingClientRect().height / u / 2
    setVp({ z: nz, x: cx - ((cx - x) * nz) / z, y: cy - ((cy - y) * nz) / z })
  }, [stopFocusMotion])

  /** 缩略图导航：保持当前缩放，只把点中的舞台坐标移到视口中心。 */
  const centerFromMiniMap = useCallback((worldX: number, worldY: number): void => {
    stopFocusMotion()
    const host = hostRef.current
    if (!host) return
    const u = zoomOf(host) || 1
    const r = host.getBoundingClientRect()
    const z = vpRef.current.z
    setVp({ z, x: r.width / u / 2 - worldX * z, y: r.height / u / 2 - worldY * z })
  }, [stopFocusMotion])

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
  const addCardAt = useCallback((x: number, y: number, under?: string, text?: string, content?: Fragment): string | null => {
    const view = cbRef.current.getView()
    const card = view?.state.schema.nodes.amadeusCanvasCard
    const paragraph = view?.state.schema.nodes.paragraph
    if (!view || !card || !paragraph) return null
    const anchor = freshAnchorId(view.state.doc)
    // 新卡也走与拖拽同源的“最近无碰撞位置”。过去工具点击/双击/回车只照搬调用点，右侧已经
    // 塞满时仍会把卡叠上去；先用空卡的保守高度占位，真实高度在挂载后还会由编辑避让继续兜底。
    const seed: ElBox = { x, y, w: CARD_W, h: 80 }
    const obstacles = [...boxesNow(null).values()]
    const push = resolveCardRepulsion([seed], obstacles)
    const px = x + push.x
    const py = y + push.y
    const body = content?.childCount ? content : paragraph.create(null, text ? view.state.schema.text(text) : undefined)
    const made = card.createAndFill({ anchor, x: Math.round(px), y: Math.round(py), w: CARD_W, h: 0 }, body)
    if (!made) return null
    const at = under ? tailPosUnder(view.state.doc, rawTree(cbRef.current.tree), under) : view.state.doc.content.size
    commitGeo(view, view.state.tr.insert(at, made))
    cbRef.current.onCommit(anchor) // ⚠️ 必须报锚:不进归属集合的话派生会把这张卡当「代表不了全貌」
    setSel([cardKey(anchor)])
    return anchor
  }, [boxesNow])

  /** 拖进舞台空白的 OS 文件 → **每个文件一张独立卡片**,内容是对该附件的引用(用户拍板 2026-08-20)。
   *  先建卡带「上传中」占位(大文件/云端库时立刻看得见东西落下了),存好再把占位换成 `![[base]]`;
   *  存失败就把那张卡撤掉,不留一张假卡。多个文件按 24px 错开,免得叠成一摞。 */
  const dropFilesAt = useCallback((files: File[], at: { x: number; y: number }): void => {
    const save = cbRef.current.saveFile
    if (!save) return
    files.forEach((f, i) => {
      const name = f.name || `文件${i + 1}`
      const hold = `上传中 ${name}`
      const anchor = actRef.current.addCardAt(at.x - CARD_W / 2 + i * 24, at.y - 24 + i * 24, undefined, hold)
      if (!anchor) return
      void save(f).then((md) => {
        // ⚠️ 三道守卫(Codex 评审 high):实例还在(切页/关标签后 getView 恒 null)、卡还在、
        //    卡里还是那份占位。少一道就是「异步回调覆盖用户这期间打的字」或「复活已删的卡」。
        //    天花板:实例已经不在时,盘上那张卡停在「上传中 …」—— 与正文上传占位同一条
        //    (UnifiedPage.saveFiles 的 replaceMark 找不到实例时同样只能作罢)。
        const view = cbRef.current.getView()
        // 认卡:先按锚,再按**占位文本**兜底 —— 上传在途时用户剪切/复制这张卡,粘出来的是新锚
        //   (锚必须现开,重复锚整笔被拒),只认锚的话回调找不到人、那张卡永远停在「上传中 …」
        //   而文件其实已经落盘(Codex 评审 high)。按占位文本认同样受乐观锁保护:只替换「一个字
        //   都没被动过」的占位卡。
        // ponytail: 上传在途时把卡删掉(不粘回来)仍会留一个无人引用的附件 —— 与「实例已经不在」
        //   同一条天花板,要收就得给上传任务建台账并接删除路径,现在不值当。
        const card = view
          ? (cardsOf(view).find((c) => c.anchor === anchor && c.node.textContent === hold)
            ?? cardsOf(view).find((c) => c.node.textContent === hold))
          : null
        if (!view || !card) return
        // ⚠️ 往下一律用 `card.anchor` 而不是建卡时那个 `anchor`:兜底认到的可能是剪切粘贴后的新锚,
        //    写回旧锚 = 什么都没发生(或删掉一张不相干的卡)。
        if (md) {
          setCardText(view, card.anchor, md, hold)
          cbRef.current.onCommit()
        } else {
          actRef.current.removeSel([cardKey(card.anchor)]) // 存失败:占位撤掉,不留一张假卡(removeSel 自带 onCommit)
        }
      })
    })
  }, [])

  /** 外部文字(粘贴 / 从别的 app 拖进来 / 侧栏笔记引用)→ 落点一张卡。
   *  能解析成 markdown 就按块结构落(标题、列表、`[[链接]]` 都是真节点),解析不到就一段纯文本。
   *  `i` = 同一批里的第几个,按 24px 错开,免得叠成一摞(与 dropFilesAt 同款)。 */
  const addCardMd = useCallback((md: string, at: { x: number; y: number }, i = 0): string | null => {
    const text = md.trim()
    if (!text) return null
    const frag = cbRef.current.parseMd?.(text) ?? null
    return actRef.current.addCardAt(at.x - CARD_W / 2 + i * 24, at.y - 24 + i * 24, undefined, text, unwrapCards(frag))
  }, [])

  /** 画布内部的卡片粘贴:整卡复现(格式、嵌入、层级里的位置关系都在),**锚一律现开**。
   *  相对位置保留 —— 一次复制多张,粘出来还是那个阵形(左上角对齐到落点)。 */
  const pasteCards = useCallback((nodes: ProseNode[], at: { x: number; y: number }): void => {
    const view = cbRef.current.getView()
    if (!view || !nodes.length) return
    const x0 = Math.min(...nodes.map((n) => Number(n.attrs.x) || 0))
    const y0 = Math.min(...nodes.map((n) => Number(n.attrs.y) || 0))
    let tr = view.state.tr
    const made: string[] = []
    for (const n of nodes) {
      // ⚠️ 逐张按**当前 tr.doc** 现算锚:一次粘多张时拿老 doc 连开会撞锚,重复锚整笔被
      //    filterTransaction 拒(C51),表现是「粘贴什么都没发生」。
      const anchor = freshAnchorId(tr.doc)
      const copy = n.type.create({
        ...n.attrs,
        anchor,
        x: Math.round(at.x + (Number(n.attrs.x) || 0) - x0),
        y: Math.round(at.y + (Number(n.attrs.y) || 0) - y0),
      }, n.content)
      tr = tr.insert(tr.doc.content.size, copy)
      made.push(anchor)
    }
    commitGeo(view, tr)
    made.forEach((a) => cbRef.current.onCommit(a)) // 归属集合逐张登记,与 addCardAt 同款
    setSel(made.map(cardKey))
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

  /** 键盘/侧边 ⊕ 的自动槽位：左右两侧都试，选负载更小且离无碰撞位置最近的一边。
   *  拖拽认亲仍尊重用户明确指向的边，只有“没有指定方向”的创建动作走这里。 */
  const autoSlotFor = useCallback((selfNode: string, rel: 'child' | 'sibling', w: number, h = 80): { parent: string; x: number; y: number } | null => {
    const me = nodeBox(selfNode)
    if (!me) return null
    const treeNow = rawTree(cbRef.current.tree)
    const own = treeNow[selfNode]
    const parent = rel === 'child' ? selfNode : (typeof own === 'string' && own ? own : '')
    const basis = rel === 'child' ? me : (parent ? nodeBox(parent) : me)
    if (!basis) return null
    const view = cbRef.current.getView()
    const allNodes = view ? cardsOf(view).map((c) => c.anchor) : []
    const peers = parent
      ? childrenOf(treeNow, parent)
      : rel === 'child'
        ? childrenOf(treeNow, selfNode)
        : allNodes.filter((a) => typeof treeNow[a] !== 'string' || !treeNow[a])
    const peerBoxes = peers.map((a) => nodeBox(a)).filter(Boolean) as ElBox[]
    const center = basis.x + basis.w / 2
    const obstacles = [...boxesNow(null).values()]
    const GAP_X = 80
    const GAP_Y = 32
    let best: { x: number; y: number; score: number } | null = null
    for (const dir of [1, -1] as const) {
      const side = peerBoxes.filter((b) => (b.x + b.w / 2 - center) * dir > 0)
      const x = dir > 0 ? basis.x + basis.w + GAP_X : basis.x - GAP_X - w
      const y = side.length ? Math.max(...side.map((b) => b.y + b.h)) + GAP_Y : basis.y
      const seed: ElBox = { x, y, w, h }
      const push = resolveCardRepulsion([seed], obstacles, { x: dir, y: 0 })
      // 同样空时略偏右；一侧越拥挤，越早把下一支分到另一侧。实际碰撞位移是主项。
      const score = Math.hypot(push.x, push.y) * 100 + side.length * 32 + (dir < 0 ? 6 : 0)
      if (!best || score < best.score) best = { x: x + push.x, y: y + push.y, score }
    }
    return best ? { parent, x: Math.round(best.x), y: Math.round(best.y) } : null
  }, [boxesNow, nodeBox])

  /** Tab = 加子节点,回车 = 加兄弟节点(用户 2026-08-18 拍板,mindmap 惯例)。
   *  `selfNode` 是**层级键**:卡片 = 锚,主卡 = `MAIN_KEY`(2026-08-19 用户实报「正文卡片不支持」——
   *  主卡自 08-18 起完全等同卡片,长子节点也不该例外;哨兵为什么撞不上真锚见 canvasEdit 那一节)。
   *  摆位是**启发式**且只作用于新卡:既有节点的 x/y 归用户所有,绝不重排(AFFiNE 也不重排)。
   *  建卡走 PM、层级走 fm,两笔在时间线上并成 'pair' —— 一次 Cmd+Z 卡与层级一起退
   *  (2026-08-18 统一时间线收口;此前要按两次,评审 P0-1 点名的就是这个)。 */
  const addRelated = useCallback((selfNode: string, rel: 'child' | 'sibling'): void => {
    const slot = autoSlotFor(selfNode, rel, CARD_W)
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
  }, [autoSlotFor, addCardAt, mutTree, mergePair])
  /** 拖到边缘认亲(2026-08-19 晚,用户拍板;思维导图同款 drop-to-attach):把一张**已有**卡拖到
   *  另一张卡/主卡的边缘 → 左右缘 = 当它的子节点,上下缘 = 与它同父(兄弟)。
   *  ⚠️ 环形目标必须先排掉:setParent 遇环只是「拒绝写入」静默返回,那样卡会被吸附摆位却没有关系,
   *     用户看到的是「吸过去了但线没出来」。这里连高亮都不给,手势期就说清楚。 */
  const attachHit = useCallback((source: string | readonly string[], at: { x: number; y: number }): AttachPreview | null => {
    const sources = [...new Set(typeof source === 'string' ? [source] : source)]
    const self = sources[0]
    if (!self) return null
    const sourceSet = new Set(sources)
    // ⚠️ 判据是**指针**落在目标卡的边缘带,不是「两个盒子离得近」。按盒距离判的第一版被 C32/C34
    //    当场抓住:把卡停在另一张卡下方 23px(纯粹是挪个位置)就被静默收成了兄弟并吸走 ——
    //    盒子挨得近是常态,指针指过去才是意图。想认亲就把指针推到那张卡的边上,边会亮起来。
    // 外侧感应带比旧版 24px 放宽到 40px；内侧仍保留大片中立区。拖到“附近”就能看见意图预告，
    // 但指针停在卡心时绝不静默认亲。
    const BAND = 40
    // 指针离某条边多近才算「在边缘上」—— 用户的原话就是「在另一个卡片**边缘**的时候」。
    //   ⚠️ 必须**按盒尺寸取比例**(每边最多吃 30%),不能只用固定 28px:一行字的卡才 58px 高,
    //   28+28 直接把它整片吃光,所谓「卡心中立区」只剩 2px —— 从卡上横着拖过去就被静默收编
    //   (Codex 08-19 深夜 medium;我自己在文档里写了中立区,代码里却没有)。
    const strip = (len: number): number => Math.min(38, Math.max(18, len * 0.32))
    const cur = rawTree(cbRef.current.tree)
    const descends = (node: string): boolean => { // node 是不是任一来源的后代(含来源本身)
      let p: unknown = node
      const seen = new Set<string>()
      while (typeof p === 'string' && p && !seen.has(p)) {
        if (sourceSet.has(p)) return true
        seen.add(p)
        p = cur[p]
      }
      return false
    }
    // ⚠️ 拖拽期的几何来自 measureCards(offset* 反映 dragCss 的过程位置),不是 dataset ——
    //    读 dataset 会让感应带整场拖拽都按**起点**判定(方案 §5「过程只动 CSS」的同一条坑)。
    const boxes = measureCards(hostRef.current)
    const targets: Array<[string, ElBox]> = [...boxes].filter(([a]) => !sourceSet.has(a) && !descends(a))
    const mb = measureMain(hostRef.current)
    if (mb) targets.push([MAIN_KEY, mb])
    let best: { node: string; side: 'e' | 'w' | 'n' | 's'; rel: 'child' | 'sibling'; score: number } | null = null
    for (const [node, t] of targets) {
      if (at.x < t.x - BAND || at.x > t.x + t.w + BAND || at.y < t.y - BAND || at.y > t.y + t.h + BAND) continue
      // 指针离哪条边的**归一化距离**最近就是哪条边。旧版直接比像素，在很扁/很长的卡上角区
      // 会偏向短边；归一化后四个连接口的有效深度一致。
      const sx = strip(t.w)
      const sy = strip(t.h)
      const cand: Array<['e' | 'w' | 'n' | 's', number, number, boolean]> = [
        ['e', Math.abs(t.x + t.w - at.x), at.x > t.x + t.w ? BAND : sx, at.y >= t.y - 12 && at.y <= t.y + t.h + 12],
        ['w', Math.abs(at.x - t.x), at.x < t.x ? BAND : sx, at.y >= t.y - 12 && at.y <= t.y + t.h + 12],
        ['s', Math.abs(t.y + t.h - at.y), at.y > t.y + t.h ? BAND : sy, at.x >= t.x - 12 && at.x <= t.x + t.w + 12],
        ['n', Math.abs(at.y - t.y), at.y < t.y ? BAND : sy, at.x >= t.x - 12 && at.x <= t.x + t.w + 12],
      ]
      for (const [side, d, band, inAxis] of cand) {
        if (!inAxis || d > band) continue
        const score = d / Math.max(1, band)
        if (!best || score < best.score) best = { node, side, rel: side === 'e' || side === 'w' ? 'child' : 'sibling', score }
      }
    }
    return best ? { source: self, count: sources.length, node: best.node, side: best.side, rel: best.rel } : null
  }, [])

  /** 认亲落笔:位置吸附进队列(PM 一笔)+ 层级(fm 一笔),并成 'pair' 一击撤销。
   *  ⚠️ 兄弟且目标是顶层节点 = 自己也成顶层 → **主动摘掉旧爹**(否则卡排进了别人的队列、关系却还
   *  挂在原处,线与位置对不上)。这条同时也是唯一一个「拖拽即可解除关系」的口子。 */
  const applyAttach = useCallback((source: string | readonly string[], hit: { node: string; side: 'e' | 'w' | 'n' | 's'; rel: 'child' | 'sibling' }): boolean => {
    const view = cbRef.current.getView()
    const sources = [...new Set(typeof source === 'string' ? [source] : source)]
    const sourceSet = new Set(sources)
    const boxes = measureCards(hostRef.current)
    const primary = sources[0]
    const box = primary ? boxes.get(primary) : null
    if (!view || !box || !primary) return false
    const slot = slotFor(hit.node, hit.rel, hit.side, box.w, box.h)
    if (!slot) return false
    const cur = rawTree(cbRef.current.tree)
    // 已选子树只挂它的根；否则父子一起选中时把两张都改成目标的直属孩子，会把原结构拍扁。
    const roots = sources.filter((a) => !(typeof cur[a] === 'string' && sourceSet.has(cur[a] as string)))
    if (!roots.length || roots.includes(slot.parent)) return false
    // 认爹之后的表先算一份**只给排序用**:几何与源码顺序要合成同一笔 PM 事务(一次 Cmd+Z 全退),
    // 而「谁是谁的后代」必须按新关系算。落盘那笔仍在下面照旧现读现写(不拿这份陈的去覆盖)。
    let relinked = rawTree(cur)
    for (const rootNode of roots) {
      delete relinked[rootNode]
      if (slot.parent) {
        const linked = setParent(relinked, rootNode, slot.parent)
        if (linked === relinked) return false
        relinked = linked
      }
    }
    const moving = sources.flatMap((a) => {
      const b = boxes.get(a)
      return b ? [{ anchor: a, box: b }] : []
    })
    if (!moving.length) return false
    const baseDx = slot.x - box.x
    const baseDy = slot.y - box.y
    const movingBoxes = moving.map(({ box: b }) => ({ ...b, x: b.x + baseDx, y: b.y + baseDy }))
    const obstacles: ElBox[] = [...boxes].filter(([a]) => !sourceSet.has(a)).map(([, b]) => b)
    const mainBox = measureMain(hostRef.current)
    if (mainBox) obstacles.push(mainBox)
    for (const b of shapeBoxes(safeElements(cbRef.current.elements), null).values()) obstacles.push(b)
    const push = resolveCardRepulsion(movingBoxes, obstacles, { x: baseDx, y: baseDy })
    const dx = baseDx + push.x
    const dy = baseDy + push.y
    let tr = view.state.tr
    for (const c of cardsOf(view)) {
      const measured = boxes.get(c.anchor)
      if (sourceSet.has(c.anchor) && measured) {
        tr = tr.setNodeMarkup(c.pos, undefined, { ...c.node.attrs, x: Math.round(measured.x + dx), y: Math.round(measured.y + dy) })
      }
    }
    // 认爹搬到父段之后;摘爹搬到文末(**也得搬** —— 留在原地会把老父亲那一段劈成两半,
    // 后面还认着它的兄弟从此掉在父段之外,见 orderUnder 的告警)。
    const changedRoots = roots.filter((a) => (typeof cur[a] === 'string' ? cur[a] as string : '') !== slot.parent)
    for (const rootNode of changedRoots) {
      tr = orderUnder(tr, relinked, rootNode, slot.parent)
    }
    commitGeo(view, tr)
    cbRef.current.onCommit()
    if (changedRoots.length) {
      const wrote = mutTree((t) => {
        let out = rawTree(t)
        for (const rootNode of roots) {
          delete out[rootNode]
          if (slot.parent) out = setParent(out, rootNode, slot.parent)
        }
        return out
      })
      if (wrote) mergePair()
    }
    if (sources.length === 1) playAttachMotion(primary, { x: dx, y: dy })
    else playArrangeMotion(moving.map(({ anchor }) => ({ anchor, x: dx, y: dy, depth: roots.includes(anchor) ? 1 : 2 })))
    setSel(sources.map(cardKey))
    return true
  }, [slotFor, mutTree, mergePair, playArrangeMotion, playAttachMotion])

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
  const removeSel = useCallback((keys: string[], opts?: { assets?: boolean }): void => {
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
      // 删掉的卡里若有文件引用块,与块菜单删块同一条询问路径(拖进来的文件就是这样成卡的)。
      // ⚠️ 剪切走 `assets:false` —— 搬家不是删除,问了之后点「删」会把粘出来那张卡的文件删掉
      //    (与跨块剪切同一条纪律,2026-08-20)。
      if (opts?.assets !== false) cbRef.current.onBlocksDeleted?.(Fragment.from(hits.map((c) => c.node).reverse()))
      cbRef.current.onCommit()
      // 层级剪枝不在这里做:唯一入口在 deriveCanvasJson(cards 权威)。文档模式下用块菜单
      // 删卡/收回文档根本不经过这条路,逐个入口挂剪枝必漏(Codex 评审 P1)。检查点只负责
      // 把「剪之前」存档,与这笔 PM 合成 pair —— 撤销时层级跟卡一起回来(Codex 评审 F1)。
      if (ckpt) mergePair()
    }
    setSel([])
  }, [writeFm, pushFmCheckpoint, treeTouches, mergePair])

  /** 选中卡按空格进入正文编辑；双击额外带上 `hit`，光标落到点击处。
   *  单击仍只负责选中/拖动，不与双击抢手势。 */
  const enterNodeEdit = useCallback((key: string, hit?: { x: number; y: number }): void => {
    const view = cbRef.current.getView()
    if (!view || (key !== MAIN_KEY && !key.startsWith('c:'))) return
    let at: number | null = null
    let inNode: ((pos: number) => boolean) | null = null
    if (key === MAIN_KEY) {
      view.state.doc.forEach((node, offset) => {
        if (at == null && node.type.name !== 'amadeusCanvasCard') at = Math.min(view.state.doc.content.size, offset + node.nodeSize - 1)
      })
      // 主卡 = 正文，其判据是「不在任何卡片里」(卡片的 DOM 就住在 PM 根之内，与 onDown 的 stillIn 同源)。
      inNode = (pos) => {
        const $p = view.state.doc.resolve(pos)
        for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'amadeusCanvasCard') return false
        return true
      }
    } else {
      const card = cardsOf(view).find((c) => c.anchor === keyId(key))
      if (card) {
        at = Math.min(view.state.doc.content.size, card.pos + card.node.nodeSize - 1)
        inNode = (pos) => pos > card.pos && pos < card.pos + card.node.nodeSize
      }
    }
    if (at == null) return
    // 双击进编辑：光标自己送到点击处 —— pointerdown 已 preventDefault，PM 收不到 mousedown，
    // 不补这一下就是「进了编辑态但光标不知道在哪」(与 2.8.0 两段式同一条纪律)。
    // ⚠️ posAtCoords 可能落到别的卡/舞台空白上，越界一律退回节点尾部。
    if (hit) {
      const p = view.posAtCoords({ left: hit.x, top: hit.y })
      if (p && inNode?.(p.pos)) at = p.pos
    }
    // 空格进编辑后把光标落在节点尾部：用户可直接续写；落在开头会让 Backspace 看似失效。
    try { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at), -1))) } catch { /* 只聚焦 */ }
    setEditing(key === MAIN_KEY ? MAIN_KEY : keyId(key))
    view.focus()
  }, [])

  /** 双击卡片聚焦：卡片中心对齐舞台中心，并把它放到适合阅读的比例。视口仍是会话态，不写盘。
   *  逐帧推进 pan/zoom，点阵、缩略图视口和内容保持同源；末段约 1.5% 回弹，不靠常驻 CSS transition。
   *  `keepEdit` = 调用方已经把这张卡送进编辑态(双击同时触发聚焦与编辑)，此处只搬视口，
   *  不得清 editing、不得把焦点从 PM 抢回舞台 —— 否则刚落好的光标当场消失。 */
  const focusNode = useCallback((key: string, keepEdit = false): void => {
    const host = hostRef.current
    if (!host) return
    const box = key === MAIN_KEY ? measureMain(host) : key.startsWith('c:') ? measureCards(host).get(keyId(key)) ?? null : null
    if (!box) return
    const u = zoomOf(host) || 1
    const hr = host.getBoundingClientRect()
    const vw = hr.width / u
    const vh = hr.height / u
    // 目标占视口约 62% 宽 / 72% 高；短卡最多放到 1.5×，长文卡则自动退到能完整阅读的比例。
    const z = Math.max(MIN_Z, Math.min(1.5, MAX_Z, (vw * 0.62) / Math.max(1, box.w), (vh * 0.72) / Math.max(1, box.h)))
    const target = { z, x: vw / 2 - (box.x + box.w / 2) * z, y: vh / 2 - (box.y + box.h / 2) * z }
    const start = { ...vpRef.current }
    stopFocusMotion()
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      vpRef.current = target
      setVp(target)
    } else {
      const distance = Math.hypot(target.x - start.x, target.y - start.y)
      const duration = Math.round(Math.max(460, Math.min(560, 420 + distance * 0.12 + Math.abs(target.z - start.z) * 120)))
      const began = performance.now()
      setFocusMotion(true)
      const tick = (now: number): void => {
        const t = Math.min(1, (now - began) / duration)
        // 二阶欠阻尼阶跃：起止速度都柔和，约在中后段越过终点 1.5%，随后自然收束。
        const k = t >= 1 ? 1 : 1 - Math.exp(-8 * t) * (Math.cos(6 * t) + (8 / 6) * Math.sin(6 * t))
        const next = {
          x: start.x + (target.x - start.x) * k,
          y: start.y + (target.y - start.y) * k,
          z: start.z + (target.z - start.z) * k,
        }
        vpRef.current = next
        setVp(next)
        if (t < 1) focusRaf.current = requestAnimationFrame(tick)
        else {
          focusRaf.current = 0
          setFocusMotion(false)
        }
      }
      focusRaf.current = requestAnimationFrame(tick)
    }
    if (keepEdit) return
    setEditing(null)
    setSel([key])
    host.focus({ preventScroll: true })
  }, [stopFocusMotion])

  /** 以 root 为不动锚，把全部后代排成思维导图。根的各支可以独立分到左右两侧；再沿纵轴找
   *  最近的无碰撞位置，避让其它卡片、主卡、形状与 Frame。全部坐标合成一笔 PM 事务。 */
  const arrangeChildren = useCallback((root: string): boolean => {
    const host = hostRef.current
    const view = cbRef.current.getView()
    if (!host || !view) return false
    const raw = rawTree(cbRef.current.tree)
    const cardBoxes = measureCards(host)
    const alive = new Set(cardBoxes.keys())
    const direct = (node: string): string[] => childrenOf(raw, node)
      .filter((a) => alive.has(a))
      .sort((a, b) => (cardBoxes.get(a)?.y ?? 0) - (cardBoxes.get(b)?.y ?? 0))
    const descendants: string[] = []
    const depths = new Map<string, number>()
    const seen = new Set<string>([root])
    const walk = (node: string, depth: number): void => {
      for (const child of direct(node)) {
        if (seen.has(child)) continue
        seen.add(child)
        descendants.push(child)
        depths.set(child, depth + 1)
        walk(child, depth + 1)
      }
    }
    walk(root, 0)
    if (!descendants.length) return false
    const rootBox = root === MAIN_KEY ? measureMain(host) : cardBoxes.get(root)
    if (!rootBox) return false

    const GAP_X = 96
    const GAP_Y = 32
    const spanMemo = new Map<string, number>()
    const spanOf = (node: string): number => {
      const own = node === root ? rootBox : cardBoxes.get(node)
      if (!own) return 0
      const kids = direct(node).filter((a) => a !== root && seen.has(a))
      const childrenSpan = kids.reduce((n, a) => n + spanOf(a), 0) + Math.max(0, kids.length - 1) * GAP_Y
      const span = Math.max(own.h, childrenSpan)
      spanMemo.set(node, span)
      return span
    }
    spanOf(root)

    const roots = direct(root).filter((a) => a !== root && seen.has(a))
    const makePlan = (rootDirs: Map<string, 1 | -1>): Map<string, ElBox> => {
      const plan = new Map<string, ElBox>()
      const place = (node: string, parent: ElBox, dir: 1 | -1): void => {
        const kids = direct(node).filter((a) => a !== root && seen.has(a))
        if (!kids.length) return
        const total = kids.reduce((n, a) => n + (spanMemo.get(a) ?? spanOf(a)), 0) + (kids.length - 1) * GAP_Y
        let y = parent.y + parent.h / 2 - total / 2
        for (const child of kids) {
          const old = cardBoxes.get(child)
          if (!old) continue
          const span = spanMemo.get(child) ?? old.h
          const box = {
            x: dir > 0 ? parent.x + parent.w + GAP_X : parent.x - GAP_X - old.w,
            y: y + (span - old.h) / 2,
            w: old.w,
            h: old.h,
          }
          plan.set(child, box)
          place(child, box, dir)
          y += span + GAP_Y
        }
      }
      for (const dir of [1, -1] as const) {
        const sideRoots = roots.filter((a) => rootDirs.get(a) === dir)
        const total = sideRoots.reduce((n, a) => n + (spanMemo.get(a) ?? spanOf(a)), 0) + Math.max(0, sideRoots.length - 1) * GAP_Y
        let y = rootBox.y + rootBox.h / 2 - total / 2
        for (const child of sideRoots) {
          const old = cardBoxes.get(child)
          if (!old) continue
          const span = spanMemo.get(child) ?? old.h
          const box = {
            x: dir > 0 ? rootBox.x + rootBox.w + GAP_X : rootBox.x - GAP_X - old.w,
            y: y + (span - old.h) / 2,
            w: old.w,
            h: old.h,
          }
          plan.set(child, box)
          place(child, box, dir)
          y += span + GAP_Y
        }
      }
      return plan
    }

    // 常见思维导图的一级分支很少，可穷举左右分配拿到真正最优；极端大树只保留几种有意义的
    // 候选，避免 2^N。旧位置所在侧也作为候选，整理不会无缘无故把已经合理的一支翻面。
    const assignments: Array<Map<string, 1 | -1>> = []
    const signatures = new Set<string>()
    const addAssignment = (dirs: Array<1 | -1>): void => {
      const sig = dirs.join(',')
      if (signatures.has(sig)) return
      signatures.add(sig)
      assignments.push(new Map(roots.map((a, i) => [a, dirs[i]])))
    }
    if (roots.length <= 9) {
      for (let mask = 0; mask < 2 ** roots.length; mask++) {
        addAssignment(roots.map((_, i) => (mask & (1 << i)) ? -1 : 1))
      }
    } else {
      addAssignment(roots.map((_, i) => i % 2 ? -1 : 1))
      addAssignment(roots.map((_, i) => i < Math.ceil(roots.length / 2) ? 1 : -1))
      addAssignment(roots.map(() => 1))
      addAssignment(roots.map(() => -1))
    }
    addAssignment(roots.map((a) => ((cardBoxes.get(a)?.x ?? rootBox.x) < rootBox.x ? -1 : 1)))

    const all = boxesNow(null)
    const movingKeys = new Set(descendants.map(cardKey))
    const obstacles = [...all].filter(([key]) => !movingKeys.has(key)).map(([, box]) => growBox(box, 24))
    let best: { plan: Map<string, ElBox>; score: number } | null = null
    for (const dirs of assignments) {
      const leftRoots = roots.filter((a) => dirs.get(a) === -1).length
      // 两支以上时一键整理必须真正使用主节点两侧。只靠“负载均衡”软评分仍可能在一侧有障碍时
      // 把全部分支纵向挪到另一侧，视觉上依旧是一条挤满的单边队列；纵向避障已经保证双侧方案
      // 总能找到安全落点，因此这里把双侧分布提升为明确约束。
      if (roots.length > 1 && (leftRoots === 0 || leftRoots === roots.length)) continue
      const base = makePlan(dirs)
      const planBoxes = [...base.values()]
      const minY = Math.min(...planBoxes.map((b) => b.y))
      const maxY = Math.max(...planBoxes.map((b) => b.y + b.h))
      // 先找近处的 72px 网格；再加入“整棵树刚好越过每个障碍物上下沿”的候选。后者保证即使
      // 遇到超大 Frame / 密集内容（远超固定 20 步）也总能找到真正零碰撞的纵向落点。
      const shifts = new Set<number>([0])
      for (let n = 1; n <= 20; n++) { shifts.add(n * 72); shifts.add(-n * 72) }
      for (const obstacle of obstacles) {
        shifts.add(Math.ceil(obstacle.y + obstacle.h + 12 - minY))
        shifts.add(Math.floor(obstacle.y - 12 - maxY))
      }
      if (obstacles.length) {
        shifts.add(Math.ceil(Math.max(...obstacles.map((b) => b.y + b.h)) + 12 - minY))
        shifts.add(Math.floor(Math.min(...obstacles.map((b) => b.y)) - 12 - maxY))
      }
      for (const dy of [...shifts].sort((a, b) => Math.abs(a) - Math.abs(b))) {
        const plan = new Map([...base].map(([a, b]) => [a, { ...b, y: b.y + dy }]))
        let collisions = 0
        for (const box of plan.values()) for (const obstacle of obstacles) if (overlaps(growBox(box, 12), obstacle)) collisions++
        const load = (dir: 1 | -1): number => {
          const spans = roots.filter((a) => dirs.get(a) === dir).map((a) => spanMemo.get(a) ?? 0)
          return spans.reduce((n, v) => n + v, 0) + Math.max(0, spans.length - 1) * GAP_Y
        }
        const rightLoad = load(1)
        const leftLoad = load(-1)
        const movement = [...plan].reduce((n, [a, b]) => {
          const old = cardBoxes.get(a)
          return n + (old ? Math.hypot(b.x - old.x, b.y - old.y) : 0)
        }, 0)
        const score = collisions * 1_000_000
          + Math.abs(dy)
          + Math.max(rightLoad, leftLoad) * 0.18
          + Math.abs(rightLoad - leftLoad) * 0.04
          + movement * 0.002
          + leftRoots * 2
        if (!best || score < best.score) best = { plan, score }
      }
    }
    if (!best) return false
    const finalPlan = new Map([...best.plan].map(([a, b]) => [a, { x: Math.round(b.x), y: Math.round(b.y) }]))
    const motions = [...finalPlan].flatMap(([anchor, box]) => {
      const old = cardBoxes.get(anchor)
      return old ? [{ anchor, x: box.x - old.x, y: box.y - old.y, depth: depths.get(anchor) ?? 1 }] : []
    })
    setCardAttrs(view, finalPlan)
    playArrangeMotion(motions)
    cbRef.current.onCommit()
    // 菜单按钮随 OverlayPortal 卸载后焦点会掉到 body；把焦点交还舞台，紧接着的 Cmd+Z/Delete
    // 才继续走统一画布键盘与撤销时间线。
    host.focus({ preventScroll: true })
    return true
  }, [boxesNow, playArrangeMotion])

  /** 进画布就把焦点收到舞台。剪贴板/键盘事件只发给**焦点元素**,而切模式那一下焦点还留在模式
   *  胶囊的 `<button>` 上(实测 activeElement=BUTTON.on)—— 不收的话进画布后第一次 Cmd+V
   *  石沉大海。焦点已经在舞台内部(比如正在卡里打字)就不抢。 */
  useEffect(() => {
    const host = hostRef.current
    if (!active || !host || (document.activeElement && host.contains(document.activeElement))) return
    host.focus({ preventScroll: true })
  }, [active])

  // ── 手势 ────────────────────────────────────────────────────────────────────
  // 同样**只依赖 active**(理由见上面 fitRef 的注释)。这里的代价更重:宿主每渲染一次就把整个
  // effect 拆了重装,进行中的那次拖拽(闭包里的 drag 局部量)当场归零 —— 松手时 onUp 拿到 null,
  // 卡片弹回原位、事务不落。回调一律经 ref 现读。
  const actRef = useRef({ mutate, writeFm, mergePair, pushFmCheckpoint, treeTouches, removeSel, editText, boxesNow, fit, zoomBy, addCardAt, addShapeAt, addFrame, addRelated, attachHit, applyAttach, setNodeParent, expandFrames, enterNodeEdit, focusNode, arrangeChildren, stopArrangeMotion, stopFocusMotion, dropFilesAt, addCardMd, pasteCards })
  actRef.current = { mutate, writeFm, mergePair, pushFmCheckpoint, treeTouches, removeSel, editText, boxesNow, fit, zoomBy, addCardAt, addShapeAt, addFrame, addRelated, attachHit, applyAttach, setNodeParent, expandFrames, enterNodeEdit, focusNode, arrangeChildren, stopArrangeMotion, stopFocusMotion, dropFilesAt, addCardMd, pasteCards }

  /** 编辑导致卡片换行/增高时，把相撞的其它卡推到最近空位；当前编辑卡是固定锚。自动布局不进
   *  用户撤销栈，否则打一行字会混进一笔“卡片自己跑开”的几何撤销。 */
  useEffect(() => {
    const host = hostRef.current
    if (!active || !host || typeof ResizeObserver === 'undefined') return
    const watched = new Set<HTMLElement>()
    const sizes = new WeakMap<HTMLElement, { w: number; h: number }>()
    let timer = 0
    let syncing = false
    const repel = (): void => {
      timer = 0
      if (syncing) return
      const fixedId = editingRef.current
      const view = cbRef.current.getView()
      if (!fixedId || !view) return
      const cardBoxes = measureCards(host)
      const fixed = fixedId === MAIN_KEY ? measureMain(host) : cardBoxes.get(fixedId)
      if (!fixed) return
      const moving = [...cardBoxes].filter(([a, b]) => a !== fixedId && overlaps(growBox(fixed, 18), b))
      if (!moving.length) return
      const mutable = new Map(cardBoxes)
      const patches = new Map<string, Record<string, number>>()
      const motions: Array<{ anchor: string; x: number; y: number; depth: number }> = []
      for (const [anchor, box] of moving) {
        const obstacles: ElBox[] = [...mutable].filter(([a]) => a !== anchor).map(([, b]) => b)
        const mainBox = measureMain(host)
        if (mainBox && fixedId !== MAIN_KEY) obstacles.push(mainBox)
        for (const b of shapeBoxes(safeElements(cbRef.current.elements), null).values()) obstacles.push(b)
        const intent = {
          x: box.x + box.w / 2 - (fixed.x + fixed.w / 2),
          y: box.y + box.h / 2 - (fixed.y + fixed.h / 2),
        }
        const push = resolveCardRepulsion([box], obstacles, intent)
        if (!push.x && !push.y) continue
        const next = { ...box, x: box.x + push.x, y: box.y + push.y }
        mutable.set(anchor, next)
        patches.set(anchor, { x: Math.round(next.x), y: Math.round(next.y) })
        motions.push({ anchor, x: push.x, y: push.y, depth: 1 })
      }
      if (!patches.size) return
      syncing = true
      setCardAttrs(view, patches, false)
      playArrangeMotion(motions)
      cbRef.current.onCommit()
      requestAnimationFrame(() => { syncing = false })
    }
    const schedule = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(repel, 90)
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const next = { w: el.offsetWidth, h: el.offsetHeight }
        const prev = sizes.get(el)
        sizes.set(el, next)
        if (prev && (prev.w !== next.w || prev.h !== next.h)) {
          const id = el.classList.contains('amx-ucard') ? el.dataset.anchor : MAIN_KEY
          if (id && id === editingRef.current) schedule()
        }
      }
    })
    const syncTargets = (): void => {
      const now = new Set<HTMLElement>(host.querySelectorAll('.amx-ucard'))
      const pm = host.querySelector<HTMLElement>('.ProseMirror')
      if (pm) now.add(pm)
      for (const el of now) if (!watched.has(el)) {
        watched.add(el)
        sizes.set(el, { w: el.offsetWidth, h: el.offsetHeight })
        ro.observe(el, { box: 'border-box' })
      }
      for (const el of [...watched]) if (!now.has(el)) {
        watched.delete(el)
        ro.unobserve(el)
      }
    }
    syncTargets()
    const mo = new MutationObserver(syncTargets)
    mo.observe(host, { subtree: true, childList: true })
    return () => {
      window.clearTimeout(timer)
      mo.disconnect()
      ro.disconnect()
    }
  }, [active, path, playArrangeMotion])

  /** 文档 → 画布的光标接力。等两帧是为了让 `.amx-canvas` 的绝对几何先真正落到 DOM；过早量盒
   * 会拿到文档流位置，随后把视口居中到完全错误的地方。正在编辑的卡自身位置与选区都不改。 */
  useEffect(() => {
    if (!active || revealSelection <= 0) return
    shouldFit.current = false
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const view = cbRef.current.getView()
        if (!view) return
        const { $from } = view.state.selection
        let key = MAIN_KEY
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d)
          if (node.type.name === 'amadeusCanvasCard') {
            key = cardKey(String(node.attrs.anchor))
            break
          }
        }
        setSel([key])
        setEditing(key === MAIN_KEY ? MAIN_KEY : keyId(key))
        actRef.current.focusNode(key, true)
        view.focus()
      })
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [active, revealSelection])
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
    // 松手排斥用一次性 WAAPI 弹簧，不给卡片常驻 transition —— 常驻会让逐帧 dragCss 追手变拖尾。
    let repelAnimations: Animation[] = []
    let repelRaf = 0
    /** 拖拽期几何规则。lift = 抬起观感(影子加深 + grabbing),与几何同一条规则免得两处拼。 */
    const setDragRule = (rules: Array<{ anchor: string; decl: string }>): void => {
      dragCss.textContent = rules
        .map((r) => `.amx-stage[data-amx-dragscope="${scope}"] .amx-ucard[data-anchor="${CSS.escape(r.anchor)}"]{${r.decl}}`)
        .join('\n')
    }
    const LIFT = 'cursor:grabbing;opacity:.94;box-shadow:0 12px 32px rgb(0 0 0 / 24%);'
    const clearDragRule = (): void => { dragCss.textContent = '' }
    const stopRepelMotion = (): void => {
      cancelAnimationFrame(repelRaf)
      repelRaf = 0
      for (const animation of repelAnimations) animation.cancel()
      repelAnimations = []
    }
    const playRepelMotion = (anchors: string[], main: boolean, push: { x: number; y: number }): void => {
      const distance = Math.hypot(push.x, push.y)
      if (distance < 1 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
      stopRepelMotion()
      // 距离只轻量影响时长：小位移不拖沓，大位移也不慢悠悠。6% 越界 + 1.5% 回摆提供
      // “释放惯性”，18px 空气层足以容纳这点弹性，不会视觉穿回障碍物。
      const duration = Math.round(Math.max(340, Math.min(480, 320 + distance * 0.55)))
      const frames: Keyframe[] = [
        {
          transform: `translate(${-push.x}px, ${-push.y}px) scale(1.012)`,
          opacity: 0.94,
          boxShadow: '0 12px 32px rgb(0 0 0 / 24%)',
          offset: 0,
          easing: 'cubic-bezier(0.16, 0.84, 0.24, 1)',
        },
        {
          transform: `translate(${push.x * 0.06}px, ${push.y * 0.06}px) scale(0.998)`,
          opacity: 1,
          boxShadow: '0 3px 12px rgb(0 0 0 / 14%)',
          offset: 0.72,
          easing: 'ease-out',
        },
        {
          transform: `translate(${-push.x * 0.015}px, ${-push.y * 0.015}px) scale(1.001)`,
          boxShadow: '0 2px 10px rgb(0 0 0 / 12%)',
          offset: 0.9,
          easing: 'ease-out',
        },
        { transform: 'translate(0, 0) scale(1)', opacity: 1, boxShadow: '0 2px 10px rgb(0 0 0 / 12%)', offset: 1 },
      ]
      // 等 React/PM 把最终坐标落到 DOM，再用反向 transform 从松手点开跑；rAF 发生在下一次绘制前，
      // 用户看不到“先闪到终点再回来”的中间帧。
      repelRaf = requestAnimationFrame(() => {
        repelRaf = 0
        const targets: HTMLElement[] = anchors
          .map((anchor) => host.querySelector<HTMLElement>(`.amx-ucard[data-anchor="${CSS.escape(anchor)}"]`))
          .filter((el): el is HTMLElement => !!el)
        if (main) {
          const pm = host.querySelector<HTMLElement>('.ProseMirror')
          if (pm) targets.push(pm)
        }
        for (const el of targets) {
          const animation = el.animate(frames, { duration, fill: 'none' })
          animation.id = 'amx-card-repel'
          repelAnimations.push(animation)
          const done = (): void => { repelAnimations = repelAnimations.filter((a) => a !== animation) }
          animation.addEventListener('finish', done, { once: true })
          animation.addEventListener('cancel', done, { once: true })
        }
      })
    }

    // Cmd+滚轮 / 触控板 pinch = 以指针为锚缩放；普通滚轮 = 平移(trackpad 双指同款)。
    const onWheel = (e: WheelEvent): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.amx-stage-minimap')) return
      actRef.current.stopFocusMotion()
      e.preventDefault()
      const { x, y, z } = vpRef.current
      const u = zoomOf(host) || 1 // 应用级 CSS zoom,见 toStage 的告警
      if (e.metaKey || e.ctrlKey) {
        // 浏览器没有独立的 pinch 事件类型：macOS/Chromium 用 ctrlKey 标记合成 wheel。
        // 不动 metaKey 分支，确保用户认为正合适的 Cmd+滚轮倍率仍是原来的 1×。
        const gain = e.ctrlKey && !e.metaKey ? TRACKPAD_PINCH_ZOOM_GAIN : 1
        const nz = Math.max(MIN_Z, Math.min(MAX_Z, z * Math.exp((-e.deltaY * gain) / 300)))
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
      | { kind: 'move'; cards: Array<{ anchor: string; ox: number; oy: number }>; ids: Set<string>; hit: string; x0: number; y0: number; dx: number; dy: number; mainStart: { x: number; y: number } | null; mainEl: HTMLElement | null; live?: boolean; additive?: boolean }
      | { kind: 'size'; id: string; corner: string; b0: ElBox; dx: number; dy: number; dw: number; dh: number; live?: boolean }
      | { kind: 'marquee'; x0: number; y0: number; additive: boolean; base: string[]; live?: boolean }
      | { kind: 'create'; tool: Tool; x0: number; y0: number; x1: number; y1: number; live?: boolean }
    let drag: Drag | null = null
    // 指针捕获拿不到就算了(合成事件、pointerId 已失效、外设拔掉都会抛)——**绝不能让它把
    // 后面的拖拽状态一起带走**:这一句抛出去的话,onDown 里它之后的语句全不执行。
    /** ⚠️ 起手这一笔**归谁**(Codex 2026-08-23 high)。修前 `onUp` 不问 pointerId:第一根手指正在
     *  拖卡、第二根落在工具条/HUD/缩略图上(那几支在登记触点**之前**就早退了,凑不成双指手势),
     *  第二根的 pointerup 冒泡到舞台就把第一根的拖拽**提前落笔** —— 而 width/mwidth/认亲那几支
     *  是拿 `e.clientX/Y` 现算的,落下去的宽度/父子关系是第二根手指的位置。
     *  记在 `capture()` 里 = 12 个 drag 起手的唯一必经点,不会漏。鼠标只有一个 pointerId,行为不变。 */
    let dragOwner = -1
    const capture = (id: number): void => { dragOwner = id; try { host.setPointerCapture(id) } catch { /* 无所谓 */ } }
    const release = (id: number): void => { try { if (host.hasPointerCapture(id)) host.releasePointerCapture(id) } catch { /* 同上 */ } }

    /** 舞台空白(不含卡片正文、不含形状、不含浮层 chrome)。 */
    const isBlank = (t: HTMLElement): boolean =>
      t === host || t.classList.contains('amx-stage-inner') || t.classList.contains('amx-el-layer')

    // ── 触屏手势(Excalidraw 同款模型)────────────────────────────────────────────────
    //  · 双指 = 平移 + 缩放一起(单指仍归当前工具,与 Excalidraw 一致:空白单指拖 = 框选)
    //  · 长按 500ms = 右键菜单(手机上没有右键;`touch-action:none` 之后系统也不再补 contextmenu)
    // ⚠️ 结构上的要害是**只有一个 `drag` 变量**:第二根手指落下会照常跑完整个 onDown、把
    //    第一根手指的 drag 顶掉,而 onMove 不认 pointerId —— 两根手指于是一起驱动同一笔拖拽。
    //    所以双指一成立就把在途的 drag 整笔作废(cancel 语义,不落笔),并在**全部手指抬起前**
    //    一概不进单指逻辑。编辑态不动:视口 transform 不惊动 PM,捏合时正在编辑的卡照常编辑。
    const touchPts = new Map<number, { x: number; y: number }>()
    let pinch: { d0: number; z0: number; sx: number; sy: number; ids: string } | null = null
    let pressTimer = 0
    let pressAt: { x: number; y: number } | null = null
    let slop = CLICK_SLOP

    /** 手势被别的东西接管:只回滚外观,**绝不落笔**(与 pointercancel 同一条,见 onCancel 顶注)。 */
    const abortDrag = (): void => {
      const d = drag
      drag = null
      if (d && d.kind !== 'pan') clearVisuals(d)
    }
    /** 两指的中心与间距,**已回到舞台窗口的局部坐标**。
     *  ⚠️ 必须先 ÷ `zoomOf`(应用级 CSS zoom —— 移动端 `body{zoom:1.15}` 就在这一级),再进舞台的 z:
     *  两级缩放,见 toStage 的告警。少这一级在桌面(zoom=1)测不出来,真机上捏合的锚点恒偏。 */
    const pinchAt = (): { x: number; y: number; d: number; ids: string } | null => {
      const [ia, ib] = [...touchPts.keys()]
      const a = touchPts.get(ia)
      const b = touchPts.get(ib)
      if (!a || !b) return null
      const u = zoomOf(host) || 1
      const r = host.getBoundingClientRect()
      return { x: ((a.x + b.x) / 2 - r.left) / u, y: ((a.y + b.y) / 2 - r.top) / u, d: Math.hypot(a.x - b.x, a.y - b.y) / u, ids: `${ia}/${ib}` }
    }
    /** 锚 = **手势开始时两指中心底下的那个舞台点**,整场手势里它始终跟着中心走 ——
     *  缩放与平移于是一次算完(增量式两段做法会随帧漂)。 */
    const beginPinch = (): void => {
      const c = pinchAt()
      if (!c) return
      const { x, y, z } = vpRef.current
      pinch = { d0: Math.max(1, c.d), z0: z, sx: (c.x - x) / z, sy: (c.y - y) / z, ids: c.ids }
    }
    const updatePinch = (): void => {
      const c = pinchAt()
      if (!c || !pinch) return
      // ⚠️ 触点对**换人就必须换基线**(Codex 2026-08-23):`pinchAt` 取的是 Map 里的前两点,而
      //    三指在场时抬起原来那两根中的一根,前两点会变成「剩下的那根 + 第三根」—— 基线还是旧
      //    那一对的中心与间距,下一帧就是一次没有手指位移对应的凭空平移/缩放。按当前视口重建
      //    (不是接着旧基线算)= 换手那一帧零跳变。
      if (c.ids !== pinch.ids) {
        beginPinch()
        return
      }
      const z = Math.max(MIN_Z, Math.min(MAX_Z, (pinch.z0 * c.d) / pinch.d0))
      setVp({ z, x: c.x - pinch.sx * z, y: c.y - pinch.sy * z })
    }
    const clearPress = (): void => {
      if (pressTimer) window.clearTimeout(pressTimer)
      pressTimer = 0
      pressAt = null
    }
    /** 长按 = 触屏的右键。移动超过 PRESS_SLOP / 第二根手指落下 / 手指抬起,三者任一都作废 ——
     *  不作废的话拖卡、框选途中会平地弹出菜单。命中判定与右键**逐字同源**(stageMenuAt)。 */
    const armPress = (e: PointerEvent): void => {
      const target = e.target as HTMLElement
      const { clientX, clientY } = e
      pressAt = { x: clientX, y: clientY }
      pressTimer = window.setTimeout(() => {
        pressTimer = 0
        pressAt = null
        if (stageMenuAt(target, clientX, clientY) === 'open') abortDrag()
      }, LONG_PRESS_MS)
    }

    const onDown = (e: PointerEvent): void => {
      setMenu(null)
      const target = e.target as HTMLElement
      if (target.closest('.amx-stage-tools, .amx-stage-hud, .amx-stage-minimap, .ctx-menu')) return // chrome 自己的按钮
      stopRepelMotion() // 动画途中再次抓取 = 立刻把控制权交还指针
      actRef.current.stopArrangeMotion()
      actRef.current.stopFocusMotion()
      if (e.pointerType === 'touch') {
        touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY })
        clearPress()
        if (touchPts.size >= 2) {
          e.preventDefault()
          abortDrag()
          beginPinch()
          return
        }
        armPress(e)
      }
      if (pinch) return // 手势期间新落的手指(三指以上)同样不进单指逻辑
      slop = e.pointerType === 'touch' ? TOUCH_SLOP / (vpRef.current.z * (zoomOf(host) || 1)) : CLICK_SLOP
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
      // ⚠️ 触屏下「一击建卡 / 一击建文本」必须推迟到**抬手**(Codex 2026-08-23 high)。
      //    这两支是全画布仅有的「pointerdown 当场落笔」——手指刚碰上就写进 PM/fm。armed 着卡片
      //    工具时想先捏合找个位置,第一根手指落下就平白多一张卡,而**手机上没有 Cmd+Z**。
      //    走既有的 create 通道:第二根手指(abortDrag)与长按(同样 abortDrag)都能把它整笔作废。
      //    rect/ellipse/frame 早就在 DRAW_TOOLS 里推迟了,这里补的正是漏下的那两个。
      if (e.pointerType === 'touch' && (t === 'card' || SHAPE_TOOLS[t])) {
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
      // padding 手柄同一条纪律),正文区 = 根之内、任何卡之外。「选字 vs 搬正文」的歧义由
      // 单击选择/拖动、空格编辑消解 —— 与卡片完全同款,见下面两个分支。
      const pmEl = target.closest<HTMLElement>('.ProseMirror')
      const onMainChrome = !card && !shape && !!pmEl && target === pmEl
      const onMainBody = !card && !shape && !!pmEl && target !== pmEl
      // 事件目标 == 卡片本身 ⇒ 落在卡的 chrome 圈上(落在正文里时 target 是内部的 p/h1/…)。
      const onCardChrome = !!card && target === card
      const anchor = card?.dataset.anchor ?? null

      // ── 卡内可交互控件:照常可点(用户 2026-08-20 实报「画布里点图片的 `</>` 没反应」)────
      // ⚠️ 根因不在按钮,在**指针事件**:pointerdown 一旦 preventDefault,浏览器就不再补发
      //    mousedown/click(兼容鼠标事件被抑制),再加上舞台 setPointerCapture 会把随后的 click
      //    重定向到舞台自己 —— 探针实测事件链只剩 `pointerdown:amx-src-btn` → `click:amx-stage`,
      //    按钮那句 onClick 一次都没跑。所以这里必须**在 preventDefault 之前**放行。
      // 顺手把这张卡置成编辑态:控件下一步多半要把光标塞进源码(revealSource),键盘与剪贴板
      // 的归属本来就该跟着走 —— 不置的话紧接着按 Cmd+V 会被舞台当成「往画布上粘一张卡」。
      const ctlOwner = target.closest(CARD_CTL) ? (anchor ?? (pmEl ? MAIN_KEY : null)) : null
      if (t === 'select' && ctlOwner) {
        setEditing(ctlOwner)
        return
      }

      // ── 卡正文也是选择/拖动命中面；编辑只走「选中后按空格」────────────────────────
      // 这一段必须排在下面的 `key` 之前，否则正文区会直接让位给 PM、拖不动整卡。
      if (card && anchor && !onCardChrome && t === 'select') {
        if (editingRef.current === anchor) return // 已在编辑这张卡:整片让位给 PM(选字/IME/⠿ 全常规)
        e.preventDefault()
        focusStage()
        const add = e.shiftKey || e.metaKey || e.ctrlKey
        const hit = cardKey(anchor)
        const curSel = selRef.current
        let keys = curSel.includes(hit) ? curSel : [hit]
        if (add) {
          keys = curSel.includes(hit) ? curSel.filter((k) => k !== hit) : [...curSel, hit]
          setSel(keys)
          if (!keys.includes(hit)) return
        } else if (!curSel.includes(hit)) setSel(keys)
        const cards: Array<{ anchor: string; ox: number; oy: number }> = []
        for (const k of keys) {
          if (!k.startsWith('c:')) continue
          const el = host.querySelector<HTMLElement>(`.amx-ucard[data-anchor="${CSS.escape(keyId(k))}"]`)
          if (el) cards.push({ anchor: keyId(k), ox: Number(el.dataset.x) || 0, oy: Number(el.dataset.y) || 0 })
        }
        drag = { kind: 'move', cards, ids: new Set(keys), hit, x0: at.x, y0: at.y, dx: 0, dy: 0, mainStart: null, mainEl: null, additive: add }
        capture(e.pointerId)
        return
      }

      // ── 主卡同款:单击/拖动，空格编辑 ────────────────────────────────────────────
      if (onMainBody && t === 'select') {
        if (editingRef.current === MAIN_KEY) return // 已在编辑正文:整片让位给 PM(选字/IME/⠿ 全常规)
        e.preventDefault()
        focusStage()
        const add = e.shiftKey || e.metaKey || e.ctrlKey
        const curSel = selRef.current
        let keys = curSel.includes(MAIN_KEY) ? curSel : [MAIN_KEY]
        if (add) {
          keys = curSel.includes(MAIN_KEY) ? curSel.filter((k) => k !== MAIN_KEY) : [...curSel, MAIN_KEY]
          setSel(keys)
          if (!keys.includes(MAIN_KEY)) return
        } else if (!curSel.includes(MAIN_KEY)) setSel(keys)
        const cards: Array<{ anchor: string; ox: number; oy: number }> = []
        for (const k of keys) {
          if (!k.startsWith('c:')) continue
          const el = host.querySelector<HTMLElement>(`.amx-ucard[data-anchor="${CSS.escape(keyId(k))}"]`)
          if (el) cards.push({ anchor: keyId(k), ox: Number(el.dataset.x) || 0, oy: Number(el.dataset.y) || 0 })
        }
        drag = {
          kind: 'move', cards, ids: new Set(keys), hit: MAIN_KEY, x0: at.x, y0: at.y, dx: 0, dy: 0,
          mainStart: { x: cbRef.current.main.x, y: cbRef.current.main.y }, mainEl: pmEl,
          additive: add,
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
          additive,
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
      const base = additive ? [...selRef.current] : []
      if (!additive) setSel([])
      // 触屏的空白单指拖 = **平移**(2026-08-23 用户拍板)。Figma / Miro / Freeform 全是
      // 「单指平移、双指缩放」,Excalidraw 的「单指框选」反而是异类 —— 手指按住空白往外拽,
      // 期待的就是画布跟着走。代价说清楚:**触屏没有框选了**,多选只能逐个点(手机端画布普遍如此);
      // 鼠标/触控板一字未动,`select` 工具照旧框选(check:canvas C21 钉着那一条)。
      if (e.pointerType === 'touch') {
        drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, vx: vpRef.current.x, vy: vpRef.current.y }
        capture(e.pointerId)
        return
      }
      drag = { kind: 'marquee', x0: at.x, y0: at.y, additive, base }
      capture(e.pointerId)
    }

    const onMove = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') {
        if (touchPts.has(e.pointerId)) touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > PRESS_SLOP) clearPress()
      }
      if (pinch) {
        updatePinch()
        return
      }
      if (drag && dragOwner !== e.pointerId) return // 不是这一笔的主人(见 capture 顶注)
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
        if (Math.abs(w - drag.w0) > slop) drag.live = true
        setDragRule([{ anchor: drag.anchor, decl: `width:${w}px;${LIFT}` }])
        return
      }
      if (drag.kind === 'mwidth') {
        const w = Math.max(MAIN_MIN_W, Math.round(drag.w0 + (e.clientX - drag.x0) / (vpRef.current.z * u)))
        if (Math.abs(w - drag.w0) > slop) drag.live = true
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
        if (Math.abs(drag.dw) > slop || Math.abs(drag.dh) > slop) drag.live = true
        setGhost({ move: null, size: { id: drag.id, dx: drag.dx, dy: drag.dy, dw: drag.dw, dh: drag.dh } })
        return
      }
      if (drag.kind === 'create') {
        drag.x1 = s.x
        drag.y1 = s.y
        if (Math.abs(drag.x1 - drag.x0) > slop || Math.abs(drag.y1 - drag.y0) > slop) drag.live = true
        // 预览借框选那个虚线框(同一个坐标系、同一种「正在圈一块地」的语义,不值一个新浮层)。
        // card/text 不吃尺寸(见 onUp 的 box),别给它们画一个骗人的框。
        if (DRAW_TOOLS.has(drag.tool)) setMarquee({ x: Math.min(drag.x0, s.x), y: Math.min(drag.y0, s.y), w: Math.abs(s.x - drag.x0), h: Math.abs(s.y - drag.y0) })
        return
      }
      if (drag.kind === 'marquee') {
        drag.live = true
        const rect = { x: Math.min(drag.x0, s.x), y: Math.min(drag.y0, s.y), w: Math.abs(s.x - drag.x0), h: Math.abs(s.y - drag.y0) }
        setMarquee(rect)
        // 命中随框逐帧更新，用户拖过卡片的当下就能看见选中框；缩回框时也要撤掉刚退出范围的项。
        const hits: string[] = []
        for (const [k, b] of actRef.current.boxesNow(null)) if (boxHits(rect, b)) hits.push(k)
        setSel(drag.additive ? [...new Set([...drag.base, ...hits])] : hits)
        return
      }
      drag.dx = Math.round(s.x - drag.x0)
      drag.dy = Math.round(s.y - drag.y0)
      if (Math.abs(drag.dx) > slop || Math.abs(drag.dy) > slop) drag.live = true
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
      // 纯卡片选择可以整批挂接；夹带主卡/形状时仍只做刚体搬动，避免把没有 tree 身份的对象认爹。
      const grabbed = keyId(drag.hit)
      const sources = !drag.mainStart && drag.cards.length > 0 && drag.ids.size === drag.cards.length
        ? drag.cards.map((c) => c.anchor).sort((a, b) => Number(b === grabbed) - Number(a === grabbed))
        : []
      setAttach(sources.length && drag.live ? actRef.current.attachHit(sources, s) : null)
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
      if (e.pointerType === 'touch') {
        touchPts.delete(e.pointerId)
        clearPress()
        // 双指手势的抬起既不是点击也不是落笔;**剩下那根手指也一并吞掉**,直到全部抬起为止
        // (否则松开一根手指的瞬间,另一根会当场变成一次拖拽/一次点选)。
        if (pinch) {
          if (touchPts.size === 0) pinch = null
          release(e.pointerId)
          drag = null
          return
        }
      }
      if (drag && dragOwner !== e.pointerId) {
        release(e.pointerId) // 别人的手指抬起:动不了这一笔(见 capture 顶注)
        return
      }
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
        // 尺寸只归 DRAW_TOOLS:触屏的 card/text 也走这条通道(见 onDown 的告警),但它们本来就
        // 只有「一击建默认大小」这一种形态,拖出来的框不该变成它们的尺寸。
        const box = DRAW_TOOLS.has(d.tool) && w >= MIN_EL && h >= MIN_EL ? { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w, h } : null
        if (d.tool === 'frame') {
          if (box) actRef.current.addFrame(box.x, box.y, box.w, box.h)
          else actRef.current.addFrame(d.x0 - FRAME_SIZE.w / 2, d.y0 - FRAME_SIZE.h / 2)
        } else if (d.tool === 'card') {
          actRef.current.addCardAt(d.x0 - CARD_W / 2, d.y0 - 24)
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
        // 多选状态下点中其中一个但**没拖**:收敛成只选它(Figma/AFFiNE 同款)。按下时之所以保留整批,
        // 是为了让「点住组里任意一个就能整批拖走」成立;不拖就意味着用户在重新指定目标,不收敛的话
        // 下一个动作(删除/微移)会连着整批一起走 —— 实测:框选全部后点一下形状再按删除,三张卡陪葬。
        // Shift/Cmd 明确是在组选择，纯点不能反手把刚加上的集合又收掉。
        if (d.kind === 'move' && d.ids.size > 1 && !d.additive) setSel([d.hit])
        clearVisuals(d)
        return
      }
      const view = getView()
      if (d.kind === 'marquee') {
        const s = toStage(e.clientX, e.clientY)
        const rect = { x: Math.min(d.x0, s.x), y: Math.min(d.y0, s.y), w: Math.abs(s.x - d.x0), h: Math.abs(s.y - d.y0) }
        const hits: string[] = []
        for (const [k, b] of actRef.current.boxesNow(null)) if (boxHits(rect, b)) hits.push(k)
        setSel(d.additive ? [...new Set([...d.base, ...hits])] : hits)
        clearVisuals(d)
        return
      }
      if (!view) {
        clearVisuals(d)
        return
      }
      let repelMotion: { anchors: string[]; main: boolean; push: { x: number; y: number } } | null = null
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
          const sources = !d.mainStart && d.cards.length > 0 && d.ids.size === d.cards.length
            ? d.cards.map((c) => c.anchor).sort((a, b) => Number(b === keyId(d.hit)) - Number(a === keyId(d.hit)))
            : []
          const hit = sources.length ? actRef.current.attachHit(sources, toStage(e.clientX, e.clientY)) : null
          if (sources.length && hit && actRef.current.applyAttach(sources, hit)) {
            clearVisuals(d)
            return
          }
          // 卡片/主卡是不可穿透对象。只平移本次选择集，静止卡不被“隔空撞走”；多选及夹带的
          // 图形/Frame 共享同一份最终 dx/dy，所以组内相对位置完全不变。
          const allCards = measureCards(host)
          const movingBoxes: ElBox[] = []
          for (const c of d.cards) {
            const box = allCards.get(c.anchor) // dragCss 已经把它量在手指松开处
            if (box) movingBoxes.push(box)
          }
          if (d.mainStart) {
            const box = measureMain(host)
            if (box) movingBoxes.push(box)
          }
          const movingAnchors = new Set(d.cards.map((c) => c.anchor))
          const obstacles: ElBox[] = [...allCards]
            .filter(([anchor]) => !movingAnchors.has(anchor))
            .map(([, box]) => box)
          if (!d.mainStart) {
            const box = measureMain(host)
            if (box) obstacles.push(box)
          }
          const push = resolveCardRepulsion(movingBoxes, obstacles, { x: d.dx, y: d.dy })
          const dx = d.dx + push.x
          const dy = d.dy + push.y
          if (push.x || push.y) repelMotion = { anchors: d.cards.map((c) => c.anchor), main: !!d.mainStart, push }
          if (d.cards.length) {
            setCardAttrs(view, new Map(d.cards.map((c) => [c.anchor, { x: Math.round(c.ox + dx), y: Math.round(c.oy + dy) }])))
          }
          // 元素与主卡合成**一笔** fm 快照(整批搬走本来就是一个动作);还牵着卡片(PM 那笔)时
          // 时间线并成 'pair' —— 一次框选整批拖,Cmd+Z 一击全还原。
          const elIds = new Set([...d.ids].filter((k) => k.startsWith('e:')).map(keyId))
          const m = d.mainStart ? { x: Math.round(d.mainStart.x + dx), y: Math.round(d.mainStart.y + dy), w: cbRef.current.main.w } : undefined
          if (elIds.size || m) {
            actRef.current.writeFm({
              ...(elIds.size ? { e: moveElements(rawList(cbRef.current.elements), elIds, dx, dy) } : {}),
              ...(m ? { m } : {}),
            })
            if (d.cards.length) actRef.current.mergePair()
          }
        }
      }
      clearVisuals(d)
      if (repelMotion) playRepelMotion(repelMotion.anchors, repelMotion.main, repelMotion.push)
      onCommit()
    }

    // 双击:卡片/主卡 = **进编辑 + 居中缩放同时发生**(聚焦那半可在设置里关);形状 = 改文字;
    // 连线 = 改标签;空白 = 新建卡片。单击永远不改变视口。
    const onDblClick = (e: MouseEvent): void => {
      // ⚠️ e.target 不可信:两段式在 pointerdown 里 setPointerCapture,派生的 click/dblclick 被
      // 重定向到 host —— 「双击卡片」于是被 isBlank 误判成「双击空白」,凭空建卡;双击形状同族,
      // 该进文字编辑的也建了卡(2026-08-18 用户实报,复现 R1/R1b)。按坐标现场取真实命中,
      // capture 重定向影响不到 elementFromPoint;selbox 整层 pointer-events:none,不会挡视线。
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) ?? (e.target as HTMLElement)
      if (target.closest('.amx-stage-tools, .amx-stage-hud, .amx-stage-minimap, .ctx-menu')) return
      const card = target.closest<HTMLElement>('.amx-ucard')
      const inMain = !card && !!target.closest('.ProseMirror')
      const nodeKey = card?.dataset.anchor ? cardKey(card.dataset.anchor) : inMain ? MAIN_KEY : null
      if (nodeKey) {
        // ⚠️ 已经在编辑这张卡/正文:双击是 PM 的**选词**手势,整片让位 —— 既不重置光标(否则
        //    刚选中的词当场塌成一个光标),也不再聚焦一次。判据与 onDown 的 stillIn 同源。
        if (editingRef.current === (nodeKey === MAIN_KEY ? MAIN_KEY : keyId(nodeKey))) return
        e.preventDefault()
        e.stopPropagation()
        // 双击 = 进编辑**与**聚焦一起发生(2026-08-22 用户拍板,不二选一)。
        // ⚠️ 光标必须在视口动画开始**之前**按当前 clientX/Y 取:focusNode 一动 pan/zoom,
        //    同一对屏幕坐标对应的文档位置就变了,慢一步光标会落到别的字上。
        actRef.current.enterNodeEdit(nodeKey, { x: e.clientX, y: e.clientY })
        if (canvasDoubleClickFocusEnabled()) actRef.current.focusNode(nodeKey, true)
        return
      }
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
    /** 命中判定与开菜单本身(右键与触屏长按**共用这一份**,别再各写一遍)。
     *  'skip' = 不归舞台管(交给原生/别人),'native' = 明确让位给 PM/原生菜单,'open' = 已开画布菜单。 */
    const stageMenuAt = (target: HTMLElement, x: number, y: number): 'skip' | 'native' | 'open' => {
      if (target.closest('.amx-stage-tools, .amx-stage-hud, .amx-stage-minimap')) return 'skip'
      const shape = target.closest<HTMLElement>(EL_HIT)
      const card = target.closest<HTMLElement>('.amx-ucard')
      const inMain = !card && !shape && !!target.closest('.ProseMirror')
      // 正在编辑的卡/正文让位给 PM/原生菜单(复制粘贴、拼写检查都在那儿)。
      if ((card?.dataset.anchor && editingRef.current === card.dataset.anchor) || (inMain && editingRef.current === MAIN_KEY)) return 'native'
      const key = shape?.dataset.el
        ? elKey(shape.dataset.el)
        : card?.dataset.anchor
          ? cardKey(card.dataset.anchor)
          : inMain
            ? MAIN_KEY
            : null
      if (!key && !isBlank(target)) return 'skip' // 浮层 chrome(把手等,不在 PM 内):原生菜单
      if (key && !selRef.current.includes(key)) setSel([key])
      setMenu({ x, y, key, at: toStage(x, y) })
      return 'open'
    }

    const onCtxMenu = (e: MouseEvent): void => {
      const r = stageMenuAt(e.target as HTMLElement, e.clientX, e.clientY)
      if (r === 'skip') return
      e.stopPropagation()
      if (r === 'open') e.preventDefault()
    }

    // 从 ⠿ 把块拖到舞台空白 → 成卡(AFFiNE 的 drag-handle drop 到 edgeless 空白同款)。
    // 落点在编辑器 DOM 之内时一律不接管:那是 PM 自己的块重排,blockLayer 已经管着。
    /** 落点让给 PM 的判据 = **正在编辑的那张卡/主卡**(与 onDown 的 stillIn 逐字同源)。
     *  ⚠️ 不能按 `.ProseMirror` 一刀切:卡片的 DOM 就住在 PM 根之内,那样等于把所有卡片盖住的
     *  那片舞台整个让出去 —— 仪器一直往 `.amx-stage` 上派发合成事件,这条从来没被测到过
     *  (2026-08-20 用户实报「画布里拖不进东西」)。 */
    const pmOwns = (e: DragEvent): boolean => {
      const t = e.target as HTMLElement | null
      const cur = editingRef.current
      if (!cur || !t) return false
      return cur === MAIN_KEY
        ? !!t.closest('.ProseMirror') && !t.closest('.amx-ucard')
        : !!t.closest(`.amx-ucard[data-anchor="${CSS.escape(cur)}"]`)
    }
    /** 外部拖进来的东西(OS 文件 / 侧栏笔记·文件引用 / 别的 app 的文字·链接)= 舞台自己接:落点建卡。
     *  ⚠️ dragover 阶段读不到 getData,只能看 types(chatDragRef 顶注写着这条)。 */
    const extKind = (e: DragEvent): 'files' | 'refs' | 'text' | null => {
      const dt = e.dataTransfer
      const types = dt ? Array.from(dt.types) : []
      if (getView()?.dragging) return null // 编辑器内部拖块:归 blockLayer
      // ⚠️ 文件与侧栏引用**恒归舞台**,即便落在正在编辑的那张卡上 —— 它们是「往这个位置放个东西」
      //    的空间动作,而让出去的话外层 EditorScope 会按**光标**插,落点是撒谎的(实测会插到卡的
      //    旁边而不是卡里;侧栏引用更是无人接管、直接消失。Codex 评审 medium)。
      if (cbRef.current.saveFile && types.includes('Files')) return 'files'
      if (hasChatRef(dt)) return 'refs'
      // 文字不同:正在编辑的卡里拖一段字进来,PM 落在插入符处才是对的。
      if (pmOwns(e)) return null
      if (types.includes('text/uri-list') || types.includes('text/plain')) return 'text'
      return null
    }
    const onStageDragOver = (e: DragEvent): void => {
      const view = getView()
      // ⚠️ 每一种 drop 会接的类型,dragover 都必须 preventDefault —— 不然浏览器压根不发 drop。
      if (extKind(e)) {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        host.classList.add('amx-dropzone')
        return
      }
      if (!view?.dragging || (e.target as HTMLElement)?.closest?.('.ProseMirror')) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      host.classList.add('amx-dropzone')
    }
    const onStageDragLeave = (): void => host.classList.remove('amx-dropzone')
    const onStageDrop = (e: DragEvent): void => {
      host.classList.remove('amx-dropzone')
      const view = getView()
      // ⚠️ 外部这一支必须 stopPropagation:外层 EditorScope 的 onDrop 也收 Files,不挡的话
      //    同一批文件会被再导入一遍(一份进卡片、一份插到主卡光标处)。
      const kind = extKind(e)
      if (kind) {
        e.preventDefault()
        e.stopPropagation()
        const at = toStage(e.clientX, e.clientY)
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (kind === 'files' && files.length) { actRef.current.dropFilesAt(files, at); return }
        if (kind === 'refs') {
          readChatRefs(e.dataTransfer).forEach((r, i) => actRef.current.addCardMd(refToCardMd(r), at, i))
          return
        }
        const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || ''
        actRef.current.addCardMd(text, at)
        return
      }
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

    /** 舞台中心的舞台坐标 —— 粘贴的落点(键盘操作没有指针位置,AFFiNE 同款落在视野中间)。 */
    const stageCenter = (): { x: number; y: number } => {
      const r = host.getBoundingClientRect()
      return toStage(r.left + r.width / 2, r.top + r.height / 2)
    }
    /** 复制/剪切选中的卡。**捕获期**挂在舞台上:卡内编辑时焦点在 PM 里(它是舞台的后代),
     *  冒泡期抢不过它 —— 而卡内的复制本来就该归 PM,所以第一句就按 editing 让路。 */
    const onCopy = (e: ClipboardEvent): void => {
      const view = getView()
      if (editingRef.current || !e.clipboardData || !view) return
      const anchors = new Set(selRef.current.filter((k) => k.startsWith('c:')).map(keyId))
      const hits = cardsOf(view).filter((c) => anchors.has(c.anchor))
      if (!hits.length) return
      // ⚠️ 必须 textBetween 带块分隔符:`node.textContent` 对多个块是**零分隔**拼接,两段
      //    「甲」「乙」会写成「甲乙」——剪切之后原卡已经没了,粘到别的 app 时这份纯文本是唯一
      //    幸存物,段落边界就此不可逆地糊掉(Codex 评审 high)。
      const text = hits.map((c) => c.node.textBetween(0, c.node.content.size, '\n\n')).join('\n\n')
      e.preventDefault()
      e.clipboardData.clearData()
      e.clipboardData.setData('text/plain', text) // 出到别的 app 只能是文字;整卡靠下面这份镜像
      // 镜像的认领凭据 = 这一次复制现开的令牌,写进自定义 MIME(Chromium 的 web custom data,
      // 只在本 app 内往返)。**不能只比文本**:用户复制完卡片又在别处复制了一模一样的字,
      // 回来粘贴就会静默粘回旧卡的格式/嵌入,而不是他刚复制的那份(Codex 评审 medium)。
      const token = `t${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
      try { e.clipboardData.setData(CLIP_MIME, token) } catch { /* 写不进自定义 MIME:降级成纯文本粘贴 */ }
      cardClip = { token, nodes: hits.map((c) => c.node) }
      pasteSeq.current = 0
      // 剪切**只删剪走的那些卡**:选中集合里的形状/连线没进剪贴板,一起删掉就是粘不回来的丢失。
      // assets:false —— 搬家不是删除,问「磁盘文件也删吗」会让粘出来那张卡的文件被删掉。
      if (e.type === 'cut') actRef.current.removeSel(hits.map((c) => cardKey(c.anchor)), { assets: false })
    }
    /** 粘贴到画布 = 落一张卡(文件走附件那条链)。卡内编辑时同样让路给 PM。 */
    const onPaste = (e: ClipboardEvent): void => {
      if (editingRef.current || !e.clipboardData) return
      const files = Array.from(e.clipboardData.files ?? [])
      const text = e.clipboardData.getData('text/plain') ?? ''
      if (!files.length && !text.trim()) return // 空剪贴板:什么都不做,别吞掉事件
      e.preventDefault()
      // 连粘错开 24px:第二张严丝合缝盖在第一张上,看起来就是「粘了没反应」(dropFilesAt 同款)。
      const n = pasteSeq.current++
      const c = stageCenter()
      const at = { x: c.x + n * 24, y: c.y + n * 24 }
      if (files.length) { actRef.current.dropFilesAt(files, at); return }
      // 剪贴板带着本画布复制时那枚令牌 → 整卡复现;否则(含「别处复制了同样的字」)按外部文字处理。
      // ⚠️ 镜像里的节点绑在**当时那个 schema** 上:换笔记/切源码/插件重载都会重建编辑器实例,
      //    拿旧 NodeType 插进新 doc 会 ReplaceError(PM 按 type 身份比对)。跨实例就降级成文字。
      const live = cardClip?.nodes[0]?.type === getView()?.state.schema.nodes.amadeusCanvasCard
      const mine = !!cardClip && e.clipboardData.getData(CLIP_MIME) === cardClip.token
      if (cardClip && live && mine) { actRef.current.pasteCards(cardClip.nodes, at); return }
      actRef.current.addCardMd(text, at)
    }

    // pointercancel ≠ 松手:系统手势接管 / 失焦 / 设备断连都会发它。当成松手的话,用户**取消**的
    // 那次拖拽会把最后一帧的临时坐标提交进 history 和磁盘(Codex P2-2)。这里只回滚外观。
    /** 幽灵手指兜底,挂 **window 捕获期**。触屏指针有**隐式捕获**(pointerdown 的目标恒收后续事件),
     *  正常情况下舞台一定收得到 pointerup —— 但隐式捕获会在**捕获目标被移出 DOM** 时释放,而卡内
     *  正文是 PM 的节点、随打字重建是常态;那之后手指抬在舞台外(顶栏/侧栏),touchPts 里就永远
     *  留着一条,下一次单击当场被当成「第二根手指」,pinch 再也等不到 size 归零 = 画布不响应单指。
     *  代价 12 行、症状是冻死,所以留这道兜底(⚠️ 仪器够不到它:harness 里舞台铺满视口,
     *  制造不出「抬在舞台外」)。次序无害:捕获期先于舞台的 pointerup,而整场手势里 `drag` 恒为
     *  null,舞台那支落到 `if (!d) return` 就结束(不会误落笔)。 */
    const onWinUp = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return
      touchPts.delete(e.pointerId)
      clearPress()
      if (pinch && touchPts.size === 0) pinch = null
    }
    window.addEventListener('pointerup', onWinUp, true)
    window.addEventListener('pointercancel', onWinUp, true)

    const onCancel = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') {
        touchPts.delete(e.pointerId)
        clearPress()
        if (pinch && touchPts.size === 0) pinch = null
      }
      release(e.pointerId)
      if (drag && dragOwner !== e.pointerId) return // 同上:别人的 cancel 不该回滚这一笔
      abortDrag()
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
    host.addEventListener('copy', onCopy, true)
    host.addEventListener('cut', onCopy, true)
    host.addEventListener('paste', onPaste, true)
    return () => {
      window.removeEventListener('pointerup', onWinUp, true)
      window.removeEventListener('pointercancel', onWinUp, true)
      clearPress()
      dragCss.remove()
      stopRepelMotion()
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
      host.removeEventListener('copy', onCopy, true)
      host.removeEventListener('cut', onCopy, true)
      host.removeEventListener('paste', onPaste, true)
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
    if (e.code === 'Space' && !mod && sel.length === 1 && (sel[0].startsWith('c:') || sel[0] === MAIN_KEY)) {
      e.preventDefault()
      enterNodeEdit(sel[0])
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

  // 点阵是画布内容的一部分，不是舞台窗口的壁纸。位移取视口平移在当前格距里的相位：
  // phase(x, step) 与 x+n·step 是同一组点，但合成层只需比视口多铺一格，不必造超大元素。
  const gridStep = GRID_STEP * vp.z
  const gridPhase = (v: number): number => ((v % gridStep) + gridStep) % gridStep
  const gridX = gridPhase(vp.x)
  const gridY = gridPhase(vp.y)

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
      className={`amx-stage${active ? '' : ' amx-stage-off'}${active ? ` amx-tool-${tool}` : ''}${focusMotion ? ' amx-vp-focus' : ''}`}
      ref={hostRef}
      tabIndex={-1}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
    >
      {active ? (
        <div
          className="amx-stage-grid"
          aria-hidden="true"
          style={{
            ['--amx-grid-step' as string]: `${gridStep}px`,
            transform: `translate3d(${gridX}px, ${gridY}px, 0)`,
          }}
        />
      ) : null}
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
      {active && miniMapVisible ? (
        <CanvasMiniMap
          hostRef={hostRef}
          vp={vp}
          elements={elements}
          ghost={ghost}
          onCenter={centerFromMiniMap}
        />
      ) : null}
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
          <button
            type="button"
            className={miniMapVisible ? 'is-on' : ''}
            aria-pressed={miniMapVisible}
            title={miniMapVisible ? '隐藏缩略图' : '显示缩略图'}
            onClick={() => {
              const next = !miniMapVisible
              setMiniMapVisible(next)
              setCanvasMiniMapEnabled(next)
              hostRef.current?.focus({ preventScroll: true })
            }}
          >
            <MapIcon size={12} />
          </button>
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
                {(menu.key === MAIN_KEY || menu.key.startsWith('c:')) && childrenOf(rawTree(tree), menu.key === MAIN_KEY ? MAIN_KEY : keyId(menu.key)).length > 0 && (
                  <button onClick={() => {
                    const root = menu.key === MAIN_KEY ? MAIN_KEY : keyId(menu.key!)
                    setMenu(null)
                    arrangeChildren(root)
                  }}>一键整理</button>
                )}
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
