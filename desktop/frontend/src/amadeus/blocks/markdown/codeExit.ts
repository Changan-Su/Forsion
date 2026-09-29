// 行内代码的「→ 跳出」(评审 I-11,TipTap exitable 的对位)。
//
// 病:inlineCode 缺省 inclusive,光标回到一段已有代码的右边界(行尾最常见)时,打字 / 空格 / → 都还在代码里 ——
// 行尾没有「下一格」可挪,→ 原地不动;刚用反引号规则打出来的代码正常,是因为那条规则落完 mark 会复位 stored marks。
// 修法:光标在代码右边界(当前生效 marks 带 code、右手边不是代码或已是块尾)按裸 → —— 第一下只把 code 从 stored
// marks 摘掉并吞键(光标不动,接着打的字落在代码外),第二下才照常移动(移动会清 stored marks)。
// 刻意不做:不全局改 inclusive(从左边走进代码、代码中间打字都要照旧);空格与「从右侧 ← 回到边界」维持原样。
// 仪器:npm run check:attention 的 X1~X3(真键盘:落盘断言新字在反引号外)。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'

export const codeExitPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (event.key !== 'ArrowRight' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false
          const { state } = view
          const sel = state.selection
          if (!(sel instanceof TextSelection) || !sel.empty) return false
          // ⚠️ 上一下 ←(原生移动)之后紧接着按 →:浏览器的 selectionchange 是异步任务,输入事件优先级更高,
          //    这一下 keydown 常常先于它被处理 —— state.selection 还停在 ← 之前(行尾),这里判「不在代码里」放行,
          //    光标一路移到后文,新字落错地方(check:attention X2 在页面稍忙时稳定复现)。所以以 DOM 选区为准:
          //    它与 PM 选区不一致时按 DOM 的落点判,接管时顺手把 PM 选区同步过去(stored marks 在同一事务里设)。
          //    stored marks 非空 = 刚由本插件(或打字)在当前位置设过 —— PM 这时是新的,而且光标落在 PM 为 stored marks
          //    画的 cursor wrapper 里,DOM 落点反解会偏;这种时候只信 PM(否则第二下 → 又被当成第一下吞掉,X3)。
          let head = sel.head
          let synced = false
          const dom = state.storedMarks ? null : (view.root as Document).getSelection?.()
          if (dom && dom.isCollapsed && dom.anchorNode && view.dom.contains(dom.anchorNode)) {
            try {
              const at = view.posAtDOM(dom.anchorNode, dom.anchorOffset)
              if (at !== head) { head = at; synced = true }
            } catch { /* DOM 落点解析不出来:照旧信 PM */ }
          }
          const $pos = state.doc.resolve(head)
          if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return false
          const marks = (!synced && state.storedMarks) || $pos.marks()
          const code = marks.find((m) => m.type.spec.code)
          if (!code) return false // 不在代码里,或已经跳出过(stored marks 里没有 code)→ 照常移动
          const after = $pos.nodeAfter
          if (after && code.isInSet(after.marks)) return false // 还在代码中间
          const tr = state.tr
          if (synced) tr.setSelection(TextSelection.create(state.doc, head))
          view.dispatch(tr.setStoredMarks(code.removeFromSet(marks)))
          return true
        },
      },
    }),
)
