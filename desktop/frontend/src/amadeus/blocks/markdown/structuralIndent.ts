/** Markdown 没有顶层标题、列表、引用的「纯视觉缩进」语法。用紧邻块前的 HTML 注释
 *  保存档位：其他 Markdown 阅读器仍按原块渲染；载入时只消费精确匹配的标记。
 *  列表项有前一兄弟时仍优先使用原生嵌套列表，这里只管无法 sink 的列表根。
 */
import { blockquoteAttr, blockquoteSchema, bulletListAttr, bulletListSchema, orderedListAttr, orderedListSchema } from '@milkdown/kit/preset/commonmark'
import { $remark } from '@milkdown/kit/utils'
import { NodeSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { ResolvedPos } from '@milkdown/kit/prose/model'
import { MAX_INDENT } from '@amadeus-shared/indentIo'

const clampIndent = (n: number): number => Math.max(0, Math.min(MAX_INDENT, Math.floor(n) || 0))

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: { amadeusIndent?: number }; ordered?: boolean; spread?: boolean; start?: number }
const MARKER = /^<!-- amadeus-indent:([1-8]) -->$/
const MARKED_TYPES = new Set(['heading', 'blockquote', 'list'])

function restoreMarkers(node: MdNode): void {
  if (!node.children) return
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const marker = children[i]
    const next = children[i + 1]
    // commonmark 的 remarkHtmlTransformer 会把块级 HTML 包进单子节点 paragraph。
    const html = marker.type === 'paragraph' && marker.children?.length === 1 ? marker.children[0] : marker
    const match = html.type === 'html' && typeof html.value === 'string' ? MARKER.exec(html.value.trim()) : null
    if (match && next && MARKED_TYPES.has(next.type)) {
      next.data = { ...next.data, amadeusIndent: Number(match[1]) }
      children.splice(i, 1)
      i--
      continue
    }
    restoreMarkers(marker)
  }
}

export const structuralIndentRemark = $remark('amadeusStructuralIndent', () => () => (tree) => restoreMarkers(tree as MdNode))
export const markdownBlockIndent = (node: MdNode): number => clampIndent(Number(node.data?.amadeusIndent ?? 0))
export const indentMarker = (n: number): string => `<!-- amadeus-indent:${clampIndent(n)} -->`

export const indentedBlockquoteSchema = blockquoteSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), indent: { default: 0 } },
    parseDOM: [{ tag: 'blockquote', getAttrs: (dom) => ({ indent: clampIndent(Number((dom as HTMLElement).dataset.indent)) }) }],
    toDOM: (node) => {
      const indent = clampIndent(node.attrs.indent as number)
      return ['blockquote', { ...ctx.get(blockquoteAttr.key)(node), ...(indent ? { 'data-indent': indent } : {}) }, 0]
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        state.openNode(type, { indent: markdownBlockIndent(node as MdNode) }).next(node.children).closeNode()
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const indent = clampIndent(node.attrs.indent as number)
        if (indent) state.addNode('html', undefined, indentMarker(indent))
        base.toMarkdown.runner(state, node)
      },
    },
  }
})

export const indentedBulletListSchema = bulletListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), indent: { default: 0 } },
    parseDOM: [{ tag: 'ul', getAttrs: (dom) => ({ spread: (dom as HTMLElement).dataset.spread === 'true', indent: clampIndent(Number((dom as HTMLElement).dataset.indent)) }) }],
    toDOM: (node) => {
      const indent = clampIndent(node.attrs.indent as number)
      return ['ul', { ...ctx.get(bulletListAttr.key)(node), 'data-spread': node.attrs.spread, ...(indent ? { 'data-indent': indent } : {}) }, 0]
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const spread = node.spread != null ? `${node.spread}` : 'false'
        state.openNode(type, { spread, indent: markdownBlockIndent(node as MdNode) }).next(node.children).closeNode()
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const indent = clampIndent(node.attrs.indent as number)
        if (indent) state.addNode('html', undefined, indentMarker(indent))
        base.toMarkdown.runner(state, node)
      },
    },
  }
})

export const indentedOrderedListSchema = orderedListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), indent: { default: 0 } },
    parseDOM: [{ tag: 'ol', getAttrs: (dom) => ({ spread: (dom as HTMLElement).dataset.spread, order: (dom as HTMLElement).hasAttribute('start') ? Number((dom as HTMLElement).getAttribute('start')) : 1, indent: clampIndent(Number((dom as HTMLElement).dataset.indent)) }) }],
    toDOM: (node) => {
      const indent = clampIndent(node.attrs.indent as number)
      return ['ol', { ...ctx.get(orderedListAttr.key)(node), ...(node.attrs.order === 1 ? {} : { start: node.attrs.order }), 'data-spread': node.attrs.spread, ...(indent ? { 'data-indent': indent } : {}) }, 0]
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const spread = node.spread != null ? `${node.spread}` : 'true'
        state.openNode(type, { spread, order: node.start ?? 1, indent: markdownBlockIndent(node as MdNode) }).next(node.children).closeNode()
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const indent = clampIndent(node.attrs.indent as number)
        if (indent) state.addNode('html', undefined, indentMarker(indent))
        base.toMarkdown.runner(state, node)
      },
    },
  }
})

const INDENTABLE = new Set(['heading', 'blockquote', 'bullet_list', 'ordered_list'])

/** 跨块文字选区：每个命中的可缩进顶层块各进/退一档，容器只改外层一次。
 *  表格/代码块的 Tab 另有输入语义；列表项内部的原生 sink/lift 仍由调用方优先处理。 */
export function adjustSelectedBlockIndents(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, delta: 1 | -1): boolean {
  const { from, to } = state.selection
  const tr = state.tr
  let found = false
  state.doc.nodesBetween(from, to, (node, pos) => {
    const name = node.type.name
    if (name === 'table' || name === 'code_block') return false
    if (name !== 'paragraph' && !INDENTABLE.has(name)) return true
    if (name === 'paragraph') {
      const $pos = state.doc.resolve(pos)
      for (let d = $pos.depth; d >= 1; d--) {
        if ($pos.node(d).type.name === 'list_item' || $pos.node(d).type.name === 'blockquote') return false
      }
    }
    found = true
    const current = clampIndent(Number(node.attrs.indent ?? 0))
    const next = clampIndent(current + delta)
    if (next !== current) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next })
    return false
  })
  if (tr.steps.length) dispatch?.(tr.scrollIntoView())
  return found
}

/** 改当前结构块的视觉缩进；列表的 sink/lift 仍由 Tab 层优先处理。 */
export function adjustStructuralIndent(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, $from: ResolvedPos, delta: 1 | -1): boolean {
  if (state.selection instanceof NodeSelection && INDENTABLE.has(state.selection.node.type.name)) {
    const node = state.selection.node
    const pos = state.selection.from
    const next = clampIndent(Number(node.attrs.indent ?? 0) + delta)
    if (next !== clampIndent(Number(node.attrs.indent ?? 0))) dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next }).scrollIntoView())
    return true
  }
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d)
    if (!INDENTABLE.has(node.type.name)) continue
    const pos = $from.before(d)
    const next = clampIndent(Number(node.attrs.indent ?? 0) + delta)
    if (next !== clampIndent(Number(node.attrs.indent ?? 0))) dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next }).scrollIntoView())
    return true
  }
  return false
}
