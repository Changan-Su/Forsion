// 页内查找替换的所见即所得半(C-18,评审 2026-09-27)。查找条(findInPage.tsx)仍按活动 View 的 DOM 扫描出 Range;
// 这里把落在本篇 PM 里的命中映射回文档位置(posAtDOM),**原文逐字对得上的**才换 —— 对不上的(嵌入卡 / 公式渲染 /
// 双链标签这类 widget 里的字,以及 PM 之外的页面 chrome)一律跳过,绝不按错位写进别处。
// 一次替换(含「全部替换」)= 一个事务 = 编辑器里一步 ⌘Z。
import type { EditorView } from '@milkdown/kit/prose/view'
import type { FindReplaceProvider } from '../../findInPage'

export function pmFindProvider(el: HTMLElement, getView: () => EditorView | null): FindReplaceProvider {
  return {
    el,
    // 只认本篇 PM 自己管的文字:一路往上走到 view.dom,途中碰到 contenteditable=false(widget:嵌入卡 / 公式 / 双链标签)
    // 或另一个 .ProseMirror(嵌入体里的第二个编辑器)就不归这里 —— 查得到、不给换(按钮置灰,不是点了没反应)。
    owns: (n) => {
      const v = getView()
      if (!v || !v.dom.contains(n)) return false
      for (let e = n.nodeType === 1 ? (n as Element) : n.parentElement; e && e !== v.dom; e = e.parentElement) {
        if ((e as HTMLElement).contentEditable === 'false' || e.classList.contains('ProseMirror')) return false
      }
      return true
    },
    replace: (items) => {
      const view = getView()
      if (!view || !view.editable) return 0
      const edits: Array<{ from: number; to: number; text: string }> = []
      for (const { range, text } of items) {
        let from: number
        let to: number
        try {
          from = view.posAtDOM(range.startContainer, range.startOffset)
          to = view.posAtDOM(range.endContainer, range.endOffset)
        } catch {
          continue
        }
        if (to <= from || view.state.doc.textBetween(from, to, '\n', '￼') !== range.toString()) continue
        edits.push({ from, to, text })
      }
      if (!edits.length) return 0
      // 倒序落:前面的位置不受后面的改动影响,不必逐条 map。命中互不重叠(扫描是非重叠的)。
      edits.sort((a, b) => b.from - a.from)
      const tr = view.state.tr
      for (const e of edits) {
        if (e.text) tr.insertText(e.text, e.from, e.to)
        else tr.delete(e.from, e.to)
      }
      view.dispatch(tr)
      return edits.length
    },
  }
}
