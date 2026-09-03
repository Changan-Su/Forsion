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
import { Fragment } from '@milkdown/kit/prose/model'
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model'
import { createDropIndicatorPlugin } from 'prosemirror-drop-indicator'
import { zoomOf } from '@lcl/engine'
import { runEndOf } from './canvasEdit'
import { tabIndent, tabOutdent, type TabFoldHooks } from '../blocks/markdown/tabIndent'
import { executeMoveBelowRow, executePair, mintCardCopies } from './columns'
import { foldStateAt, foldedSectionAfter, toggleFoldAt } from './headingFold'
import { isListFolded, listFoldStateAt, toggleListFoldAt } from './listFold'
import { keyboardPlugins } from './keyboard'
import { isCoarsePointer } from '../../touch'
import { registerMessages, subscribeLocale, translate } from '../../i18n'

registerMessages({
  'blocklayer.dragHandle': { zh: '点击打开菜单,按住拖动', en: 'Click for menu, hold to drag' },
  'blocklayer.addBelow': { zh: '在下方插入块', en: 'Add block below' },
  'blocklayer.cardGrab': { zh: '选中所在卡片,按住拖动整卡', en: 'Select card, hold to drag it' },
  'blocklayer.expandChildren': { zh: '展开子项', en: 'Expand children' },
  'blocklayer.foldChildren': { zh: '折叠子项', en: 'Collapse children' },
  'blocklayer.expandSection': { zh: '展开小节', en: 'Expand section' },
  'blocklayer.foldSection': { zh: '折叠小节', en: 'Collapse section' },
  'blocklayer.phParagraph': { zh: "输入 '/' 唤起命令", en: "Type '/' for commands" },
  'blocklayer.phHeading': { zh: '标题 {n}', en: 'Heading {n}' },
})

export interface BlockLayerHooks {
  /** 点 ⠿ → 由宿主(UnifiedPage)在该坐标弹块菜单;此刻 NodeSelection 已在(mousedown 设的)。 */
  onMenu: (at: { x: number; y: number }) => void
  /** **整块**删掉了这些内容(块选中 Delete/Backspace)。宿主据此问「引用块牵着的磁盘文件也删吗」。
   *  剪切不发(搬家不是删除),逐字符编辑更不经过这里 —— 判据是结构性的,不靠启发式。
   *  调用时机在 dispatch **之后**:宿主要读删完的文档算「同一篇里还有没有别处引用」。 */
  onBlocksDeleted?: (content: Fragment) => void
  /** 画布层级 tree(2026-08-31,文档模式卡片拖拽用):算「族段」(卡 + 紧随其后的后代卡)与摘爹
   *  判据。tree 的真源在 fm(不在 doc 里),交互层只读 —— 不给 = 单卡粒度、永不摘爹。 */
  canvasTree?: () => Record<string, unknown>
  /** 文档模式把带爹的卡搬走之后**摘爹**(tree 写不进 PM 事务,回宿主走 fm 管线)。
   *  调用时机在搬动 dispatch 之后;复制(Alt 拖)不发 —— 原卡没动,副本当场铸新锚(见下)。 */
  onCardDetach?: (anchors: string[]) => void
  /** Alt 拖复制卡时,副本**当场铸的新锚**(Codex 08-31 high):宿主必须把它们收进 ownedCards ——
   *  否则首次派生把新锚写进盘后,归属判据(stored ⊆ owned)fail-closed,本会话画布派生整体冻结。 */
  onCardsMinted?: (anchors: string[]) => void
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

/** 单独成块的图片/嵌入以可见媒体盒作为交互几何。它们的 PM 段落壳还可能带隐藏源码、基线行盒，
 *  高度会比画面多出一截；拿壳去拉长抓手/画按压框，就会在图片底下多垂几十像素。 */
function visualBlockElement(el: HTMLElement): HTMLElement {
  if (el.tagName !== 'P') return el
  const media = el.querySelector<HTMLElement>(
    ':scope > img:not(.ProseMirror-separator), :scope > .wiki-inline-img-wrap, :scope > .unified-embed',
  )
  if (!media) return el
  // PM 会在叶子图片后补 separator img + trailingBreak；wiki/embed 的源码则留在隐藏 span 里。
  // 它们都不是用户可见的同排内容，不能让 `:only-child` 判据失效。真正混有文字/其它元素时仍用段落壳。
  const visibleSibling = [...el.children].some((child) =>
    child !== media
    && !child.matches('.ProseMirror-separator, .ProseMirror-trailingBreak, .wikilink-src-hidden'),
  )
  const visibleText = [...el.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && !!child.textContent?.trim())
  return visibleSibling || visibleText ? el : media
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
        // cell / 画布卡内首子不归壳(卡:2026-08-31,单行卡的行此前永远抓成整卡,行块拖不出去;
        // 整卡入口 = 悬停卡 padding / Esc 阶梯 / 右键卡缘,把手粒度与 cell 对齐成逐行)。
        !['amadeusColumnCell', 'amadeusCanvasCard'].includes($pos.node($pos.depth).type.name)
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
    // 卡片头/尾**真空带** = 抓整卡(2026-08-31)。首子改行级把手后,指针落在卡内、但在首子之上 /
    // 末子之下的空当(层级框卡的 --amx-frame-pad、卡内末尾留白)时归整卡 —— caretPositionFromPoint
    // 会把这些点吸进最近的行,此前是「首子归外壳」顺带救的,现在显式按几何判。
    // ⚠️ 只认真空区:行与行之间的缝仍归最近的行;自由卡「零装饰无缝」几乎没有真空带,整卡的
    // 主入口是把手栏的抓卡钮(cardGrab,见 handlePlugin)—— 头带取定义宽(如 12px)试过,会吃掉
    // 紧凑单行的行中心,坐标切分是零和的,别再走那条路。
    if ($pos.depth >= 1 && $pos.node($pos.depth).type.name === 'amadeusCanvasCard') {
      const cardPos = $pos.before($pos.depth)
      const cardEl = view.nodeDOM(cardPos)
      if (cardEl instanceof HTMLElement) {
        const first = cardEl.firstElementChild?.getBoundingClientRect()
        const last = cardEl.lastElementChild?.getBoundingClientRect()
        if ((first && coords.y < first.top) || (last && coords.y > last.bottom)) {
          const cardNode = view.state.doc.nodeAt(cardPos)
          if (cardNode) return { node: cardNode, pos: cardPos, el: cardEl }
        }
      }
    }
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
      let content = state.doc.slice(range.from, range.to).content
      if (copy) {
        // 跨块选区可能盖到整卡(topRangeOf 对卡内选区爬升到卡边界):复制必须当场铸新锚+报宿主,
        // 绝不留给 normalizer(理由与漏报后果见 mintCardCopies 顶注,C89 系仪器)。
        const r = mintCardCopies(state.doc, content)
        content = r.content
        if (r.minted.length) hooks.onCardsMinted?.(r.minted)
      }
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
    let content = view.state.doc.slice(range.from, range.to).content
    if (copy) {
      // 同 executeMoveToTail:选区盖到整卡时,副本落在原卡**之前**是常态(画布模式 clientY 扫描
      // 与 doc 序无关)—— 靠 normalizer 事后换锚会劫走原卡锚(C89a 修前红),必须当场铸+报宿主。
      const r2 = mintCardCopies(view.state.doc, content)
      content = r2.content
      if (r2.minted.length) hooks.onCardsMinted?.(r2.minted)
    }
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

  // ── 文档模式的卡片拖拽(2026-08-31,用户实报「文档模式拖不动卡」)。─────────────────────
  //  病根 = 「精确落点 × 完整性闸」的叠加:精确落点插件按「最近块边」取落点,而文档模式相邻卡缝
  //  只有几 px,最近边几乎总在**卡内** —— 卡进卡 = canvasIntegrityGuard 整笔拒(嵌套卡锚进卡辖域
  //  = 重开整篇拒折的毁档防线),于是指示线照画、松手被吞:线在撒谎,纯卡文档里整卡处处不可落。
  //  画布模式有 executeDropInCanvas 全接管,文档模式此前没有对应物 —— 这一支就是它:
  //   · 拖动单位 = 卡的**族段**(卡 + 紧随其后的后代卡;runEndOf 与画层级框/orderUnder 同一把尺)。
  //     只搬卡自己会把父段劈成两半:后代还认爹、却落在父段之外,「排序始终在父 Card 内」当场破
  //     (canvasStage.orderUnder 的 Codex 08-20 告诫,同一条)。
  //   · 落点 = 顶层**单元**(族段 / 普通块)的前/后缝,按指针 y 对单元中线取边。永不产出
  //     「劈开别人族段」或「卡进卡」的位置;指示线与落点出自同一函数 = 线说真话。
  //   · 搬走带爹的卡 = **摘爹**(hooks.onCardDetach,tree 真源在 fm、交互层写不了):文档模式把卡
  //     拖离父段就是「移出去」,留着旧关系 = 缩进框错位的潜在不变式漏洞。父是主卡哨兵 `m:` /
  //     悬空值不摘(那条关系在文档模式不可见,别动);Alt 复制不摘(原卡没动,副本由 normalizer
  //     换新锚,新锚无 tree 条目 = 自由卡)。
  interface CardDocDrop { at: number; lineEl: HTMLElement; edge: 'top' | 'bottom'; expandFold?: number }

  /** doc 顶层的全部卡(锚/顶层序号/位置)。idx 是**顶层子节点序号**(runEndOf 的口径,非数组下标)。 */
  const cardItemsOf = (view: EditorView): Array<{ anchor: string; idx: number; pos: number; size: number }> => {
    const card = view.state.schema.nodes.amadeusCanvasCard
    const items: Array<{ anchor: string; idx: number; pos: number; size: number }> = []
    if (!card) return items
    view.state.doc.forEach((node, offset, index) => {
      if (node.type === card) items.push({ anchor: String(node.attrs.anchor), idx: index, pos: offset, size: node.nodeSize })
    })
    return items
  }

  /** 文档模式卡拖拽的落点(dragover 画线与 drop 执行共用 —— 两边必须同源,线才诚实)。
   *  顶层按「单元」扫:卡的族段合并成一个单元,普通块各自一单元;指针所在单元按中线取前/后缝。 */
  const resolveCardDocDrop = (view: EditorView, e: DragEvent): CardDocDrop | null => {
    const doc = view.state.doc
    const card = view.state.schema.nodes.amadeusCanvasCard
    if (!card) return null
    const tree = hooks.canvasTree?.() ?? {}
    const items = cardItemsOf(view)
    const runHead = new Map<number, number>() // 族段首卡的 items 下标 → 段尾(不含)
    for (let i = 0; i < items.length;) {
      const end = runEndOf(items, i, tree)
      runHead.set(i, end)
      i = end
    }
    const elAt = (p: number): HTMLElement | null => {
      const d = view.nodeDOM(p)
      return d instanceof HTMLElement ? d : null
    }
    const units: Array<{ from: number; to: number; firstEl: HTMLElement | null; lastEl: HTMLElement | null; foldPos?: number }> = []
    let pos = 0
    let itemIdx = 0
    let skipUntil = -1 // 折叠小节的隐藏区:整段并进标题单元,区内子节点(含卡)不再各自成单元
    for (let i = 0; i < doc.childCount; i++) {
      const child = doc.child(i)
      if (pos < skipUntil) {
        if (child.type === card) itemIdx++
        pos += child.nodeSize
        continue
      }
      if (child.type === card) {
        const end = runHead.get(itemIdx) // 段内非首卡拿不到 = 已并入前一单元,跳过
        if (end != null) {
          const last = items[end - 1]
          units.push({ from: pos, to: last.pos + last.size, firstEl: elAt(pos), lastEl: elAt(last.pos) })
        }
        itemIdx++
      } else {
        // 折叠标题 = 标题 + 隐藏小节一个单元(Codex 08-31 medium):各自独立对待的话,标题下缘的
        // 落点恰好落进 display:none 的小节里 —— 线画在明处、卡掉进暗处「当场消失」。
        // ⚠️ 只挪到 foldedSectionAfter 还不够:小节的结构边界是「下一枚同级标题」,卡不像
        //    键盘层插的同级标题那样自己终结小节 —— 落在 after 位下次重算隐藏区照样把卡吞回暗处。
        //    所以下缘落卡 = **先展开该标题再插**(Notion 收起态 toggle 的同款语义;expandFold
        //    由 executeCardDropInDoc 消费);隐藏区里的块一概不可当落点。
        let to = pos + child.nodeSize
        let foldPos: number | undefined
        if (child.type.name === 'heading' && foldStateAt(view, pos) === 'folded') {
          const after = foldedSectionAfter(view.state, pos)
          if (after != null) {
            to = after
            skipUntil = after
            foldPos = pos
          }
        }
        units.push({ from: pos, to, firstEl: elAt(pos), lastEl: elAt(pos), foldPos })
      }
      pos += child.nodeSize
    }
    let lastSeen: CardDocDrop | null = null
    for (let ui = 0; ui < units.length; ui++) {
      const u = units[ui]
      if (!u.firstEl || !u.lastEl) continue // 元素刚被换掉:跳过这一单元
      const top = u.firstEl.getBoundingClientRect().top
      const bottom = u.lastEl.getBoundingClientRect().bottom
      lastSeen = { at: u.to, lineEl: u.lastEl, edge: 'bottom', expandFold: u.foldPos }
      if (e.clientY > bottom) continue
      // ⚠️ 上缘与「前一单元的下缘」是同一个结构位置(顶层节点连续):前一单元是折叠标题时,
      //    这里也得带上它的 expandFold —— 否则从缝隙上半/下一标题上半落卡,插进的还是小节
      //    结构之内,重算隐藏区照样吞卡(Codex 二轮 medium)。位置在自己小节之外的普通上缘,
      //    positional 前驱不是折叠单元,expandFold 自然是 undefined。
      const before = ui > 0 ? units[ui - 1] : null
      return e.clientY <= (top + bottom) / 2
        ? { at: u.from, lineEl: u.firstEl, edge: 'top', expandFold: before && before.foldPos != null && before.to === u.from ? before.foldPos : undefined }
        : lastSeen
    }
    return lastSeen // 指针在末单元之下 = 插到文末
  }

  /** 完整落点计划:落点 + 被拖族段范围 + 是否落回自己(no-op)。非卡拖拽 → null。 */
  const planCardDocDrop = (view: EditorView, e: DragEvent): { drop: CardDocDrop; range: { from: number; to: number }; self: boolean } | null => {
    const sel = view.state.selection
    const card = view.state.schema.nodes.amadeusCanvasCard
    if (!card || !(sel instanceof NodeSelection) || sel.node.type !== card) return null
    const drop = resolveCardDocDrop(view, e)
    if (!drop) return null
    const tree = hooks.canvasTree?.() ?? {}
    const items = cardItemsOf(view)
    const di = items.findIndex((it) => it.pos === sel.from)
    if (di < 0) return null
    const last = items[runEndOf(items, di, tree) - 1]
    const range = { from: sel.from, to: last.pos + last.size }
    return { drop, range, self: drop.at >= range.from && drop.at <= range.to }
  }

  const executeCardDropInDoc = (view: EditorView, e: DragEvent, copy: boolean): boolean => {
    const sel = view.state.selection
    const card = view.state.schema.nodes.amadeusCanvasCard
    if (!card || !(sel instanceof NodeSelection) || sel.node.type !== card) return false
    const plan = planCardDocDrop(view, e)
    if (!plan || plan.self) return true // 吞掉:no-op 远好过退回默认路径塞进非法位再被闸拒
    let content = view.state.doc.slice(plan.range.from, plan.range.to).content
    if (copy) {
      // Alt 复制:副本**此刻就铸新锚**+报宿主(理由与漏报后果见 mintCardCopies 顶注,Codex 08-31
      // high ×2)。原卡锚永不动;副本不带 tree 条目 = 自由卡(既定口径)。
      const r = mintCardCopies(view.state.doc, content)
      content = r.content
      if (r.minted.length) hooks.onCardsMinted?.(r.minted)
    }
    // 折叠标题下缘的落点在小节结构之内 —— 先展开再插,否则卡进了 display:none(见 resolver 注释)。
    // toggleFoldAt 只动会话态 deco,不产生 doc step,at 不用重算。
    if (plan.drop.expandFold != null && foldStateAt(view, plan.drop.expandFold) === 'folded') toggleFoldAt(view, plan.drop.expandFold)
    let tr = view.state.tr
    if (!copy) tr = tr.delete(plan.range.from, plan.range.to)
    tr = tr.insert(tr.mapping.map(plan.drop.at), content)
    tr.setMeta('amxColumns', true)
    view.dispatch(tr.scrollIntoView())
    if (!copy) {
      const anchor = String(sel.node.attrs.anchor)
      const tree = hooks.canvasTree?.() ?? {}
      const parent = tree[anchor]
      // 只摘「父是在场卡锚」的关系:主卡哨兵/悬空父在文档模式本就不可见,别动(canvasEdit.depthOf 同口径)。
      if (typeof parent === 'string' && cardItemsOf(view).some((it) => it.anchor === parent)) hooks.onCardDetach?.([anchor])
    }
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
  const showHline = (view: EditorView, rowEl: HTMLElement, indent = 0, edge: 'bottom' | 'top' = 'bottom'): void => {
    const dom = ensureHline(view)
    const z = visualScale(view.dom)
    const o = overlayOrigin(dom)
    const r = rowEl.getBoundingClientRect()
    const y = edge === 'top' ? r.top - 6 : r.bottom + 6 // top:卡拖拽的「插到单元之前」画在上缘
    dom.style.display = 'block'
    dom.style.width = `${Math.max(0, r.width - indent) / z}px`
    dom.style.transform = `translate(${Math.round((r.left + indent - o.x) / z)}px, ${Math.round((y - o.y) / z)}px)`
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
          cardGrab.style.display = cardHostOf(a) ? '' : 'none' // 卡内块才出「抓整卡」钮
          // 绝对定位(布局 px):视口 rect ÷ 累计视觉缩放反补偿,把手压到块首行行高中点(AFFiNE 手感)。
          // `.milkdown` 在画布模式是 position:static 且宽度为 0；拿它量 visualScale 会退化成
          // 仅 CSS zoom、漏掉 stage-inner 的 transform scale。PM 根始终有实体宽度，能同时量到两级缩放。
          const z = visualScale(editorView.dom)
          // 画布模式会把 `.milkdown` 改成 position:static，让 stage-inner 成为真正的 absolute
          // containing block；用 container.rect 当原点会把舞台 pan 整段重复算进 left/top，缩放后
          // 偏移还会继续放大。始终从把手自己的真实包含块取原点，文档/画布两种布局都成立。
          const o = overlayOrigin(content)
          const geometryEl = visualBlockElement(a.el)
          const r = geometryEl.getBoundingClientRect()
          // list_item 的边框盒从正文左缘开始，已包含当前 ul/ol 的 marker gutter；直接拿 r.left
          // 会让顶层 bullet 的把手比普通段落右移整整 1.4em。把手横轴改锚到当前列表容器左缘：
          // 只去掉“本层标记槽”，嵌套列表的父级左移量仍在，因此真正层级/Tab 缩进不会被抹平。
          const list = a.el.tagName === 'LI' && /^(UL|OL)$/.test(a.el.parentElement?.tagName ?? '')
            ? a.el.parentElement
            : null
          const anchorLeft = list?.getBoundingClientRect().left ?? r.left
          const cs = getComputedStyle(geometryEl)
          const lh = Number.parseFloat(cs.lineHeight) || 24
          const pt = Number.parseFloat(cs.paddingTop) || 0
          const lineOffset = pt + Math.max(0, (lh - 24) / 2)
          const blockH = r.height / z
          const grownH = Math.max(24, blockH - 16)
          // 长块 hover 时抓手会从 24px 拉到“块高 - 16px”。它原本仍以首行 24px 槽的中心为轴
          // 向上下同时生长，于是多行块/图片越高，顶部越跑到块外（截图里的长灰条即此）。补一个
          // 向下位移，让拉长后的上下沿恒落在块内各 8px；短块仍保持 0 位移。
          const growY = grownH > 24 ? grownH / 2 - 4 - lineOffset : 0
          content.dataset.show = 'true'
          content.style.setProperty('--amx-block-h', `${blockH}px`) // hover 拉长用(见 styles.css)
          content.style.setProperty('--amx-block-grow-y', `${growY}px`)
          const w = content.offsetWidth || 52
          content.style.top = `${(r.top - o.y) / z + lineOffset}px`
          content.style.left = `${(anchorLeft - o.x) / z - w - 8}px`
        }

        const drag = document.createElement('button')
        drag.type = 'button'
        drag.className = 'drag-handle'
        drag.textContent = '⠿'
        drag.draggable = true
        drag.title = translate('blocklayer.dragHandle')
        drag.addEventListener('click', (e) => {
          e.stopPropagation()
          const r = drag.getBoundingClientRect()
          hooks.onMenu({ x: r.left, y: r.bottom + 4 })
          // 焦点收回编辑器:mousedown 的浏览器默认行为把焦点给了 ⠿ 这个 <button>,不收回的话
          // 菜单一开,键盘就整片失效(块选着却 Cmd+C/Delete 无反应)。菜单是浮层,不吃焦点也照用。
          // ⚠️ 触屏上不收:focus 会弹安卓软键盘,把这个向上弹的浮层从手指底下顶走(见 touch.ts
          //    顶注与 check:menutap);手机上本来也没有快捷键可按。
          if (!isCoarsePointer()) viewRef?.focus()
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
          const r = visualBlockElement(a.el).getBoundingClientRect()
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
        /** 标题折叠锚。⚠️ 与列表同一条「首子归外壳」规矩:hover 卡/分栏格的**首块**时把手锚在
         *  外壳上(a.pos = 卡的前位),折叠钮要往里探一格才够得着那个标题 —— 否则卡内第一个标题
         *  永远不出钮(2026-08-20 探针实测:卡内 H2 有钮、卡内首行 H1 没钮,就是这一格之差)。
         *  探一格对文本块无害:段落 +1 落进 inline,headingSiteAt 判不出标题,自然返回 null。 */
        const headFoldPos = (a: ActiveBlock): number | null => {
          const view = viewRef
          if (!view) return null
          if (foldStateAt(view, a.pos)) return a.pos
          // ⚠️ `childCount > 0` 不能省(Codex 2026-08-20):分割线是**非文本块的叶子**、nodeSize=1,
          //    只挡 isTextblock 的话 a.pos+1 落到的是它**后面那个块**的前位 —— 下一块恰是可折叠
          //    标题时,折叠钮会长在分割线的把手上,点下去折的是别人的小节。
          if (!a.node.isTextblock && a.node.childCount > 0 && foldStateAt(view, a.pos + 1)) return a.pos + 1
          return null
        }
        const foldKindOf = (a: ActiveBlock | null): 'heading' | 'list' | null => {
          const view = viewRef
          if (!view || !a) return null
          if (headFoldPos(a) != null) return 'heading'
          if (listFoldPos(a) != null) return 'list'
          return null
        }
        const syncFold = (a: ActiveBlock | null): void => {
          const view = viewRef
          const kind = foldKindOf(a)
          const lp = a ? listFoldPos(a) : null
          const hp = a ? headFoldPos(a) : null
          const fs = !view || !a || !kind ? null : kind === 'heading' ? (hp == null ? null : foldStateAt(view, hp)) : lp == null ? null : listFoldStateAt(view, lp)
          fold.style.display = fs ? '' : 'none'
          fold.textContent = fs === 'folded' ? '▸' : '▾'
          // 四个字面键(别拼 key):i18nCoverage 的 C 断言只认字面量,动态拼出来的键漏了也不会红。
          fold.title =
            kind === 'list'
              ? fs === 'folded' ? translate('blocklayer.expandChildren') : translate('blocklayer.foldChildren')
              : fs === 'folded' ? translate('blocklayer.expandSection') : translate('blocklayer.foldSection')
        }
        fold.addEventListener('click', (e) => {
          e.stopPropagation()
          const view = viewRef
          const a = activeRef
          if (!view || !a) return
          const lp2 = foldKindOf(a) === 'list' ? listFoldPos(a) : null
          if (lp2 != null) toggleListFoldAt(view, lp2)
          else {
            const hp2 = headFoldPos(a)
            if (hp2 == null) return
            toggleFoldAt(view, hp2)
          }
          syncFold(a)
        })

        const add = document.createElement('button')
        add.type = 'button'
        add.className = 'block-add'
        add.textContent = '＋'
        add.title = translate('blocklayer.addBelow')
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

        // 卡片抓手(2026-08-31):悬停块在某张画布卡**里**时,把手栏多出这一颗「抓整卡」。
        // 首子改行级把手后,自由卡(零装饰无缝)失去了可发现的整卡鼠标入口 —— 头/尾真空带只有
        // 几 px,定义宽的头带又会吃掉紧凑单行的行中心(坐标切分是零和的)。与折叠钮同一先例:
        // 按上下文出现的 gutter 钮。点击 = 选中整卡开菜单;拖动 = 整卡拖拽(mousedown 把
        // NodeSelection 与 activeRef 都换成卡,dragstart 序列化/按压框/拖影全部顺着既有链路走)。
        const cardGrab = document.createElement('button')
        cardGrab.type = 'button'
        // ⚠️ 类名不能带 drag-handle:既有仪器/辅助函数全按「gutter 里唯一一颗 .drag-handle」取钮,
        //    共用类名 = querySelector 抓到这颗隐藏钮,拖拽起手全体失灵(unified-page/C2 双红实测)。
        cardGrab.className = 'card-grab'
        cardGrab.textContent = '❏'
        cardGrab.draggable = true
        cardGrab.title = translate('blocklayer.cardGrab')
        cardGrab.style.display = 'none'
        /** 悬停块所在的卡(自身就是卡 → null,主把手已经是它)。 */
        const cardHostOf = (a: ActiveBlock | null): ActiveBlock | null => {
          const view = viewRef
          if (!view || !a || a.node.type.name === 'amadeusCanvasCard') return null
          try {
            const $p = view.state.doc.resolve(a.pos)
            for (let d = $p.depth; d >= 1; d--) {
              if ($p.node(d).type.name !== 'amadeusCanvasCard') continue
              const pos = $p.before(d)
              const node = view.state.doc.nodeAt(pos)
              const el = view.nodeDOM(pos)
              return node && el instanceof HTMLElement ? { node, pos, el } : null
            }
          } catch { /* 块刚被换掉 */ }
          return null
        }
        cardGrab.addEventListener('mousedown', (e) => {
          const view = viewRef
          const host = cardHostOf(activeRef)
          if (!view || !host) return // 没有宿主卡(不该可见):放行给 content 走行级老路
          // 不给 content 的 mousedown 把选区收回行级;按压框改由这里画(它也被 stopPropagation 挡了)。
          e.stopPropagation()
          activeRef = host // 拖影 / 按压框 / update 失效守卫全按卡走
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, host.pos)))
          view.focus()
          showHoverRect()
        })
        cardGrab.addEventListener('click', (e) => {
          e.stopPropagation()
          if (!activeRef) return
          const r = cardGrab.getBoundingClientRect()
          hooks.onMenu({ x: r.left, y: r.bottom + 4 })
          if (!isCoarsePointer()) viewRef?.focus()
        })

        content.append(cardGrab, drag, add, fold)

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
          // 框选收尾必须把焦点收回编辑器:框选是在**空白**上按下的,焦点还留在 body ——
          // 选中一片块之后 Delete / Cmd+C / Cmd+X 全部没反应(键盘事件压根到不了 PM),
          // 用户实报的「必须通过菜单」就是这条。2026-08-20 探针实测 activeElement=BODY。
          if (moved) {
            editorView.focus()
            return
          }
          // 没拖动 = 一次「点空白」:AFFiNE 把光标送到该 y 上最近块的行首/行尾(按点在正文列哪一侧),
          // 而不是什么都不做。拖动过的那次是框选,已经在 onMqMove 里设过选区了。
          if (!start || !e) return
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
          // 文档模式的卡片拖拽:整支自管(见 executeCardDropInDoc 顶注)。精确落点/尾巴/分栏配对
          // 全让路;指示线画在将要执行的顶层缝上(与 drop 同一个 plan 函数 = 线说真话)。
          // 落回自己族段 = 不画线不 preventDefault(真机上浏览器给「不可放」光标,drop 不会发)。
          {
            const selNow = view.state.selection
            if (!inCanvas(view) && selNow instanceof NodeSelection && selNow.node.type === view.state.schema.nodes.amadeusCanvasCard) {
              tailRef = false
              pairRef = null
              childRef = null
              belowRef = null
              hideVline()
              const plan = planCardDocDrop(view, e)
              if (plan && !plan.self) {
                showHline(view, plan.drop.lineEl, 0, plan.drop.edge)
                e.preventDefault()
              } else hideHline()
              return
            }
          }
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
          // 画布模式的落点全归 executeDropInCanvas(不变式见其顶注);文档模式的**卡片**拖拽全归
          // executeCardDropInDoc(非卡拖拽它返回 false,照旧走下面的普通路由)。
          let done = inCanvas(view)
            ? executeDropInCanvas(view, e, copy)
            : executeCardDropInDoc(view, e, copy)
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

        // 三颗常驻钮的 title 只在建 DOM 时写过一次 —— 切语言不重建编辑器,不订阅就永远停在旧语言。
        // (fold.title 每次 syncFold 重算、空块 placeholder 随 decorations 重算,都不用管。)
        const offLocale = subscribeLocale(() => {
          drag.title = translate('blocklayer.dragHandle')
          add.title = translate('blocklayer.addBelow')
          cardGrab.title = translate('blocklayer.cardGrab')
        })

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
            offLocale()
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
        // 文档模式的卡片拖拽整支归 onRootDragOver / executeCardDropInDoc 自管(2026-08-31):
        // 「最近块边」对卡是撒谎源(相邻卡缝几 px,最近边常在卡内 → 完整性闸整笔拒),
        // 这里全让路,线由那边画在合法顶层缝上。
        if (view.state.selection.node.type === view.state.schema.nodes.amadeusCanvasCard) return false
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
                // 层级框内部不给插入口(2026-08-20):框是「段首画上沿、段末画下沿」合出来的,
                // 往段中插一个段落 = 把段切断,框当场从中间裂开。要在父子之间加正文,先把子卡
                // 拖出这一段。判据 = 本卡是框成员但不是段首 → 它上面那道缝在框里。
                if (el.classList.contains('amx-card-f0') && !el.classList.contains('amx-card-f0-top')) {
                  prevEl = el
                  off += n.nodeSize
                  continue
                }
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
            node.type.name === 'paragraph' ? translate('blocklayer.phParagraph')
            : node.type.name === 'heading' ? translate('blocklayer.phHeading', { n: node.attrs.level ?? 1 })
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
  const blockRangeDelete = (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView, cut = false): boolean => {
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
    if (!dispatch) return true
    const removed = state.doc.slice(range.from, range.to).content
    dispatch(state.tr.delete(range.from, range.to).scrollIntoView())
    if (!cut) hooks.onBlocksDeleted?.(removed)
    return true
  }

  /** 块选中(NodeSelection)按 Delete/Backspace:PM base 的 deleteSelection 逐字对齐,只多发一次
   *  onBlocksDeleted —— 文件引用块最常见的删法就是「点 ⠿ 选中 → Delete」。 */
  const nodeSelDelete = (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const sel = state.selection
    if (!(sel instanceof NodeSelection)) return false
    if (!dispatch) return true
    const removed = Fragment.from(sel.node)
    dispatch(state.tr.deleteSelection().scrollIntoView())
    hooks.onBlocksDeleted?.(removed)
    return true
  }
  const blockDel = (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView): boolean =>
    blockRangeDelete(state, dispatch, view) || nodeSelDelete(state, dispatch)
  const blockDeleteKeymap = $prose(() => keymap({ Backspace: blockDel, Delete: blockDel }))

  // 跨块选区的**剪切**同理:PM 自带的 cut = 复制 + deleteSelection(文字语义)= 留一个空段壳。
  // 这里只在 blockRangeDelete 认账(≥2 个同层块、且顶满整块跨度)时接管,序列化照抄 dragstart
  // 那份 serializeForClipboard;其余一律交回 PM。复制(copy)不用管 —— 它本来就没有删除那一步。
  const blockCutPlugin = $prose(() => new Plugin({
    props: {
      handleDOMEvents: {
        cut: (view, event) => {
          const e = event as ClipboardEvent
          if (!e.clipboardData || !blockRangeDelete(view.state, undefined, view, true)) return false
          const { dom, text } = (view as unknown as {
            serializeForClipboard: (s: unknown) => { dom: HTMLElement; text: string }
          }).serializeForClipboard(view.state.selection.content())
          e.preventDefault()
          e.clipboardData.clearData()
          e.clipboardData.setData('text/html', dom.innerHTML)
          e.clipboardData.setData('text/plain', text)
          blockRangeDelete(view.state, view.dispatch.bind(view), view, true)
          return true
        },
      },
    },
  }))

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
    plugins: [handlePlugin, dropIndicator, gapInsert, blockSelDeco, placeholderDeco, escKeymap, tabKeymap, selectAllKeymap, blockDeleteKeymap, blockCutPlugin, moveBlockKeymap, keyboardPlugins].flat(),
    getView: () => viewRef,
    topRangeOf,
  }
}
