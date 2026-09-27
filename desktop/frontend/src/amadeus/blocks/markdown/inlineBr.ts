// D-06(评审 2026-09-27):行内 / 表格单元格 / 列表项里的 `<br>` 打开即被删,前后文字粘连,第一次编辑即永久落盘。
//
// 病:Milkdown commonmark preset 的 remark-preserve-empty-line(visitEmptyLine)在**任意深度** splice 掉
// 值恰为 `<br>` `<br/>` `<br />` `<br >` 的 html 节点 —— 它本意只是「空段落 = 整行 `<br />`」的读回,
// 却连段落 / 单元格里的行内 `<br>` 一起吃了。`hello<br>world` → `helloworld`,`| Alice<br>Bob |` → `AliceBob`。
// 其余变体(`<BR>`、带属性)不删,但成了 contenteditable=false 的字面原子。
//
// 修法(对称两侧,逐字往返):
//  · 读:在 preserve-empty-line **之前**(commonmarkWithIndent 里原位插入)把**行内**的 `<br…>` html 节点换成
//    remark 的 break 节点,原文记在 `data.amadeusBr` —— 渲染成真换行(同 Obsidian)。
//  · 写:hardbreak 扩一个 `html` attr;有原文就原样写回 html(`<br>` / `<BR>` / `<br class="x">` 逐字),
//    没有(用户自己敲的 Shift+Enter)照旧走 preset 的 `\` 换行。
//  · 段落 / 标题的序列化器会掐掉**尾随** hardbreak(preset serializeText:尾部 `\` 换行读回来是字面反斜杠),
//    带原文的 `<br>` 不在此列 —— `Alice<br>` 在单元格末尾是合法的,掐了就是 D-06 换个位置复发(见 keepsTrailingBr)。
//
// ⚠️ 只动**行内**:父节点是 root / blockquote / listItem 的 html 是块级 HTML,整行 `<br>` 在那里是「空段落」的
//    编码(附录 A 既定的空行编码,softBreak.ts 的 stripEmptyLineBr / blankLineRemark 那套),原样交给 preset。
//    段落里独占一行的 `<br>`(`a⏎<br />⏎b`)同理 —— 那是旧版(v3)空段落的落盘形,见 ownLine。
// ⚠️ preserve-empty-line 插件本身**不能拆**:preset 段落序列化器按它的 id 判断要不要把空段落写成 `<br />`。
// 仪器:npm run check:rtcorpus(d06.*)、inlineBr.test.ts。
import { $prose, $remark } from '@milkdown/kit/utils'
import { hardbreakSchema } from '@milkdown/kit/preset/commonmark'
import { AddMarkStep, ReplaceStep } from '@milkdown/kit/prose/transform'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

// mdast 是动态形状的 AST,这层统一按 any 处理(同 softBreak.ts / marks.ts)。
/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

/** 单个 `<br…>` 标签(行内 html 节点的值恰是一个标签)。`<brx>` 这类不是 br。 */
const INLINE_BR_RE = /^<br\b[^<>]*>$/i
/** 这些父节点下的 html 是块级 HTML,不归本插件管(整行 `<br>` = 空行编码)。 */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/** 段落里**独占一行**的 `<br>`(前后都是换行 / 段首段尾):旧版空段落的落盘记号(`a⏎<br />⏎b` = a、空段、b),
 *  与写侧 stripEmptyLineBr「整行 `<br>` = 空行」同一口径 —— 照旧交给 preserve-empty-line,不当成换行(否则多出一个空段)。 */
function ownLine(kids: MdNode[], i: number): boolean {
  const prev = kids[i - 1], next = kids[i + 1]
  // 真换行才算行界:硬换行(`\` / 两空格)是 break 节点;已被本插件转成 break 的 `<br>` 不算(`a<br><br>⏎b` 的第二个不是独占一行)。
  const lineBreak = (n: MdNode): boolean => n.type === 'break' && !n.data?.amadeusBr
  const endsLine = (n: MdNode): boolean => !n || lineBreak(n) || (n.type === 'text' && /\n[ \t]*$/.test(n.value ?? ''))
  const startsLine = (n: MdNode): boolean => !n || lineBreak(n) || (n.type === 'text' && /^[ \t]*\n/.test(n.value ?? ''))
  return endsLine(prev) && startsLine(next)
}

/** 就地把树里所有**行内** `<br…>` 换成带原文的 break 节点(导出供单测)。 */
export function inlineBrToBreak(tree: MdNode): void {
  const walk = (node: MdNode): void => {
    const kids: MdNode[] | undefined = node?.children
    if (!Array.isArray(kids)) return
    const inline = !BLOCK_PARENTS.has(node.type)
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]
      if (inline && k?.type === 'html' && typeof k.value === 'string' && INLINE_BR_RE.test(k.value) && !ownLine(kids, i)) {
        kids[i] = { type: 'break', data: { amadeusBr: k.value }, position: k.position }
        continue
      }
      walk(k)
    }
  }
  walk(tree)
}

export const inlineBrRemark = $remark('amadeusInlineBr', () => () => (tree: MdNode): void => inlineBrToBreak(tree))

/** hardbreak + `html` attr:带原文的换行原样写回。其余与 preset 同款(toDOM / leafText / isInline 都不动)。 */
export const hardbreakWithHtmlSchema = hardbreakSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), html: { default: null } },
    // 原文也进 DOM:粘贴走 plugin-clipboard 的「md → PM → DOM → parseSlice」,不带上它 `<br>` 在粘贴后退成 `\` 换行。
    parseDOM: [
      { tag: 'br[data-md-br]', getAttrs: (dom) => ({ html: (dom as HTMLElement).getAttribute('data-md-br') }) },
      ...(base.parseDOM ?? []),
    ],
    toDOM: (node) => {
      const spec = base.toDOM!(node) as [string, Record<string, unknown>, ...unknown[]]
      return typeof node.attrs.html === 'string' && spec[0] === 'br'
        ? [spec[0], { ...spec[1], 'data-md-br': node.attrs.html }, ...spec.slice(2)] as never
        : spec as never
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const html = (node as MdNode).data?.amadeusBr
        state.addNode(type, { isInline: Boolean((node as MdNode).data?.isInline), html: typeof html === 'string' ? html : null })
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        if (typeof node.attrs.html === 'string') state.addNode('html', undefined, node.attrs.html)
        else base.toMarkdown.runner(state, node)
      },
    },
  }
})

/** 段落 / 标题末尾是「带原文的 `<br>`」:不能走 preset 的 serializeText(它掐尾随 hardbreak)。 */
export const keepsTrailingBr = (node: PMNode): boolean =>
  node.lastChild?.type.name === 'hardbreak' && typeof node.lastChild.attrs.html === 'string'

/** preset hardbreakClearMarkPlugin 的原位替换:给跨过 `<br>` 的选区加 mark 时,它用 setNodeMarkup(…, undefined, [])
 *  把 hardbreak 的 attrs **重置成缺省** —— `<br>` 原文随之丢掉(落成 `\` 换行),软换行也被拍成硬换行。
 *  这里只清 marks、attrs 原样带着;插入 hardbreak 那一支(meta 'hardbreak')与 preset 一致。
 *  挂法:commonmarkWithIndent 里原位替换 preset 的 hardbreakClearMarkPlugin(两个同时在 = 后者再重置一次)。 */
export const hardbreakClearMarkKeepAttrs = $prose((ctx) => new Plugin({
  key: new PluginKey('AMADEUS_HARDBREAK_MARKS'),
  appendTransaction: (trs, _old, newState) => {
    const tr = trs[0]
    const step = tr?.steps[0]
    if (!tr || !step) return null
    const type = hardbreakSchema.type(ctx)
    if (tr.getMeta('hardbreak')) {
      // 刚插入的 hardbreak:与 preset 逐字一致(新节点本来就是缺省 attrs)。
      if (!(step instanceof ReplaceStep)) return null
      return newState.tr.setNodeMarkup(step.from, type, undefined, [])
    }
    if (step instanceof AddMarkStep) {
      let next = newState.tr
      newState.doc.nodesBetween(step.from, step.to, (node, pos) => {
        if (node.type === type && node.marks.length) next = next.setNodeMarkup(pos, type, node.attrs, [])
      })
      return next.docChanged ? next : null
    }
    return null
  },
}))

