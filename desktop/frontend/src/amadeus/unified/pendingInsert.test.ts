// @vitest-environment happy-dom
// 异步插入落点:只有一张图的段不算「空段」(原地替换会把图删掉,Codex 评审 P1);粘贴图片行内插在锚处。
import { expect, it, vi } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
vi.mock('../../i18n', () => ({ registerMessages: () => {}, translate: (k: string) => k }))
vi.mock('../blocks/markdown/callout', () => ({ unfoldCalloutsForInsert: () => {} }))
import { beginPending, insertAtPending, insertInlineAtPending, pendingInsertPlugin } from './pendingInsert'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    image: { group: 'inline', inline: true, attrs: { src: {} }, toDOM: (n) => ['img', { src: n.attrs.src }] },
  },
})
const p = (...c: Parameters<typeof schema.nodes.paragraph.create>[1][]) => schema.nodes.paragraph.create(null, c as never)
const img = (src: string) => schema.nodes.image.create({ src })
function view(doc: ReturnType<typeof schema.node>, at: number) {
  const state = EditorState.create({ doc, plugins: [pendingInsertPlugin()] })
  const v = new EditorView(document.createElement('div'), { state: state.apply(state.tr.setSelection(TextSelection.create(state.doc, at))) })
  return v
}
const shape = (v: EditorView) => { const out: string[] = []; v.state.doc.forEach((b) => { const parts: string[] = []; b.forEach((c) => parts.push(c.isText ? c.text! : `[${c.attrs.src}]`)); out.push(parts.join('')) }); return out }

it('a paragraph holding only an image is not blank: the upload lands after it, the image stays', () => {
  const v = view(schema.node('doc', null, [p(img('old.png'))]), 1)
  const a = beginPending(v, 'x')
  insertAtPending(v, a.id, schema.node('doc', null, [p(schema.text('![[new.pdf]]'))]).content)
  expect(shape(v)).toEqual(['[old.png]', '![[new.pdf]]'])
})

it('a pasted image goes inline at the anchor, mid-sentence', () => {
  const v = view(schema.node('doc', null, [p(schema.text('hello world'))]), 6)
  const a = beginPending(v, 'x')
  expect(insertInlineAtPending(v, a.id, img('p.png'))).toBe(true)
  expect(shape(v)).toEqual(['hello[p.png] world'])
})
