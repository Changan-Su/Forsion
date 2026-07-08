// [[Page Name]] 实况双链(与公式实况预览 mathLivePreview.ts 同款的逐行显隐):
//  · 光标**不在**该行 → 隐藏 [[ ]] 源码,就地渲染成异色双链;点渲染出的链接 → 跳转目标笔记。
//  · 光标**回到**该行 → 整行露出字面 [[note]] 源码可编辑;此时点它**不跳转**(普通文本 / 只定位光标)。
// 链接始终是 .md 里的字面文本(零 schema、零序列化改动,round-trip、Obsidian 可读)。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { WIKILINK_RE, linkTarget } from '@amadeus-shared/links'
import { buildBlockString } from './mathLivePreview'

const wikiKey = new PluginKey<{ focus: boolean }>('amadeus-wikilink-live')

/** [[Name|alias]] → 显示 alias;[[Name#heading]] / [[Name]] → 显示原样内文(仅去两端 [[ ]])。 */
function displayLabel(inner: string): string {
  const bar = inner.indexOf('|')
  const l = (bar === -1 ? inner : inner.slice(bar + 1)).trim()
  return l || inner.trim()
}

function buildDecorations(state: EditorState, onOpen: (name: string) => void): DecorationSet {
  const focus = wikiKey.getState(state)?.focus ?? false
  const decos: Decoration[] = []
  const selFrom = state.selection.from
  const selTo = state.selection.to
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (node.type.spec.code) return false // 代码块内不渲染双链
    const cs = pos + 1
    const s = buildBlockString(node) // offset i ↔ 文档位 cs+i;内联 code 抹成空格、硬换行→'\n'(与公式共用)
    if (s.indexOf('[[') === -1) return false
    // 聚焦且选区落在本块 → 算光标所在「行」区间(以 '\n' 为界),该行双链露源码、其余行照常渲染。
    let lineFrom = -1
    let lineTo = -1
    if (focus && selFrom <= cs + node.content.size && selTo >= cs) {
      const a = Math.max(0, Math.min(s.length, selFrom - cs))
      const b = Math.max(0, Math.min(s.length, selTo - cs))
      lineFrom = s.lastIndexOf('\n', a - 1) + 1
      const nl = s.indexOf('\n', b)
      lineTo = nl === -1 ? s.length : nl
    }
    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(s))) {
      const spFrom = m.index
      const spTo = m.index + m[0].length
      const onActiveLine = lineFrom !== -1 && spFrom < lineTo && spTo > lineFrom
      if (onActiveLine) continue // 本行 → 露源码可编辑,不渲染、点它不跳转
      const from = cs + spFrom
      const to = cs + spTo
      const target = linkTarget(m[1])
      const label = displayLabel(m[1])
      decos.push(Decoration.inline(from, to, { class: 'wikilink-src-hidden' }))
      decos.push(
        Decoration.widget(
          from,
          () => {
            const el = document.createElement('span')
            el.className = 'wikilink'
            el.setAttribute('data-wiki', target)
            el.textContent = label
            el.addEventListener('mousedown', (e) => {
              e.preventDefault() // 不落光标、不进编辑态 → 直接跳转
              onOpen(target)
            })
            return el
          },
          { side: -1, ignoreSelection: true, key: `w${from}:${m[0]}` },
        ),
      )
    }
    return false // 不深入内联
  })
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

export function wikilinkPlugin(onOpen: (name: string) => void) {
  return $prose(
    () =>
      new Plugin<{ focus: boolean }>({
        key: wikiKey,
        state: {
          init: () => ({ focus: false }),
          apply: (tr, value) => {
            const m = tr.getMeta(wikiKey) as { focus?: boolean } | undefined
            return m && typeof m.focus === 'boolean' ? { focus: m.focus } : value
          },
        },
        props: {
          // 失焦 → 全部渲染成链接;聚焦 → 仅光标所在行露源码(每个 Amadeus 块是独立编辑器)。
          handleDOMEvents: {
            focus: (view) => { if (!wikiKey.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(wikiKey, { focus: true })); return false },
            blur: (view) => { if (wikiKey.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(wikiKey, { focus: false })); return false },
          },
          decorations: (state) => buildDecorations(state, onOpen),
        },
      }),
  )
}
