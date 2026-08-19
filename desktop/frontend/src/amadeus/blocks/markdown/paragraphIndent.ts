/** 段落缩进档位(2026-08-14 用户拍板:Tab=整段缩进,Notion/AFFiNE 视觉,替换掉「段落转列表」)。
 *
 *  存储:paragraph 节点 attr `indent`(0..MAX_INDENT),DOM 上是 `data-indent`,CSS 按档位给
 *  margin。md 侧:toMarkdown 在段首发 `&#9;`×n 的 html 节点(remark-stringify 原样保留),
 *  经 shared/amadeus/indentIo 的 entitiesToTabs 落盘成行首字面制表符;载入方向 tabsToEntities 先把字面
 *  制表符转实体(防缩进代码块/列表吸入),remark 把实体解码成段首字面 \t 字符,parseMarkdown
 *  再把它们剥进 attr。两处字符串变换的挂点在 MarkdownBlock(v3 逐块)与 UnifiedPage(v4 整页)。
 *
 *  ⚠️ 挂法是**在 commonmark preset 数组里原位替换**(commonmarkWithIndent),不是 .use() 追加:
 *  extendSchema 返回新插件而非原地改单例(只 import 不挂 = 扩展静默不生效);而追加 .use 会让
 *  $node 对同名节点 filter+append —— paragraph 被挪到 schema 节点序**尾部**,heading 顶替它成为
 *  缺省块类型,新建/切分块全部变 H1(实测 e2e 栽过,两种错法都别再犯)。
 */
import { commonmark, paragraphAttr, paragraphSchema } from '@milkdown/kit/preset/commonmark'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { ResolvedPos } from '@milkdown/kit/prose/model'
import { MAX_INDENT } from '@amadeus-shared/indentIo'

export const clampIndent = (n: number): number => Math.max(0, Math.min(MAX_INDENT, Math.floor(n) || 0))

type MdNode = { type: string; value?: string; children?: MdNode[] }

const paragraphIndentSchema = paragraphSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { indent: { default: 0 } },
    parseDOM: [{
      tag: 'p',
      getAttrs: (dom) => ({ indent: clampIndent(Number((dom as HTMLElement).getAttribute('data-indent'))) }),
    }],
    toDOM: (node) => {
      const attrs = { ...ctx.get(paragraphAttr.key)(node) } as Record<string, string>
      const indent = clampIndent(node.attrs.indent as number)
      if (indent) attrs['data-indent'] = String(indent)
      return ['p', attrs, 0]
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        // 段首 text 的行首字面 \t(来自 &#9; 实体解码)剥进 indent attr。
        let indent = 0
        let children = node.children as MdNode[] | undefined
        const first = children?.[0]
        if (first && first.type === 'text' && typeof first.value === 'string') {
          const m = /^\t+/.exec(first.value)
          if (m) {
            indent = clampIndent(m[0].length)
            // 只剥进 attr 的那几枚:外部文件行首 >MAX_INDENT 枚制表符时,超额部分留在文本里
            // (序列化经 remark 转义 + entitiesToTabs 归一,总数保全)—— 全剥但只回发 8 枚
            // 就是首次开-存静默丢字符(评审 P2)。
            const rest = first.value.slice(indent)
            children = rest ? [{ ...first, value: rest }, ...children!.slice(1)] : children!.slice(1)
          }
        }
        state.openNode(type, indent ? { indent } : undefined)
        if (children?.length) state.next(children as never)
        else if (!children) state.addText(((node as MdNode).value || '') as string)
        state.closeNode()
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const indent = clampIndent(node.attrs.indent as number)
        if (!indent || node.content.size === 0) return void base.toMarkdown.runner(state, node)
        state.openNode('paragraph')
        state.addNode('html', undefined, '&#9;'.repeat(indent))
        // serializeText 内联:尾部 hardbreak 掐掉(与基座 preset 同款,内部函数拿不到)
        const lastIsBreak = node.lastChild?.type.name === 'hardbreak'
        state.next(lastIsBreak ? node.content.cut(0, node.content.size - node.lastChild!.nodeSize) : node.content)
        state.closeNode()
      },
    },
  }
})

/** commonmark preset 的原位替换版:paragraph 的 $ctx/$node 换成缩进扩展,**位置不动**
 *  (缺省块类型 = schema 节点序里第一个 block,位置一动 heading 就上位)。 */
export const commonmarkWithIndent = commonmark.map((p) =>
  (p as unknown) === (paragraphSchema.node as unknown) ? paragraphIndentSchema.node
  : (p as unknown) === (paragraphSchema.ctx as unknown) ? paragraphIndentSchema.ctx
  : p)

/** 缩进档的适用面:列表项/引用块的**任意深度祖先**内一律不适用 —— 列表是 sink/lift 的地盘;
 *  引用块里的段落缩进 md 表示不了(序列化成 `> &#9;` 垃圾前缀,评审 P2),不给设。
 *  Tab 与回车/退格共用这一条政策,别在第二处另写一份。 */
function indentable($pos: ResolvedPos): boolean {
  for (let d = $pos.depth; d >= 1; d--) {
    const t = $pos.node(d).type.name
    if (t === 'list_item' || t === 'blockquote') return false
  }
  return true
}

/** 光标所在段落的缩进档;不是段落、或该段不适用缩进档时返回 null。
 *  ⚠️ 返回 0 与返回 null 语义不同:0 = 「是可缩进的段落,但当前在 0 档」(退格该交回 base 合并),
 *  null = 「这段根本不归缩进档管」(列表/引用,交回各自的 lift 语义)。 */
export function paragraphIndentAt($from: ResolvedPos): number | null {
  if ($from.parent.type.name !== 'paragraph') return null
  return indentable($from) ? clampIndent($from.parent.attrs.indent as number) : null
}

/** 选区覆盖的每个段落缩进 ±1。不适用缩进档的段落(见 indentable)跳过。恒吞键。 */
export function adjustParagraphIndent(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, delta: 1 | -1): boolean {
  const { from, to } = state.selection
  const tr = state.tr
  let touched = false
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== 'paragraph') return
    if (!indentable(state.doc.resolve(pos))) return false
    const cur = clampIndent(node.attrs.indent as number)
    const next = clampIndent(cur + delta)
    if (next !== cur) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next })
      touched = true
    }
    return false
  })
  if (touched) dispatch?.(tr.scrollIntoView())
  return true
}
