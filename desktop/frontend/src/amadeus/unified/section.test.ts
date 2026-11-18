// @vitest-environment happy-dom
// 版块(方向 B,page/5)在真 Milkdown 里的往返:layout 行的 section 样式折进 amadeusColumnRow.attrs.section,
// 派生回来逐字一样(未知键也带回去),正文逐字不动;版块 1 栏也成行;版块里的空栏不被别处的拖拽清掉。
import { afterEach, describe, expect, it } from 'vitest'
import { bootEditor, type Booted } from '../blocks/markdown/parseFidelity.testkit'
import {
  columnPlugins, createColumnsFold, deriveLayoutJson, parseLayoutJson, patchSection, removeEmptyColumnTr,
  sectionView, isSectionRow, executePair, type LayoutV4,
} from './columns'
import { NodeSelection } from '@milkdown/kit/prose/state'

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

describe('版块样式工具函数', () => {
  it('sectionView:缺省与认不出的取值', () => {
    expect(sectionView({})).toEqual({ bg: '', pad: 'm', cards: true, valign: 't' })
    expect(sectionView({ bg: 'pink', pad: 'xl', cards: 0, valign: 'x' })).toEqual({ bg: '', pad: 'm', cards: true, valign: 't' })
    expect(sectionView({ bg: 'teal', pad: 's', cards: false, valign: 'b' })).toEqual({ bg: 'teal', pad: 's', cards: false, valign: 'b' })
  })

  it('patchSection:新对象、缺省值删键、未知键留着', () => {
    const raw = { bg: 'blue', later: 1 }
    const next = patchSection(raw, { bg: '', pad: 'l' })
    expect(next).toEqual({ later: 1, pad: 'l' })
    expect(raw).toEqual({ bg: 'blue', later: 1 })
    expect(patchSection(next, { pad: 'm', cards: true })).toEqual({ later: 1 })
  })
})
