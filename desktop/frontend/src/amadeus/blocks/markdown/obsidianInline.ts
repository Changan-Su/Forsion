// Obsidian 行内语法 `==高亮==` 与 `%%注释%%` 的实况预览(I-17,合并 R-20;拍板 #11)。
//
// 零 schema、零序列化改动:两种语法在文档里**始终是纯文本**(磁盘逐字),只用 ProseMirror 装饰呈现 ——
// 与 mathLivePreview.ts 同一套口径:光标碰到这一处 → 露源码可编辑;离开 → 渲染。
//  · `==x==`:内文恒有高亮底;离开时 `==` 定界符藏起来。
//  · `%%x%%`(可跨软换行,多行注释在 v4 里是「一段 + 硬换行」):离开时整段藏起来,原处留一枚小徽章,点它进源码。
// ⚠️ 不复用 bgSchema(那是 `<mark>` 的 schema mark):把 `==x==` 解析成 bg mark,序列化就会写成 `<mark>…</mark>`,
//    每存一次改写一次用户的 Obsidian 文件;反过来也不许把存量 `<mark>` 读成 `==`。高亮包裹也**不许**用 `<mark>` 标签
//    (nodeName:'mark')—— PM 打字时重读 DOM,bgSchema.parseDOM 认 `tag: 'mark'`,装饰壳会被当成 bg mark 读回文档。
// 扫描口径:代码(行内码 / 代码块)与 `$…$` 公式里的不算;`%%` 优先配对,注释里的 `==` 不再单独渲染。
// ponytail: 跨段落(中间夹空行)的 `%%` 块注释不认 —— 只认同一段内(含软换行)的,跨段的照旧显示字面。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { buildBlockString, scanMath } from './mathLivePreview'
import { editorFocusKey, editorFocused } from './editorFocus'
import { registerMessages, translate } from '../../../i18n'

registerMessages({
  'obsinline.comment.title': { zh: '注释（点击编辑）', en: 'Comment (click to edit)' },
})

export interface ObsSpan { kind: 'hl' | 'cmt'; from: number; to: number }

/** 块串里的 `%%…%%` 与 `==…==` 跨度(偏移 = 块串下标,含定界符)。入参同 buildBlockString:代码已抹成空格、硬换行为 `\n`。 */
export function scanObsidian(s: string): ObsSpan[] {
  if (s.indexOf('%%') === -1 && s.indexOf('==') === -1) return []
  // 公式里的不算:抹成等长空格,偏移不动。
  let t = s
  for (const m of scanMath(s)) t = t.slice(0, m.from) + ' '.repeat(m.to - m.from) + t.slice(m.to)
  const out: ObsSpan[] = []
  // `%%…%%`:从左往右配对,内容非空;没配上的 `%%` 是字面。
  for (let i = t.indexOf('%%'); i !== -1;) {
    const close = t.indexOf('%%', i + 2)
    if (close === -1) break
    if (close > i + 2) {
      out.push({ kind: 'cmt', from: i, to: close + 2 })
      i = t.indexOf('%%', close + 2)
    } else {
      i = t.indexOf('%%', i + 1) // `%%%%`:空注释不算,挪一格再找
    }
  }
  // `==x==`:定界符内侧不贴空白、外侧不贴 `=`(`a === b`、`x == y` 不误伤),不跨行,不落在注释里。
  const HL = /(?<!=)==(?![\s=])([^\n]*?)(?<![\s=])==(?!=)/g
  for (let m = HL.exec(t); m; m = HL.exec(t)) {
    const from = m.index
    const to = from + m[0].length
    if (to - from <= 4) continue
    if (out.some((c) => c.kind === 'cmt' && from < c.to && to > c.from)) continue
    out.push({ kind: 'hl', from, to })
  }
  return out.sort((a, b) => a.from - b.from)
}

const key = new PluginKey('amadeus-obsidian-inline')

function commentBadge(view: EditorView, caretAt: number): HTMLElement {
  const el = document.createElement('span')
  el.className = 'amx-obs-cmt-badge'
  el.contentEditable = 'false'
  el.textContent = '%%'
  el.title = translate('obsinline.comment.title')
  el.addEventListener('mousedown', (e) => {
    if (!view.editable) return // 只读实例:注释不展开(分享页 / 收件箱)
    e.preventDefault()
    const pos = Math.min(caretAt, view.state.doc.content.size)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).setMeta(editorFocusKey, true))
    view.focus()
  })
  return el
}

function buildDecorations(state: EditorState): DecorationSet {
  const focus = editorFocused(state)
  const { from: selFrom, to: selTo } = state.selection
  const decos: Decoration[] = []
  state.doc.descendants((node: PMNode, pos: number) => {
    if (!node.isTextblock) return true
    if (node.type.spec.code) return false
    const text = node.textContent
    if (text.indexOf('%%') === -1 && text.indexOf('==') === -1) return false
    const cs = pos + 1
    for (const sp of scanObsidian(buildBlockString(node))) {
      const from = cs + sp.from
      const to = cs + sp.to
      const active = focus && selFrom <= to && selTo >= from
      if (sp.kind === 'hl') {
        decos.push(Decoration.inline(from + 2, to - 2, { class: 'amx-obs-hl' }))
        const cls = active ? 'amx-obs-delim' : 'amx-obs-hidden'
        decos.push(Decoration.inline(from, from + 2, { class: cls }), Decoration.inline(to - 2, to, { class: cls }))
      } else if (active) {
        decos.push(Decoration.inline(from, to, { class: 'amx-obs-cmt' }))
      } else {
        decos.push(Decoration.inline(from, to, { class: 'amx-obs-hidden' }))
        decos.push(Decoration.widget(from, (v) => commentBadge(v, from + 2), { side: -1, ignoreSelection: true, key: `obs-cmt:${from}` }))
      }
    }
    return false
  })
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

export function obsidianInlinePlugin() {
  return $prose(
    () =>
      new Plugin({
        key,
        props: {
          // 失焦 → 全部渲染(同 mathLivePreview:点到编辑器外,光标所在那处也收起)。焦点态读 editorFocus。
          decorations: (state) => buildDecorations(state),
        },
      }),
  )
}

/** ⌘⇧H:切换 `==` 高亮。选区落在某个 `==x==` 里(或正好罩住它)→ 摘掉定界符;否则把选区包成 `==选区==`
 *  (首尾空白让到外面 —— 贴着空白的 `==` 不成立)。空选区且不在高亮里 → 不动作(不插 `====`:软换行后
 *  单独一行的 `====` 是 setext 标题下划线)。恒返回 true:web 端 Chrome 的 ⌘⇧H 是「打开主页」。 */
export const toggleObsHighlight: Command = (state, dispatch) => {
  const { $from, $to, from, to, empty } = state.selection
  if (!$from.sameParent($to) || !$from.parent.isTextblock || $from.parent.type.spec.code) return true
  const cs = $from.start()
  const hit = scanObsidian(buildBlockString($from.parent)).find((sp) => sp.kind === 'hl' && cs + sp.from <= from && to <= cs + sp.to)
  if (hit) {
    dispatch?.(state.tr.delete(cs + hit.to - 2, cs + hit.to).delete(cs + hit.from, cs + hit.from + 2))
    return true
  }
  if (empty) return true
  const text = state.doc.textBetween(from, to, '\n', '￼')
  if (text.includes('\n')) return true
  const a = from + (text.length - text.trimStart().length)
  const b = to - (text.length - text.trimEnd().length)
  if (b <= a) return true
  // 不带 mark 的纯文本定界符:插在加粗 / 链接边上也不会被并进去,落盘是 `==**x**==` 而不是 `==**x==**`。
  const delim = state.schema.text('==')
  const tr = state.tr.insert(b, delim).insert(a, delim)
  tr.setSelection(TextSelection.create(tr.doc, a + 2, b + 2))
  dispatch?.(tr)
  return true
}
