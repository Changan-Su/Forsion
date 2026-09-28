// @vitest-environment happy-dom
//
// I-04(评审 2026-09-27):在链接末尾继续打字,新字被并进链接 —— `[文字](url)` 后敲 ` 后` 落盘成 `[文字 后](url)`。
// 药:linkWithRefSchema(preset linkSchema 的原位替换)设 inclusive:false。真 Milkdown(生产装配,parseFidelity.testkit)
// + 真 handleTextInput / 默认 insertText(= 浏览器键入走的那条);真浏览器键盘 + CDP 输入法 + 粘贴:npm run check:linkcard 的 L 组。
import { describe, expect, it } from 'vitest'
import type { EditorView } from '@milkdown/kit/prose/view'
import { TextSelection } from '@milkdown/kit/prose/state'
import { bootEditor } from './parseFidelity.testkit'

function type(view: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
}
/** 首段内第 n 个字符之后(文本坐标)放光标。 */
function caretAt(view: EditorView, textOffset: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + textOffset)))
}
const linked = (view: EditorView): string[] => {
  const out: string[] = []
  view.state.doc.firstChild!.forEach((n) => { if (n.isText && n.marks.some((m) => m.type.name === 'link')) out.push(n.text!) })
  return out
}

describe('链接末端不延续(inclusive:false)', () => {
  it('链接在行末:End 后接着打字是普通文字', async () => {
    const b = await bootEditor('x [文字](https://example.com)\n')
    try {
      caretAt(b.view, 'x 文字'.length)
      type(b.view, ' 后')
      expect(linked(b.view)).toEqual(['文字'])
      expect(b.md()).toBe('x [文字](https://example.com) 后\n')
    } finally { await b.destroy() }
  })

  it('「链接|后文」交界处打字不并进链接', async () => {
    const b = await bootEditor('[文字](https://example.com)尾\n')
    try {
      caretAt(b.view, '文字'.length)
      type(b.view, 'X')
      expect(linked(b.view)).toEqual(['文字'])
      expect(b.md()).toBe('[文字](https://example.com)X尾\n')
    } finally { await b.destroy() }
  })

  it('链接内部照旧属于链接(只改末端,不改中段)', async () => {
    const b = await bootEditor('[文字](https://example.com)\n')
    try {
      caretAt(b.view, 1)
      type(b.view, 'Z')
      expect(linked(b.view)).toEqual(['文Z字'])
    } finally { await b.destroy() }
  })

  it('纯文本粘贴到链接末尾也不带链接', async () => {
    const b = await bootEditor('x [文字](https://example.com)\n')
    try {
      caretAt(b.view, 'x 文字'.length)
      b.view.pasteText('粘贴')
      expect(linked(b.view)).toEqual(['文字'])
      expect(b.view.state.doc.firstChild!.textContent).toBe('x 文字粘贴')
    } finally { await b.destroy() }
  })
})
