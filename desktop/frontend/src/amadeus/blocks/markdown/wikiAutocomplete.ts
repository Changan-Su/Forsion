// A ProseMirror plugin that watches for an in-progress [[ … and reports the query,
// its document range, and caret screen coords so a React popup can suggest pages.
// The query lives in the document (unlike the slash menu), so the popup lets letters
// pass through and only intercepts navigation keys.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { blockLabel, type BlockNode } from './blockTriggers'

export interface WikiQuery {
  /** Text typed after the opening "[[". */
  query: string
  /** Document position just after "[[". */
  from: number
  /** Document position of the caret. */
  to: number
  left: number
  /** 光标行下沿(视口 px):菜单默认展开点。 */
  top: number
  /** 光标行上沿(视口 px):下方放不下时菜单翻到这条线之上,不盖住正在打字的行。 */
  anchorTop: number
}

export function wikiSuggestPlugin(report: (q: WikiQuery | null) => void) {
  return $prose(
    () =>
      new Plugin({
        view: () => ({
          update(view) {
            const { selection } = view.state
            if (!selection.empty) return report(null)
            const $head = selection.$head
            if (!$head.parent.isTextblock) return report(null)
            const before = $head.parent.textBetween(0, $head.parentOffset, undefined, '￼')
            const open = before.lastIndexOf('[[')
            if (open < 0) return report(null)
            const q = before.slice(open + 2)
            if (/[\]\n]/.test(q)) return report(null) // the [[ was closed or aborted
            const from = $head.start() + open + 2
            const to = selection.head
            let coords: { left: number; top: number; bottom: number }
            try {
              coords = view.coordsAtPos(to)
            } catch {
              return report(null)
            }
            report({ query: q, from, to, left: coords.left, top: coords.bottom, anchorTop: coords.top })
          },
        }),
      }),
  )
}

/** Same shape for an in-progress "/" slash command (Notion/AFFiNE 式):
 *  triggers when "/" sits at line start or after whitespace; aborts on ANY whitespace /
 *  newline / "]" in the query, or an over-long query. Crucially the query lives IN THE
 *  DOCUMENT (like [[ and @, unlike the old keystroke-sink menu) — so letters fall through
 *  to the editor and never get swallowed, and typing a space just leaves "/foo " as literal
 *  text (the menu vanishes). `from` = position just after "/"; the picker deletes the
 *  "/query" range via slashRange (blockTriggers) before applying the item. */
export function slashSuggestPlugin(report: (q: WikiQuery | null) => void) {
  return $prose(
    () =>
      new Plugin({
        view: () => ({
          update(view) {
            const { selection } = view.state
            if (!selection.empty) return report(null)
            const $head = selection.$head
            if (!$head.parent.isTextblock) return report(null)
            if ($head.parent.type.name === 'code_block') return report(null) // 代码块内 '/' 恒字面(路径/正则/注释)
            const before = $head.parent.textBetween(0, $head.parentOffset, undefined, '￼')
            const slash = before.lastIndexOf('/')
            if (slash < 0) return report(null)
            if (slash > 0 && !/\s/.test(before[slash - 1])) return report(null) // 词中的 '/'(TCP/IP、路径)不触发
            const q = before.slice(slash + 1)
            // 空格(含 nbsp)/换行/']' → 关菜单留字面;'￼' = 行内图片/公式 leaf 占位,命中即关
            // (否则 slashRange 从 '/' 删到光标会把图片/公式一起删掉,Codex)。
            if (q.length > 40 || /[\s\]\n￼]/.test(q)) return report(null)
            const from = $head.start() + slash + 1
            const to = selection.head
            let coords: { left: number; top: number; bottom: number }
            try {
              coords = view.coordsAtPos(to)
            } catch {
              return report(null)
            }
            report({ query: q, from, to, left: coords.left, top: coords.bottom, anchorTop: coords.top })
          },
        }),
      }),
  )
}

/** Same shape for an in-progress "@" mention (Notion 式提及页面):
 *  triggers when "@" sits at line start or after whitespace; aborts on brackets/newline
 *  or an over-long query (an "@" far behind the caret is prose, not a mention).
 *  `from` = position just after "@" — the picker replaces [from-1, to) with "[[name]]". */
export function mentionSuggestPlugin(report: (q: WikiQuery | null) => void) {
  return $prose(
    () =>
      new Plugin({
        view: () => ({
          update(view) {
            const { selection } = view.state
            if (!selection.empty) return report(null)
            const $head = selection.$head
            if (!$head.parent.isTextblock) return report(null)
            const before = $head.parent.textBetween(0, $head.parentOffset, undefined, '￼')
            const at = before.lastIndexOf('@')
            if (at < 0) return report(null)
            if (at > 0 && !/\s/.test(before[at - 1])) return report(null) // 邮箱等:@ 前非空白不触发
            const q = before.slice(at + 1)
            if (q.length > 30 || /[[\]\n]/.test(q)) return report(null)
            const from = $head.start() + at + 1
            const to = selection.head
            let coords: { left: number; top: number; bottom: number }
            try {
              coords = view.coordsAtPos(to)
            } catch {
              return report(null)
            }
            report({ query: q, from, to, left: coords.left, top: coords.bottom, anchorTop: coords.top })
          },
        }),
      }),
  )
}

/** 非空选区 → 上浮格式工具栏(选中文字的“快捷编辑”,同 Notion/AFFiNE)。与 [[ / @ / 斜杠三个补全
 *  互斥:它们只在光标折叠(空选区)时触发,这个只在有选区时触发。报告选区两端中点上方的屏幕坐标。 */
export interface SelRect {
  from: number
  to: number
  left: number
  /** 选区行上沿(视口 px):工具栏默认浮在它之上。 */
  top: number
  /** 选区行下沿(视口 px):上方没空间时翻到它之下。 */
  bottom: number
  /** 选区所在块的类型名(「正文」/「标题 2」/「无序列表」…),给工具栏的「转换为」按钮显示当前类型。 */
  kind: string
}
export function selectionToolbarPlugin(report: (r: SelRect | null) => void) {
  return $prose(
    () =>
      new Plugin({
        view: () => ({
          update(view) {
            const { selection, doc } = view.state
            // hasFocus:编辑器失焦(点到别处/别的块)时 blur 会派空事务触发 update、选区仍非空 →
            // 不判此条会留下过期工具栏,点它会对已离开的块施格式(Codex L2)。
            if (selection.empty || !view.editable || !view.hasFocus()) return report(null)
            const { from, to } = selection
            const $from = doc.resolve(from)
            if (!$from.parent.isTextblock) return report(null) // 节点选区不服务行内格式化
            // 跨块选区(段落拖到标题)行内格式仍然可用,但**不能谎报**成起点块的类型 —— 标成「多个块」。
            const spans = !$from.sameParent(doc.resolve(to))
            let a: { left: number; top: number; bottom: number }
            let b: { left: number; top: number; bottom: number }
            try {
              a = view.coordsAtPos(from)
              b = view.coordsAtPos(to)
            } catch {
              return report(null)
            }
            // 祖先链(内→外),attrs 各随各的节点 → 当前块类型名(此前工具栏恒显示「正文」)。
            const chain: BlockNode[] = []
            for (let d = $from.depth; d > 0; d--) {
              const n = $from.node(d)
              chain.push({ name: n.type.name, level: n.attrs.level as number | undefined, checked: (n.attrs.checked as boolean | null | undefined) ?? null })
            }
            report({ from, to, left: (a.left + b.left) / 2, top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), kind: spans ? '多个块' : blockLabel(chain) })
          },
        }),
      }),
  )
}
