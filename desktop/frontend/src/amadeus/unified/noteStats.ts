/** v4 正文的计数接缝(评审 C-22):状态栏在编辑器外,只经 lifecycle 读数,不摸 view。
 *  · 数的是**可见文字**(PM doc 的 textBetween):链接地址、表格竖线、`- [ ]`、`**` 这些 markdown 记号不算;
 *    原子节点(图片等)给空串;嵌入 `![[x]]` 的语法本身不可见(卡片画的是被嵌内容),也不算;双链只算显示的名字。
 *  · 有非空选区时另给选区的数。
 *  · 节拍:文档或选区变了 → 下一帧 bump 一次(同一帧里多笔事务合并);全文的数按 doc 身份缓存,只动选区不重数全文。 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { countText, type TextCount } from '../lib/textCount'
import { bumpUnifiedStats } from './lifecycle'

export interface NoteStats { all: TextCount; sel: TextCount | null }

export function visibleText(doc: ProseNode, from = 0, to = doc.content.size): string {
  return doc.textBetween(from, to, '\n', () => '')
    .replace(/!\[\[[^\]\n]*\]\]/g, '')
    .replace(/\[\[(?:[^\]|\n]*\|)?([^\]\n]*)\]\]/g, '$1')
}

/** 本实例的计数器:全文按 doc 身份缓存。 */
export function createStatsReader(getView: () => EditorView | null | undefined): () => NoteStats | null {
  let doc: ProseNode | null = null
  let all: TextCount = { chars: 0, words: 0 }
  return () => {
    const v = getView()
    if (!v) return null
    if (v.state.doc !== doc) {
      doc = v.state.doc
      all = countText(visibleText(doc))
    }
    const { from, to, empty } = v.state.selection
    return { all, sel: empty ? null : countText(visibleText(v.state.doc, from, to)) }
  }
}

/** 文档 / 选区一变就(下一帧)通知状态栏重读。 */
export function createStatsTicker(): MilkdownPlugin[] {
  return [
    $prose(() => new Plugin({
      view: () => {
        let raf = 0
        const kick = (): void => {
          if (raf) return
          raf = requestAnimationFrame(() => { raf = 0; bumpUnifiedStats() })
        }
        kick()
        return {
          update: (view, prev) => {
            if (view.state.doc !== prev.doc || !view.state.selection.eq(prev.selection)) kick()
          },
          destroy: () => { if (raf) cancelAnimationFrame(raf); bumpUnifiedStats() },
        }
      },
    })),
  ]
}
