// v4 统一编辑器的分栏 = 单实例内的 PM 自定义节点(2026-08-13 方案 Y,advisor+Codex 两轮定案):
//   amadeusColumnRow > amadeusColumnCell+ > block+,cell attrs = {anchor, width}。
// 磁盘格式不变(规范 §3.3):序列化时每 cell 前发射 `<!-- a id -->` 锚注释,amadeus_layout /
// amadeus_schema 由 compose 侧从序列化后的 doc **派生**(单一真源,绝不另存一份活 layout)。
// 多实例区段模型被否决的原因:跨实例拖拽 slice 不兼容 / 双 PM history 撤销撕裂 / 防抖梯次竞态
// (Codex 评审 A/B 两组 P0),单实例列节点让这些机械性问题按构造消失。
import { $nodeSchema, $prose, $remark } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Fragment } from '@milkdown/kit/prose/model'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

export interface LayoutColumn { refs: string[]; width: number }
/** tail = 行尾界标锚(可选):规范辖域是「锚到下一锚或文件尾」,行在文件中间而行后内容无锚时,
 *  最后一列会把后续内容整个吞进来 —— 我们写盘的行一律带 tail 锚封底(语法仍是普通锚注释,
 *  外部工具零感知;layout 里记下 id,读侧折叠时一并吸收不留字面)。手写/升级的无 tail 行照旧到下一锚/EOF。 */
export interface LayoutRow { columns: LayoutColumn[]; tail?: string }
export interface LayoutV4 { v: 4; rows: LayoutRow[] }

/** 规范 §3.3 锚注释(与 shared markers 同语法;这里只认整行注释形态)。 */
const MARKER_RE = /^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->$/

/** amadeus_layout 单行 JSON → 校验过形状的 LayoutV4;任何不对 → null(fail-closed 回自然流)。 */
export function parseLayoutJson(raw: string | null): LayoutV4 | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    const l = v as LayoutV4
    if (!l || l.v !== 4 || !Array.isArray(l.rows)) return null
    for (const row of l.rows) {
      if (!row || !Array.isArray(row.columns) || row.columns.length < 1) return null
      if (row.tail != null && (typeof row.tail !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.tail))) return null
      for (const col of row.columns) {
        // refs 至少一条:空列过形状校验后 fold 读 refs[0] 会对 markers 索引 undefined 直接抛错(Codex 终审)。
        if (!col || !Array.isArray(col.refs) || col.refs.length < 1 || !col.refs.every((r) => typeof r === 'string' && /^[A-Za-z0-9_-]+$/.test(r))) return null
        if (typeof col.width !== 'number' || !Number.isFinite(col.width) || col.width <= 0) return null
      }
    }
    return l
  } catch {
    return null
  }
}

/** 文件内唯一的新锚 id(v4 锚永不 renumber,写侧只保证不撞已有)。
 *  ⚠️ 画布卡片(amadeusCanvasCard,2026-08-16)与分栏共用同一个锚命名空间 —— 分栏与画布**绝不许
 *  引用同一枚锚**(方案 §3.2 互斥不变式),所以这里必须把卡片锚也算进已用集合。 */
export function freshAnchorId(doc: ProseNode): string {
  const used = new Set<string>()
  doc.descendants((n) => {
    if (n.type.name === 'amadeusColumnCell' && n.attrs.anchor) used.add(String(n.attrs.anchor))
    if (n.type.name === 'amadeusColumnRow' && n.attrs.tail) used.add(String(n.attrs.tail))
    if (n.type.name === 'amadeusCanvasCard' && n.attrs.anchor) used.add(String(n.attrs.anchor))
    // 惰性字面锚(解散/收回留下的 `<!-- a id -->`)同属一个命名空间 —— 漏掉它,新锚就有概率撞上一枚
    // 正文里已存在的标记,下次折叠因「重复锚」整体失败(Codex P2-1)。锚形态见 foldColumns 的注释。
    if (n.type.name === 'html') {
      const m = MARKER_RE.exec(String(n.attrs.value ?? '').trim())
      if (m) used.add(m[1])
    }
  })
  for (;;) {
    const id = 'c' + Math.random().toString(36).slice(2, 6)
    if (!used.has(id)) return id
  }
}

/** 复制类插入(Alt 拖 / 菜单「复制块」)把片段里的画布卡**当场换成现铸新锚**,绝不留给
 *  canvasNormalizer 事后挑:它按 doc 序给「后出现的那份」换锚,副本落在原卡之前时被改名的是
 *  **原卡**,tree 边/连线/几何整套被副本劫走(Codex 08-31 high)。返回铸出的锚 —— 调用方必须把
 *  它们报进宿主的归属集合(blockLayer 走 hooks.onCardsMinted,菜单直接 pipe.ownedCards.add):
 *  漏报 = 首次派生落盘后「stored ⊆ owned」判据 fail-closed,画布派生冻结到重开。
 *  卡恒在 doc 顶层(完整性闸),不递归;freshAnchorId 只保证不撞 doc 已有锚,批内自查重。 */
export function mintCardCopies(doc: ProseNode, content: Fragment): { content: Fragment; minted: string[] } {
  const minted: string[] = []
  const nodes: ProseNode[] = []
  content.forEach((n) => {
    if (n.type.name === 'amadeusCanvasCard') {
      let id = freshAnchorId(doc)
      while (minted.includes(id)) id = freshAnchorId(doc)
      minted.push(id)
      nodes.push(n.type.create({ ...n.attrs, anchor: id }, n.content, n.marks))
    } else nodes.push(n)
  })
  return minted.length ? { content: Fragment.fromArray(nodes), minted } : { content, minted }
}

export const columnRowSchema = $nodeSchema('amadeusColumnRow', () => ({
  content: 'amadeusColumnCell+',
  group: 'block',
  defining: true,
  isolating: true,
  // 不可整体选中(Codex Y-P0):行后段首退格的 selectNodeBackward 会选中整行,再一击就删掉
  // 两列内容;行/列的结构操作只走专用 UI(拖拽/菜单),不给通用 NodeSelection。
  selectable: false,
  attrs: { tail: { default: '' } },
  parseDOM: [{ tag: 'div[data-amx-colrow]', getAttrs: (dom) => ({ tail: (dom as HTMLElement).dataset.tail ?? '' }) }],
  toDOM: (node) => ['div', { 'data-amx-colrow': '', 'data-tail': String(node.attrs.tail), class: 'amx-ucolrow' }, 0],
  parseMarkdown: {
    match: ({ type }) => type === 'amadeusColumnRow',
    runner: (state, node, type) => {
      state.openNode(type, { tail: (node as { tail?: string }).tail ?? '' })
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'amadeusColumnRow',
    runner: (state, node) => {
      // 落盘 = 每 cell 一条锚注释 + cell 内容,按源序自然流(布局意义由 amadeus_layout 恢复);
      // 行有 tail 锚则封底(防最后一列辖域吞掉行后内容,见 LayoutRow.tail 注)。
      // 空 cell 只发锚(裸锚,规范口径)—— 空段落走通用序列化会落成 `<br />`(Codex Y-P1)。
      node.forEach((cell) => {
        state.addNode('html', undefined, `<!-- a ${cell.attrs.anchor} -->`)
        const empty = cell.childCount === 1 && cell.firstChild!.type.name === 'paragraph' && cell.firstChild!.content.size === 0
        if (!empty) state.next(cell.content)
      })
      if (node.attrs.tail) state.addNode('html', undefined, `<!-- a ${node.attrs.tail} -->`)
    },
  },
}))

export const columnCellSchema = $nodeSchema('amadeusColumnCell', () => ({
  content: 'block+',
  // isolating:cell 边界不参与 Backspace join(Notion/AFFiNE 语义:列首退格不吞进邻列)。
  defining: true,
  isolating: true,
  selectable: false, // 同 row:结构删除只走专用 UI(Codex Y-P0)
  attrs: { anchor: { default: '' }, width: { default: 1 } },
  parseDOM: [{
    tag: 'div[data-amx-colcell]',
    getAttrs: (dom) => {
      const w = Number((dom as HTMLElement).dataset.width)
      return {
        anchor: (dom as HTMLElement).dataset.anchor ?? '',
        width: Number.isFinite(w) && w > 0 ? w : 1, // 负数/NaN 一律回 1(Codex Y:属性不变量)
      }
    },
  }],
  toDOM: (node) => ['div', {
    'data-amx-colcell': '',
    'data-anchor': String(node.attrs.anchor),
    'data-width': String(node.attrs.width),
    class: 'amx-ucolcell',
    style: `flex-grow:${Number(node.attrs.width) || 1}`,
  }, 0],
  parseMarkdown: {
    match: ({ type }) => type === 'amadeusColumnCell',
    runner: (state, node, type) => {
      state.openNode(type, { anchor: (node as { anchor?: string }).anchor ?? '', width: (node as { width?: number }).width ?? 1 })
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    // 正常路径 row 的 runner 已整体接管;这条只兜「孤 cell」异常(schema 上不可能,防御性摊平)。
    match: (node) => node.type.name === 'amadeusColumnCell',
    runner: (state, node) => {
      state.next(node.content)
    },
  },
}))

// ── 读侧:remark 折叠(fold)。layout 经 **per-editor 闭包** getLayout 注入(2026-08-13 Codex 终审
// P1:模块级单槽在多页并发异步初始化时会拿别页的 layout 解析本页正文 → 改闭包,每次 parse
// 现读本页 pipe.fm,天然最新,回灌前也无需手动注入)。
// 校验 fail-closed(Codex A2/A3/共1):refs 与锚一一对应、flatMap 后按源序连续、全局不重复;
// 任何歧义 → 该行整个不折叠,内容连同标记逐字留在自然流。未引用锚 = 惰性,不折叠。
// 多 ref 列(v3 升级产物):首 ref 定 cell 边界,后续 ref 的标记**保留为 cell 内惰性字面**——
// 锚永不回收,`![[note#id]]` 按「紧随其后块级节点」继续解析;派生时 cellRefs 原样收回。

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

function foldColumns(tree: MdNode, layout: LayoutV4 | null, onFolded?: () => void): void {
  if (!layout?.rows?.length) return
  const kids: MdNode[] = Array.isArray(tree?.children) ? tree.children : []
  // 只折叠 **parse 树**(remark-parse 节点带 position;序列化侧自建的 mdast 没有)——
  // amadeusColumnRow 这个 mdast 类型没有 stringify handler,折了序列化树必炸。
  if (kids.length && !kids.some((k) => k?.position)) return
  // 锚形态两认:根级 html 块,或「段落包单个 inline html」—— Milkdown preset 自己的 remark
  // 变换先于本插件跑,会把根级 html 注释包进段落(C5 实测),两种都得认。
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
  const markers: Array<{ id: string; idx: number }> = []
  kids.forEach((n, i) => {
    const id = markerIdOf(n)
    if (id) markers.push({ id, idx: i })
  })
  if (!markers.length) return
  const ordOf = new Map<string, number>()
  markers.forEach((mk, ord) => {
    if (ordOf.has(mk.id)) ordOf.set(mk.id, -1) // 重复锚:两处都作废(歧义 fail-closed)
    else ordOf.set(mk.id, ord)
  })
  const consumed = new Set<number>()
  const replaces: Array<{ from: number; to: number; node: MdNode }> = []
  for (const row of layout.rows) {
    if (row.columns.length < 2) continue
    const flat = row.columns.flatMap((c) => c.refs)
    if (!flat.length) continue
    const ords = flat.map((r) => ordOf.get(r) ?? -1)
    if (ords.some((o) => o < 0 || consumed.has(o))) continue
    if (new Set(ords).size !== ords.length) continue
    if (!ords.every((o, i) => i === 0 || o === ords[i - 1] + 1)) continue // 源序连续
    const lastOrd = ords[ords.length - 1]
    // tail 封底:下一锚恰是本行 tail → 末列辖域止于它,且该标记被吸进行属性(不留字面)。
    const tailOrd = row.tail != null && lastOrd + 1 < markers.length && markers[lastOrd + 1].id === row.tail && !consumed.has(lastOrd + 1)
      ? lastOrd + 1
      : null
    const spanEnd = tailOrd != null ? markers[tailOrd].idx : lastOrd + 1 < markers.length ? markers[lastOrd + 1].idx : kids.length
    const cells: MdNode[] = []
    let ok = true
    row.columns.forEach((col, ci) => {
      const firstOrd = ordOf.get(col.refs[0])!
      const from = markers[firstOrd].idx + 1
      const nextFirst = ci + 1 < row.columns.length ? ordOf.get(row.columns[ci + 1].refs[0])! : null
      const to = nextFirst != null ? markers[nextFirst].idx : spanEnd
      if (to < from) {
        ok = false
        return
      }
      const children = kids.slice(from, to)
      cells.push({
        type: 'amadeusColumnCell',
        anchor: col.refs[0],
        width: col.width || 1,
        children: children.length ? children : [{ type: 'paragraph', children: [] }],
      })
    })
    if (!ok || cells.length < 2) continue
    ords.forEach((o) => consumed.add(o))
    if (tailOrd != null) consumed.add(tailOrd)
    replaces.push({
      from: markers[ords[0]].idx,
      to: tailOrd != null ? markers[tailOrd].idx + 1 : spanEnd,
      node: { type: 'amadeusColumnRow', tail: tailOrd != null ? row.tail : '', children: cells },
    })
  }
  replaces.sort((a, b) => b.from - a.from)
  for (const r of replaces) kids.splice(r.from, r.to - r.from, r.node)
  if (replaces.length) onFolded?.()
}

/** onFolded:本次 parse 至少折出一行时回调 —— UnifiedPage 用它置 sawRows(「真渲染过行」的
 *  另一个判定点;只靠编辑期 derive 会漏「打开即拖散」:解散时 derive 第一次跑就已无 row,
 *  sawRows 恒 false → layout 剥不掉 → 重开时列复活,advisor 复核抓的雷)。 */
export function createColumnsFold(getLayout: () => LayoutV4 | null, onFolded?: () => void): MilkdownPlugin[] {
  return [$remark('amadeusColumnsFold', () => () => (tree: MdNode) => {
    foldColumns(tree, getLayout(), onFolded)
  })].flat()
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── 写侧:layout 从**序列化后的 doc**派生(单一真源,Codex A13)。────────────────────────
/** cell 的完整 refs = 首锚(attr)+ 内容里的惰性字面锚**按序**(多 ref 列的 v3 升级产物:
 *  折叠时后续 ref 的标记留在 cell 内 —— 派生若只写首锚,下次加载「连续锚」校验必失败,
 *  布局一次编辑后就死(Codex 终审 P0)。原样收回 = layout↔正文精确往返。 */
function cellRefs(cell: ProseNode): string[] {
  const refs = [String(cell.attrs.anchor)]
  cell.forEach((child) => {
    if (child.type.name !== 'paragraph' || child.childCount !== 1) return
    const inner = child.firstChild!
    if (inner.type.name !== 'html') return
    const m = MARKER_RE.exec(String(inner.attrs.value ?? '').trim())
    if (m) refs.push(m[1])
  })
  return refs
}

export function deriveLayoutJson(doc: ProseNode): string | null {
  const rows: LayoutRow[] = []
  doc.forEach((node) => {
    if (node.type.name !== 'amadeusColumnRow') return
    const columns: LayoutColumn[] = []
    node.forEach((cell) => {
      columns.push({ refs: cellRefs(cell), width: Number(cell.attrs.width) || 1 })
    })
    if (columns.length >= 2) rows.push({ columns, ...(node.attrs.tail ? { tail: String(node.attrs.tail) } : {}) })
  })
  if (!rows.length) return null
  return JSON.stringify({ v: 4, rows })
}

// ── 规范化(appendTransaction):行内 <2 列 → 解散回自然流(恒);空 cell 只在**结构性事务**
// (drop / 我们自己的列操作,meta uiEvent='drop' | amxColumns)后清除 —— 打字删空必须保留
// (Codex B10:空 cell = 合法裸锚,正常编辑不许突然塌方)。
// 锚永不回收(Codex 共2/规范):被清的 cell 与解散的行,锚一律转**惰性字面标记**留在自然流
// (`<!-- a id -->` 行;既有 `![[note#id]]` 按「紧随其后块级节点」继续解析)。
export const columnsNormalizer = $prose(() =>
  new Plugin({
    key: new PluginKey('AMX_COLUMNS_NORMALIZE'),
    appendTransaction: (trs, _old, state) => {
      if (!trs.some((t) => t.docChanged)) return null
      const structural = trs.some((t) => t.getMeta('uiEvent') === 'drop' || t.getMeta('amxColumns'))
      const { paragraph, html } = state.schema.nodes
      // 空锚不发标记(PM createAndFill 自动补出的 cell anchor='',发出去就是 `<!-- a  -->` 毁格式)。
      const markerParas = (anchor: string): ProseNode[] =>
        anchor ? [paragraph.create(null, html.create({ value: `<!-- a ${anchor} -->` }))] : []
      type Job = { from: number; to: number; content: ProseNode[] }
      const jobs: Job[] = []
      // 嵌套行禁令(Codex Y-P0:cell content 'block+' 管不住粘贴进来的 row):cell 里的 row 原地展开。
      // ⚠️ 顶级 row 必须继续下钻(返回 true)才能看见 cell 里的嵌套 row(Codex 终审:返回 false 则分支不可达)。
      state.doc.descendants((node, pos, parent) => {
        if (node.type.name === 'amadeusColumnRow' && parent?.type.name === 'amadeusColumnCell') {
          const flat: ProseNode[] = []
          node.forEach((c) => c.forEach((child) => flat.push(child)))
          jobs.push({ from: pos, to: pos + node.nodeSize, content: flat.length ? flat : [paragraph.create()] })
          return false // 嵌套行自身之下不再深入(内容已整体摊平)
        }
        return true
      })
      state.doc.forEach((node, offset) => {
        if (node.type.name !== 'amadeusColumnRow') return
        const cells: ProseNode[] = []
        node.forEach((c) => cells.push(c))
        const isEmpty = (c: ProseNode): boolean =>
          c.childCount === 1 && c.firstChild!.type.name === 'paragraph' && c.firstChild!.content.size === 0
        const survivors = structural ? cells.filter((c) => !isEmpty(c)) : cells
        // 空锚补号(PM createAndFill 自动补 cell 时 anchor=''):就地重建带新锚的 cell。
        const needAnchorFix = survivors.some((c) => !c.attrs.anchor)
        if (survivors.length === cells.length && survivors.length >= 2 && !needAnchorFix) return
        const used = new Set<string>()
        state.doc.descendants((n) => {
          if (n.type.name === 'amadeusColumnCell' && n.attrs.anchor) used.add(String(n.attrs.anchor))
          if (n.type.name === 'amadeusColumnRow' && n.attrs.tail) used.add(String(n.attrs.tail))
        })
        const fixAnchor = (c: ProseNode): ProseNode => {
          if (c.attrs.anchor) return c
          let id = 'c' + Math.random().toString(36).slice(2, 6)
          while (used.has(id)) id = 'c' + Math.random().toString(36).slice(2, 6)
          used.add(id)
          return c.type.create({ ...c.attrs, anchor: id }, c.content)
        }
        // 被清 cell 恒为空(只有空 cell 会被结构性清除),其锚是裸锚无内容 —— 统一放行后
        // (语义:原属该行,行后最接近原位;完美插回原列间隙不值得为空锚做,Codex 终审 P1 记录)。
        const droppedMarkers = cells.filter((c) => !survivors.includes(c)).flatMap((c) => markerParas(String(c.attrs.anchor)))
        if (survivors.length >= 2) {
          jobs.push({
            from: offset,
            to: offset + node.nodeSize,
            content: [node.type.create(node.attrs, survivors.map(fixAnchor)), ...droppedMarkers],
          })
        } else {
          // 解散:每个存活 cell 的锚转惰性标记 + 内容摊平,空 cell 只留标记,tail 锚同保。
          const flat: ProseNode[] = [...droppedMarkers]
          for (const c of survivors) {
            flat.push(...markerParas(String(c.attrs.anchor)))
            c.forEach((child) => flat.push(child))
          }
          flat.push(...markerParas(String(node.attrs.tail ?? '')))
          jobs.push({ from: offset, to: offset + node.nodeSize, content: flat.length ? flat : [paragraph.create()] })
        }
      })
      if (!jobs.length) return null
      let tr = state.tr
      for (const j of jobs.sort((a, b) => b.from - a.from)) {
        tr = tr.replaceWith(j.from, j.to, j.content)
      }
      return tr
    },
  }),
)

// ── 拖至块左右缘 → 成列(v3 pairBlocks 语义,单事务单步撤销)。────────────────────────────
// target 顶级块:目标+拖块成两列新行;target 已在列内:该侧插入新列(Codex B8 拓扑)。
// B9:list_item 不能做 cell 根级子节点 → 先规范化为完整列表再入列。
// 返回 false = 无法配对(调用方放行默认落点,绝不 preventDefault)。
export function executePair(view: EditorView, targetPos: number, side: 'left' | 'right', copy = false): boolean {
  const { state } = view
  const sel = state.selection
  if (!(sel instanceof NodeSelection)) return false
  const dragged = sel.node
  if (dragged.type.name === 'amadeusColumnRow' || dragged.type.name === 'amadeusColumnCell') return false
  if (targetPos >= sel.from && targetPos < sel.to) return false // 拖到自己身上
  const row = state.schema.nodes.amadeusColumnRow
  const cellT = state.schema.nodes.amadeusColumnCell
  if (!row || !cellT) return false
  const cellChild =
    dragged.type.name === 'list_item' ? sel.$from.parent.type.create(sel.$from.parent.attrs, dragged) : dragged
  const $t = state.doc.resolve(targetPos)
  let inRow: { rowPos: number; cellIndex: number } | null = null
  if ($t.depth > 0) {
    let rowDepth = -1
    for (let d = $t.depth; d >= 1; d--)
      if ($t.node(d).type === row) {
        rowDepth = d
        break
      }
    if (rowDepth < 0) return false // 嵌套在别处(li/callout 内):不配对
    if (rowDepth !== 1) return false // 行只允许顶级
    inRow = { rowPos: $t.before(rowDepth), cellIndex: $t.index(rowDepth) }
  }
  const taken = new Set<string>()
  const fresh = (): string => {
    let id = freshAnchorId(state.doc)
    while (taken.has(id)) id = freshAnchorId(state.doc)
    taken.add(id)
    return id
  }
  const aT = fresh()
  const aD = fresh()
  let tr = state.tr
  if (!copy) tr = tr.delete(sel.from, sel.to) // Alt(mac)/Ctrl 拖 = 复制:原块留在原地
  if (!inRow) {
    const tPos = tr.mapping.map(targetPos)
    const tNode = tr.doc.nodeAt(tPos)
    if (!tNode) return false
    const cells =
      side === 'left'
        ? [cellT.create({ anchor: aD, width: 1 }, cellChild), cellT.create({ anchor: aT, width: 1 }, tNode)]
        : [cellT.create({ anchor: aT, width: 1 }, tNode), cellT.create({ anchor: aD, width: 1 }, cellChild)]
    tr = tr.replaceWith(tPos, tPos + tNode.nodeSize, row.create({ tail: fresh() }, cells))
  } else {
    const rowPos2 = tr.mapping.map(inRow.rowPos)
    const rowNode = tr.doc.nodeAt(rowPos2)
    if (!rowNode || rowNode.type !== row) return false
    const insertIndex = side === 'left' ? inRow.cellIndex : inRow.cellIndex + 1
    let at = rowPos2 + 1
    for (let i = 0; i < Math.min(insertIndex, rowNode.childCount); i++) at += rowNode.child(i).nodeSize
    tr = tr.insert(at, cellT.create({ anchor: aD, width: 1 }, cellChild))
  }
  tr.setMeta('amxColumns', true)
  view.dispatch(tr.scrollIntoView())
  return true
}

/** 拖到分栏行**下方**(行底以下、未进下一顶层块)→ 块移出到行后顶层(AFFiNE 语义,2026-08-13
 *  第5振:行是文末节点时,行内任何落点都被 posAtCoords 吸进最近 cell,块永远出不了列)。
 *  删+插一个事务;meta amxColumns 与横向拖拽同门(拖空 cell 由 normalizer 解散)。 */
export function executeMoveBelowRow(view: EditorView, rowPos: number, copy = false): boolean {
  const { state } = view
  const sel = state.selection
  if (!(sel instanceof NodeSelection)) return false
  const dragged = sel.node
  if (dragged.type.name === 'amadeusColumnRow' || dragged.type.name === 'amadeusColumnCell') return false
  const rowNode = state.doc.nodeAt(rowPos)
  if (!rowNode || rowNode.type.name !== 'amadeusColumnRow') return false
  // 已经紧贴行后:移动是 no-op(别造空撤销步),复制则是正当的「就地再来一份」。
  if (!copy && sel.from === rowPos + rowNode.nodeSize) return false
  // list_item 拖出列:包回完整列表(与 executePair B9 同规)
  const moved =
    dragged.type.name === 'list_item' ? sel.$from.parent.type.create(sel.$from.parent.attrs, dragged) : dragged
  let tr = state.tr
  if (!copy) tr = tr.delete(sel.from, sel.to) // Alt(mac)/Ctrl 拖 = 复制
  tr = tr.insert(tr.mapping.map(rowPos + rowNode.nodeSize), moved)
  tr.setMeta('amxColumns', true)
  view.dispatch(tr.scrollIntoView())
  return true
}

/** 「移到新列」(v3 splitToColumn 语义):把顶层块 [from,to) 换成「左列=它 + 右列空段」的两列行,
 *  光标落右列。⠿ 菜单与 slash「分栏」共用这一份 —— 别在调用处各写一遍建行代码。
 *  目标不在顶层(已在列内 / li 内)返回 false:行只允许顶级,列内块靠拖拽调整(与 executePair 同规)。 */
export function splitToColumn(view: EditorView, from: number, to: number, node: ProseNode): boolean {
  // ⚠️ 画布卡片不给入列(Codex P0-7):卡真被塞进 cell 后,空列 normalizer 解散行、canvas normalizer
  //    又因卡后出现列锚/tail 把卡拆壳 —— 既没有新列,卡片几何与 canvas 键也一起没了,只剩几枚惰性锚。
  //    将来要支持得定义「先收回卡、再入列」的单事务并保住旧锚(方案 §3.2),不是放开这道闸就行。
  if (node.type.name === 'amadeusCanvasCard') return false
  const { state } = view
  if (state.doc.resolve(from).depth !== 0) return false
  const row = state.schema.nodes.amadeusColumnRow
  const cellT = state.schema.nodes.amadeusColumnCell
  const para = state.schema.nodes.paragraph
  if (!row || !cellT || !para) return false
  const taken = new Set<string>()
  const fresh = (): string => {
    let id = freshAnchorId(state.doc)
    while (taken.has(id)) id = freshAnchorId(state.doc)
    taken.add(id)
    return id
  }
  const rowNode = row.create({ tail: fresh() }, [
    cellT.create({ anchor: fresh(), width: 1 }, node),
    cellT.create({ anchor: fresh(), width: 1 }, para.create()),
  ])
  let tr = state.tr.replaceWith(from, to, rowNode)
  // 落点=右列那个空段的内部(行尾 -3 = 跳过 段闭合/cell 闭合/row 闭合 三个位置)。
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(from + rowNode.nodeSize - 3)))
  tr.setMeta('amxColumns', true)
  view.dispatch(tr.scrollIntoView())
  return true
}

/** 列 schema + 规范化(fold 另经 createColumnsFold 按页闭包创建)。 */
export const columnPlugins = [columnRowSchema, columnCellSchema, columnsNormalizer].flat()
