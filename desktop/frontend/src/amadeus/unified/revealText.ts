// 全智库搜索 / 标签面板点命中之后,在 v4 笔记里把命中处亮出来(评审 G4-01)。
// v4 正文不进 pageStore,面板原来那条「按 v3 blocks 找 data-block-id」的定位在 v4 上恒落空 → 只开不跳。
// 这里只放两件纯逻辑:在 PM doc 里找命中 + 把会话折叠(标题小节 / 列表子项)里藏着命中的那几层展开;
// 滚动 / 选区 / 闪片由 UnifiedPage 的 revealText 接缝按 C-03 的顺序做(先展开、再 focus、再放选区、再贴顶滚)。
// ⚠️ callout 折叠(`> [!note]-`)是 md 里的标记,展开 = 改盘 —— 点一下搜索结果不许写文件,所以不在这里展开,
//    命中在折起的 callout 里时由调用方退到最近一个看得见的祖先(callout 本身)去亮。
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { isHiddenAt, toggleFoldAt } from './headingFold'
import { listFoldsHiding, toggleListFoldAt } from './listFold'

export interface TextHit {
  from: number
  to: number
  /** 命中所在文本块的前位(nodeDOM 用)。 */
  block: number
}

/** 标签的右边界:`#work` 不许落在 `#workshop` / `#work/urgent` 上(字符集同 shared/links 的 TAG_RE)。 */
const TAG_CHAR = /[\p{L}\p{N}_/-]/u

/** 文本块 → 与文档位一一对应的字符串(下标 i ↔ 位置 start+i):文本原样,行内叶子节点(硬换行 / 行内图片等)
 *  各占一位,用 U+FFFC 占住,保证下标换算不漂。 */
function blockText(node: ProseNode): string {
  let s = ''
  node.forEach((child) => {
    if (child.isText) s += child.text ?? ''
    else s += '￼'.repeat(child.nodeSize)
  })
  return s
}

/** 在 doc 里按文档序找第一处命中。needles 依次尝试(整串优先,切词兜底 —— 与 vaultIndex.search 的摘要锚同口径),
 *  大小写不敏感。tag=true:needle 形如 `#标签`,左边须是行首或空白、右边不能再接标签字符。 */
export function findTextHit(doc: ProseNode, needles: string[], tag = false): TextHit | null {
  for (const raw of needles) {
    const needle = raw.trim().toLowerCase()
    if (!needle) continue
    let hit: TextHit | null = null
    doc.descendants((node, pos) => {
      if (hit) return false
      if (!node.isTextblock) return true
      const text = blockText(node)
      const lower = text.toLowerCase()
      // toLowerCase 改变长度的罕见字符(İ 等)会让下标错位:这种块退回按原文比较,宁可漏也不跳错位。
      const hay = lower.length === text.length ? lower : text
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
        if (tag) {
          if (i > 0 && !/\s/.test(hay[i - 1])) continue
          const next = hay.codePointAt(i + needle.length)
          if (next != null && TAG_CHAR.test(String.fromCodePoint(next))) continue
        }
        hit = { from: pos + 1 + i, to: pos + 1 + i + needle.length, block: pos }
        break
      }
      return false
    })
    if (hit) return hit
  }
  return null
}

/** 把藏着 pos 的会话折叠逐层展开(标题小节可以嵌套、列表子项也可以嵌套;每展开一层再问一次)。
 *  返回是否动过折叠态。纯装饰 meta,不改 doc、不写盘。 */
export function unfoldToReveal(view: EditorView, pos: number): boolean {
  let changed = false
  for (let guard = 0; guard < 32; guard++) {
    const fp = isHiddenAt(view.state, pos)
    if (fp != null) {
      toggleFoldAt(view, fp)
      changed = true
      continue
    }
    const items = listFoldsHiding(view.state, pos)
    if (!items.length) break
    toggleListFoldAt(view, items[0])
    changed = true
  }
  return changed
}
