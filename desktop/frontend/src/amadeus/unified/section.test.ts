// @vitest-environment happy-dom
// 版块(方向 B,page/5)在真 Milkdown 里的往返:layout 行的 section 样式折进 amadeusColumnRow.attrs.section,
// 派生回来逐字一样(未知键也带回去),正文逐字不动;版块 1 栏也成行;版块里的空栏不被别处的拖拽清掉。
import { afterEach, describe, expect, it } from 'vitest'
import { bootEditor, type Booted } from '../blocks/markdown/parseFidelity.testkit'
import {
  columnPlugins, createColumnsFold, deriveLayoutJson, parseLayoutJson, patchSection, removeEmptyColumnTr,
  sectionView, isSectionRow, executePair, type LayoutV4,
} from './columns'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { setSectionColumns } from './sections'

const BODY = [
  '# 版块探针', '',
  '<!-- a s1 -->', '',
  '单栏版块 ALPHA。', '',
  '<!-- a t1 -->', '',
  '<!-- a c1 -->', '',
  '左栏 BETA。', '',
  '<!-- a c2 -->', '',
  '右栏 GAMMA。', '',
  '<!-- a t2 -->', '',
  '后文 DELTA。', '',
].join('\n')
const LAYOUT = '{"v":4,"rows":[{"columns":[{"refs":["s1"],"width":1}],"tail":"t1","section":{"bg":"blue","later":1}},'
  + '{"columns":[{"refs":["c1"],"width":1},{"refs":["c2"],"width":1}],"tail":"t2","section":{"pad":"l","cards":false,"valign":"m"}}]}'

let b: Booted | null = null
afterEach(async () => { await b?.destroy(); b = null })

async function boot(body: string, layoutJson: string | null): Promise<Booted> {
  const layout: LayoutV4 | null = parseLayoutJson(layoutJson)
  b = await bootEditor(body, { extra: [...columnPlugins, ...createColumnsFold(() => layout)] })
  return b
}

function rows(bb: Booted) {
  const out: Array<{ pos: number; cells: number; section: unknown }> = []
  bb.view.state.doc.forEach((n, pos) => { if (n.type.name === 'amadeusColumnRow') out.push({ pos, cells: n.childCount, section: n.attrs.section }) })
  return out
}

describe('版块:读进来、派生回去', () => {
  it('1 栏版块与 2 栏版块都折成行,样式进 attr', async () => {
    const bb = await boot(BODY, LAYOUT)
    const rs = rows(bb)
    expect(rs.map((r) => r.cells)).toEqual([1, 2])
    expect(rs[0].section).toEqual({ bg: 'blue', later: 1 })
    expect(rs[1].section).toEqual({ pad: 'l', cards: false, valign: 'm' })
  })

  it('派生 layout 逐字一样(未知键带回),正文逐字不动', async () => {
    const bb = await boot(BODY, LAYOUT)
    expect(deriveLayoutJson(bb.view.state.doc)).toBe(LAYOUT)
    expect(bb.saved()).toBe(BODY)
  })

  it('不带版块的 page/4 分栏:派生不多出 section 键', async () => {
    const plain = '{"v":4,"rows":[{"columns":[{"refs":["c1"],"width":1},{"refs":["c2"],"width":1}],"tail":"t2"}]}'
    const body = ['<!-- a c1 -->', '', '左', '', '<!-- a c2 -->', '', '右', '', '<!-- a t2 -->', '', '后文', ''].join('\n')
    const bb = await boot(body, plain)
    expect(deriveLayoutJson(bb.view.state.doc)).toBe(plain)
    expect(bb.saved()).toBe(body)
  })

  it('普通分栏写成 1 栏(手写 / 坏数据)照旧不折叠,内容留在自然流', async () => {
    const one = '{"v":4,"rows":[{"columns":[{"refs":["s1"],"width":1}],"tail":"t1"}]}'
    const bb = await boot(BODY, one)
    expect(rows(bb)).toEqual([])
    expect(bb.saved()).toBe(BODY)
  })

  it('section 不是对象 → 整份 layout 判坏(fail-closed 回自然流)', () => {
    expect(parseLayoutJson('{"v":4,"rows":[{"columns":[{"refs":["s1"],"width":1}],"section":[1]}]}')).toBeNull()
    expect(parseLayoutJson('{"v":4,"rows":[{"columns":[{"refs":["s1"],"width":1}],"section":"blue"}]}')).toBeNull()
  })
})

describe('版块:规范化', () => {
  it('结构性事务不清版块的空栏;1 栏版块不解散', async () => {
    const bb = await boot(BODY, LAYOUT)
    const { state } = bb.view
    // 把右栏 GAMMA 那段清空 → 结构性事务(拖拽同门)
    let gamma = -1
    state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent.includes('GAMMA')) gamma = pos })
    const para = state.doc.nodeAt(gamma)!
    const tr = state.tr.delete(gamma + 1, gamma + 1 + para.content.size).setMeta('amxColumns', true)
    bb.view.dispatch(tr)
    expect(rows(bb).map((r) => r.cells)).toEqual([1, 2])
  })

  it('普通分栏的空列照旧被结构性事务清掉并解散', async () => {
    const plain = '{"v":4,"rows":[{"columns":[{"refs":["c1"],"width":1},{"refs":["c2"],"width":1}],"tail":"t2"}]}'
    const body = ['<!-- a c1 -->', '', '左', '', '<!-- a c2 -->', '', '右', '', '<!-- a t2 -->', '', '后文', ''].join('\n')
    const bb = await boot(body, plain)
    const { state } = bb.view
    let right = -1
    state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent === '右') right = pos })
    bb.view.dispatch(state.tr.delete(right + 1, right + 2).setMeta('amxColumns', true))
    expect(rows(bb)).toEqual([])
  })

  it('1 栏版块里唯一的空栏退格 → 版块解散,锚转惰性标记', async () => {
    const bb = await boot(BODY, LAYOUT)
    let alpha = -1
    bb.view.state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent.includes('ALPHA')) alpha = pos })
    const p = bb.view.state.doc.nodeAt(alpha)!
    bb.view.dispatch(bb.view.state.tr.delete(alpha + 1, alpha + 1 + p.content.size))
    const cellPos = bb.view.state.doc.resolve(alpha).before()
    const tr = removeEmptyColumnTr(bb.view.state, cellPos, -1)
    expect(tr).not.toBeNull()
    bb.view.dispatch(tr!)
    expect(rows(bb).map((r) => r.cells)).toEqual([2])
    expect(bb.saved()).toContain('<!-- a s1 -->')
    expect(bb.saved()).toContain('<!-- a t1 -->')
  })

  it('拖块进满 4 栏的版块 → 拒绝配对', async () => {
    const four = '{"v":4,"rows":[{"columns":[{"refs":["a"],"width":1},{"refs":["b"],"width":1},{"refs":["c"],"width":1},{"refs":["d"],"width":1}],"tail":"t","section":{}}]}'
    const body = ['<!-- a a -->', '', 'A', '', '<!-- a b -->', '', 'B', '', '<!-- a c -->', '', 'C', '', '<!-- a d -->', '', 'D', '', '<!-- a t -->', '', '外面', ''].join('\n')
    const bb = await boot(body, four)
    const { state } = bb.view
    let outside = -1
    let inB = -1
    state.doc.descendants((n, pos) => {
      if (n.isTextblock && n.textContent === '外面') outside = pos
      if (n.isTextblock && n.textContent === 'B') inB = pos
    })
    bb.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, outside)))
    expect(executePair(bb.view, inB, 'right')).toBe(false)
    expect(rows(bb).map((r) => r.cells)).toEqual([4])
  })

  it('粘进栏里的版块行被摊平(版块不能套版块)', async () => {
    const bb = await boot(BODY, LAYOUT)
    const { state } = bb.view
    const sec = state.doc.child(1) // 第一行 = 1 栏版块(标题之后)
    expect(isSectionRow(sec)).toBe(true)
    let beta = -1
    state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent.includes('BETA')) beta = pos })
    bb.view.dispatch(state.tr.insert(beta, sec.copy(sec.content)))
    // 顶层仍是两行;BETA 所在的栏里没有行
    expect(rows(bb).map((r) => r.cells)).toEqual([1, 2])
    let nested = 0
    bb.view.state.doc.forEach((n) => n.descendants((c) => { if (c.type.name === 'amadeusColumnRow') nested++ }))
    expect(nested).toBe(0)
  })
})

describe('版块:复制与粘贴', () => {
  it('同篇里再贴一份版块 → 后一份换新锚,两份都还能折叠', async () => {
    const bb = await boot(BODY, LAYOUT)
    const { state } = bb.view
    const sec = state.doc.child(1)
    expect(isSectionRow(sec)).toBe(true)
    bb.view.dispatch(state.tr.insert(state.doc.content.size, sec.copy(sec.content)).setMeta('uiEvent', 'paste'))
    const anchors: string[] = []
    bb.view.state.doc.forEach((n) => {
      if (n.type.name !== 'amadeusColumnRow') return
      anchors.push(String(n.attrs.tail))
      n.forEach((c) => anchors.push(String(c.attrs.anchor)))
    })
    expect(rows(bb).map((r) => r.cells)).toEqual([1, 2, 1])
    expect(new Set(anchors).size).toBe(anchors.length)
    // 派生 → 重新打开:三行都折得回来
    const lay = deriveLayoutJson(bb.view.state.doc)
    const saved = bb.saved()
    await bb.destroy(); b = null
    const again = await boot(saved, lay)
    expect(rows(again).map((r) => r.cells)).toEqual([1, 2, 1])
  })

  it('外层缺锚的行里又粘着一行:先修里层再修外层,后面的正文一个字不少', async () => {
    const bb = await boot('Intro 段落。\n', null)
    const { schema } = bb.view.state
    const { amadeusColumnRow: row, amadeusColumnCell: cell, paragraph } = schema.nodes
    const inner = row.create({ tail: '', section: {} }, cell.create({ anchor: '' }, paragraph.create(null, schema.text('里层'))))
    const outer = row.create({ tail: '', section: {} }, cell.create({ anchor: '' }, [paragraph.create(null, schema.text('外层')), inner]))
    bb.view.dispatch(bb.view.state.tr.insert(0, outer))
    expect(bb.view.state.doc.textContent).toContain('Intro 段落。')
    expect(bb.view.state.doc.textContent).toContain('外层')
    expect(bb.view.state.doc.textContent).toContain('里层')
    let nested = 0
    bb.view.state.doc.forEach((n) => n.descendants((c) => { if (c.type.name === 'amadeusColumnRow') nested++ }))
    expect(nested).toBe(0)
    bb.view.state.doc.forEach((n) => { if (n.type.name === 'amadeusColumnRow') n.forEach((c) => expect(c.attrs.anchor).not.toBe('')) })
  })
})

describe('版块:评审补的几条', () => {
  it('贴在原件上方:原件的锚不动,换号的是新贴的那份(既有链接仍指原件)', async () => {
    const bb = await boot(BODY, LAYOUT)
    const { state } = bb.view
    const sec = state.doc.child(1)
    const at = state.doc.child(0).nodeSize // 原件之前
    bb.view.dispatch(state.tr.insert(at, sec.copy(sec.content)).setMeta('uiEvent', 'paste'))
    const rs: Array<{ tail: string; anchors: string[] }> = []
    bb.view.state.doc.forEach((n) => {
      if (n.type.name !== 'amadeusColumnRow') return
      const anchors: string[] = []
      n.forEach((c) => anchors.push(String(c.attrs.anchor)))
      rs.push({ tail: String(n.attrs.tail), anchors })
    })
    expect(rs).toHaveLength(3)
    expect(rs[1]).toEqual({ tail: 't1', anchors: ['s1'] }) // 原件
    expect(rs[0].tail).not.toBe('t1')
    expect(rs[0].anchors[0]).not.toBe('s1')
  })

  it('撤销重做、外部回灌带回来的锚一个不改(撤销删掉的重复注释不被换号)', async () => {
    const body = ['甲段。', '', '<!-- a x1 -->', '', '乙段。', '', '<!-- a x1 -->', '', '丙段。', ''].join('\n')
    const bb = await boot(body, null)
    const { state } = bb.view
    let first = -1
    state.doc.forEach((n, off) => { if (first < 0 && n.type.name === 'paragraph' && n.childCount === 1 && n.firstChild!.type.name === 'html') first = off })
    const node = state.doc.nodeAt(first)!
    // 外部回灌形态(addToHistory:false):把删掉的那段原样塞回来
    bb.view.dispatch(state.tr.delete(first, first + node.nodeSize))
    bb.view.dispatch(bb.view.state.tr.insert(first, node).setMeta('addToHistory', false))
    expect(bb.saved()).toBe(body)
    // 撤销重做形态(history$ 回放)
    bb.view.dispatch(bb.view.state.tr.delete(first, first + node.nodeSize))
    bb.view.dispatch(bb.view.state.tr.insert(first, node).setMeta('history$', { redo: false }))
    expect(bb.saved()).toBe(body)
  })

  it('Mod-D 那样不带粘贴标记的复制(普通编辑)照样换新锚', async () => {
    const bb = await boot(BODY, LAYOUT)
    const { state } = bb.view
    const sec = state.doc.child(1)
    bb.view.dispatch(state.tr.insert(state.doc.child(0).nodeSize + sec.nodeSize, sec.copy(sec.content)))
    const tails: string[] = []
    bb.view.state.doc.forEach((n) => { if (n.type.name === 'amadeusColumnRow') tails.push(String(n.attrs.tail)) })
    expect(tails[0]).toBe('t1')
    expect(new Set(tails).size).toBe(tails.length)
  })

  it('没有分栏的笔记里本来就重复的锚注释:一次无关编辑不改写它们', async () => {
    const body = ['甲段。', '', '<!-- a x1 -->', '', '乙段。', '', '<!-- a x1 -->', '', '丙段。', ''].join('\n')
    const bb = await boot(body, null)
    let pos = -1
    bb.view.state.doc.descendants((n, p) => { if (pos < 0 && n.isTextblock && n.textContent === '甲段。') pos = p + 1 })
    bb.view.dispatch(bb.view.state.tr.insertText('X', pos))
    expect(bb.saved()).toBe(body.replace('甲段。', 'X甲段。'))
  })

  it('版块粘进引用块:原地摊平成普通内容(存盘只折顶层行,留着重开就丢布局)', async () => {
    const bb = await boot(BODY, LAYOUT)
    const { state } = bb.view
    const sec = state.doc.child(1)
    const { blockquote, paragraph } = state.schema.nodes
    const end = state.doc.content.size
    bb.view.dispatch(state.tr.insert(end, blockquote.create(null, [paragraph.create(null, state.schema.text('引用里')), sec.copy(sec.content)])))
    let nested = 0
    bb.view.state.doc.forEach((n) => n.descendants((c) => { if (c.type.name === 'amadeusColumnRow') nested++ }))
    expect(nested).toBe(0)
    let quoted = ''
    bb.view.state.doc.forEach((n) => { if (n.type.name === 'blockquote') quoted = n.textContent })
    expect(quoted).toContain('引用里')
    expect(quoted).toContain('ALPHA')
  })

  it('光标在要并掉的栏里减栏:光标跟着内容走,打的字不进锚标记', async () => {
    const bb = await boot(BODY, LAYOUT)
    const rowPos = rows(bb)[1].pos // 两栏版块
    let gamma = -1
    bb.view.state.doc.descendants((n, p) => { if (n.isTextblock && n.textContent.startsWith('右栏')) gamma = p + 1 })
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, gamma + 2)))
    expect(setSectionColumns(bb.view, rowPos, 1)).toBe(true)
    bb.view.dispatch(bb.view.state.tr.insertText('X'))
    const out = bb.saved()
    expect(out).toContain('右栏X GAMMA。')
    expect(out).toContain('<!-- a c2 -->')
    expect(out).not.toMatch(/X<!--|-->X/)
  })

  it('并进来的栏只有分隔线(没有正文块):补一个空段落放光标,打的字不进锚标记', async () => {
    const body = ['<!-- a e1 -->', '', '<!-- a d2 -->', '', '---', '', '<!-- a te -->', '', '后文。', ''].join('\n')
    const lay = '{"v":4,"rows":[{"columns":[{"refs":["e1"],"width":1},{"refs":["d2"],"width":1}],"tail":"te","section":{}}]}'
    const bb = await boot(body, lay)
    const rowPos = rows(bb)[0].pos
    const row = bb.view.state.doc.nodeAt(rowPos)!
    let firstCell = -1
    row.forEach((c, off, i) => { if (i === 0) firstCell = rowPos + 1 + off + 2 })
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, firstCell)))
    expect(setSectionColumns(bb.view, rowPos, 1)).toBe(true)
    bb.view.dispatch(bb.view.state.tr.insertText('X'))
    const out = bb.saved()
    expect(out).not.toMatch(/X<!--|-->X/)
    expect(out).toContain('<!-- a d2 -->')
    expect(out).toMatch(/\nX\n/)
  })

  it('光标在要并掉的空栏里减栏:光标落到留下那栏的正文末尾,不落进行后的锚标记', async () => {
    const bb = await boot(BODY, LAYOUT)
    const rowPos = rows(bb)[1].pos
    expect(setSectionColumns(bb.view, rowPos, 3)).toBe(true)
    let third = -1
    const row = bb.view.state.doc.nodeAt(rowPos)!
    row.forEach((c, off, i) => { if (i === 2) third = rowPos + 1 + off + 2 })
    bb.view.dispatch(bb.view.state.tr.setSelection(TextSelection.create(bb.view.state.doc, third)))
    expect(setSectionColumns(bb.view, rowPos, 2)).toBe(true)
    bb.view.dispatch(bb.view.state.tr.insertText('X'))
    const out = bb.saved()
    expect(out).toContain('右栏 GAMMA。X')
    expect(out).not.toMatch(/X<!--|-->X/)
  })
})

describe('版块样式工具函数', () => {
  it('sectionView:缺省与认不出的取值', () => {
    expect(sectionView({})).toEqual({ bg: '', pad: 'm', cards: true, valign: 't', stack: true })
    expect(sectionView({ bg: 'pink', pad: 'xl', cards: 0, valign: 'x', stack: 0 })).toEqual({ bg: '', pad: 'm', cards: true, valign: 't', stack: true })
    expect(sectionView({ bg: 'teal', pad: 's', cards: false, valign: 'b', stack: false })).toEqual({ bg: 'teal', pad: 's', cards: false, valign: 'b', stack: false })
  })

  it('patchSection:新对象、缺省值删键、未知键留着', () => {
    const raw = { bg: 'blue', later: 1 }
    const next = patchSection(raw, { bg: '', pad: 'l' })
    expect(next).toEqual({ later: 1, pad: 'l' })
    expect(raw).toEqual({ bg: 'blue', later: 1 })
    expect(patchSection(next, { pad: 'm', cards: true })).toEqual({ later: 1 })
  })
})
