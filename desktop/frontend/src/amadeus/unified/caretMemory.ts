/** 光标的本机记忆(评审 C-23):换篇回来、重载 / 重启后回到上次的光标处。
 *  · 记:选区或文档变了 → 300ms 防抖记 anchor / head + head 前后一小段文字;实例拆掉时补记最后一次。
 *  · 放:编辑器建好后一个微任务里(折叠记忆同一时机),restore() 允许才放 —— 有别的落点请求(新建流聚焦标题、
 *    标题回车进正文、改名「接着写」、画布模式、只读)一律让位;之后的显式跳转(大纲 / 锚点 / 搜索命中)照常覆盖它。
 *    按文本复核:位置越界或前后文字对不上(文档在别处被改过)就丢弃,绝不把光标放到别的字上。
 *  · 焦点:只在 focus() 说可以时给 —— 焦点掉在 body 上(换篇后旧编辑器被拆、刚启动)且本实例属于活动面板;
 *    侧栏 / 输入框里握着焦点时不抢。不进撤销栈、不滚动(滚动由滚动记忆负责)。 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin, TextSelection, type Selection } from '@milkdown/kit/prose/state'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { flushNoteViews, readNoteCaret, writeNoteCaret } from './viewMemory'

/** head 前后各 12 个位置内的文字(跨块用 \n、原子节点用 ￼)。 */
export function caretContext(doc: ProseNode, head: number): string {
  const size = doc.content.size
  return doc.textBetween(Math.max(0, head - 12), Math.min(size, head + 12), '\n', '￼')
}

export function createCaretMemory(opts: {
  where: () => { vaultRoot: string | null | undefined; path: string }
  restore: () => boolean
  focus: () => boolean
}): MilkdownPlugin[] {
  return [
    $prose(() => new Plugin({
      view: (view) => {
        let alive = true
        let timer: ReturnType<typeof setTimeout> | null = null
        const save = (): void => {
          timer = null
          const { vaultRoot, path } = opts.where()
          const s = view.state.selection
          writeNoteCaret(vaultRoot, path, { a: s.anchor, h: s.head, t: caretContext(view.state.doc, s.head) })
        }
        queueMicrotask(() => {
          if (!alive || !opts.restore()) return
          const { vaultRoot, path } = opts.where()
          const c = readNoteCaret(vaultRoot, path)
          const doc = view.state.doc
          if (!c || c.a > doc.content.size || c.h > doc.content.size || caretContext(doc, c.h) !== c.t) return
          let sel: Selection
          try { sel = TextSelection.between(doc.resolve(c.a), doc.resolve(c.h)) } catch { return }
          if (sel.anchor !== c.a || sel.head !== c.h) return // 落不到原位(那里已不是文字位)→ 不猜
          view.dispatch(view.state.tr.setSelection(sel).setMeta('addToHistory', false))
          if (opts.focus()) view.focus()
        })
        // 重载 / 关窗不走 React 卸载:防抖着的那一笔现在记、现在落(渲染进程无响应被重载时也只丢这 300ms 之前的)。
        const onHide = (): void => {
          if (!timer) return
          clearTimeout(timer)
          save()
          flushNoteViews()
        }
        window.addEventListener('pagehide', onHide)
        return {
          update: (v, prev) => {
            if (v.state.selection.eq(prev.selection) && v.state.doc === prev.doc) return
            if (timer) clearTimeout(timer)
            timer = setTimeout(save, 300)
          },
          destroy: () => {
            alive = false
            window.removeEventListener('pagehide', onHide)
            if (timer) { clearTimeout(timer); save() }
          },
        }
      },
    })),
  ]
}
