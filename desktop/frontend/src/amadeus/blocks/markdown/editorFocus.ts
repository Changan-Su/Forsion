// 编辑器有没有焦点,记进 EditorState —— `decorations(state)` 拿不到 view,问不了 hasFocus。
// 公式 / 高亮注释 / 双链 / 标签的「光标行露源码」和空块占位提示都读这一个;结构前缀(structuralSource)读的是
// DOM 焦点,靠这里的事务重新求值。
// 原先这六个插件各记一份,聚焦时各发一笔只带 meta 的事务;而每笔事务所有装饰插件都要整篇重算一遍,
// 1500 段的笔记点进去第一下约 250ms(2026-10-10 量)。合成一笔。仪器:scripts/focus-cost.check.cjs。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'

/** 要在同一笔事务里顺手置焦点态(点渲染出来的公式 / 注释徽标进源码)时:`tr.setMeta(editorFocusKey, true)`。 */
export const editorFocusKey = new PluginKey<boolean>('amx-editor-focus')

/** 编辑器此刻有没有焦点(没装 editorFocusPlugin 的编辑器恒为 false)。 */
export const editorFocused = (state: EditorState): boolean => editorFocusKey.getState(state) ?? false

export function editorFocusPlugin() {
  return $prose(
    () =>
      new Plugin<boolean>({
        key: editorFocusKey,
        state: {
          init: () => false,
          apply: (tr, v) => {
            const m = tr.getMeta(editorFocusKey) as boolean | undefined
            return typeof m === 'boolean' ? m : v
          },
        },
        // 新建块 autoFocus 可能先于插件视图挂载(那次 focus 事件没人接):补一拍初始态
        view: (view) => {
          queueMicrotask(() => {
            if (!view.isDestroyed && view.hasFocus() && !editorFocused(view.state)) view.dispatch(view.state.tr.setMeta(editorFocusKey, true))
          })
          return {}
        },
        props: {
          handleDOMEvents: {
            // focus 事件必发一笔,哪怕已经记着 true(上面那种顺手置过的):结构前缀要靠这笔事务按 DOM 焦点重新求值。
            focus: (view) => { view.dispatch(view.state.tr.setMeta(editorFocusKey, true)); return false },
            blur: (view) => { if (editorFocused(view.state)) view.dispatch(view.state.tr.setMeta(editorFocusKey, false)); return false },
          },
        },
      }),
  )
}
