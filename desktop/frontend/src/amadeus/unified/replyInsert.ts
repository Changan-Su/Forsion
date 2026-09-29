/** 助手回答插回笔记的落点(评审 G3-08)。纯函数:只读 doc,不碰视图。
 *
 *  对话若由「问 Tangu」(G3-04)从这篇的选区 / 块发起,引用里带回来 `[[路径#标题]]` 与被引用的原文(askTangu.ts)。
 *  落点 = 被引用块所在**顶层块**之后(顶层块 = doc 或分栏 cell 的直接子节点,与 insertMd 的 'cursor' 同口径:
 *  列内插入不穿出到 doc 级、列表里插在整只列表之后)。
 *  找法:标题解析得到 → 只在那一节里找原文;先找首行、再从那里往后找末行(跨块选区按行拼的,见 askTanguQuote)。
 *  原文找不到(引用后又改过)但标题在 → 那一节末尾;都不成 → null,调用方退回「光标处 / 文末」。 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { docHeadings } from './outline'
import type { ReplyAnchor } from './lifecycle'

/** pos 所在顶层块的结尾(doc / 分栏 cell 的直接子节点)。 */
function topBlockEnd(doc: ProseNode, pos: number): number | null {
  const $p = doc.resolve(pos)
  let d = $p.depth
  while (d >= 1 && !['doc', 'amadeusColumnCell'].includes($p.node(d - 1).type.name)) d--
  return d >= 1 ? $p.after(d) : null
}

/** 标题 pos 那一节的结尾:下一个同级或更高级的**顶层**标题之前,没有就文末。标题不在顶层(分栏 / 引用里)→ 紧跟它自己。 */
function sectionEnd(doc: ProseNode, pos: number, level: number): number {
  if (doc.resolve(pos).depth !== 0) return topBlockEnd(doc, pos + 1) ?? doc.content.size
  let end = doc.content.size
  let seen = false
  doc.forEach((node, off) => {
    if (end !== doc.content.size) return
    if (off === pos) { seen = true; return }
    if (!seen || node.type.name !== 'heading') return
    const lv = Number((node.attrs as { level?: unknown }).level) || 1
    if (lv <= level) end = off
  })
  return end
}

export function replyAnchorPos(doc: ProseNode, anchor: ReplyAnchor | null | undefined): number | null {
  if (!anchor) return null
  const hs = docHeadings(doc)
  const hi = anchor.heading ? hs.findIndex((x) => x.text === anchor.heading!.trim()) : -1
  const h = hi >= 0 ? hs[hi] : null
  const from = h ? h.pos : 0
  const to = h ? sectionEnd(doc, h.pos, h.level) : doc.content.size
  const lines = (anchor.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length) {
    const blocks: Array<{ pos: number; text: string }> = []
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true
      if (pos >= from) blocks.push({ pos, text: node.textContent })
      return false
    })
    const i = blocks.findIndex((b) => b.text.includes(lines[0]))
    if (i >= 0) {
      const last = lines[lines.length - 1]
      const j = blocks.findIndex((b, k) => k >= i && b.text.includes(last))
      const end = topBlockEnd(doc, blocks[j >= 0 ? j : i].pos + 1)
      if (end != null) return end
    }
  }
  return h ? to : null
}
