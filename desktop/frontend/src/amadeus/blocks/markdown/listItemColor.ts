/** 列表项 / 待办的整块颜色(./blockColor):在 gfm 的待办扩展之上再扩一层,attr 挂在 list_item 上(DOM 写在 <li>),
 *  落盘写进第一段段首,读入时从第一段摘下来。挂法照 ./paragraphIndent 的「原位替换」:在 gfm preset 数组里换掉
 *  extendListItemSchemaForTask 的 node / ctx,不追加 —— 追加会让同名节点被挪到 schema 节点序末尾。 */
import { extendListItemSchemaForTask } from '@milkdown/kit/preset/gfm'
import { COLOR_ATTR_SPEC, colorDomAttrs, colorFromDom, liftContainerColor, withColorOnFirstChild } from './blockColor'

type MdListItem = { type: string; children?: unknown[]; label?: unknown; spread?: unknown; checked?: unknown }

export const coloredListItemSchema = extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...base.attrs, ...COLOR_ATTR_SPEC },
    parseDOM: (base.parseDOM ?? []).map((rule) => ({
      ...rule,
      getAttrs: (dom: HTMLElement | string) => {
        const got = typeof rule.getAttrs === 'function' ? rule.getAttrs(dom as never) : {}
        if (got === false || typeof dom === 'string') return got
        return { ...(got ?? {}), ...colorFromDom(dom) }
      },
    })),
    toDOM: (node) => {
      const spec = base.toDOM!(node) as [string, Record<string, unknown>, ...unknown[]]
      const color = colorDomAttrs(node.attrs)
      return Object.keys(color).length ? [spec[0], { ...spec[1], ...color }, ...spec.slice(2)] as never : spec as never
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const lifted = liftContainerColor(node as MdListItem)
        if (!lifted.bg && !lifted.fg) return void base.parseMarkdown.runner(state, node, type)
        // 与 preset 的两条 runner(commonmark list_item / gfm 待办)同一套 attr 推导,只多 bg / fg。
        const n = node as MdListItem
        const label = n.label != null ? `${n.label}.` : '•'
        const listType = n.label != null ? 'ordered' : 'bullet'
        const spread = n.spread != null ? `${n.spread}` : 'true'
        const checked = n.checked != null ? Boolean(n.checked) : null
        state.openNode(type, { label, listType, spread, ...(checked != null ? { checked } : {}), bg: lifted.bg, fg: lifted.fg })
        state.next(lifted.node.children as never)
        state.closeNode()
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => base.toMarkdown.runner(state, withColorOnFirstChild(node as never)),
    },
  }
})
