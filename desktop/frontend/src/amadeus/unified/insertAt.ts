// 插件写口 `insertMarkdownAt`(2026-11-16)在 v4 编辑器事务里的两件位置活:'caret' 档的行内插入,和 cursorMarker 落光标。
// 解析与派发仍在 UnifiedPage 的 insertMd(与 insertMarkdown 同一条解析 + 事务);这里只管事务内的算术,单测见 insertAt.test.ts。
//
// cursorMarker 的口径:插件给的标记在**解析前**换成一个占位字(第一处换、其余删),解析 → 插入 → 同一事务里删掉占位字、
// 光标落在那里。标记与占位字都从没进过已派发的文档 —— 一步撤销、绝不落盘。直接拿插件原样的标记去文档里找不行:
// 模板标记常带 `%` `$` `{}` 这类 markdown 会吃掉的字(`$…$` 成公式、`<…>` 成 HTML),解析完就找不到了,而它的残骸照样写盘。
import type { Fragment, Node as ProseNode } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'

/** 占位字:U+FDD0 是 Unicode 非字符(规范保证不出现在交换文本里),markdown 不拿它当语法,不会被解析吃掉或拆开。 */
export const CARET_MARK = '﷐'

/** 插件的标记 → 占位字:第一处换成占位字,其余直接删(标记一律不落盘)。
 *  - 没给标记 / 文中没有 → `marked: false`,原文不动。
 *  - 文中本来就有占位字(几乎不可能)→ 分不清哪个是标记:只删标记,不落光标。
 *  `plain` = 所有标记都删掉的原文:占位字落不进正文文字时,调用方用它重解析。 */
export function markCaret(md: string, marker?: string): { md: string; plain: string; marked: boolean } {
  if (!marker || !md.includes(marker)) return { md, plain: md, marked: false }
  const parts = md.split(marker)
  const plain = parts.join('')
  if (md.includes(CARET_MARK)) return { md: plain, plain, marked: false }
  return { md: parts[0] + CARET_MARK + parts.slice(1).join(''), plain, marked: true }
}

/** 解析结果里的占位字能不能落光标:恰好一个、在正文文字里,且没被抄进任何属性(自动链接的地址、图片路径、wiki 链接目标)。
 *  不满足就落不了 —— 删了文字里那个,属性里那个照样写盘 —— 调用方改用 `plain` 重解析(光标照旧落在插入内容末尾)。 */
export function caretMarkUsable(doc: ProseNode): boolean {
  let inText = 0
  let elsewhere = false
  const has = (attrs: unknown): boolean => JSON.stringify(attrs ?? null).includes(CARET_MARK)
  doc.descendants((n) => {
    if (elsewhere) return false
    if (has(n.attrs)) elsewhere = true
    if (n.isText) {
      inText += (n.text ?? '').split(CARET_MARK).length - 1
      if (n.marks.some((m) => has(m.attrs))) elsewhere = true
    }
    return true
  })
  return inText === 1 && !elsewhere
}

/** 派发前的最后一步:在事务的文档里找占位字,删掉,光标落在那里。整篇只认**恰好一个**(就是刚插进来那个 ——
 *  调用方保证插入内容里只有一个,原文档里有占位字的极端情况数出来就不是一个)。找不到 / 不止一个 → false,
 *  事务不动,调用方放弃这笔、改插 `plain`(否则占位字会被写盘)。 */
export function landOnCaretMark(tr: Transaction): boolean {
  let at = -1
  let n = 0
  tr.doc.descendants((node, pos) => {
    if (n > 1) return false
    if (!node.isText) return true
    const text = node.text ?? ''
    for (let i = text.indexOf(CARET_MARK); i >= 0; i = text.indexOf(CARET_MARK, i + 1)) {
      if (n++ === 0) at = pos + i
    }
    return false
  })
  if (n !== 1) return false
  tr.delete(at, at + 1)
  tr.setSelection(TextSelection.create(tr.doc, at))
  return true
}

/** 'caret' 档:解析结果恰好一个**段落** → 把它的行内内容放到选区处(非空选区先删,同打字 / 粘贴一行字)。
 *  放不下 → null,调用方退回 'cursor' 档:选区不是文字选区(选中整块 / 卡片)、内容不止一段或不是段落(标题、列表、代码块),
 *  或光标所在文本块不收这些行内内容(代码块里放加粗、标题里放硬换行)。
 *  返回的事务**未派发**、选区已落在插入内容末尾;`to` = 那个位置。 */
export function inlineAtCaret(state: EditorState, content: Fragment): { tr: Transaction; to: number } | null {
  if (content.childCount !== 1) return null
  const para = content.firstChild
  if (!para || para.type.name !== 'paragraph' || !para.content.size) return null
  if (!(state.selection instanceof TextSelection)) return null
  const tr = state.tr
  if (!state.selection.empty) tr.deleteSelection()
  const $at = tr.selection.$from
  const inline = para.content
  if (!$at.parent.inlineContent || !$at.parent.canReplace($at.index(), $at.index(), inline)) return null
  tr.insert($at.pos, inline)
  const to = $at.pos + inline.size
  tr.setSelection(TextSelection.create(tr.doc, to))
  return { tr, to }
}
