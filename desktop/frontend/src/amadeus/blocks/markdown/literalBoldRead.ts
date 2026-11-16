// Literal bold, read half: every mdast `strong` back into `text(open) …children text(close)` (switch in ./literalBoldFlag).
// open / close are taken from the source by position, so `**` vs `__` survives verbatim. Registered in PARSE_FIDELITY
// (./paragraphIndent), so every parse of the shared editor core (open, paste of Markdown text, external reload, source
// mode, split blocks) reads the same way; the write half is in ./textSafe.
// 加粗字面化的读侧:mdast 的 strong 还原成「定界符文字 + 内容 + 定界符文字」,定界符按原文位置取(`**` / `__` 原样)。
// 挂在 PARSE_FIDELITY,编辑器内核的每次解析(打开、粘贴 Markdown 文字、外部回灌、源码模式、切块)同一口径;写侧见 ./textSafe。
import { $remark } from '@milkdown/kit/utils'
import { literalBoldEnabled } from './literalBoldFlag'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

/** Replace every `strong` with its delimiters as text, recursively. Exported for tests.
 *  把每个 strong 换成「定界符文字 + 子节点 + 定界符文字」(递归)。 */
export function restoreStrongAsText(tree: MdNode, src: string): void {
  const visit = (n: MdNode): void => {
    const kids = n?.children
    if (!Array.isArray(kids)) return
    let touched = false
    const out: MdNode[] = []
    for (const k of kids) {
      visit(k)
      if (k?.type !== 'strong') {
        out.push(k)
        continue
      }
      const s = k.position?.start?.offset
      const e = k.position?.end?.offset
      let open = typeof s === 'number' ? src.slice(s, s + 2) : '**'
      let close = typeof e === 'number' ? src.slice(e - 2, e) : open
      if (open !== '**' && open !== '__') open = '**'
      if (close !== open) close = open
      touched = true
      out.push({ type: 'text', value: open }, ...(k.children ?? []), { type: 'text', value: close })
    }
    if (touched) n.children = out
  }
  visit(tree)
}

/** Read half: in PARSE_FIDELITY (./paragraphIndent). No-op with the switch off. 读侧,开关关着原样返回。 */
export const literalBoldRemark = $remark('amadeusLiteralBold', () => () => (tree: MdNode, file: { value?: unknown }) => {
  if (!literalBoldEnabled()) return
  restoreStrongAsText(tree, String(file?.value ?? ''))
})
/* eslint-enable @typescript-eslint/no-explicit-any */

