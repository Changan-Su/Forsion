// @vitest-environment happy-dom
//
// D-11(评审 2026-09-27):用户写的反斜杠转义往返保真。走 parseFidelity 夹具的**整篇重新序列化**口径(md() 不走 D-18 逐字回填),
// 即「被编辑的块」的写法。修前:`\#x` → `#x`(进标签索引)、`\[\[x\]\]` → `[[x]]`(真双链)、`\=\=` / `\%\%` → Obsidian 高亮 / 注释。
// 真浏览器那一半:check:rtcorpus 的 d11.*(含「看得见字面」)。
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { bootEditor, roundTrip, type Booted } from './parseFidelity.testkit'
import { buildBlockString } from './mathLivePreview'

let b: Booted | null = null
afterEach(async () => { await b?.destroy(); b = null })

describe('转义逐字往返(D-11)', () => {
  it.each([
    ['句中 \\#', 'not a tag: \\#notatag and C\\# code\n'],
    ['行首 \\#(unescapeTagAtLineStart 不许剥用户的)', '\\#notatag 行首\n'],
    ['\\[\\[ 不成双链(unescapeWikiOutsideFences 不许剥)', 'literal \\[\\[not a link\\]\\] here\n'],
    ['\\=\\= / \\%\\%', 'literal \\=\\=not hl\\=\\= and \\%\\%not cmt\\%\\%\n'],
    ['\\$ 不是公式', 'not math: \\$x\\$ ok\n'],
    ['公式与转义同段(公式体里的反斜杠照 R-01)', 'set $\\{a\\}$ and \\#t\n'],
    ['粗体 / 链接文字里', '**a\\#b** 与 [x\\]y](http://e.x)\n'],
    ['多余的转义也照原样', 'literal \\*not em\\* and \\_x\\_ and 1\\. mid\n'],
  ])('%s', async (_name, md) => {
    expect(await roundTrip(md)).toBe(md)
  })

  it('显示侧:转义过的定界符不参与双链 / 公式 / 高亮 / 标签匹配', async () => {
    b = await bootEditor('a \\[\\[x\\]\\] \\$y\\$ \\=\\=z\\=\\= \\#t [[real]]\n')
    const s = buildBlockString(b.view.state.doc.firstChild!)
    expect(s).not.toMatch(/\[\[x|\$y\$|==z==|#t/)
    expect(s).toContain('[[real]]')
  })

  it('在两个转义字符之间打字母:字母不带反斜杠(只给 ASCII 标点补转义)', async () => {
    b = await bootEditor('x \\[\\[y\n')
    const view = b.view
    let at = -1
    view.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text!.includes('[[')) at = pos + n.text!.indexOf('[[') + 1; return at < 0 })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).insertText('a'))
    expect(b.md()).toBe('x \\[a\\[y\n')
  })
})
