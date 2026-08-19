/** v4 统一编辑器的块交互层(2026-08-13,用户拍板「每行=可拖动块,逻辑对齐 AFFiNE/Notion」):
 *  hover ⠿/＋ 浮动把手(逐节点粒度,列表项单独可拖)+ HTML5 拖拽重排(精确落点+指示线)+
 *  把手菜单(转换/复制/删除,由 UnifiedPage 渲染)+ 块选中(点把手/Esc 二段,NodeSelection)。
 *
 *  地基分工(2026-08-13 分栏 spike 后二版):
 *  - hover 命中/定位/拖起 = **自写**(原用 @milkdown/plugin-block,但它的 pointermove 命中永远取
 *    `编辑器水平中线` 的 x —— 对分栏(amadeusColumnRow)结构性列盲:中线落在列缝/邻列,把手命中
 *    整行(C3 spike 实测)。自写版按真指针坐标命中,爬升规则保留其「首子归外壳」,加一条:
 *    **cell 内首子不归壳**(列内逐块粒度);定位改绝对定位÷zoomOf,顺带根治浮动把手 zoom 漂移)。
 *  - dragstart 序列化照抄 plugin-block:serializeForClipboard + view.dragging={slice,move}。
 *  - prosemirror-drop-indicator:dragover 逐块上下边沿找最近落点(嵌套边沿自带缩进 x),
 *    handleDrop 用精确落点替换 PM 默认 dropPoint(默认那个会诡异重嵌套);同文档移动=删+插一个事务。
 *  - AFFiNE 行为基准:块内打字藏把手 / callout(blockquote)整只一个把手 / 表格内部不出把手 /
 *    Esc 两段(文字 → 块选中 → 回文字)。多选/框选归 Phase B。 */
import { $prose } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { findParent } from '@milkdown/kit/prose'
import { keymap } from '@milkdown/kit/prose/keymap'
import { AllSelection, NodeSelection, TextSelection, Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model'
import { createDropIndicatorPlugin } from 'prosemirror-drop-indicator'
import { zoomOf } from '@lcl/engine'
import { tabIndent, tabOutdent, type TabFoldHooks } from '../blocks/markdown/tabIndent'
import { executeMoveBelowRow, executePair } from './columns'
import { foldStateAt, toggleFoldAt } from './headingFold'
import { isListFolded, listFoldStateAt, toggleListFoldAt } from './listFold'
import { keyboardPlugins } from './keyboard'

export interface BlockLayerHooks {
  /** 点 ⠿ → 由宿主(UnifiedPage)在该坐标弹块菜单;此刻 NodeSelection 已在(mousedown 设的)。 */
  onMenu: (at: { x: number; y: number }) => void
}

export interface BlockLayer {
  plugins: MilkdownPlugin[]
  /** 菜单动作要驱动编辑器:交互层捕获的 EditorView(未挂载 = null)。 */
  getView: () => EditorView | null
  /** 跨块选区覆盖到的顶层块边界(整节点对齐、两端同父);⠿ 菜单的整批动作与拖拽共用这一份判定。 */
  topRangeOf: (view: EditorView) => { from: number; to: number } | null
}

/** 元素的**累计视觉缩放**(CSS zoom × 全部祖先的 transform scale)。`rect` 是视口 px、`offsetWidth`
 *  是未缩放的局部 px(端级 zoom×浮层坐标那条老账),两者相除就把两种缩放一并量到。宽为 0 时无从量,
 *  回落 zoomOf(老口径)。
 *  ponytail:只对**轴对齐等比缩放**成立(画布卡片就是这一种)。旋转/倾斜/scaleX≠scaleY 下
 *  bounding box 宽度不是 x/y 的统一因子 —— 真要支持那些,换 `new DOMMatrix(cs.transform)` 逐层
 *  累乘。另:offsetWidth 取整,分数布局宽会带亚像素误差,故与 zoomOf 差得极小时按 zoomOf 算,
 *  保证「无 transform 时严格退化成老行为」(Codex 评审 P2)。 */
function visualScale(el: HTMLElement): number {
  const w = el.offsetWidth
  if (w <= 0) return zoomOf(el)
  const z = zoomOf(el)
  const k = el.getBoundingClientRect().width / w
  return Math.abs(k - z) < 0.01 ? z : k
}

/** 这个元素会不会给后代的 `position: fixed` 当包含块(css-position-3 §containing block +
 *  css-contain:layout/paint containment)。⚠️不止 transform —— will-change 预告同样属性、
 *  contain: layout/paint/strict/content、container-type、backdrop-filter、content-visibility
 *  全都会建立包含块(Codex 评审 P1:漏一项 = 浮层整体偏一个容器位)。 */
function createsFixedCB(cs: CSSStyleDeclaration): boolean {
  if (cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none') return true
  if (cs.backdropFilter && cs.backdropFilter !== 'none') return true
  if (cs.containerType && cs.containerType !== 'normal') return true
  if (/\b(layout|paint|strict|content)\b/.test(cs.contain ?? '')) return true
  if (cs.contentVisibility === 'auto' || cs.contentVisibility === 'hidden') return true
  return /\b(transform|perspective|filter|backdrop-filter|contain)\b/.test(cs.willChange ?? '')
}

/** 包含块的**padding box** 原点(视口 px):写进 style 的坐标是相对它算的,先减掉。
 *  - `position: absolute` → offsetParent(最近的定位祖先,编辑器里是 .milkdown);
 *  - `position: fixed` → 最近的 createsFixedCB 祖先,没有则视口({0,0})。
 *  边框要单独减:包含块是 padding box,而 rect 给的是 border box(卡片带 1px 描边就差 1px)。 */
function overlayOrigin(el: HTMLElement): { x: number; y: number } {
  const originOf = (host: HTMLElement): { x: number; y: number } => {
    const r = host.getBoundingClientRect()
    const cs = getComputedStyle(host)
    return { x: r.left + (Number.parseFloat(cs.borderLeftWidth) || 0), y: r.top + (Number.parseFloat(cs.borderTopWidth) || 0) }
  }
  if (getComputedStyle(el).position === 'absolute') {
    // ⚠️ offsetParent 在元素(或祖先)`display:none` 时是 **null** —— 这些浮层的 CSS 初值恰好就是
    //    display:none,首次定位时问它必然拿 null,回落 {0,0} = 整体偏一个容器位(实测 336×244)。
    //    所以自己往上找:非 static 的祖先,或任何能当包含块的祖先(transform 系同样接管 absolute)。
    let cb = el.offsetParent as HTMLElement | null
    for (let p = el.parentElement; !cb && p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.position !== 'static' || createsFixedCB(cs)) cb = p
    }
    return cb ? originOf(cb) : { x: 0, y: 0 }
  }
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (createsFixedCB(getComputedStyle(p))) return originOf(p)
  }
  return { x: 0, y: 0 }
}

/** 把手可命中判定:表格/引用(callout)内部不给独立把手(整只算一块);行/列骨架自身不给把手。 */
const pickableNode = ($pos: ResolvedPos, node: ProseNode | null): boolean => {
  if (!node) return false
  const name = node.type.name
  if (name === 'amadeusColumnRow' || name === 'amadeusColumnCell') return false
  if (findParent((n) => n.type.name === 'table' || n.type.name === 'blockquote')($pos)) return false
  return true
}

export interface ActiveBlock {
  node: ProseNode
  pos: number // 节点前位置(NodeSelection 落点)
  el: HTMLElement
}

/** hover 命中(取代 plugin-block 的列盲中线版):按**真指针坐标** posAtCoords,爬升规则沿用
 *  「首子归外壳」,但 cell 内首子不归壳(列内保持逐块粒度)。异常一律 null(与上游同,try 包裹)。 */
function pickBlockAt(view: EditorView, coords: { x: number; y: number }): ActiveBlock | null {
  try {
    const inside = view.posAtCoords({ left: coords.x, top: coords.y })?.inside
    if (inside == null || inside < 0) return null
    let $pos = view.state.doc.resolve(inside)
    let node = view.state.doc.nodeAt(inside)
    let el = view.nodeDOM(inside)
    const climb = (needLookup: boolean): void => {
      const checkDepth =
        $pos.depth >= 1 &&
        $pos.index($pos.depth) === 0 &&
        $pos.node($pos.depth).type.name !== 'amadeusColumnCell' // cell 内首子不归壳
      if (!(needLookup || checkDepth)) return
      if ($pos.depth < 1) return // 无处可爬(命中骨架顶到 doc):放弃,外层判 pickable 后回 null
      const anc = $pos.before($pos.depth)
      node = view.state.doc.nodeAt(anc)
      el = view.nodeDOM(anc)
      $pos = view.state.doc.resolve(anc)
      if (!pickableNode($pos, node)) climb(true)
    }
    climb(!pickableNode($pos, node))
    if (!node || !pickableNode($pos, node) || !(el instanceof HTMLElement)) return null
    return { node, pos: $pos.pos, el }
  } catch {
    return null
  }
}

/** Esc(文字态)的目标块:最深的可选中祖先;夹层段落(列表项/引用里的 paragraph)升级到外壳
 *  (与把手的「首子归外壳」同一手感);blockquote 祖先恒整只(callout 规则)。 */
function escTargetPos(state: EditorState): number | null {
  const { $from } = state.selection
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d)
    if (node.type.name === 'blockquote') return $from.before(d)
  }
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d)
    if (!NodeSelection.isSelectable(node)) continue
    if (node.type.name === 'paragraph' && d > 1) continue // 夹层段落 → 继续升
    return $from.before(d)
  }
  return null
}

/** 最近的可滚动祖先(编辑器自身不滚,滚的是 .amx-pane 一类外层)。 */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

export function createBlockLayer(hooks: BlockLayerHooks): BlockLayer {
  let viewRef: EditorView | null = null
  let activeRef: ActiveBlock | null = null

  // ── 分栏配对态(拖到块左右缘 ≤28px):竖直指示线 + 捕获期 drop 单点路由(Codex B5:
  // pair 命中即 preventDefault+stopPropagation,横向落点/PM 默认 drop 都不再跑,一次 drop 只消费一次)。
  let pairRef: { targetPos: number; side: 'left' | 'right' } | null = null
  let vline: HTMLDivElement | null = null
  const ensureVline = (view: EditorView): HTMLDivElement => {
    if (vline && vline.isConnected) return vline
    vline = document.createElement('div')
    vline.className = 'unified-drop-vline'
    vline.style.display = 'none'
    ;(view.dom.parentElement ?? document.body).appendChild(vline)
    return vline
  }
  const showVline = (view: EditorView, el: HTMLElement, side: 'left' | 'right'): void => {
    const dom = ensureVline(view)
    const z = visualScale(view.dom)
    const o = overlayOrigin(dom)
    const r = el.getBoundingClientRect()
    const x = (side === 'left' ? r.left - 6 : r.right + 3) - o.x
    dom.style.display = 'block'
    dom.style.height = `${r.height / z}px`
    dom.style.transform = `translate(${Math.round(x / z)}px, ${Math.round((r.top - o.y) / z)}px)`
  }
  const hideVline = (): void => {
    if (vline) vline.style.display = 'none'
  }
  const EDGE = 28

  // ── 分栏行下方落点(第5振):指针越过行底 → 落点=行后顶层,整宽横线。与 pairRef 同一套
  // 捕获期 drop 单点路由;横线复用 .unified-drop-line 样式(关掉入场动画,拖拽逐 tick 重定位不重播)。
  // 存行 **DOM 元素**而非裸 pos(Codex 第5振评审 P2:悬停期若有外部回灌事务,缓存 pos 可能
  // 巧合指到别的行,类型校验照过但落点错) —— drop 时对仍连接的元素现场 posAtDOM。
  /** 拖拽=复制的判据,与 PM 自身 drop 路径逐字对齐(prosemirror-view dragCopyModifier:
   *  mac=Alt、其余=Ctrl)。必须同源:否则「默认落点 Alt 复制、拖成列 Alt 却是移动」两套手感。 */
  const dragCopies = (e: DragEvent): boolean => (/Mac/i.test(navigator.platform) ? e.altKey : e.ctrlKey)

  /** 跨块选区覆盖到的**顶层块**边界(整节点对齐);不是跨块选区返回 null。
   *  与 UnifiedPage 的 ⠿ 菜单共用同一份判定(经 BlockLayer.topRangeOf 暴露),别再抄第二份。 */
  const topRangeOf = (view: EditorView): { from: number; to: number } | null => {
    const sel = view.state.selection
    if (!(sel instanceof TextSelection) || sel.empty || sel.$from.sameParent(sel.$to)) return null
    const top = ($p: ResolvedPos): number => {
      let d = $p.depth
      while (d >= 1 && !['doc', 'amadeusColumnCell'].includes($p.node(d - 1).type.name)) d--
      return d
    }
    const df = top(sel.$from)
    const dt = top(sel.$to)
    if (df < 1 || dt < 1) return null
    // ⚠️ 两端必须同一个父容器:一端在分栏 cell 内、一端在 doc 顶层时,doc.slice 得到的是
    //    openStart=2 的**开片**,直接拿 .content 去 insert 会把整只 amadeusColumnRow 切开搬走,
    //    还会复制出 anchor 重复的 cell(fixAnchor 只补空锚、不查重)→ layout 与锚一对多。
    //    这种跨界选区是框选的常规产物(topBlockEls 故意把 cell 直接子也列进去),必须挡住。
    if (sel.$from.node(df - 1) !== sel.$to.node(dt - 1)) return null
    return { from: sel.$from.before(df), to: sel.$to.after(dt) }
  }

  /** 抓取点所在段落的「tab 缩进子树」范围:段落 + 紧随其后、缩进更深的连续段落。
   *  (2026-08-19 用户实报,AFFiNE/Notion 同款:带子块的块,选中/拖动都是整体。)
   *  只认 doc 顶层与分栏 cell(与 topRangeOf 的容器名单一致;卡内抓取维持单块,闭合锚轮再扩);
   *  列表/引用等结构块自带整体性,不在此列。单段(无更深后继)返回 null。 */
  const indentSubtreeOf = (view: EditorView, pos: number, node: ProseNode): { from: number; to: number } | null => {
    if (node.type.name !== 'paragraph') return null
    const $p = view.state.doc.resolve(pos)
    const parent = $p.parent
    if (!['doc', 'amadeusColumnCell'].includes(parent.type.name)) return null
    const base = Number(node.attrs.indent ?? 0)
    const idx = $p.index()
    let end = pos + node.nodeSize
    let kids = 0
    for (let i = idx + 1; i < parent.childCount; i++) {
      const sib = parent.child(i)
      if (sib.type.name !== 'paragraph' || Number(sib.attrs.indent ?? 0) <= base) break
      end += sib.nodeSize
      kids++
    }
    return kids ? { from: pos, to: end } : null
  }

  /** 跨块选区的整批拖:落点按「指针在目标块中线上/下」定前/后,删+插一个事务。
   *  为什么不交给 PM/落点插件:TextSelection.content() 是 openStart/openEnd=1 的**开片**,
   *  drop 时 replaceRange 会把它并进落点块 —— 实测只搬走第一块,后面几块留在原地(M2 首红)。
   *  这里按整节点边界切一个**闭片**,再自己删+插,整批语义才成立。
   *  顺带兑现「落回原处 = no-op」:落点落在自己范围内直接放弃,不产生空事务/空撤销步。 */
  /** 拖到末块之下 = 搬到文档末尾(顶层)。单块(NodeSelection,含整卡)与跨块选区(缩进子树/
   *  框选)都收;已在末尾 = no-op 不造空撤销步。 */
  const executeMoveToTail = (view: EditorView, copy: boolean): boolean => {
    const { state } = view
    const end = state.doc.content.size
    const range = topRangeOf(view)
    if (range) {
      if (!copy && range.to === end) return true
      const content = state.doc.slice(range.from, range.to).content
      let tr = state.tr
      if (!copy) tr = tr.delete(range.from, range.to)
      tr = tr.insert(tr.mapping.map(end), content)
      tr.setMeta('amxColumns', true)
      view.dispatch(tr.scrollIntoView())
      return true
    }
    const sel = state.selection
    if (!(sel instanceof NodeSelection)) return false
    if (!copy && sel.to === end) return true
    const dragged = sel.node
    const moved = dragged.type.name === 'list_item' ? sel.$from.parent.type.create(sel.$from.parent.attrs, dragged) : dragged
    let tr = state.tr
    if (!copy) tr = tr.delete(sel.from, sel.to)
    tr = tr.insert(tr.mapping.map(end), moved)
    tr.setMeta('amxColumns', true)
    view.dispatch(tr.scrollIntoView())
    return true
  }

  const executeMoveBlocks = (view: EditorView, e: DragEvent, copy: boolean): boolean => {
    const range = topRangeOf(view)
    if (!range) return false
    let el: HTMLElement | null = null
    for (const cand of Array.from(view.dom.children) as HTMLElement[]) {
      const r = cand.getBoundingClientRect()
      if (e.clientY >= r.top && e.clientY <= r.bottom) { el = cand; break }
    }
    if (!el) return false
    let before = 0
    let node: ProseNode | null = null
    try {
      const p = view.posAtDOM(el, 0)
      before = p - 1
      node = view.state.doc.nodeAt(before)
    } catch {
      return false
    }
    if (!node) return false
    const r = el.getBoundingClientRect()
    const at = e.clientY > r.top + r.height / 2 ? before + node.nodeSize : before
    if (at >= range.from && at <= range.to) return true // 落回自己身上:吞掉,什么都不做
    const content = view.state.doc.slice(range.from, range.to).content
    let tr = view.state.tr
    if (!copy) tr = tr.delete(range.from, range.to)
    tr = tr.insert(tr.mapping.map(at), content)
    tr.setMeta('amxColumns', true)
    view.dispatch(tr.scrollIntoView())
    return true
  }

  /** 拖到列表项右缘 → 放进它当子项(AFFiNE edge==='right' 的 md 可表示形态)。
   *  落点位置 = 目标项内容末尾;它已经有子列表就并进去,没有就新建一层同类列表。 */
  const executeMoveIntoList = (view: EditorView, targetPos: number, copy: boolean): boolean => {
    const { state } = view
    const sel = state.selection
    if (!(sel instanceof NodeSelection)) return false
    const target = state.doc.nodeAt(targetPos)
    if (!target || target.type.name !== 'list_item') return false
    if (targetPos >= sel.from && targetPos < sel.to) return false // 落到自己身上
    const listItem = state.schema.nodes.list_item
    const bullet = state.schema.nodes.bullet_list
    if (!listItem || !bullet) return false
    const dragged = sel.node
    if (dragged.type.name === 'amadeusColumnRow' || dragged.type.name === 'amadeusColumnCell') return false
    const item = dragged.type.name === 'list_item' ? dragged : listItem.createAndFill(null, dragged)
    if (!item) return false
    const last = target.child(target.childCount - 1)
    const hasNested = target.childCount > 1 && /_list$/.test(last.type.name)
    let tr = state.tr
    if (!copy) tr = tr.delete(sel.from, sel.to)
    const tPos = tr.mapping.map(targetPos)
    const tNode = tr.doc.nodeAt(tPos)
    if (!tNode || tNode.type.name !== 'list_item') return false
    const at = hasNested ? tPos + tNode.nodeSize - 2 : tPos + tNode.nodeSize - 1
    tr = tr.insert(at, hasNested ? item : (last.type.name.endsWith('_list') ? last.type : bullet).create(null, item))
    tr.setMeta('amxColumns', true)
    view.dispatch(tr.scrollIntoView())
    return true
  }

  /** 这台编辑器此刻在不在画布模式(`.amx-canvas` 挂在 pane 级 .unified-body 上)。 */
  const inCanvas = (view: EditorView): boolean => !!view.dom.closest('.unified-body')?.classList.contains('amx-canvas')

  /** 一个父节点的子块里,按指针纵坐标定的插入位置(上半 = 该块之前,下半 = 该块之后)。 */
  const dropPosAmong = (view: EditorView, parent: ProseNode, start: number, e: DragEvent): number => {
    let off = start
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i)
      const dom = view.nodeDOM(off)
      const r = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null
      if (r && e.clientY <= r.bottom) return e.clientY > r.top + r.height / 2 ? off + child.nodeSize : off
      off += child.nodeSize
    }
    return off
  }

  /** 主卡(自然流)里的落点。**只数非卡子节点**,兜底恒是卡片区起点 —— 见下面那条不变式。 */
  const dropPosInMain = (view: EditorView, e: DragEvent): number => {
    const doc = view.state.doc
    const card = view.state.schema.nodes.amadeusCanvasCard
    let at = 0
    for (let i = 0; i < doc.childCount; i++) {
      const child = doc.child(i)
      if (child.type === card) return at // 卡片区起点:再往后就是「卡与卡之间」,禁区
      const dom = view.nodeDOM(at)
      const r = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null
      if (r && e.clientY <= r.bottom) return e.clientY > r.top + r.height / 2 ? at + child.nodeSize : at
      at += child.nodeSize
    }
    return at
  }

  /** 画布模式的落点路由(2026-08-18,用户实报)。
   *
   *  ⚠️ **不变式:画布模式下,块拖拽绝不允许在「卡与卡之间」的 doc 顶层插入。** 那会打断尾部连续
   *  卡片区 → canvasNormalizer 立刻把断点之前的卡**全部就地拆壳**,锚以 `<!-- a k1 -->` 的字面形态
   *  显形在正文里、cards 同时掉枚。两段都是实测的:
   *   · 落点插件在画布模式下算出来的位置**与指针无关** —— 卡片是绝对定位,view.dom 的子元素矩形
   *     彼此重叠、DOM 序 ≠ 视觉序,它那套「逐块扫上下边沿」失去前提。瞄准另一张卡的正文/顶边/底边,
   *     三次落点完全一样(都掉进主卡)。
   *   · 顶层插在两张卡之间 → 前一张卡当场拆壳、锚显形。
   *  所以这一层在画布模式下**全接管**:指针压在哪张卡上就落进那张卡,否则落进主卡自然流(位置钳在
   *  卡片区之前)。两条路都产生不了禁区里的位置。 */
  const executeDropInCanvas = (view: EditorView, e: DragEvent, copy: boolean): boolean => {
    const sel = view.state.selection
    if (!(sel instanceof NodeSelection)) return false
    const card = view.state.schema.nodes.amadeusCanvasCard
    if (!card) return false
    // ⚠️ 舞台空白区不归这里:那是 canvasStage 的 onStageDrop(普通块「拖出成卡」/ 已有卡「搬到
    //    落点」)。判据必须是「落点在编辑器 DOM 之内」,而且必须排在下面的卡片吞判**之前** ——
    //    2026-08-18 用户实报「⠿ 拖卡没反应」的根因之一就是这两句次序反了:凡卡片拖拽一律被吞,
    //    连拖到空白重新摆位也被吃掉(还顺手清了 view.dragging,舞台的 drop 根本收不到)。
    const t = e.target as HTMLElement | null
    if (!t || !view.dom.contains(t)) return false
    // 卡拖进**编辑器区域**(主卡/别的卡)= 卡内出现卡锚,重开时 fold 的「末卡之后不许还有别的锚」
    // 当场拒折,**整篇画布消失** —— 这条毁档防线只吞「落点在编辑器里」的卡拖拽(no-op 远好过毁档)。
    if (sel.node.type === card) return true
    const el = t.closest?.('.amx-ucard') as HTMLElement | null
    let at: number
    if (el) {
      let pos: number
      try {
        pos = view.posAtDOM(el, 0) - 1
      } catch {
        return false
      }
      const node = view.state.doc.nodeAt(pos)
      if (node?.type !== card) return false
      at = dropPosAmong(view, node, pos + 1, e)
    } else {
      at = dropPosInMain(view, e)
    }
    if (at >= sel.from && at <= sel.to) return true // 落回自己身上:吞掉,不产生空事务
    let tr = view.state.tr
    if (!copy) tr = tr.delete(sel.from, sel.to)
    tr = tr.insert(tr.mapping.map(at), sel.node)
    tr.setMeta('amxColumns', true)
    view.dispatch(tr.scrollIntoView())
    return true
  }

  /** OS 文件拖入时的落点(与块拖拽两套指示互斥:文件那条只画线、不参与块路由)。 */
  // ⚠️ 浮层几何的两个补偿量(2026-08-15 PM-under-transform spike 实测后加,仪器 unified-scale.check.cjs):
  //    编辑器将来住在画布卡片里 = `transform: scale(k)` 的子树,而这层原来只除 zoomOf。
  //    ① zoomOf 读的是 currentCSSZoom,**transform 不进那个量** → 视口 rect ÷ 1 再被同一个 transform
  //       缩放一次 = k² 级偏差(实测 k=2 时把手偏 94px);
  //    ② 祖先一有 transform,`position: fixed` 的包含块就从视口变成那个祖先 → 直接写视口 px 整体
  //       偏一个卡片位(实测 k=1 也偏 245px)。
  //    两者都退化成老行为(无 transform 时 ①=zoomOf、②={0,0}),所以普通笔记路径零变化。
  let fileDropRef: { pos: number } | null = null
  let childRef: { targetPos: number; el: HTMLElement } | null = null
  let belowRef: { rowEl: HTMLElement } | null = null
  /** 末块之下 = 顶层文末落点(2026-08-19 闭合锚:末块是卡时这里成了合法且常用的落点,
   *  此前无人认领 → 拖到末卡之下静默没反应)。 */
  let tailRef = false
  let hline: HTMLDivElement | null = null
  const ensureHline = (view: EditorView): HTMLDivElement => {
    if (hline && hline.isConnected) return hline
    hline = document.createElement('div')
    hline.className = 'unified-drop-line'
    hline.style.display = 'none'
    hline.style.animation = 'none'
    ;(view.dom.parentElement ?? document.body).appendChild(hline)
    return hline
  }
  const showHline = (view: EditorView, rowEl: HTMLElement, indent = 0): void => {
    const dom = ensureHline(view)
    const z = visualScale(view.dom)
    const o = overlayOrigin(dom)
    const r = rowEl.getBoundingClientRect()
    dom.style.display = 'block'
    dom.style.width = `${Math.max(0, r.width - indent) / z}px`
    dom.style.transform = `translate(${Math.round((r.left + indent - o.x) / z)}px, ${Math.round((r.bottom + 6 - o.y) / z)}px)`
  }
  const hideHline = (): void => {
    if (hline) hline.style.display = 'none'
  }

  // ── 浮动把手(⠿ + ＋):命中/定位/拖起全自写(见文件头:plugin-block 的中线命中对分栏列盲)。──
  const handlePlugin = $prose(() => {
    return new Plugin({
      key: new PluginKey('UNIFIED_BLOCK_HANDLE'),
      view: (editorView) => {
        viewRef = editorView
        const container = editorView.dom.parentElement ?? document.body // .milkdown(position:relative,见 CSS)
        // hover 追踪挂 pane 级 .unified-body:把手悬在 .milkdown 左缘**之外**(实测 rect 整个在容器
        // 左侧),挂 container 的话指针一穿越容器边界 mouseleave 就藏把手——真机「一移过去就消失」。
        const root = (container.closest('.unified-body') as HTMLElement | null) ?? container
        /** 画布模式的落点指示:目标卡描边(单选,传 null = 清掉)。 */
        const markDropCard = (el: HTMLElement | null): void => {
          for (const c of root.querySelectorAll('.amx-ucard.amx-droptarget')) c.classList.remove('amx-droptarget')
          el?.classList.add('amx-droptarget')
        }
        const content = document.createElement('div')
        content.className = 'unified-gutter'
        content.dataset.show = 'false'

        const hide = (): void => {
          content.dataset.show = 'false'
          activeRef = null
        }
        const show = (a: ActiveBlock): void => {
          if (!editorView.editable) return // 只读文档不给把手(AFFiNE 同):看得见拖不动比没有更糟
          activeRef = a
          syncFold(a)
          // 绝对定位(布局 px):视口 rect ÷ 累计视觉缩放反补偿,把手压到块首行行高中点(AFFiNE 手感)。
          const z = visualScale(container)
          const cr = container.getBoundingClientRect()
          const r = a.el.getBoundingClientRect()
          const cs = getComputedStyle(a.el)
          const lh = Number.parseFloat(cs.lineHeight) || 24
          const pt = Number.parseFloat(cs.paddingTop) || 0
          content.dataset.show = 'true'
          content.style.setProperty('--amx-block-h', `${r.height / z}px`) // hover 拉长用(见 styles.css)
          const w = content.offsetWidth || 52
          content.style.top = `${(r.top - cr.top) / z + pt + Math.max(0, (lh - 24) / 2)}px`
          content.style.left = `${(r.left - cr.left) / z - w - 8}px`
        }

        const drag = document.createElement('button')
        drag.type = 'button'
        drag.className = 'drag-handle'
        drag.textContent = '⠿'
        drag.draggable = true
        drag.title = '点击打开菜单,按住拖动 / Click for menu, hold to drag'
        drag.addEventListener('click', (e) => {
          e.stopPropagation()
          const r = drag.getBoundingClientRect()
          hooks.onMenu({ x: r.left, y: r.bottom + 4 })
        })
        // mousedown = 选中所在块;三个拖拽事件都挂 gutter 整体(plugin-block 同款:真实拖动
        // 从 ⠿ 冒泡上来,仪器合成事件也直接打在 gutter 上)。
        content.addEventListener('mousedown', () => {
          const view = viewRef
          const a = activeRef
          if (!view || !a) return
          // 已有跨块选区且本块就在里面 → 保留它(整批拖走,AFFiNE 同);否则收敛成这一块。
          // ⚠️ 比的是**内容边界**不是节点边界:文字选区永远落在节点内部([pos+1, pos+size-1]),
          //    拿节点前位去比会恒不成立,多选一按下就被收敛成单块(M2 首红即此)。
          const cur = view.state.selection
          const cStart = a.pos + 1
          const cEnd = a.pos + a.node.nodeSize - 1
          if (cur instanceof TextSelection && !cur.empty && cur.from <= cStart && cur.to >= cEnd) {
            view.focus()
            return
          }
          // tab 缩进子树 = 整体单元:抓的段落带着更深缩进的后继段时,按下即收成跨块选区 ——
          // 拖拽/联合高亮/块菜单/Delete 全走既有多块机器,一处收敛零新路径。
          const sub = indentSubtreeOf(view, a.pos, a.node)
          if (sub) {
            const doc = view.state.doc
            view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(sub.from + 1), doc.resolve(sub.to - 1))))
            view.focus()
            return
          }
          if (!NodeSelection.isSelectable(a.node)) return
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, a.pos)))
          view.focus()
        })
        // 按下把手(还没开拖)= 在块上盖一层外扩 4px 的圆角高亮(AFFiNE 的 hover-rect)。
        // 走独立浮层而不是给节点加 class:多块选中时它要能盖住整个选区的并集矩形。
        let hoverRect: HTMLDivElement | null = null
        const showHoverRect = (): void => {
          const view = viewRef
          const a = activeRef
          if (!view || !a) return
          if (!hoverRect || !hoverRect.isConnected) {
            hoverRect = document.createElement('div')
            hoverRect.className = 'unified-press-rect'
            ;(view.dom.parentElement ?? document.body).appendChild(hoverRect)
          }
          const z = visualScale(view.dom)
          const o = overlayOrigin(hoverRect)
          const r = a.el.getBoundingClientRect()
          const range = topRangeOf(view)
          let box = { left: r.left - o.x, top: r.top - o.y, right: r.right - o.x, bottom: r.bottom - o.y }
          if (range) {
            // 多块选中:并集矩形(把手按下时拖走的是整批,高亮也该是整批)
            for (const el of Array.from(view.dom.children) as HTMLElement[]) {
              if (!el.classList.contains('amx-block-selected')) continue
              const b = el.getBoundingClientRect()
              box = { left: Math.min(box.left, b.left - o.x), top: Math.min(box.top, b.top - o.y), right: Math.max(box.right, b.right - o.x), bottom: Math.max(box.bottom, b.bottom - o.y) }
            }
          }
          Object.assign(hoverRect.style, {
            display: 'block',
            transform: `translate(${Math.round((box.left - 4) / z)}px, ${Math.round((box.top - 4) / z)}px)`,
            width: `${(box.right - box.left + 8) / z}px`,
            height: `${(box.bottom - box.top + 8) / z}px`,
          })
        }
        const hideHoverRect = (): void => {
          if (hoverRect) hoverRect.style.display = 'none'
        }
        content.addEventListener('mousedown', showHoverRect)
        window.addEventListener('mouseup', hideHoverRect)

        // dragstart 序列化照抄 plugin-block:slice 进 DataTransfer + view.dragging={slice,move}。
        content.addEventListener('dragstart', (event) => {
          const view = viewRef
          if (!view) return
          view.dom.dataset.dragging = 'true'
          const sel = view.state.selection
          // 拖折叠标题:先展开(否则只拖走标题本身,隐藏小节留在原地、落点处还会错吸新范围)。
          if (sel instanceof NodeSelection && foldStateAt(view, sel.from) === 'folded') toggleFoldAt(view, sel.from)
          if (sel instanceof NodeSelection && listFoldStateAt(view, sel.from) === 'folded') toggleListFoldAt(view, sel.from)
          const multi = sel instanceof TextSelection && !sel.empty && !sel.$from.sameParent(sel.$to)
          if (event.dataTransfer && (sel instanceof NodeSelection || multi)) {
            const slice = sel.content()
            event.dataTransfer.effectAllowed = 'copyMove'
            const { dom, text } = (view as unknown as {
              serializeForClipboard: (s: unknown) => { dom: HTMLElement; text: string }
            }).serializeForClipboard(slice)
            event.dataTransfer.clearData()
            event.dataTransfer.setData('text/html', dom.innerHTML)
            event.dataTransfer.setData('text/plain', text)
            if (activeRef?.el) event.dataTransfer.setDragImage(activeRef.el, 0, 0)
            view.dragging = { slice, move: true } as EditorView['dragging']
          }
        })
        content.addEventListener('dragend', () => {
          const view = viewRef
          hideHoverRect()
          pairRef = null
          belowRef = null
          childRef = null
          tailRef = false
          hideVline()
          hideHline()
          if (view) {
            view.dom.dataset.dragging = 'false'
            view.dragging = null
          }
        })

        // 标题小节折叠钮(AFFiNE 对齐,2026-08-14):active 块是「小节非空的标题」才显示;
        // 三态与常驻展开 widget 由 headingFold.ts 单源提供。
        const fold = document.createElement('button')
        fold.type = 'button'
        fold.className = 'block-add block-fold'
        fold.textContent = '▾'
        fold.style.display = 'none'
        // 同一个钮服务两种折叠:先问标题小节,没有再问列表子项(headingFold / listFold 两套锚各管各的)。
        // ⚠️ 列表**首项**的把手按「首子归外壳」锚在整只列表上(P7 既定口径,拖拽要的就是这个),
        //    所以折叠钮要往里探一格:列表节点 → 它的第一个 list_item。否则首项永远折不起来。
        const listFoldPos = (a: ActiveBlock): number | null => {
          const view = viewRef
          if (!view) return null
          if (listFoldStateAt(view, a.pos)) return a.pos
          if (/_list$/.test(a.node.type.name) && listFoldStateAt(view, a.pos + 1)) return a.pos + 1
          return null
        }
        const foldKindOf = (a: ActiveBlock | null): 'heading' | 'list' | null => {
          const view = viewRef
          if (!view || !a) return null
          if (foldStateAt(view, a.pos)) return 'heading'
          if (listFoldPos(a) != null) return 'list'
          return null
        }
        const syncFold = (a: ActiveBlock | null): void => {
          const view = viewRef
          const kind = foldKindOf(a)
          const lp = a ? listFoldPos(a) : null
          const fs = !view || !a || !kind ? null : kind === 'heading' ? foldStateAt(view, a.pos) : lp == null ? null : listFoldStateAt(view, lp)
          fold.style.display = fs ? '' : 'none'
          fold.textContent = fs === 'folded' ? '▸' : '▾'
          const what = kind === 'list' ? '子项 / children' : '小节 / section'
          fold.title = `${fs === 'folded' ? '展开' : '折叠'}${what}`
        }
        fold.addEventListener('click', (e) => {
          e.stopPropagation()
          const view = viewRef
          const a = activeRef
          if (!view || !a) return
          const lp2 = foldKindOf(a) === 'list' ? listFoldPos(a) : null
          if (lp2 != null) toggleListFoldAt(view, lp2)
          else toggleFoldAt(view, a.pos)
          syncFold(a)
        })

        const add = document.createElement('button')
        add.type = 'button'
        add.className = 'block-add'
        add.textContent = '＋'
        add.title = '在下方插入块 / Add block below'
        add.addEventListener('click', (e) => {
          e.stopPropagation()
          const view = viewRef
          const a = activeRef
          if (!view || !a) return
          const paragraph = view.state.schema.nodes.paragraph
          if (!paragraph) return
          const at = a.pos + a.node.nodeSize
          let tr = view.state.tr.insert(at, paragraph.create())
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1))).scrollIntoView()
          view.dispatch(tr)
          view.focus()
          hide()
        })

        content.append(drag, add, fold)

        // ── 空白处框选多块(AFFiNE:dragStart 命中 root/note 本身才起框,块正文上按下走文字选区)。──
        // 选区语义仍是原生跨块 TextSelection —— 框选只是换一种「圈定范围」的手势,圈完之后的
        // 删除/复制/拖拽全部沿用原生那条路(与整块淡底同一个模型,不另造块选区对象)。
        let marquee: HTMLDivElement | null = null
        let mqFrom: { x: number; y: number } | null = null
        /** 顶层块的 DOM(分栏行下探到 cell 的直接子,列内逐块可框)。 */
        const topBlockEls = (): HTMLElement[] => {
          const out: HTMLElement[] = []
          for (const el of Array.from(editorView.dom.children) as HTMLElement[]) {
            if (el.classList.contains('amx-ucolrow')) {
              for (const cell of Array.from(el.querySelectorAll('.amx-ucolcell')) as HTMLElement[])
                out.push(...(Array.from(cell.children) as HTMLElement[]))
            } else out.push(el)
          }
          return out
        }
        const onMqDown = (e: PointerEvent): void => {
          if (e.button !== 0 || e.pointerType === 'touch') return
          // ⚠️ 画布模式整片让路给舞台自己的框选(canvasStage)。root 是 `.unified-body` —— 舞台是它的
          //    后代,所以这个处理器会**吃到画布上的每一次按下**:两个框选同时起(屏幕上真的两个框),
          //    而且 onMqUp 收尾时会 `editorView.focus()` 把焦点从舞台抢走 —— 现象是画布上选中形状后
          //    按 Delete 毫无反应(键盘事件全去了 PM)。实测抓到的,别把这一行删了。
          if (root.classList.contains('amx-canvas')) return
          const t = e.target as HTMLElement | null
          if (!t || t.closest('.unified-gutter') || t.closest('.amx-embed') || t.closest('button, input, textarea, a')) return
          if (!editorView.editable) return
          // 命中任一块的矩形 = 正文上按下,走原生文字选区;只有落在块与块之间/两侧留白才起框。
          if (topBlockEls().some((el) => {
            const r = el.getBoundingClientRect()
            return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
          })) return
          mqFrom = { x: e.clientX, y: e.clientY }
          marquee = document.createElement('div')
          marquee.className = 'amx-marquee'
          document.body.appendChild(marquee)
          document.body.classList.add('amx-marquee-active')
          window.addEventListener('pointermove', onMqMove)
          window.addEventListener('pointerup', onMqUp as EventListener, { once: true })
        }
        const onMqMove = (e: PointerEvent): void => {
          if (!marquee || !mqFrom) return
          const x = Math.min(mqFrom.x, e.clientX), y = Math.min(mqFrom.y, e.clientY)
          const w = Math.abs(e.clientX - mqFrom.x), h = Math.abs(e.clientY - mqFrom.y)
          Object.assign(marquee.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })
          const hit: number[] = []
          for (const el of topBlockEls()) {
            const r = el.getBoundingClientRect()
            if (r.bottom < y || r.top > y + h || r.right < x || r.left > x + w) continue
            try {
              hit.push(editorView.posAtDOM(el, 0))
            } catch { /* 元素刚被换掉:跳过 */ }
          }
          if (!hit.length) return
          const a = Math.min(...hit)
          const bEl = topBlockEls().filter((el) => {
            const r = el.getBoundingClientRect()
            return !(r.bottom < y || r.top > y + h || r.right < x || r.left > x + w)
          }).pop()
          if (!bEl) return
          let b = a
          try {
            const p = editorView.posAtDOM(bEl, 0)
            const node = editorView.state.doc.nodeAt(p - 1)
            b = node ? p + node.content.size : p
          } catch { /* 同上 */ }
          const doc = editorView.state.doc
          const sel = TextSelection.between(doc.resolve(Math.min(a, doc.content.size)), doc.resolve(Math.min(b, doc.content.size)))
          if (!sel.eq(editorView.state.selection)) editorView.dispatch(editorView.state.tr.setSelection(sel))
        }
        const onMqUp = (e?: PointerEvent): void => {
          window.removeEventListener('pointermove', onMqMove)
          const moved = !!(e && mqFrom && (Math.abs(e.clientX - mqFrom.x) > 4 || Math.abs(e.clientY - mqFrom.y) > 4))
          const start = mqFrom
          marquee?.remove()
          marquee = null
          mqFrom = null
          document.body.classList.remove('amx-marquee-active')
          // 没拖动 = 一次「点空白」:AFFiNE 把光标送到该 y 上最近块的行首/行尾(按点在正文列哪一侧),
          // 而不是什么都不做。拖动过的那次是框选,已经在 onMqMove 里设过选区了。
          if (moved || !start || !e) return
          // ⚠️ 用 posAtCoords(x 钳进编辑区)而不是 DOM 遍历:同一 y 上可能压着零高度的 widget,
          //    按 DOM 挑「第一个 y 命中的元素」会挑错(实测落进一个空块)。钳 x 这一手与 hover
          //    的余白重试同源(见 onMouseMove)。
          const box = editorView.dom.getBoundingClientRect()
          const cx = Math.min(Math.max(e.clientX, box.left + 8), box.right - 8)
          const got = editorView.posAtCoords({ left: cx, top: e.clientY })
          if (!got) return
          const $p = editorView.state.doc.resolve(got.pos)
          if (!$p.parent.isTextblock) return
          const at = e.clientX < box.left + box.width / 2 ? $p.start() : $p.end()
          editorView.dispatch(editorView.state.tr.setSelection(TextSelection.near(editorView.state.doc.resolve(at))))
          editorView.focus()
        }
        root.addEventListener('pointerdown', onMqDown)

        container.appendChild(content)

        // hover 命中:真指针坐标(节流);命中失败**不藏**(块间空隙抖动),离开容器/滚动/打字才藏。
        // 指针在编辑区**左右余白**(pane 内、view.dom 盒外)但与某行同水平线:把 x 钳到编辑区
        // 边缘重试(AFFiNE 同款,余白 hover 也出把手 —— 真机第5振追加项)。
        let lastMove = 0
        // ⚠️ 80ms 节流必须带**后沿**:只做前沿的话,「快速划过去然后停住」的最后一次 move 被丢掉,
        //    把手就停在倒数第二个位置上(指针明明在甲上、把手却锚着甲二)。实测可复现:
        //    先 hover 乙、再 hover 甲,折叠钮不出现 —— 因为生效的是中途那一格。
        let trailTimer: ReturnType<typeof setTimeout> | null = null
        const onMouseMove = (e: MouseEvent): void => {
          const now = Date.now()
          if (now - lastMove < 80) {
            const { clientX, clientY } = e
            if (trailTimer) clearTimeout(trailTimer)
            trailTimer = setTimeout(() => {
              trailTimer = null
              lastMove = Date.now()
              handleMove(clientX, clientY)
            }, 80)
            return
          }
          lastMove = now
          handleMove(e.clientX, e.clientY)
        }
        const handleMove = (clientX: number, clientY: number): void => {
          const e = { clientX, clientY }
          if (editorView.dom.dataset.dragging === 'true') return
          let a = pickBlockAt(editorView, { x: e.clientX, y: e.clientY })
          if (!a) {
            const r = editorView.dom.getBoundingClientRect()
            if (e.clientY >= r.top && e.clientY <= r.bottom && (e.clientX < r.left + 8 || e.clientX > r.right - 8)) {
              const cx = Math.min(Math.max(e.clientX, r.left + 8), r.right - 8)
              a = pickBlockAt(editorView, { x: cx, y: e.clientY })
            }
          }
          if (a) show(a)
        }
        root.addEventListener('mousemove', onMouseMove, { passive: true })
        const onLeave = (e: MouseEvent): void => {
          // 移出 pane 才算离开;移到把手/编辑器任意处不算(都还在 root 里)。
          const to = e.relatedTarget as HTMLElement | null
          if (to && (content.contains(to) || root.contains(to))) return
          hide()
        }
        root.addEventListener('mouseleave', onLeave)
        const onKeyDown = (): void => {
          if (editorView.dom.dataset.dragging !== 'true') hide()
        }
        editorView.dom.addEventListener('keydown', onKeyDown)

        // 右键块 → 选中 + 同一份 ⠿ 菜单(v3 BlockHost onCtxMenu 对位;审计缺口 #11)。
        const onCtxMenu = (e: MouseEvent): void => {
          const view = viewRef
          if (!view) return
          const a = pickBlockAt(view, { x: e.clientX, y: e.clientY })
          if (!a || !NodeSelection.isSelectable(a.node)) return
          e.preventDefault()
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, a.pos)))
          view.focus()
          hooks.onMenu({ x: e.clientX, y: e.clientY })
        }
        editorView.dom.addEventListener('contextmenu', onCtxMenu)

        // 滚动即藏(定位只在 pointermove 时算,滚动中把手会原地漂着不动)。
        const onScroll = (): void => {
          if (editorView.dom.dataset.dragging !== 'true') hide()
        }
        window.addEventListener('scroll', onScroll, { capture: true, passive: true })

        // 拖拽边缘自动滚(真滚动容器是 .amx-pane 一类外层)。
        const onDragOver = (e: DragEvent): void => {
          if (editorView.dom.dataset.dragging !== 'true') return
          const sc = scrollParentOf(editorView.dom)
          if (!sc) return
          const r = sc.getBoundingClientRect()
          if (e.clientY < r.top + 56) sc.scrollTop -= 14
          else if (e.clientY > r.bottom - 56) sc.scrollTop += 14
        }
        window.addEventListener('dragover', onDragOver)

        // 行下方检测(第5振):挂 **root 捕获期**——真机指针在行底以下时多半悬在 .page-tail /
        // pane 空白区(view.dom 的兄弟/祖先),dropIndicator 只监听 view.dom 根本收不到;且这里
        // 不 preventDefault 的话浏览器压根不发 drop(HTML5 DnD 规则),横线冻屏、松手无事发生。
        const onRootDragOver = (e: DragEvent): void => {
          const view = viewRef
          const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : []
          // OS 文件拖入:内容插入仍归 fileDropGuard/importToPage 那条链,但落点得**看得见**——
          // 画一条横线,并在 drop 时把光标先送到线所在处,否则文件恒插在原光标位置、线在撒谎。
          if (types.includes('Files')) {
            if (!view) return
            let hit: HTMLElement | null = null
            for (const el of Array.from(view.dom.children) as HTMLElement[]) {
              const r = el.getBoundingClientRect()
              if (e.clientY >= r.top && e.clientY <= r.bottom) { hit = el; break }
            }
            if (!hit) return
            try {
              const p = view.posAtDOM(hit, 0)
              const node = view.state.doc.nodeAt(p - 1)
              if (!node) return
              const r = hit.getBoundingClientRect()
              fileDropRef = { pos: e.clientY > r.top + r.height / 2 ? p + node.content.size : p }
              showHline(view, hit)
            } catch { /* 元素刚被换掉 */ }
            return
          }
          if (!view || view.dom.dataset.dragging !== 'true') return
          // 末块之下(NodeSelection 与跨块选区都收;画布模式不适用,卡是绝对定位):
          tailRef = false
          if (!inCanvas(view)) {
            const selNow = view.state.selection
            const blocksDrag = selNow instanceof NodeSelection || !!topRangeOf(view)
            const lastEl = view.dom.lastElementChild as HTMLElement | null
            if (blocksDrag && lastEl) {
              const lr = lastEl.getBoundingClientRect()
              const vr = view.dom.getBoundingClientRect()
              if (e.clientY > lr.bottom + 2 && e.clientX >= vr.left && e.clientX <= vr.right) {
                tailRef = true
                pairRef = null
                childRef = null
                belowRef = null
                hideVline()
                showHline(view, lastEl)
                e.preventDefault()
                return
              }
            }
          }
          if (!(view.state.selection instanceof NodeSelection)) return
          // 画布模式:落点指示换成「目标卡描边」。那条横线在这里必然撒谎(卡是绝对定位,画线用的
          // 块矩形彼此重叠),而落点由 executeDropInCanvas 全接管 —— 见它的不变式注释。
          if (inCanvas(view)) {
            markDropCard((e.target as HTMLElement | null)?.closest?.('.amx-ucard') as HTMLElement | null)
            belowRef = null
            hideHline()
            e.preventDefault()
            return
          }
          let belowRow: HTMLElement | null = null
          for (const el of view.dom.querySelectorAll(':scope > .amx-ucolrow')) {
            const r = el.getBoundingClientRect()
            if (e.clientX < r.left || e.clientX > r.right || e.clientY <= r.bottom + 2) continue
            const next = el.nextElementSibling
            if (next && e.clientY >= next.getBoundingClientRect().top - 2) continue
            belowRow = el as HTMLElement
          }
          if (belowRow) {
            try {
              const rowPos = view.posAtDOM(belowRow, 0) - 1
              const rowNode = view.state.doc.nodeAt(rowPos)
              if (rowNode?.type.name === 'amadeusColumnRow') {
                belowRef = { rowEl: belowRow }
                showHline(view, belowRow)
                e.preventDefault()
                return
              }
            } catch {
              // posAtDOM 失效(行刚被改掉):放行默认落点
            }
          }
          belowRef = null
          hideHline()
        }
        root.addEventListener('dragover', onRootDragOver, true)
        // 拖离 pane(去别的面板/窗口):清横线与配对态,别让指示残留到 dragend(Codex P2)。
        const onRootDragLeave = (e: DragEvent): void => {
          const to = e.relatedTarget as HTMLElement | null
          if (to && root.contains(to)) return
          belowRef = null
          fileDropRef = null
          childRef = null
          pairRef = null
          hideVline()
          hideHline()
          markDropCard(null)
        }
        root.addEventListener('dragleave', onRootDragLeave, true)

        // 分栏配对/行下方 drop:捕获期单点路由(挂 root:行下方的 drop 落在 view.dom 之外;
        // 先于 PM/落点插件;失败放行默认落点,绝不半路拦截)。
        const onDropCapture = (e: DragEvent): void => {
          const view = viewRef
          const pr = pairRef
          const br = belowRef
          const cr = childRef
          const fd = fileDropRef
          const tl = tailRef
          pairRef = null
          belowRef = null
          childRef = null
          fileDropRef = null
          tailRef = false
          hideVline()
          hideHline()
          markDropCard(null)
          if (!view) return
          // OS 文件:只把光标送到落点(内容插入归 importToPage 那条链),不 preventDefault。
          if (fd) {
            try {
              view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(fd.pos, view.state.doc.content.size)))))
            } catch { /* 位置已失效 */ }
            return
          }
          // 行下方:对仍连接的行元素**现场**重解析 pos(悬停期事务把缓存 pos 弄脏的话,
          // 旧 pos 可能指到别的行;元素断连/解析失败=放行默认落点)。
          const copy = dragCopies(e)
          // 画布模式的落点全归这一支(不变式见 executeDropInCanvas);它只在「不是 NodeSelection /
          // posAtDOM 失效」时返回 false,那时才退回普通笔记那套。
          let done = inCanvas(view) && executeDropInCanvas(view, e, copy)
          if (!done) {
            if (tl) {
              done = executeMoveToTail(view, copy)
            } else if (topRangeOf(view)) {
              done = executeMoveBlocks(view, e, copy)
            } else if (cr) {
              done = executeMoveIntoList(view, cr.targetPos, copy)
            } else if (br) {
              try {
                if (br.rowEl.isConnected) done = executeMoveBelowRow(view, view.posAtDOM(br.rowEl, 0) - 1, copy)
              } catch {
                done = false
              }
            } else if (pr) {
              done = executePair(view, pr.targetPos, pr.side, copy)
            }
          }
          if (done) {
            e.preventDefault()
            e.stopPropagation()
            view.dom.dataset.dragging = 'false'
            view.dragging = null
          }
        }
        root.addEventListener('drop', onDropCapture, true)

        // 列宽拖拽:按在行的列缝(gap 背景属于 row 元素本身)→ 实时 flexGrow 预览,松手写回 attrs。
        let resizeCleanup: (() => void) | null = null // 拖拽中途卸载/pointercancel 也要摘 window 监听(Codex 终审 P2)
        const onPointerDown = (e: PointerEvent): void => {
          const view = viewRef
          const t = e.target as HTMLElement | null
          if (!view || !t || !t.classList?.contains('amx-ucolrow')) return
          const rowEl = t
          const cells = [...rowEl.children].filter((c): c is HTMLElement => c instanceof HTMLElement && 'amxColcell' in c.dataset)
          let li = -1
          for (let i = 0; i < cells.length - 1; i++) {
            if (e.clientX >= cells[i].getBoundingClientRect().right - 2 && e.clientX <= cells[i + 1].getBoundingClientRect().left + 2) {
              li = i
              break
            }
          }
          if (li < 0) return
          e.preventDefault()
          const L = cells[li]
          const R = cells[li + 1]
          const lLeft = L.getBoundingClientRect().left
          const pxTotal = R.getBoundingClientRect().right - lLeft
          const sumW = (Number(L.dataset.width) || 1) + (Number(R.dataset.width) || 1)
          const frac = (ev: PointerEvent): number => Math.min(0.85, Math.max(0.15, (ev.clientX - lLeft) / pxTotal))
          const move = (ev: PointerEvent): void => {
            const f = frac(ev)
            L.style.flexGrow = String(sumW * f)
            R.style.flexGrow = String(sumW * (1 - f))
          }
          const stop = (): void => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            window.removeEventListener('pointercancel', stop)
            resizeCleanup = null
          }
          const up = (ev: PointerEvent): void => {
            stop()
            const f = frac(ev)
            const round4 = (n: number): number => Math.round(n * 10000) / 10000
            try {
              const rowPos = view.posAtDOM(rowEl, 0) - 1
              const rowNode = view.state.doc.nodeAt(rowPos)
              if (!rowNode || rowNode.type.name !== 'amadeusColumnRow') return
              let at = rowPos + 1
              let tr = view.state.tr
              for (let i = 0; i < rowNode.childCount; i++) {
                const c = rowNode.child(i)
                if (i === li) tr = tr.setNodeMarkup(at, undefined, { ...c.attrs, width: round4(sumW * f) })
                if (i === li + 1) tr = tr.setNodeMarkup(at, undefined, { ...c.attrs, width: round4(sumW * (1 - f)) })
                at += c.nodeSize
              }
              tr.setMeta('amxColumns', true)
              view.dispatch(tr)
            } catch {
              // posAtDOM 失效(行刚被改掉):放弃写回,预览样式随下次渲染消失
            }
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
          window.addEventListener('pointercancel', stop)
          resizeCleanup = stop
        }
        container.addEventListener('pointerdown', onPointerDown)

        return {
          // 锚点块被删/被整节点替换 → 把手立刻失效(否则它还指着一个已经不在的 pos,
          // 接下来的拖拽/菜单会作用到错的地方)。
          update: (v) => {
            if (activeRef && v.state.doc.nodeAt(activeRef.pos) !== activeRef.node) hide()
          },
          destroy: () => {
            window.removeEventListener('mouseup', hideHoverRect)
            hoverRect?.remove()
            hoverRect = null
            if (trailTimer) clearTimeout(trailTimer)
            onMqUp()
            root.removeEventListener('pointerdown', onMqDown)
            root.removeEventListener('mousemove', onMouseMove)
            editorView.dom.removeEventListener('keydown', onKeyDown)
            editorView.dom.removeEventListener('contextmenu', onCtxMenu)
            root.removeEventListener('dragover', onRootDragOver, true)
            root.removeEventListener('dragleave', onRootDragLeave, true)
            root.removeEventListener('drop', onDropCapture, true)
            root.removeEventListener('mouseleave', onLeave)
            container.removeEventListener('pointerdown', onPointerDown)
            resizeCleanup?.()
            window.removeEventListener('scroll', onScroll, { capture: true })
            window.removeEventListener('dragover', onDragOver)
            content.remove()
            vline?.remove()
            vline = null
            hline?.remove()
            hline = null
            pairRef = null
            belowRef = null
            activeRef = null
            if (viewRef === editorView) viewRef = null
          },
        }
      },
    })
  })

  // ── 落点指示线 + 精确落点 drop(prosemirror-drop-indicator)。────────────────────
  // 自绘指示线(不用 @milkdown/plugin-cursor 的 DOM 件):要做 zoomOf 反补偿——
  // position:fixed 元素在 CSS zoom 祖先里,视口 px 直接写 translate 会按 zoom 放大(镜像老坑)。
  const dropIndicator = $prose(() => {
    let dom: HTMLDivElement | null = null
    const ensureDom = (view: EditorView): HTMLDivElement => {
      if (dom && dom.isConnected) return dom
      dom = document.createElement('div')
      dom.className = 'unified-drop-line'
      dom.style.display = 'none'
      // ⚠️ 与 ensureHline 同款:关掉入场动画。`amx-dropline-in` 的 from 里写了 `transform: scaleX(.3)`,
      //    而这条线的位置**全靠内联 transform** —— 动画期间(100ms)CSS 动画压过内联样式,线会跳到
      //    容器原点再弹回来(2026-08-15 spike 探针实锤:量到的 transform 与代码写的对不上)。
      dom.style.animation = 'none'
      ;(view.dom.parentElement ?? document.body).appendChild(dom)
      return dom
    }
    const plugin = createDropIndicatorPlugin({
      onDrag: ({ view, event }) => {
        // OS 文件拖入不归本层(fileDropGuard/importToPage 链路),不出指示线不抢 drop。
        const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : []
        if (types.includes('Files')) return false
        // 画布模式:这条线在这里必然撒谎(卡片绝对定位 → 画线依据的块矩形彼此重叠、DOM 序 ≠ 视觉序),
        // 而落点已由 onDropCapture 的 executeDropInCanvas 全接管。指示改成目标卡描边。
        if (inCanvas(view)) {
          hideVline()
          return false
        }
        // 只接管「从 ⠿ 拖起的整块」(Codex P1):PM 文字选区拖拽/浏览器链接与 HTML 拖入
        // 走 PM 默认落点 —— 精确落点插件会把行内文字硬插到块边界,还 preventDefault 抢默认 drop。
        if (!view.dragging) return false
        if (!(view.state.selection instanceof NodeSelection)) return false
        // 行下方落点归 root 级捕获期 dragover 检测(handlePlugin 的 onRootDragOver:指针多半在
        // view.dom **之外**的 pane 空白区,本插件只挂 view.dom 收不到)——命中期本层全让路。
        if (belowRef) {
          pairRef = null
          childRef = null // ⚠️ 漏清它 = 画的是「落到行后」、执行的却是「塞进列表项当子项」(drop 路由 cr 在 br 之前)
          hideVline()
          return false
        }
        // 分栏配对检测:指针贴目标块左右缘 → 竖线换横线,drop 由捕获期路由消费(pair 期横线不出)。
        const sel = view.state.selection
        const a = pickBlockAt(view, { x: event.clientX, y: event.clientY })
        // 列表项右缘(缩进量以内)→ 变成「放进它当子项」,指示线左端缩进 24px 画在该项下缘。
        if (a && a.node.type.name === 'list_item' && !(a.pos >= sel.from && a.pos < sel.to)) {
          const r = a.el.getBoundingClientRect()
          if (event.clientX > r.left + 24 && event.clientY > r.top + r.height / 2) {
            childRef = { targetPos: a.pos, el: a.el }
            pairRef = null
            hideVline()
            showHline(view, a.el, 24)
            return false
          }
        }
        childRef = null
        if (a && !(a.pos >= sel.from && a.pos < sel.to)) {
          const r = a.el.getBoundingClientRect()
          const side = event.clientX <= r.left + EDGE ? 'left' : event.clientX >= r.right - EDGE ? 'right' : null
          if (side) {
            pairRef = { targetPos: a.pos, side }
            showVline(view, a.el, side)
            return false
          }
        }
        pairRef = null
        hideVline()
        return true
      },
      onShow: ({ view, line }) => {
        const el = ensureDom(view)
        // 与 showHline 同一套补偿(见那两个 helper 的注释):累计视觉缩放 + fixed 包含块原点。
        const z = visualScale(view.dom)
        const o = overlayOrigin(el)
        const x1 = (line.p1.x - o.x) / z
        const x2 = (line.p2.x - o.x) / z
        const y = (line.p1.y - o.y) / z
        el.style.display = 'block'
        el.style.width = `${Math.max(0, x2 - x1)}px`
        el.style.transform = `translate(${Math.round(x1)}px, ${Math.round(y - 1.5)}px)`
      },
      onHide: () => {
        if (dom) dom.style.display = 'none'
      },
    })
    return plugin
  })

  // ── 卡缝插入口(2026-08-19 用户拍板「悬停卡缝出 + 行」,AFFiNE 同款)。──────────────────
  // 闭合锚让「两卡之间的顶层正文」成为合法位置,但两卡相邻时中间没有可点击的光标位 ——
  // 文档模式下,指针悬进相邻两张卡的缝隙带即浮现一条细插入线(中央 ＋),点击 = 在缝隙处插入
  // 空段并落光标。只认「卡↔卡」相邻对:卡↔正文之间本来就有光标位,文首/文末各有标题回车与
  // page-tail 兜底。画布模式不出(卡是绝对定位,缝隙无意义)。
  const gapInsert = $prose(() => {
    let line: HTMLDivElement | null = null
    // ⚠️ 记「缝下那张卡的锚」,不记裸数字位置(Codex 08-19:悬停后键盘编辑再点击,旧 pos 已经
    // 漂进卡内/越界)。点击时按锚现场重解析;update 钩子在 doc 变更后直接藏线。
    let beforeAnchor: string | null = null
    const hide = (): void => { if (line) line.style.display = 'none' }
    return new Plugin({
      key: new PluginKey('AMX_GAP_INSERT'),
      view: (view) => {
        const ensure = (): HTMLDivElement => {
          if (line && line.isConnected) return line
          line = document.createElement('div')
          line.className = 'amx-gap-insert'
          line.innerHTML = '<span>＋</span>'
          line.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
          line.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            if (!beforeAnchor) return
            let pos = -1
            view.state.doc.forEach((n, off) => {
              if (pos < 0 && n.type.name === 'amadeusCanvasCard' && String(n.attrs.anchor) === beforeAnchor) pos = off
            })
            const para = view.state.schema.nodes.paragraph
            if (pos < 0 || !para) { hide(); return }
            let tr = view.state.tr.insert(pos, para.create())
            tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView()
            view.dispatch(tr)
            view.focus()
            hide()
          })
          ;(view.dom.parentElement ?? document.body).appendChild(line)
          return line
        }
        const onMove = (e: MouseEvent): void => {
          if (inCanvas(view) || view.dragging) { hide(); return }
          const card = view.state.schema.nodes.amadeusCanvasCard
          if (!card) { hide(); return }
          const doc = view.state.doc
          let off = 0
          let prevEl: HTMLElement | null = null
          let hit: { top: number; bottom: number; left: number; right: number; anchor: string } | null = null
          for (let i = 0; i < doc.childCount && !hit; i++) {
            const n = doc.child(i)
            if (n.type === card) {
              const el = view.nodeDOM(off)
              if (el instanceof HTMLElement) {
                if (prevEl) {
                  const a = prevEl.getBoundingClientRect()
                  const b = el.getBoundingClientRect()
                  // 缝隙带各向卡内借 3px:文档模式相邻卡几乎零间距,不借就没有可悬停的命中面
                  if (e.clientY >= a.bottom - 3 && e.clientY <= b.top + 3
                    && e.clientX >= Math.min(a.left, b.left) && e.clientX <= Math.max(a.right, b.right)) {
                    hit = { top: a.bottom, bottom: b.top, left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), anchor: String(n.attrs.anchor) }
                  }
                }
                prevEl = el
              } else prevEl = null
            } else prevEl = null
            off += n.nodeSize
          }
          if (!hit) { hide(); return }
          const el2 = ensure()
          const z = visualScale(view.dom)
          const o = overlayOrigin(el2)
          const midY = (hit.top + hit.bottom) / 2
          el2.style.display = 'flex'
          el2.style.width = `${(hit.right - hit.left) / z}px`
          el2.style.transform = `translate(${Math.round((hit.left - o.x) / z)}px, ${Math.round((midY - o.y) / z - 9)}px)`
          beforeAnchor = hit.anchor
        }
        const root = view.dom.parentElement ?? view.dom
        root.addEventListener('mousemove', onMove)
        root.addEventListener('mouseleave', hide)
        return {
          update: (v, prev) => {
            if (!v.state.doc.eq(prev.doc)) hide() // 文档变了:线的几何依据已过期,藏掉等下次悬停重算
          },
          destroy: () => {
            root.removeEventListener('mousemove', onMove)
            root.removeEventListener('mouseleave', hide)
            line?.remove()
            line = null
          },
        }
      },
    })
  })

  // ── Tab 缩进层:分支阶梯全在 blocks/markdown/tabIndent.ts(v3 块世界共用同一份,免得两边
  //    漂移);这里只补 v4 才有的列表折叠钩子。段落分支已改纯缩进档(paragraphIndent.ts),
  //    不再有「并入前列表」,标题折叠钩子(hiddenAt/unfold)随之退役。
  const tabFoldHooks: TabFoldHooks = {
    // sink 的落点是前一兄弟 li 的子列表:兄弟列表折叠着(listFold)先展开(评审 P1)。
    listFoldedAt: (state, itemPos) => isListFolded(state, itemPos),
    unfoldList: (view, itemPos) => toggleListFoldAt(view, itemPos),
  }
  const tabKeymap = $prose(() =>
    keymap({
      Tab: (state, dispatch, view) => tabIndent(state, dispatch, view, tabFoldHooks),
      'Shift-Tab': (state, dispatch) => tabOutdent(state, dispatch),
    }),
  )

  // ── 空块提示(AFFiNE 对齐)。─────────────────────────────────────────────────
  // 光标所在的空文本块给一行灰提示:正文提示斜杠菜单、标题提示自己的级别。样式早就写好了
  // (styles.css 的 `.is-empty::before { content: attr(data-placeholder) }`),只是**从来没人挂**
  // 这两个属性 —— 新用户于是完全不知道有 '/' 这回事。
  // 引用/callout 内不提示(AFFiNE 同款:引用块的 placeholder 恒空);代码块不提示(里面全是字面)。
  const placeholderDeco = $prose(() =>
    new Plugin({
      props: {
        decorations: (state) => {
          const sel = state.selection
          if (!sel.empty) return null
          const $f = sel.$from
          const node = $f.parent
          if (!node.isTextblock || node.content.size > 0) return null
          for (let d = $f.depth; d >= 1; d--) if ($f.node(d).type.name === 'blockquote') return null
          const text =
            node.type.name === 'paragraph' ? "输入 '/' 唤起命令"
            : node.type.name === 'heading' ? `标题 ${node.attrs.level ?? 1}`
            : null
          if (!text) return null
          return DecorationSet.create(state.doc, [
            Decoration.node($f.before(), $f.after(), { class: 'is-empty', 'data-placeholder': text }),
          ])
        },
      },
    }),
  )

  // ── 键盘搬块 Mod-Alt-↑/↓(AFFiNE 另绑 Mod-Shift-↑/↓,两套都收)。────────────────
  // 与前/后一个**同级兄弟**互换位置,光标跟着走(块内偏移原样保留)。v3 块世界靠 keys.moveDir
  // 走 store 换序,统一实例里 ArrowUp/Down 分支整条 `if (unified) return false` 让给原生 ——
  // 于是键盘搬块在 v4 页面上直接消失了(只剩鼠标拖 ⠿)。
  const moveBlock = (dir: -1 | 1) => (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const { $from } = state.selection
    // 搬运单位 = 最内层「可与兄弟换位」的祖先:顶层块,或列表里的**单个列表项**(AFFiNE 是项级,
    // 爬到顶层会把整只列表搬走)。引用/callout 不在名单里 → 整只搬,与把手粒度一致。
    let d = $from.depth
    while (d >= 1 && !['doc', 'amadeusColumnCell', 'bullet_list', 'ordered_list'].includes($from.node(d - 1).type.name)) d--
    if (d < 1) return false
    const parent = $from.node(d - 1)
    const index = $from.index(d - 1)
    const swapWith = index + dir
    if (swapWith < 0 || swapWith >= parent.childCount) return false
    const from = $from.before(d)
    const to = $from.after(d)
    const node = state.doc.nodeAt(from)
    if (!node) return false
    const offset = state.selection.from - from // 块内光标偏移,搬完原样还原
    const siblingSize = parent.child(swapWith).nodeSize
    // 上移:落到前一个兄弟之前(该位置在删除点之前,不受删除影响);
    // 下移:落到后一个兄弟之后(原坐标 to+size,删掉本块后左移 to-from → from+size)。
    const at = dir < 0 ? from - siblingSize : from + siblingSize
    const tr = state.tr.delete(from, to).insert(at, node)
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + offset, tr.doc.content.size))))
    dispatch?.(tr.scrollIntoView())
    return true
  }
  const moveBlockKeymap = $prose(() =>
    keymap({
      'Mod-Alt-ArrowUp': moveBlock(-1),
      'Mod-Alt-ArrowDown': moveBlock(1),
      'Mod-Shift-ArrowUp': moveBlock(-1),
      'Mod-Shift-ArrowDown': moveBlock(1),
    }),
  )

  // ── Mod+A 分级全选(AFFiNE/Notion 对齐)。──────────────────────────────────────
  // 一级=光标所在文本块的内容;二级=它所属的顶层块(列表整只 / 引用整只 / 列内那一块);
  // 三级=整篇。PM 原生只有「整篇」一级 —— 整页一实例之后,那一下会把别的段落一起吞掉,
  // 用户想全选本段却得到全文(块世界里每块一实例时不存在这个问题)。
  // 跨块选区的 Delete/Backspace = 删整块范围(2026-08-19,配合缩进子树/框选的「整体操作」):
  // TextSelection.between 的默认删除按文字语义走,会留一个合并后的**空段壳** —— 块级多选的
  // 语义是「删这些块」,不是「删这段文字」。整节点边界一刀,不留渣。
  const blockRangeDelete = (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView): boolean => {
    const range = view ? topRangeOf(view) : null
    if (!range) return false
    // 两道闸(Codex 08-19 high:卡内 AAA→BBB 的普通跨段选删曾被升级成整卡删除):
    // ① 范围须覆盖 ≥2 个同层块 —— 卡内跨段选区被 topRangeOf 提升成「整张卡」= 1 个块,交还 PM
    //   (Cmd+A 二级的整卡内容选同理:删内容不删卡);
    // ② 选区须顶满整块内容跨度(把手子树/框选=between(from+1,to-1) 恰好顶满);部分选择交还
    //   PM 做文字删除。
    const $f = state.doc.resolve(range.from)
    const $t = state.doc.resolve(range.to)
    if ($t.index() - $f.index() < 2) return false
    const sel = state.selection
    if (sel.from > range.from + 1 || sel.to < range.to - 1) return false
    dispatch?.(state.tr.delete(range.from, range.to).scrollIntoView())
    return true
  }
  const blockDeleteKeymap = $prose(() => keymap({ Backspace: blockRangeDelete, Delete: blockRangeDelete }))

  const selectAllKeymap = $prose(() =>
    keymap({
      'Mod-a': (state, dispatch) => {
        const { $from } = state.selection
        const covers = (a: number, b: number): boolean => state.selection.from <= a && state.selection.to >= b
        const tiers: Array<[number, number]> = []
        if ($from.parent.isTextblock) tiers.push([$from.start(), $from.end()])
        let d = $from.depth
        while (d >= 1 && !['doc', 'amadeusColumnCell'].includes($from.node(d - 1).type.name)) d--
        if (d >= 1) tiers.push([$from.start(d), $from.end(d)])
        for (const [a, b] of tiers) {
          if (covers(a, b)) continue // 这一级已经全在选区里 → 升到下一级
          dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, a, b)))
          return true
        }
        dispatch?.(state.tr.setSelection(new AllSelection(state.doc)))
        return true
      },
    }),
  )

  // ── 多块选中的呈现(AFFiNE 对齐)。─────────────────────────────────────────────
  // 跨块拖选,PM 原生画的是「按行参差的文字高亮」,AFFiNE 画的是整块矩形淡底。这里**只换呈现**:
  // 选区语义仍是原生 TextSelection —— 删除/复制/序列化/撤销全走 PM 与 clipboardTextSerializer
  // 既有的路,不另造一套「块选中 store」(v3 那套是块世界的产物,单实例里没有块 id 可挂)。
  // 覆盖到的每个**顶层块**(doc 或 cell 的直接子节点)加一层节点装饰;列内选中逐块给,不给整行。
  const multiBlockRanges = (state: EditorState): Array<[number, number]> => {
    const sel = state.selection
    if (!(sel instanceof TextSelection) || sel.empty) return []
    const hits: Array<[number, number]> = []
    const collect = (node: ProseNode, contentStart: number): void => {
      node.forEach((child, offset) => {
        const from = contentStart + offset
        const to = from + child.nodeSize
        if (to <= sel.from || from >= sel.to) return // 只碰到边界点的块不算被选中
        if (child.type.name === 'amadeusColumnRow') {
          child.forEach((cell, off2) => collect(cell, from + 1 + off2 + 1))
          return
        }
        hits.push([from, to])
      })
    }
    collect(state.doc, 0)
    return hits.length >= 2 ? hits : [] // 块内选几个字仍归原生文字高亮
  }
  const blockSelDeco = $prose(() =>
    new Plugin({
      props: {
        decorations: (state) => {
          const hits = multiBlockRanges(state)
          if (!hits.length) return null
          return DecorationSet.create(state.doc, hits.map(([f, t]) => Decoration.node(f, t, { class: 'amx-block-selected' })))
        },
        // 开关位:接管期把原生 ::selection 涂透明(CSS 单处,见 styles.css)。
        attributes: (state): Record<string, string> =>
          multiBlockRanges(state).length ? { 'data-blocksel': 'true' } : {},
      },
    }),
  )

  // ── 块选中键盘层:Esc 两段(AFFiNE):文字 → 选中所在块;再 Esc → 回块内文字光标。──────
  const escKeymap = $prose(() =>
    keymap({
      Escape: (state, dispatch) => {
        const sel = state.selection
        if (sel instanceof NodeSelection) {
          const inside = TextSelection.near(state.doc.resolve(sel.from + 1))
          dispatch?.(state.tr.setSelection(inside))
          return true
        }
        if (sel instanceof TextSelection) {
          const at = escTargetPos(state)
          if (at == null) return false
          dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, at)))
          return true
        }
        return false
      },
    }),
  )

  return {
    plugins: [handlePlugin, dropIndicator, gapInsert, blockSelDeco, placeholderDeco, escKeymap, tabKeymap, selectAllKeymap, blockDeleteKeymap, moveBlockKeymap, keyboardPlugins].flat(),
    getView: () => viewRef,
    topRangeOf,
  }
}
