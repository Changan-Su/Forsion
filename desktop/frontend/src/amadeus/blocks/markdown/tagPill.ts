// 正文 `#标签` 实况胶囊(评审 2026-09-27 L-14;与 wikilink.ts 同款的逐行显隐):
//  · 光标**不在**该行 → `#tag` 包一层 .amx-tag-pill 胶囊;点胶囊 → 发 `amadeus:open-tag`,宿主打开标签检索并定位该标签。
//  · 光标**在**该行 → 不装饰,就是可编辑的字面文本(点它只定位光标)。
// **零 schema、零序列化改动**:磁盘上永远是字面 `#tag`(Obsidian 互通);行首 `#tag` 的转义还原在 tagEscape.ts(R-25)。
// 识别口径与索引同源(links.TAG_RE:`#` 前是行首或空白;纯数字 `#1` 不算);代码块与行内代码里不装饰
// (buildBlockString 把行内代码抹成空格)。
// ponytail: buildBlockString 用**空格**抹行内代码,`` `x`#tag `` 在编辑器里会成胶囊,索引(maskCode 用 \u0001)不算 —— 极少见。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { TAG_RE } from '@amadeus-shared/links'
import { buildBlockString } from './mathLivePreview'

/** 点击胶囊时派发到 window 的事件(detail = { tag });由应用层(amadeusOverlays)打开标签视图。 */
export const OPEN_TAG_EVENT = 'amadeus:open-tag'

const key = new PluginKey<{ focus: boolean }>('amadeus-tag-pill')

function buildDecorations(state: EditorState): DecorationSet {
  const focus = key.getState(state)?.focus ?? false
  const { from: selFrom, to: selTo } = state.selection
  const decos: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (node.type.spec.code) return false
    const s = buildBlockString(node)
    if (!s.includes('#')) return false
    const cs = pos + 1
    // 选区两端都在本块时,按所在「行」(硬换行分隔)露源码 —— 同 wikilink.ts。
    let lineFrom = -1
    let lineTo = -1
    if (focus && selFrom >= cs && selTo <= cs + node.content.size) {
      const a = Math.max(0, Math.min(s.length, selFrom - cs))
      const b = Math.max(0, Math.min(s.length, selTo - cs))
      lineFrom = s.lastIndexOf('\n', a - 1) + 1
      const nl = s.indexOf('\n', b)
      lineTo = nl === -1 ? s.length : nl
    }
    const re = new RegExp(TAG_RE.source, TAG_RE.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      const tag = m[1]
      if (/^[0-9/]+$/.test(tag)) continue // `#1`、`#1/2` 不是标签(同 parseTags)
      const end = m.index + m[0].length
      const start = end - tag.length - 1 // `#` 的位置
      if (lineFrom !== -1 && start <= lineTo && end >= lineFrom) continue // 光标行 = 源码
      decos.push(Decoration.inline(cs + start, cs + end, { class: 'amx-tag-pill', 'data-tag': tag }))
    }
    return false
  })
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

export function tagPillPlugin() {
  return $prose(
    () =>
      new Plugin<{ focus: boolean }>({
        key,
        state: {
          init: () => ({ focus: false }),
          apply: (tr, v) => {
            const m = tr.getMeta(key) as { focus?: boolean } | undefined
            return m && typeof m.focus === 'boolean' ? { focus: m.focus } : v
          },
        },
        props: {
          decorations: (state) => buildDecorations(state),
          handleDOMEvents: {
            focus: (view) => { if (!key.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(key, { focus: true })); return false },
            blur: (view) => { if (key.getState(view.state)?.focus) view.dispatch(view.state.tr.setMeta(key, { focus: false })); return false },
            // 只有「成了胶囊」的标签可点(光标行上的是源码,点了照常落光标)。左键、无修饰键;按下即拦,不落光标。
            mousedown: (_view, e) => {
              const el = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
                ? (e.target as HTMLElement | null)?.closest?.('.amx-tag-pill') as HTMLElement | null
                : null
              const tag = el?.dataset.tag
              if (!tag) return false
              e.preventDefault()
              window.dispatchEvent(new CustomEvent(OPEN_TAG_EVENT, { detail: { tag } }))
              return true
            },
          },
        },
      }),
  )
}
