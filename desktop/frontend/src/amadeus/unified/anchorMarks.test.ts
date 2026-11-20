// @vitest-environment happy-dom
// 锚标记段(独占一段的 `<!-- a id -->`)在编辑器里收起:装饰只挂在独占一段的锚标记上;落盘逐字不变;
// 退格 / Delete 跨过它们去并真正的上一块 / 下一块(锚标记随被并的那块挪到合并结果前面);
// 其余路径把锚标记并进了文字 → 拆回独占一段;光标落在锚标记段上 → 挪到看得见的文字。
import { afterEach, describe, expect, it } from 'vitest'
import { NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import { bootEditor, type Booted } from '../blocks/markdown/parseFidelity.testkit'
import { ANCHOR_MARK_CLASS, anchorMarksPlugin, isAnchorMarkPara } from './anchorMarks'
import { bsOverAnchorMarks, deleteOverAnchorMarks } from './keyboard'

const BODY = ['段甲。', '', '<!-- a m1 -->', '', '段乙。', '', '<!-- a m2 -->', '', '<!-- a m3 -->', '', '段丙。', '', '段丁。', '', '<!-- a mz -->', ''].join('\n')

let b: Booted | null = null
afterEach(async () => { await b?.destroy(); b = null })
const boot = async (body = BODY): Promise<Booted> => (b = await bootEditor(body, { extra: [anchorMarksPlugin] }))

/** 文字恰好是 text 的那一段在文档里的起点。 */
function paraAt(bb: Booted, text: string): number {
  let at = -1
  bb.view.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isTextblock && n.textContent === text) at = pos
    return at < 0
  })
  if (at < 0) throw new Error('找不到段落 ' + text)
  return at
}
const caretAt = (bb: Booted, text: string, where: 'start' | 'end'): void => {
  const p = paraAt(bb, text)
  const node = bb.view.state.doc.nodeAt(p)!
  bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, p + 1 + (where === 'end' ? node.content.size : 0))))
}
const caretPara = (bb: Booted): string => bb.view.state.selection.$head.parent.textContent

describe('锚标记段:收起,落盘不变', () => {
  it('只给独占一段的锚标记挂类;夹在文字里的、非锚的注释照常显示', async () => {
    const bb = await boot(['甲 <!-- a x1 --> 乙', '', '<!-- a m1 -->', '', '<!-- 备注 -->', '', '<!-- /a k1 -->', '', '丙', ''].join('\n'))
    const hidden = [...bb.view.dom.querySelectorAll('.' + ANCHOR_MARK_CLASS)].map((e) => e.textContent)
    expect(hidden).toEqual(['<!-- a m1 -->'])
  })

  it('没动过的文档落盘逐字一样;别处打字不碰锚标记', async () => {
    const bb = await boot()
    expect(bb.saved()).toBe(BODY)
    caretAt(bb, '段丁。', 'end')
    bb.view.dispatch(bb.view.state.tr.insertText('X'))
    expect(bb.saved()).toBe(BODY.replace('段丁。', '段丁。X'))
  })
})

describe('退格 / Delete 跨过锚标记', () => {
  it('段首退格:并进上一块,锚标记挪到合并结果前面', async () => {
    const bb = await boot()
    caretAt(bb, '段乙。', 'start')
    expect(bsOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(true)
    expect(bb.saved()).toBe(['<!-- a m1 -->', '', '段甲。段乙。', '', '<!-- a m2 -->', '', '<!-- a m3 -->', '', '段丙。', '', '段丁。', '', '<!-- a mz -->', ''].join('\n'))
    expect(bb.view.state.selection.$head.parentOffset).toBe(3)
  })

  it('隔着连着几枚的段首退格:几枚一起挪', async () => {
    const bb = await boot()
    caretAt(bb, '段丙。', 'start')
    expect(bsOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(true)
    expect(bb.saved()).toBe(['段甲。', '', '<!-- a m1 -->', '', '<!-- a m2 -->', '', '<!-- a m3 -->', '', '段乙。段丙。', '', '段丁。', '', '<!-- a mz -->', ''].join('\n'))
  })

  it('段尾 Delete:把下一块并上来,锚标记挪到本块前面', async () => {
    const bb = await boot()
    caretAt(bb, '段甲。', 'end')
    expect(deleteOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(true)
    expect(bb.saved()).toBe(['<!-- a m1 -->', '', '段甲。段乙。', '', '<!-- a m2 -->', '', '<!-- a m3 -->', '', '段丙。', '', '段丁。', '', '<!-- a mz -->', ''].join('\n'))
    expect(caretPara(bb)).toBe('段甲。段乙。')
    expect(bb.view.state.selection.$head.parentOffset).toBe(3)
  })

  it('下一块是引用:Delete 交给 K-22 把引用里的字接上来,锚标记跟着字走(Codex 评审)', async () => {
    const body = ['Intro', '', '<!-- a m -->', '', '> Quote', ''].join('\n')
    const bb = await boot(body)
    caretAt(bb, 'Intro', 'end')
    expect(deleteOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(true)
    expect(bb.saved()).toBe(['<!-- a m -->', '', 'IntroQuote', ''].join('\n'))
  })

  it('下一块是打头为空段的引用:锚标记仍指着那只引用,不跑到本块前面(Codex 复核)', async () => {
    const body = ['Intro', '', '<!-- a m -->', '', '> Quote', ''].join('\n')
    const bb = await boot(body)
    let bq = -1
    bb.view.state.doc.forEach((n, off) => { if (n.type.name === 'blockquote') bq = off })
    bb.view.dispatch(bb.view.state.tr.insert(bq + 1, bb.view.state.schema.nodes.paragraph.create()))
    caretAt(bb, 'Intro', 'end')
    expect(deleteOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(true)
    const kinds: string[] = []
    bb.view.state.doc.forEach((n) => kinds.push(isAnchorMarkPara(n) ? 'm' : n.type.name === 'blockquote' ? 'bq:' + n.textContent : n.textContent))
    expect(kinds.indexOf('m') + 1).toBe(kinds.findIndex((k) => k.includes('Quote')))
  })

  it('下一块是 callout:Delete 照 K-22 只整块选中它,锚标记不动(Codex 复核)', async () => {
    const body = ['Intro', '', '<!-- a m -->', '', '> [!note]', '> 正文', ''].join('\n')
    const bb = await boot(body)
    const before = bb.view.state.doc
    caretAt(bb, 'Intro', 'end')
    expect(deleteOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(true)
    expect(bb.view.state.selection instanceof NodeSelection).toBe(true)
    expect((bb.view.state.selection as NodeSelection).node.type.name).toBe('blockquote')
    expect(bb.view.state.doc.eq(before)).toBe(true)
  })

  it('后面只剩锚标记:Delete 吞掉,一个字节不动', async () => {
    const bb = await boot()
    caretAt(bb, '段丁。', 'end')
    expect(deleteOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(true)
    expect(bb.saved()).toBe(BODY)
  })

  it('前面只有锚标记:退格吞掉', async () => {
    const body = ['<!-- a m0 -->', '', '开头。', ''].join('\n')
    const bb = await boot(body)
    caretAt(bb, '开头。', 'start')
    expect(bsOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(true)
    expect(bb.saved()).toBe(body)
  })

  it('上一块是分割线:只选中它,锚标记不动', async () => {
    const body = ['---', '', '<!-- a m1 -->', '', '段乙。', ''].join('\n')
    const bb = await boot(body)
    const before = bb.view.state.doc
    caretAt(bb, '段乙。', 'start')
    expect(bsOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(true)
    expect(bb.view.state.selection.constructor.name).toMatch(/NodeSelection/)
    expect(bb.view.state.doc.eq(before)).toBe(true)
  })

  it('紧挨着没有锚标记:不接管,交回原来的链', async () => {
    const bb = await boot()
    caretAt(bb, '段丁。', 'start')
    expect(bsOverAnchorMarks(bb.view.state, bb.view.dispatch)).toBe(false)
  })
})

describe('其余路径的兜底', () => {
  it('base 的合并把锚标记并进了文字(退格 / Delete 没走到上面那两条时)→ 拆回独占一段', async () => {
    const bb = await boot()
    // 模拟 base joinBackward:段乙并进 m1 那一段
    const at = paraAt(bb, '段乙。')
    bb.view.dispatch(bb.view.state.tr.join(at))
    expect(bb.saved()).toBe(BODY)
    // 模拟 base joinForward:m1 那一段并进段甲
    const a = paraAt(bb, '段甲。')
    const after = a + bb.view.state.doc.nodeAt(a)!.nodeSize
    bb.view.dispatch(bb.view.state.tr.join(after))
    expect(bb.saved()).toBe(BODY)
  })

  it('撤销重做 / 外部回灌带回来的内容不改写', async () => {
    const bb = await boot()
    const at = paraAt(bb, '段乙。')
    bb.view.dispatch(bb.view.state.tr.join(at).setMeta('addToHistory', false))
    expect(bb.saved()).toContain('<!-- a m1 -->段乙。')
  })

  it('光标落在锚标记前 → 回上一块末尾;落在锚标记后 → 去下一块开头;打的字进那里', async () => {
    const bb = await boot()
    let m1 = -1
    bb.view.state.doc.forEach((n, off) => { if (m1 < 0 && isAnchorMarkPara(n)) m1 = off })
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, m1 + 1)))
    expect(isAnchorMarkPara(bb.view.state.selection.$head.parent)).toBe(false)
    expect(caretPara(bb)).toBe('段甲。')
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, m1 + 2)))
    expect(caretPara(bb)).toBe('段乙。')
    bb.view.dispatch(bb.view.state.tr.insertText('X'))
    expect(bb.saved()).toBe(BODY.replace('段乙。', 'X段乙。'))
  })

  it('有范围的选区头落进锚标记段:只挪头,锚点不动(Codex 评审)', async () => {
    const bb = await boot()
    const a = paraAt(bb, '段甲。') + 2
    let m1 = -1
    bb.view.state.doc.forEach((n, off) => { if (m1 < 0 && isAnchorMarkPara(n)) m1 = off })
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, a, m1 + 1)))
    const sel = bb.view.state.selection
    expect(sel.anchor).toBe(a)
    expect(sel.empty).toBe(false)
    expect(caretPara(bb)).toBe('段甲。')
  })

  it('兜底拆分后光标留在原来那段里,不跑到下一段(Codex 评审)', async () => {
    const body = ['<!-- a m -->', '', 'Beta', '', 'Gamma', ''].join('\n')
    const bb = await boot(body)
    caretAt(bb, 'Beta', 'start')
    bb.view.dispatch(bb.view.state.tr.join(paraAt(bb, 'Beta')))
    expect(bb.saved()).toBe(body)
    expect(caretPara(bb)).toBe('Beta')
    expect(bb.view.state.selection.$head.parentOffset).toBe(0)
  })

  it('锚标记被并进标题(base 的 Mod-Delete 之类)→ 拆回,标题仍是标题(Codex 评审)', async () => {
    const body = ['# Title', '', '<!-- a m -->', '', 'Target', ''].join('\n')
    const bb = await boot(body)
    const h = paraAt(bb, 'Title')
    bb.view.dispatch(bb.view.state.tr.join(h + bb.view.state.doc.nodeAt(h)!.nodeSize))
    expect(bb.saved()).toBe(body)
  })

  it('拆分只动原本独占一段的那枚,同段里的行内锚注释不碰(Codex 评审)', async () => {
    const body = ['A <!-- a x --> B', '', '<!-- a m -->', '', 'C', ''].join('\n')
    const bb = await boot(body)
    const a = paraAt(bb, 'A  B')
    bb.view.dispatch(bb.view.state.tr.join(a + bb.view.state.doc.nodeAt(a)!.nodeSize))
    expect(bb.saved()).toBe(body)
  })

  it('跨块选中删除吞掉了锚标记、但它指着的那块还剩字 → 插回合并结果前面(Codex 评审)', async () => {
    const body = ['abc', '', '<!-- a m -->', '', 'def', ''].join('\n')
    const bb = await boot(body)
    const a = paraAt(bb, 'abc'), d = paraAt(bb, 'def')
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, a + 3, d + 2)).deleteSelection())
    expect(bb.saved()).toBe(['<!-- a m -->', '', 'abef', ''].join('\n'))
  })

  it('它指着的那块整块删掉了 → 锚标记不补;挪到别处(还在文档里)也不补成两份', async () => {
    const body = ['abc', '', '<!-- a m -->', '', 'def', '', 'ghi', ''].join('\n')
    const bb = await boot(body)
    const a = paraAt(bb, 'abc'), g = paraAt(bb, 'ghi')
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, a + 3, g + 1)).deleteSelection())
    expect(bb.saved()).toBe(['abghi', ''].join('\n'))

    const bb2 = await bootEditor(body, { extra: [anchorMarksPlugin] })
    try {
      const st = bb2.view.state
      let m = -1
      st.doc.forEach((n, off) => { if (m < 0 && isAnchorMarkPara(n)) m = off })
      const dd = m + st.doc.nodeAt(m)!.nodeSize
      const moved = st.doc.slice(m, dd + st.doc.nodeAt(dd)!.nodeSize)
      const tr = st.tr.delete(m, dd + st.doc.nodeAt(dd)!.nodeSize)
      tr.insert(tr.doc.content.size, moved.content)
      bb2.view.dispatch(tr)
      expect(bb2.saved().match(/<!-- a m -->/g)?.length).toBe(1)
      expect(bb2.saved()).toBe(['abc', '', 'ghi', '', '<!-- a m -->', '', 'def', ''].join('\n'))
    } finally { await bb2.destroy() }
  })

  it('跨出容器的删除(从列表项删进引用):不补锚标记,免得补到别的块前面指错(Codex 复核)', async () => {
    const body = ['- abc', '', '> ABC', '>', '> <!-- a m -->', '>', '> def', '', 'tail', ''].join('\n')
    const bb = await boot(body)
    const a = paraAt(bb, 'abc'), d = paraAt(bb, 'def')
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, a + 3, d + 2)).deleteSelection())
    expect(bb.saved()).not.toContain('<!-- a m -->')
    expect(bb.saved()).toContain('abef')
  })

  it('剪切不补(锚标记跟着剪贴板走,粘贴回来就是它)(Codex 复核)', async () => {
    const body = ['abc', '', '<!-- a m -->', '', 'def', ''].join('\n')
    const bb = await boot(body)
    const a = paraAt(bb, 'abc'), d = paraAt(bb, 'def')
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, a + 3, d + 2)).deleteSelection().setMeta('uiEvent', 'cut'))
    expect(bb.saved()).toBe(['abef', ''].join('\n'))
  })

  it('别处行内注释里有同号的,不挡住补回(Codex 复核)', async () => {
    const body = ['abc', '', '<!-- a m -->', '', 'def', '', 'other <!-- a m --> text', ''].join('\n')
    const bb = await boot(body)
    const a = paraAt(bb, 'abc'), d = paraAt(bb, 'def')
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, a + 3, d + 2)).deleteSelection())
    expect(bb.saved()).toBe(['<!-- a m -->', '', 'abef', '', 'other <!-- a m --> text', ''].join('\n'))
  })

  it('根事务是外部回灌时,别的插件追加的事务也不算用户编辑,不补(Codex 复核)', async () => {
    const appender = $prose(() => new Plugin({
      appendTransaction: (trs, _o, st) => (trs.some((t) => t.getMeta('testAppend')) ? st.tr.insertText('!', st.doc.content.size - 1) : null),
    }))
    const body = ['abc', '', '<!-- a m -->', '', 'def', ''].join('\n')
    b = await bootEditor(body, { extra: [appender, anchorMarksPlugin] })
    const a = paraAt(b, 'abc'), d = paraAt(b, 'def')
    b.view.dispatch(b.view.state.tr.delete(a + 3, d + 2).setMeta('addToHistory', false).setMeta('testAppend', true))
    expect(b.saved()).not.toContain('<!-- a m -->')
  })

  it('有范围的选区:头往回挪会落到锚点上时改往前挪,范围不收没(Codex 复核)', async () => {
    const body = ['abc', '', '---', '', '<!-- a m -->', '', 'def', ''].join('\n')
    const bb = await boot(body)
    const a = paraAt(bb, 'abc')
    let m = -1
    bb.view.state.doc.forEach((n, off) => { if (m < 0 && isAnchorMarkPara(n)) m = off })
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, a + 4, m + 1)))
    expect(bb.view.state.selection.empty).toBe(false)
    expect(bb.view.state.selection.anchor).toBe(a + 4)
    expect(caretPara(bb)).toBe('def')
  })

  it('往回走落到锚标记段上 → 挪到上一块', async () => {
    const bb = await boot()
    let m3 = -1
    bb.view.state.doc.forEach((n, off) => { if (isAnchorMarkPara(n) && String(n.firstChild!.attrs.value).includes('m3')) m3 = off })
    caretAt(bb, '段丙。', 'start')
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, m3 + 1)))
    expect(caretPara(bb)).toBe('段乙。')
  })
})
