// v4 统一编辑器的「块上画布」数据层(2026-08-16 Phase 1,方案见 docs/Function/Amadeus-Canvas双模式方案.md)。
//
// 形态 = 分栏(columns.ts)的直系:单实例内的 PM 自定义节点 `amadeusCanvasCard`(attrs
// `{anchor,x,y,w,h}`),磁盘上是「开锚 + 内容 + 闭合符」的双标记包裹区(2026-08-19 改版,
// `<!-- a k -->…<!-- /a k -->`),几何存 fm 单键 `amadeus_canvas`。闭合锚让卡可以合法住在
// 文档任何位置(旧「卡区收尾」不变式 = 本周全部毁档的病根,已退役);读侧兼容旧形(无闭合符
// = 辖域到下一开锚或文件尾),文件一经保存即迁移。⚠️ parseBody(compiler/markers)已学会在
// 闭合符收束块辖域 —— 改那边同时须 cp server vendor(microserver/amadeus/vendor/markers.ts)。
//
// 三条与分栏不同、值得单独记住的取舍:
//
// 1. **两种模式共用同一次折叠**(方案 §5 原文设想的是「两套折叠配置」)。改成一套的理由:
//    不折叠时 `<!-- a c1 -->` 会以字面 html 块的形态出现在文档模式的正文里 —— 用户的原话是
//    「它首先是个文档」,文档里冒出注释行就不成立了。折成节点之后,模式只决定 CSS(文档模式=
//    普通顺流块,画布模式=绝对定位卡片),派生路径只有一条,两模式不可能各自派生出不同的 cards。
//
// 2. **cards 之外的字段逐字保留**(方案 §4 组装点唯一 / §8 未知键)。cards 段的真源是 PM 节点
//    attrs(换取移动/调宽进 PM 撤销栈),mode/main/elements 与任何未知键的真源是磁盘上那行 JSON。
//    派生 = 读那行 → **只替换 cards** → 回吐。绝不重建整个对象,否则 Phase 2 的 elements 会被
//    Phase 1 的代码当场吃掉。
//
// 3. **懒物化**(用户 2026-08-16 拍板:「点开了画布才开始添加画布模式所需要的东西」)。没有卡片
//    且磁盘上原本就没有 canvas 键 → 派生恒返回 null,一个字节都不写。切到画布模式**本身不算**
//    使用画布(方案 §4 同款纪律),只是换个视角看同一篇文档。
import { $nodeSchema, $prose, $remark } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { Plugin, PluginKey, NodeSelection, TextSelection, AllSelection, type Selection, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { undoDepth, isHistoryTransaction } from '@milkdown/kit/prose/history'
import { Fragment, Slice } from '@milkdown/kit/prose/model'
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model'
import { freshAnchorId, type LayoutV4 } from './columns'
import { rawTree, pruneTree, depthOf } from './canvasEdit'

/** 卡片几何。坐标一律取整(方案 §3.1 量化,控制 fm 体积);h 省略 = 随内容自适应。 */
export interface CanvasCard { ref: string; x: number; y: number; w: number; h?: number }
/** 主卡几何(未入卡的自然流全部)。 */
export interface CanvasMain { x: number; y: number; w: number }
export interface CanvasV1 {
  v: number
  mode?: 'doc' | 'canvas'
  main?: CanvasMain
  cards?: CanvasCard[]
  /** Phase 2 白板元素。本期不渲染、不校验内部形状,**原样保管**(方案 §8:老画布端绝不吞新画布端的元素)。 */
  elements?: unknown[]
  /** 节点层级(2026-08-18,用户拍板「像 mindmap 记代号」):`{ 子卡锚: 父卡锚 }`。
   *  ⚠️ **不进正文**,也**不物化成 elements 里的连线** —— 层级是唯一真源,画出来的那条线是它的呈现。
   *  同一件事存两份必然分叉(手动删掉线 ≠ 解除父子)。
   *  ⚠️ 这里**不做形状校验**(与 elements 同待遇):校验放在渲染侧的 safeTree,一条手改坏的父子关系
   *  不许让整行 fail-closed 把用户的画布几何一起带走。 */
  tree?: Record<string, unknown>
  [k: string]: unknown
}

export const CANVAS_V = 1
/** 新卡默认宽度与主卡默认宽度(px,舞台坐标系)。 */
export const CARD_W = 400
export const MAIN_W = 720

const MARKER_RE = /^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->$/
/** 闭合符(2026-08-19 用户拍板「双标记包裹」):`<!-- /a k1 -->`,带 ref 自描述。
 *  写侧恒发;读侧兼容旧形(无闭合符 = 辖域到下一开锚或文件尾,编辑保存即迁移)。 */
const CLOSE_RE = /^<!--\s*\/a\s+([A-Za-z0-9_-]+)\s*-->$/
const ID_RE = /^[A-Za-z0-9_-]+$/

const int = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt)

/** amadeus_canvas 单行 JSON → 校验过形状的 CanvasV1;任何不对 → null(fail-closed:本次会话按无画布
 *  处理,而**调用方必须逐字保留原行**,方案 §3.2 —— 解析不了不等于可以抹掉用户的画布)。
 *  ⚠️ `v` 超出认知同样返回 null(方案 §8 schemaTooNew 精神):新端写的画布在老端上只是「看不见」,
 *  不会被老端重排成畸形。 */
export function parseCanvasJson(raw: string | null): CanvasV1 | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const c = v as CanvasV1
    if (c.v !== CANVAS_V) return null
    if (c.mode != null && c.mode !== 'doc' && c.mode !== 'canvas') return null
    // ⚠️ 必须 `typeof === 'number'`,不能用 `Number.isFinite(Number(v))`:后者把 `"900"` 判成合法,
    //    而下游的 `int()` 只认真 number → 静默回默认值,用户的坐标/宽度当场丢成 0/400(Codex P1)。
    //    类型不符一律整键 fail-closed,由调用方逐字保留。
    const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
    if (c.main != null) {
      if (typeof c.main !== 'object' || !num(c.main.w) || c.main.w <= 0) return null
      if (!num(c.main.x) || !num(c.main.y)) return null
    }
    if (c.cards != null) {
      if (!Array.isArray(c.cards)) return null
      for (const card of c.cards) {
        if (!card || typeof card !== 'object') return null
        if (typeof card.ref !== 'string' || !ID_RE.test(card.ref)) return null
        if (!num(card.w) || card.w <= 0) return null
        if (!num(card.x) || !num(card.y)) return null
        if (card.h != null && (!num(card.h) || card.h < 0)) return null
      }
      // 同一锚出现两次 = 歧义,整键作废(与分栏「重复锚两处都作废」同口径)。
      const refs = c.cards.map((x) => x.ref)
      if (new Set(refs).size !== refs.length) return null
    }
    if (c.elements != null && !Array.isArray(c.elements)) return null
    return c
  } catch {
    return null
  }
}

/** 分栏已经占用的锚(refs + tail)。画布与分栏**绝不许引用同一枚锚**(方案 §3.2 互斥不变式):
 *  两个折叠器争同一段源码,先跑的那个赢,结果随插件注册顺序漂移。读侧由画布让位。 */
export function layoutAnchors(layout: LayoutV4 | null): Set<string> {
  const s = new Set<string>()
  for (const row of layout?.rows ?? []) {
    for (const col of row.columns) for (const r of col.refs) s.add(r)
    if (row.tail) s.add(row.tail)
  }
  return s
}

export const canvasCardSchema = $nodeSchema('amadeusCanvasCard', () => ({
  content: 'block+',
  group: 'block',
  defining: true,
  isolating: true, // 卡边界不参与 Backspace join:卡首退格不吞进上一张卡(同分栏 cell)
  // ⚠️ 与分栏 row/cell 相反,卡片**可整体选中**。分栏那边禁选是因为一次误删丢的是两列内容,
  // 而卡片就是一个视觉单元,选中即删正是用户预期,且可撤销。更要紧的是:不可选 = 拿不到
  // NodeSelection = ⠿ 拖不动它、块菜单也对它无效,文档模式下就再没有任何办法把卡收回正文了。
  selectable: true,
  attrs: { anchor: { default: '' }, x: { default: 0 }, y: { default: 0 }, w: { default: CARD_W }, h: { default: 0 } },
  parseDOM: [{
    tag: 'div[data-amx-card]',
    getAttrs: (dom) => {
      const d = (dom as HTMLElement).dataset
      return { anchor: d.anchor ?? '', x: int(Number(d.x), 0), y: int(Number(d.y), 0), w: int(Number(d.w), CARD_W) || CARD_W, h: int(Number(d.h), 0) }
    },
  }],
  toDOM: (node) => ['div', {
    'data-amx-card': '',
    'data-anchor': String(node.attrs.anchor),
    'data-x': String(node.attrs.x),
    'data-y': String(node.attrs.y),
    'data-w': String(node.attrs.w),
    'data-h': String(node.attrs.h),
    class: 'amx-ucard',
    // 几何走自定义属性而不是直接写 left/top/width:CSS 的 attr() 取不了长度值,而内联 left
    // 会在**文档模式**下也生效(卡片当场变绝对定位飞出正文)。自定义属性只被 .amx-canvas
    // 作用域下的规则消费,文档模式一个像素都不动。
    style: `--amx-x:${node.attrs.x}px;--amx-y:${node.attrs.y}px;--amx-w:${node.attrs.w}px`,
  }, 0],
  parseMarkdown: {
    match: ({ type }) => type === 'amadeusCanvasCard',
    runner: (state, node, type) => {
      const n = node as { anchor?: string; x?: number; y?: number; w?: number; h?: number }
      state.openNode(type, { anchor: n.anchor ?? '', x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? CARD_W, h: n.h ?? 0 })
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'amadeusCanvasCard',
    runner: (state, node) => {
      // 落盘 = 开锚 + 卡内容 + 闭合符(2026-08-19 双标记包裹):辖域显式收边,卡后可以合法接
      // 主流正文。空卡只发一对裸锚 —— 空段落走通用序列化会落成 `<br />`(分栏 Codex Y-P1 同坑)。
      state.addNode('html', undefined, `<!-- a ${node.attrs.anchor} -->`)
      const empty = node.childCount === 1 && node.firstChild!.type.name === 'paragraph' && node.firstChild!.content.size === 0
      if (!empty) state.next(node.content)
      state.addNode('html', undefined, `<!-- /a ${node.attrs.anchor} -->`)
    },
  },
}))

// ── 读侧:remark 折叠。与分栏同款 per-editor 闭包(现读本页 pipe.fm,多页并发不串)。────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

function foldCanvas(tree: MdNode, canvas: CanvasV1 | null, taken: Set<string>, onFolded?: (refs: string[]) => void): void {
  const cards = canvas?.cards
  if (!cards?.length) return
  const kids: MdNode[] = Array.isArray(tree?.children) ? tree.children : []
  // 只折 **parse 树**(remark-parse 节点带 position);序列化树里没有这个 mdast 类型的 handler,折了必炸。
  if (kids.length && !kids.some((k) => k?.position)) return
  // 锚两形态:根级 html 块,或「段落包单个 inline html」——preset 的 remark 变换会把根级注释包进段落。
  const markerIdOf = (n: MdNode): string | null => {
    let v: string | null = null
    if (n?.type === 'html' && typeof n.value === 'string') v = n.value
    else if (n?.type === 'paragraph' && Array.isArray(n.children) && n.children.length === 1) {
      const c = n.children[0]
      if (c?.type === 'html' && typeof c.value === 'string') v = c.value
    }
    if (v == null) return null
    const m = MARKER_RE.exec(v.trim())
    return m ? m[1] : null
  }
  const closerIdOf = (n: MdNode): string | null => {
    let v: string | null = null
    if (n?.type === 'html' && typeof n.value === 'string') v = n.value
    else if (n?.type === 'paragraph' && Array.isArray(n.children) && n.children.length === 1) {
      const c = n.children[0]
      if (c?.type === 'html' && typeof c.value === 'string') v = c.value
    }
    if (v == null) return null
    const m = CLOSE_RE.exec(v.trim())
    return m ? m[1] : null
  }

  // ── 2026-08-19 闭合锚改版:折叠由「在册开锚」驱动,不再要求卡区收尾/连续/与 cards 同序 ——
  // 卡可以合法住在文档任何位置,普通内容与卡自由交错(本周所有毁档都源自旧的尾部不变式)。
  // 辖域两代同堂:闭合形 <!-- a k --> … <!-- /a k -->(写侧恒发,闭合符随折叠消费掉);
  // 旧形 = 到下一开锚或文件尾(读侧兼容,文件一经保存即迁移成闭合形)。
  // ⚠️ 折叠资格仍以 cards **在册**为准:收回文档留下的惰性字面锚不在册,绝不复活成卡
  // (锚永不回收,`![[note#id]]` 引用照常解析)。按锚跳过取代整篇 fail-closed:
  // 重复锚两处都作废、分栏占用让位、不在册不折 —— 都只影响那一枚,其余卡照折。
  const geo = new Map(cards.map((c) => [c.ref, c]))
  const opens: Array<{ id: string; idx: number }> = []
  kids.forEach((n, i) => {
    const id = markerIdOf(n)
    if (id) opens.push({ id, idx: i })
  })
  if (!opens.length) return
  const dup = new Map<string, number>()
  opens.forEach((o) => dup.set(o.id, (dup.get(o.id) ?? 0) + 1))
  const regions: Array<{ id: string; open: number; end: number; closer: number }> = []
  for (const o of opens) {
    if ((dup.get(o.id) ?? 0) > 1 || taken.has(o.id) || !geo.has(o.id)) continue
    let end = kids.length
    let closer = -1
    for (let j = o.idx + 1; j < kids.length; j++) {
      if (markerIdOf(kids[j])) { end = j; break } // 下一开锚(在不在册都算)= 旧形收边
      if (closerIdOf(kids[j]) === o.id) { end = j; closer = j; break } // 闭合形收边
    }
    regions.push({ id: o.id, open: o.idx, end, closer })
  }
  if (!regions.length) return
  const folded: string[] = []
  for (const r of [...regions].reverse()) { // 尾→头 splice,前面的下标不失效
    const g = geo.get(r.id)!
    const children = kids.slice(r.open + 1, r.end)
    kids.splice(r.open, (r.closer >= 0 ? r.closer + 1 : r.end) - r.open, {
      type: 'amadeusCanvasCard',
      anchor: r.id,
      x: int(g.x, 0), y: int(g.y, 0), w: int(g.w, CARD_W) || CARD_W, h: int(g.h, 0),
      children: children.length ? children : [{ type: 'paragraph', children: [] }],
    })
    folded.unshift(r.id)
  }
  onFolded?.(folded)
}

/** onFolded(refs):本次 parse 真折出来的卡锚 → 宿主并进归属集合。**没有它就没有安全的解散判据**
 *  (见 deriveCanvasJson 的四条告警),不是可选的调试钩子。宿主必须在**每次 parse 前清空**集合。 */
export function createCanvasFold(getCanvas: () => CanvasV1 | null, getLayout: () => LayoutV4 | null, onFolded?: (refs: string[]) => void): MilkdownPlugin[] {
  return [$remark('amadeusCanvasFold', () => () => (tree: MdNode) => {
    foldCanvas(tree, getCanvas(), layoutAnchors(getLayout()), onFolded)
  })].flat()
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── 写侧:cards 从**序列化后的 doc**派生,其余字段从磁盘那行原样搬运。────────────────────

export function deriveCards(doc: ProseNode): CanvasCard[] {
  const cards: CanvasCard[] = []
  doc.forEach((node) => {
    if (node.type.name !== 'amadeusCanvasCard') return
    const anchor = String(node.attrs.anchor)
    if (!ID_RE.test(anchor)) return
    const h = int(node.attrs.h, 0)
    cards.push({ ref: anchor, x: int(node.attrs.x, 0), y: int(node.attrs.y, 0), w: int(node.attrs.w, CARD_W) || CARD_W, ...(h > 0 ? { h } : {}) })
  })
  return cards
}

/** 派生 amadeus_canvas 的**单行 JSON**;返回 null = 该键不该存在(懒物化 / 解散)。
 *  storedLine 是磁盘上的现值:cards 之外的一切(mode/main/elements/未知键)只从它来。
 *  storedLine 非法(解析不出)时恒返回它自己 —— 逐字保留,绝不用派生结果覆盖看不懂的内容。
 *
 *  ⚠️ `owned` = **本实例负责得起的卡锚集合**:本次 parse 真折出来的(createCanvasFold 的 onFolded)
 *  ∪ 本实例自己建出来的(blockToCard)。判据是「磁盘上那份 cards 是否**全部**落在这个集合里」——
 *  不在,就说明 doc 不能代表这篇画布的全貌,整行逐字保留。一个布尔量解不了,四种场景会互相打架:
 *   · 折叠 fail-closed(缺锚/锚被分栏抢走/次序不符)→ doc 零卡片。只看「卡为空」会判成「用户删光了」
 *     剥键:打开这种文件敲一个字画布全没。
 *   · 同上再拖出一张新卡 → `cards.length>0` 绕过上面的保护,用只含新卡的数组整体替换磁盘那份,
 *     没折出来的旧卡几何永久丢失(Codex P0-1)。
 *   · 反过来,首次拖出的卡不是折来的;只认「折出过」的话,当场收回它又会判成「折叠没成功」把刚写的
 *     canvas 行原样留着 —— 收回重开即复活(Codex P0-2)。
 *   · 集合必须**每次 parse 清零**:折成功过一次就终身锁存的话,外部把锚改坏后回灌,下一次本地编辑
 *     会把「这次折叠失败」误判成「用户删除全部卡」而剥键(Codex P0-5)。
 *  分栏那边的布尔 sawRows 是同一个坑的前身,它自己也还带着最后那条终身锁存的毛病。
 *
 *  ⚠️ `modeOverride = null` 表示「本实例没有权利改 mode」(移动端 / 用户没点过模式钮)——
 *  不给 null 的话,手机只改正文也会把桌面存的 `mode:"canvas"` 覆写成 doc(Codex P1-7)。
 *
 *  ⚠️「cards 之外的字段保管」是**字段级**不是字节级:这里走 parse → 展开 → stringify,键序会被
 *  重排、超过 2^53 的整数会掉精度(Codex P1-5)。真要字节级得对原始 JSON 做定向 splice,
 *  Phase 2 若引入大整数/精确格式的字段再改。 */
export function deriveCanvasJson(doc: ProseNode, storedLine: string | null, modeOverride: 'doc' | 'canvas' | null, owned: ReadonlySet<string>): string | null {
  const cards = deriveCards(doc)
  const stored = parseCanvasJson(storedLine)
  if (!stored) {
    // 磁盘上没有(或读不懂)画布键。有卡片说明是本次刚拖出来的 → 物化;否则一个字节都不写。
    if (storedLine != null) return storedLine // 非法:逐字保留
    if (!cards.length) return null
    return JSON.stringify({ v: CANVAS_V, mode: modeOverride ?? 'canvas', main: { x: 0, y: 0, w: MAIN_W }, cards })
  }
  // 磁盘上有卡没落在归属集合里 → 本实例的 doc 代表不了全貌,整行逐字保留(理由见上面四条)。
  if (!(stored.cards ?? []).every((c) => owned.has(c.ref))) return storedLine
  // 主卡永在:卡片清空且无白板元素 → 剥键(解散语义,同分栏「无分栏剥两键」,方案 §3.2)。
  // ⚠️ 主卡**挪过位**(2026-08-18 一等公民,C42 仪器抓的)算画布内容:素笔记只拖主卡就物化的
  //    那一行,少这一句会在下一次击键被这里整行剥掉 —— 主卡位置静默丢失。默认位形照剥(懒物化闭环)。
  if (!cards.length && !(stored.elements?.length)) {
    const m = stored.main
    if (!m || (m.x === 0 && m.y === 0 && m.w === MAIN_W)) return null
  }
  const next: CanvasV1 = { ...stored, v: CANVAS_V, cards }
  if (modeOverride) next.mode = modeOverride
  if (!next.main) next.main = { x: 0, y: 0, w: MAIN_W }
  if (!next.elements?.length) delete next.elements
  // 层级剪枝的**唯一入口**。走到这里说明 doc 代表得了这篇画布的全貌(上面的归属判据),
  // 于是 cards 就是「哪些节点还活着」的权威 —— 指向已不存在的卡的父子关系一律剪掉(子节点认祖父)。
  // ⚠️ 放在这里而不是各个删除入口:文档模式下用块菜单删卡 / 收回文档**根本不经过画布那几条路**,
  //    逐个入口去挂剪枝必漏(Codex 评审 P1 实证:删掉中间那层后,孙节点仍挂在幽灵父节点上,
  //    线不见了、在它上面按回车还会继续往幽灵下面加节点)。
  const tree = rawTree(next.tree)
  const keys = Object.keys(tree)
  if (keys.length) {
    // ⚠️ 剪枝**只裁「锚形态且确实没了」的节点**。cards 只是卡片的名册,不是「所有合法节点」的名册:
    //    主卡哨兵 `m:`(2026-08-19)永远不在里面,按名册硬裁的话「主卡长出来的子节点」在下一次派生
    //    就被当成挂在幽灵父上剪掉 —— 现象是层级线一闪就没(实测)。判据因此改成「长得像锚」而不是
    //    枚举例外:非锚形态的值一律不认识、不动它(与 §8「老端绝不吞新端」同一条纪律,以后再加哨兵
    //    也不用回来改这里)。⚠️ 老版本客户端没这条 → 打开新文件保存一次会把主卡的父子关系剪掉
    //    (只丢一条层级线,卡与正文不受影响);本批本来就要与闭合锚同车发版。
    const alive = new Set(cards.map((c) => c.ref))
    const dead = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v) && !alive.has(v)
    const gone = new Set<string>()
    for (const child of keys) {
      if (dead(child)) gone.add(child)
      if (dead(tree[child])) gone.add(tree[child] as string)
    }
    if (gone.size) {
      const pruned = pruneTree(tree, gone)
      if (Object.keys(pruned).length) next.tree = pruned
      else delete next.tree
    }
  }
  return JSON.stringify(next)
}

/** 白板元素的落盘(2026-08-17 Phase 2 第二步:元素可编辑)。cards 的真源是 doc,**elements 的真源
 *  是磁盘那行** —— 所以它不走 deriveCanvasJson,而是就地换掉 elements 键、其余字段逐字保留。
 *  与 deriveCanvasJson 的三条口径完全对齐:懒物化(没键且没元素 = 一个字节不写)、解散(元素删光
 *  就剥 elements 键)、fail-closed(那行读不懂就原样返回,绝不用派生结果覆盖看不懂的内容)。
 *  ⚠️ 传进来的 elements 必须是**原始条目**(canvasEdit 的产物),不是 safeElements 的收窄视图。
 *  ⚠️ 物化时 mode 恒 'canvas':只有在画布模式下才画得出元素来。 */
export function withElements(storedLine: string | null, elements: unknown[]): string | null {
  const stored = parseCanvasJson(storedLine)
  if (!stored) {
    if (storedLine != null) return storedLine
    if (!elements.length) return null
    return JSON.stringify({ v: CANVAS_V, mode: 'canvas', main: { x: 0, y: 0, w: MAIN_W }, cards: [], elements })
  }
  const next: CanvasV1 = { ...stored, v: CANVAS_V, elements }
  if (!elements.length) delete next.elements
  return JSON.stringify(next)
}

/** 主卡几何的落盘(2026-08-18 主卡一等公民)。与 withElements 同口径:真源是磁盘那行、
 *  fail-closed(读不懂原样返回)。懒物化的判据反着来 —— main 恒有默认值,「盘上无键 + 写的是
 *  默认位形」= 没有信息,一个字节不写(否则视角切进画布就物化一行默认 JSON,违反方案 §4)。 */
export function withMain(storedLine: string | null, main: CanvasMain): string | null {
  const next: CanvasMain = { x: Math.round(main.x), y: Math.round(main.y), w: Math.round(main.w) }
  const stored = parseCanvasJson(storedLine)
  if (!stored) {
    if (storedLine != null) return storedLine
    if (!next.x && !next.y && next.w === MAIN_W) return null
    return JSON.stringify({ v: CANVAS_V, mode: 'canvas', main: next, cards: [] })
  }
  return JSON.stringify({ ...stored, v: CANVAS_V, main: next })
}

/** 节点层级的落盘(2026-08-18)。与 withElements **逐条对齐**的三口径:懒物化(没键且没层级 =
 *  一个字节不写)、解散(层级清空就剥 tree 键)、fail-closed(那行读不懂就原样返回)。
 *  真源同样是磁盘那行 —— 层级不由 doc 派生,doc 里根本没有它。 */
export function withTree(storedLine: string | null, tree: Record<string, unknown>): string | null {
  const n = Object.keys(tree).length
  const stored = parseCanvasJson(storedLine)
  if (!stored) {
    if (storedLine != null) return storedLine
    if (!n) return null
    return JSON.stringify({ v: CANVAS_V, mode: 'canvas', main: { x: 0, y: 0, w: MAIN_W }, cards: [], tree })
  }
  const next: CanvasV1 = { ...stored, v: CANVAS_V, tree }
  if (!n) delete next.tree
  return JSON.stringify(next)
}

// ── 规范化(2026-08-19 闭合锚改版后只剩一件事:卡内分栏禁令的写侧守卫)。──────────────────
// 闭合锚让卡可以合法住在文档任何位置:「尾部连续卡区」不变式与它派生的两个分支 —— 出区拆壳
// (旧 §3.2 隐式触发)与散块吸收(2026-08-18 深夜)—— 一并退役。拆壳只走显式入口(块菜单
// 「收回文档」= unwrapCard);普通内容与卡的相对位置全部合法;嵌套卡/重复锚由
// canvasIntegrityGuard 整笔拒绝。勿把拆壳/吸收加回来:那是旧辖域规则(到下一锚或文件尾)的
// 补丁,双标记包裹之后病根已除。
// 保留的守卫:卡内不许住 amadeusColumnRow(方案 §3.2「卡内恒为无锚纯内容」)。卡的 content 是
// `block+`,拦不住粘贴/默认拖放塞进来的行节点;真让它留在卡里,序列化后卡辖域内会冒出列锚,
// 重开时列锚把卡内容切走。处置 = 整行搬到**那张卡之前**(闭合锚后任何卡外位置都合法),
// 行结构与锚全不动。
export const canvasNormalizer = $prose(() =>
  new Plugin({
    key: new PluginKey('AMX_CANVAS_NORMALIZE'),
    appendTransaction: (trs, _old, state) => {
      if (!trs.some((t) => t.docChanged)) return null
      const card = state.schema.nodes.amadeusCanvasCard
      if (!card) return null
      const cuts: Array<{ from: number; to: number; node: ProseNode; before: number }> = []
      // 顶层重复锚 = 就地换新锚(2026-08-19 Codex F5:Alt 拖复制卡的正当产物 —— 此前完整性闸
      // 整笔拒绝,复制静默无效)。后出现的那张拿新锚,几何照抄 = 标准「复制一份」;新锚经
      // freshAnchorId 与全部在用/惰性锚查重。粘贴路径不受影响(transformPasted 已剥卡)。
      const reanchor: number[] = []
      const seen = new Set<string>()
      state.doc.forEach((node, offset) => {
        if (node.type !== card) return
        const a = String(node.attrs.anchor)
        if (seen.has(a)) reanchor.push(offset)
        else seen.add(a)
        node.forEach((child, childOff) => {
          if (child.type.name !== 'amadeusColumnRow') return
          const at = offset + 1 + childOff
          cuts.push({ from: at, to: at + child.nodeSize, node: child, before: offset })
        })
      })
      if (!cuts.length && !reanchor.length) return null
      let tr = state.tr
      for (const pos of reanchor) {
        const node = tr.doc.nodeAt(pos)
        if (node?.type === card) tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, anchor: freshAnchorId(tr.doc) })
      }
      for (const c of cuts) {
        // 逐条搬,坐标全走 mapping:同卡多行时后行 map 到前行插完之后,先后次序保持。
        tr = tr.delete(tr.mapping.map(c.from, 1), tr.mapping.map(c.to, -1))
        tr = tr.insert(tr.mapping.map(c.before), c.node)
      }
      return tr.steps.length ? tr : null
    },
  }),
)

// ── 卡片完整性两道闸(2026-08-18 深夜 Codex F1:复制粘贴卡片 → 嵌套卡/重复锚,重开整篇拒折)。──
// 卡的 schema 天生允许两种非法形态:group:'block' + content:'block+' ⇒ 卡可以嵌进卡/引用块;
// parseDOM 带 anchor ⇒ 剪贴板 HTML 粘回来复活同一枚锚。嵌套卡的 toMarkdown 照发 marker =
// 卡内冒锚,重开时 fold「末卡之后不许还有别的锚」整篇拒折;重复锚则两处都作废。两道闸分工:
//
// 1) transformPasted:粘贴切片里的卡节点**就地解壳**(粘的是内容,不是卡身份)。只走
//    parseFromClipboard(粘贴/跨文档拖入);同文档 ⠿ 拖卡走 view.dragging 原切片,**不经此钩**,
//    §3.2「拖回主卡拆壳」与画布搬卡都不受影响。粘贴因此永不携卡 → normalizer 的散块吸收接手落位。
export const canvasPasteGuard = $prose(() =>
  new Plugin({
    key: new PluginKey('AMX_CANVAS_PASTE_GUARD'),
    props: {
      transformPasted: (slice, view) => {
        // ⚠️ prosemirror-view 对 **drop 也跑 transformPasted**(2026-08-19 P5 探针实锤,此前
        // 「同文档 ⠿ 拖卡不经此钩」的注释是错的):同文档移动(dragging.move)原样放行,否则
        // 拖卡=静默解壳。Alt 拖复制/跨窗拖入/粘贴照旧解壳 —— 那些路径复制锚,解成内容才安全。
        if (view.dragging?.move) return slice
        const card = view.state.schema.nodes.amadeusCanvasCard
        if (!card) return slice
        let has = false
        slice.content.descendants((n) => { if (n.type === card) { has = true; return false } return true })
        if (!has) return slice
        const unwrap = (frag: Fragment): Fragment => {
          const out: ProseNode[] = []
          frag.forEach((n) => {
            if (n.type === card) unwrap(n.content).forEach((c) => out.push(c))
            else out.push(n.copy(unwrap(n.content)))
          })
          return Fragment.fromArray(out)
        }
        // maxOpen 重算开边深度:手工搬 openStart/End 在「卡在切片开口边」时必错(深度塌了一层)。
        return Slice.maxOpen(unwrap(slice.content))
      },
    },
  }),
)
// 2) filterTransaction 兜底:结果 doc 里出现「卡不在 doc 顶层」或「顶层重复锚」的事务整笔拒绝
//    (落点无处可去的搬卡 = no-op,与画布模式 executeDropInCanvas 的吞语义一致)。覆盖粘贴之外
//    的一切路径:文档模式 ⠿ 把卡拖进另一张卡/引用块、Alt 拖复制卡。fold/reconcile 不受影响
//    (折叠只会产出顶层唯一锚)。
export const canvasIntegrityGuard = $prose(() =>
  new Plugin({
    key: new PluginKey('AMX_CANVAS_INTEGRITY'),
    filterTransaction: (tr, state) => {
      if (!tr.docChanged) return true
      const card = state.schema.nodes.amadeusCanvasCard
      if (!card) return true
      // 只拒「卡不在 doc 顶层」(嵌套卡/卡进引用块 = 序列化后卡辖域里冒锚,重开即坏)。
      // 顶层重复锚**不再拒**(2026-08-19 Codex F5):那是 Alt 拖复制卡的正当产物,由 normalizer
      // 就地换新锚收编 —— 拒绝的话复制静默无效,比重复更难察觉。
      let ok = true
      tr.doc.descendants((n, _pos, parent) => {
        if (!ok || n.type !== card) return ok
        if (parent?.type.name !== 'doc') { ok = false; return false }
        return true
      })
      return ok
    },
  }),
)

export const canvasPlugins = [canvasCardSchema, canvasNormalizer, canvasPasteGuard, canvasIntegrityGuard].flat()

// ── 跨卡选区夹断(2026-08-18,评审 P0-2)。────────────────────────────────────────────────
// 画布的视觉顺序 ≠ 源码顺序,原生选区可以横跨视觉上不相邻的卡片(以及主卡↔卡片)——
// 复制/删除的时候带走的是「源码上连续、屏幕上乱跳」的一段。夹断规则:TextSelection 的两端
// 必须落在同一个容器里(某张卡之内,或主卡自然流之内);跨了就把 head 夹回 anchor 所在容器的
// 近端边界。AllSelection(卡内 Cmd+A)同样按 anchor 容器收窄 —— 画布模式下「全选整篇」没有
// 视觉意义,收成「全选本卡」正是 AFFiNE 的行为。
// ⚠️ 幂等是免死循环的关键:夹完两端同容器,下一轮 appendTransaction 恒返回 null。
export function createSelectionClamp(inCanvas: () => boolean): MilkdownPlugin[] {
  return [$prose(() =>
    new Plugin({
      key: new PluginKey('AMX_CANVAS_SEL_CLAMP'),
      appendTransaction: (trs, oldState, state) => {
        if (!inCanvas()) return null
        const card = state.schema.nodes.amadeusCanvasCard
        if (!card) return null
        // 全篇没有卡片就只有主卡一个容器,无「跨」可言。
        let firstCardPos = -1
        {
          let pos = 0
          for (let i = 0; i < state.doc.childCount; i++) {
            const child = state.doc.child(i)
            if (child.type === card) {
              firstCardPos = pos
              break
            }
            pos += child.nodeSize
          }
        }
        if (firstCardPos < 0) return null
        // 容器 = 顶层子节点(卡片按 index 区分);主卡自然流统一算 -1(它在源码上是连续前段,
        // 卡片区恒在尾部 —— canvasNormalizer 的不变式)。
        const contOf = ($p: ResolvedPos): number => ($p.depth >= 1 && $p.node(1).type === card ? $p.index(0) : -1)
        /** 容器的内容区间(卡 = 开闭标记各让 1;主卡 = 第一张尾部卡之前的一切)。 */
        const rangeOf = (c: number): { from: number; to: number } => {
          if (c < 0) return { from: 0, to: firstCardPos }
          let pos = 0
          for (let i = 0; i < c; i++) pos += state.doc.child(i).nodeSize
          return { from: pos + 1, to: pos + state.doc.child(c).nodeSize - 1 }
        }
        /** 夹出来的选区必须真的单容器且与现选区不同,否则放行 —— 这是免 appendTransaction
         *  死循环的硬闸(纯图片卡这类没有文本位的容器,`between` 可能逃出去)。 */
        const emit = (next: Selection): Transaction | null => {
          if (next.eq(state.selection)) return null
          if (contOf(state.doc.resolve(next.anchor)) !== contOf(state.doc.resolve(next.head))) return null
          return state.tr.setSelection(next)
        }
        const sel = state.selection
        if (sel.empty || sel instanceof NodeSelection) return null
        if (sel instanceof AllSelection) {
          // ⚠️ AllSelection 两端在 depth 0,contOf 恒 -1,泛用路径看不见它 —— 必须单独收窄。
          // 卡内 Cmd+A → 收成「全选本容器」(画布上「全选整篇」没有视觉意义,AFFiNE 同款)。
          // 参照物 = 全选之前光标所在容器;doc 刚变过就没有可靠参照,放行。
          if (trs.some((t) => t.docChanged)) return null
          const ref = Math.max(0, Math.min(oldState.selection.head, state.doc.content.size))
          const r = rangeOf(contOf(state.doc.resolve(ref)))
          if (r.from >= r.to) return null // 空容器(通篇皆卡的主卡):没有可选内容
          return emit(TextSelection.between(state.doc.resolve(r.from), state.doc.resolve(r.to), -1))
        }
        if (!(sel instanceof TextSelection)) return null
        const $anchor = state.doc.resolve(sel.anchor)
        const ca = contOf($anchor)
        if (ca === contOf(state.doc.resolve(sel.head))) return null
        const r = rangeOf(ca)
        const headPos = Math.max(r.from, Math.min(r.to, sel.head))
        return emit(TextSelection.between($anchor, state.doc.resolve(headPos), sel.head >= sel.anchor ? -1 : 1))
      },
    }),
  )].flat()
}

// ── 文档模式:光标所在卡片的整块约束框(2026-08-18,用户拍板「无缝衔接 + 悬停/光标进入才显示」)。──
// 悬停侧纯 CSS(:hover)就够;光标侧只能从 PM 选区推 —— 整篇只有一个 contenteditable 根,
// :focus-within 分不出光标落在哪张卡里。这里用 node decoration 往当前容器卡上打
// `amx-card-active` 类:decoration 是 PM 自己的通道,不触发 DOMObserver 重画(「手势期禁碰
// PM 的 DOM」那条纪律管的是**陌生属性**,decoration 不算)。约束框 CSS 限定在文档模式
// (:not(.amx-canvas)),画布模式下这个类挂着没有消费方,无害。
export function createCardActiveDeco(): MilkdownPlugin[] {
  return [$prose(() =>
    new Plugin({
      key: new PluginKey('AMX_CARD_ACTIVE'),
      props: {
        decorations(state) {
          const card = state.schema.nodes.amadeusCanvasCard
          if (!card) return null
          const sel = state.selection
          let pos = -1
          let node: ProseNode | null = null
          if (sel instanceof NodeSelection) {
            if (sel.node.type === card) { pos = sel.from; node = sel.node }
            else if (sel.$from.depth >= 1) {
              // 卡内块级 NodeSelection(⠿ 右键/Esc 阶梯选中段落等):光标作用域仍在这张卡里,
              // 约束框不该掉 —— 恰好是搬块/删块这类高危操作的时刻(Codex 评审 2026-08-18 晚)。
              const top = sel.$from.node(1)
              if (top.type === card) { pos = sel.$from.before(1); node = top }
            }
          } else if (sel.$head.depth >= 1) {
            // 容器 = 顶层祖先(卡片恒为顶层节点,canvasNormalizer 不变式)。AllSelection/gap
            // cursor 的端点在 depth 0,走不进来 —— 那些形态没有「所在卡」可言。
            const top = sel.$head.node(1)
            if (top.type === card) { pos = sel.$head.before(1); node = top }
          }
          if (!node) return null
          return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: 'amx-card-active' })])
        },
      },
    }),
  )].flat()
}

// ── 文档模式:层级缩进(2026-08-19,用户拍板「有父子属性的 Card 嵌套包裹,排序始终在父 Card 内」)。──
// 分工:**源码相邻**由写侧保证(canvasStage 的 orderUnder / addCardAt(under) —— 认爹或建子节点时
// 把子卡那一段整体搬到父段之后),这里只负责**呈现**:按深度给卡打一枚档位类,CSS 去缩进 + 画左轨。
// 为什么不是真嵌套:卡在 PM 里恒为顶层节点(canvasIntegrityGuard),而闭合锚的辖域遇到下一枚开锚
// 就收边 —— 卡里再冒一枚开锚 = 父卡辖域提前截断,那是协议改动,不是一个显示需求该付的代价。
//
// ⚠️ 档位走 **class 而不是内联 style**:卡的 toDOM 已经把画布几何(--amx-x/y/w)写在 style 上了,
//    decoration 的 style 与它同属一个属性,一旦哪天的 prosemirror-view 是「覆盖」而不是「追加」,
//    画布模式的卡会当场全部飞到 0,0。六个档位六条 CSS,换的是这条风险归零。
// ⚠️ tree 不在 doc 里,改层级不产生 PM 事务 → decorations 不会自己重算。UnifiedPage 在 canvas 行
//    真变过之后补一笔空事务把它推醒(见那边的 useEffect)。
const DEPTH_CAP = 6

export function createCardDepthDeco(getCanvas: () => CanvasV1 | null): MilkdownPlugin[] {
  return [$prose(() =>
    new Plugin({
      key: new PluginKey('AMX_CARD_DEPTH'),
      props: {
        decorations(state) {
          const card = state.schema.nodes.amadeusCanvasCard
          if (!card) return null
          const tree = rawTree(getCanvas()?.tree)
          if (!Object.keys(tree).length) return null
          // alive = 本篇真实在场的卡锚。父不在其中 = 没有爹(深度 0),见 depthOf 的告警。
          const alive = new Set<string>()
          const at: Array<{ pos: number; size: number; anchor: string }> = []
          state.doc.forEach((node, offset) => {
            if (node.type !== card) return
            const a = String(node.attrs.anchor)
            alive.add(a)
            at.push({ pos: offset, size: node.nodeSize, anchor: a })
          })
          const decos: Decoration[] = []
          for (const c of at) {
            const d = depthOf(tree, c.anchor, alive, DEPTH_CAP)
            if (d > 0) decos.push(Decoration.node(c.pos, c.pos + c.size, { class: `amx-card-child amx-card-d${d}` }))
          }
          return decos.length ? DecorationSet.create(state.doc, decos) : null
        },
      },
    }),
  )].flat()
}

// ── 统一撤销时间线(2026-08-18,评审 P0-1)。────────────────────────────────────────────────
// 两条撤销栈本身不动(卡片/正文=PM history,元素/层级/主卡=fm 快照,理由见 canvasElements 顶注),
// 动的是**仲裁**:一条按时间排序的 'pm'|'fm'|'pair' 流水,Cmd+Z 永远退「最近发生的那件事」。
//  · 'pm' 由下面的观察插件在「undoDepth 增长且不是撤销/重做事务」时**推入**(它只推不弹 ——
//    弹一律归舞台的仲裁器,双写点必然重复记账);
//  · 'fm' 由舞台的 fm 写入咽喉推入;
//  · 'pair' = 一次用户动作横跨两域(Tab 建子节点:PM 建卡 + fm 记层级),一次 Cmd+Z 两域各退一步。
// 自愈是设计的一部分:PM 的 history 深度有上限、编辑器可能整实例重建(外部回灌),时间线里的
// 'pm' 条目可能指向已经不存在的历史 —— 仲裁器在 pmUndo 返回 false 时把该条目丢弃并继续找下一条,
// 绝不让一枚陈旧条目卡死整条撤销链。
export interface UndoTimeline {
  log: Array<'pm' | 'fm' | 'pair'>
  future: Array<'pm' | 'fm' | 'pair'>
}
const TIMELINE_CAP = 200

export function createHistoryTimeline(tl: UndoTimeline): MilkdownPlugin[] {
  return [$prose(() =>
    new Plugin({
      key: new PluginKey('AMX_CANVAS_HISTORY_TIMELINE'),
      state: {
        init: (_c, state) => ({ depth: undoDepth(state) }),
        apply: (tr, val, _old, newState) => {
          const depth = undoDepth(newState)
          if (tr.docChanged && depth > val.depth && !isHistoryTransaction(tr)) {
            tl.log.push('pm')
            if (tl.log.length > TIMELINE_CAP) tl.log.shift()
            tl.future.length = 0
          }
          return depth === val.depth ? val : { depth }
        },
      },
    }),
  )].flat()
}
