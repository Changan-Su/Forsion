// 标题「源码行」(对标 Obsidian,与 wikilink.ts / mathLivePreview.ts 同一套逐行显隐语义):
//  · 光标**不在**标题里 → 前缀井号不可见。
//  · 光标**进入**标题 → 行首露出字面 `###`(淡色),**排版仍是标题**。
// 井号在文档里并不存在(commonmark 解析时就被吃掉了,heading 节点只留 level 属性),
// 所以只能用 widget 装饰画出来 —— 它不是文本,不会被选中/复制,也不参与序列化。
//
// ⚠️ 曾经还给该行挂过 `.heading-src` 把字号降回正文,**已撤销,别加回来**:降回正文后,
// 用户敲 `# ` 时触发其实已经生效(节点真变成 h1),但屏幕上字号没变、行首多个 `#` ——
// 与「`# ` 触发压根没生效」完全无法区分,用户实报「输入 # 什么也没发生」。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

const key = new PluginKey<{ focus: boolean }>('amadeus-heading-src')

function build(state: EditorState): DecorationSet {
  if (!key.getState(state)?.focus) return DecorationSet.empty
  const { from, to } = state.selection
  const decos: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true
    const level = Number(node.attrs.level) || 1
    // 选区与本标题有交集才露源码(含空选区落在节点内部)。
    if (from > pos + node.nodeSize - 1 || to < pos + 1) return false
    decos.push(
      Decoration.widget(
        pos + 1,
        () => {
          const el = document.createElement('span')
          el.className = 'heading-hash'
          el.contentEditable = 'false'
          el.textContent = '#'.repeat(level) + ' '
          return el
        },
        // side:-1 排在首字符前;ignoreSelection 让光标照常落在第一个真实字符上。
        { side: -1, ignoreSelection: true, key: `h${pos}:${level}` },
      ),
    )
    return false
  })
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

export function headingSourcePlugin() {
  return $prose(
    () =>
      new Plugin<{ focus: boolean }>({
        key,
        state: {
          init: () => ({ focus: false }),
          apply: (tr, value) => {
            const m = tr.getMeta(key) as { focus?: boolean } | undefined
            return m && typeof m.focus === 'boolean' ? { focus: m.focus } : value
          },
        },
        props: {
          // 每个 Amadeus 块是独立编辑器,失焦即全部收回渲染态(同 wikilink)。
          handleDOMEvents: {
            focus: (view) => {
              if (!key.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(key, { focus: true }))
              return false
            },
            blur: (view) => {
              if (key.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(key, { focus: false }))
              return false
            },
          },
          decorations: build,
        },
      }),
  )
}
