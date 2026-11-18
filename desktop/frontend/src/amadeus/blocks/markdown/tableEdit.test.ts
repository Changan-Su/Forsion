// 悬停层的三个表格原语(appendTableTr / moveTableRowTr / moveTableColTr)对着与 preset-gfm 同构的 schema:
// `table = table_header_row table_row+`,表头行只装 table_header、正文行只装 table_cell,对齐存在每一格的 alignment 上。
// 钉的是「产出的永远是合法 GFM 表」与「一笔事务」:schema.check() 不过 = 拼出了 GFM 存不下的结构。
// 真编辑器里的手感(悬停 / 拖动 / 撤销 / 落盘)归 scripts/table-hover.check.cjs(npm run check:tablehover)。
import { describe, expect, it } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { appendTableTr, moveTableColTr, moveTableRowTr, tableMenuModel, tableCellPos } from './tableEdit'

// colspan / rowspan / colwidth:prosemirror-tables 的 tableNodes() 给 gfm 格子带的三个属性,TableMap 靠它们算宽高。
const cellAttrs = { alignment: { default: 'left' as string | null }, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } }
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    table: { group: 'block', content: 'table_header_row table_row+', tableRole: 'table', isolating: true, toDOM: () => ['table', ['tbody', 0]] },
    table_header_row: { content: 'table_header*', tableRole: 'row', toDOM: () => ['tr', 0] },
    table_row: { content: 'table_cell*', tableRole: 'row', toDOM: () => ['tr', 0] },
    table_header: { content: 'paragraph', attrs: cellAttrs, tableRole: 'header_cell', isolating: true, toDOM: () => ['th', 0] },
    table_cell: { content: 'paragraph', attrs: cellAttrs, tableRole: 'cell', isolating: true, toDOM: () => ['td', 0] },
  },
})
const { paragraph: P, table: T, table_header_row: HR, table_row: R, table_header: TH, table_cell: TD } = schema.nodes
const p = (s: string): PMNode => P.create(null, s ? schema.text(s) : null)

/** [表头, 正文行…];aligns 是每列表头 / 正文格的对齐(GFM 只认表头那份,正文格被 keepTableAlign 拉齐)。 */
function makeTable(rows: string[][], aligns: (string | null)[]): PMNode {
  return T.create(null, rows.map((cells, r) => (r === 0 ? HR : R).create(null,
    cells.map((s, c) => (r === 0 ? TH : TD).create({ alignment: aligns[c] }, p(s))))))
}
function stateOf(table: PMNode): EditorState {
  const doc = schema.node('doc', null, [p('before'), table, p('after')])
  return EditorState.create({ doc, selection: TextSelection.create(doc, 2) })
}
const TABLE_POS = 8 // 'before' 段 = 1 + 6 + 1
const grid = (doc: PMNode): string[][] => {
  const out: string[][] = []
  doc.child(1).forEach((row) => { const cells: string[] = []; row.forEach((c) => cells.push(c.textContent)); out.push(cells) })
  return out
}
const aligns = (doc: PMNode, row = 0): (string | null)[] => {
  const out: (string | null)[] = []
  doc.child(1).child(row).forEach((c) => out.push(c.attrs.alignment as string | null))
  return out
}
const steps = (tr: { steps: unknown[] }): number => tr.steps.length

describe('appendTableTr', () => {
  const base = (): EditorState => stateOf(makeTable([['a', 'b'], ['1', '2'], ['3', '4']], [null, 'center']))

  it('adds rows and columns in one transaction and stays a valid GFM table', () => {
    const st = base()
    const tr = appendTableTr(st, TABLE_POS, 2, 3)!
    expect(tr).not.toBeNull()
    tr.doc.check()
    const g = grid(tr.doc)
    expect(g.length).toBe(5)
    expect(g.every((r) => r.length === 5)).toBe(true)
    expect(g[0].slice(0, 2)).toEqual(['a', 'b'])
    expect(tr.doc.child(1).child(0).child(4).type.name).toBe('table_header')
    expect(tr.doc.child(1).child(4).child(0).type.name).toBe('table_cell')
    // 新列写 `---`(无对齐);新行继承表头的对齐
    expect(aligns(tr.doc, 0)).toEqual([null, 'center', null, null, null])
    expect(aligns(tr.doc, 4)).toEqual([null, 'center', null, null, null])
    expect(tr.doc.child(2).textContent).toBe('after')
  })

  it('caret lands in the new row / new column header when asked', () => {
    const st = base()
    const row = appendTableTr(st, TABLE_POS, 1, 0, 'row')!
    const $r = row.selection.$head
    expect($r.node($r.depth - 1).type.name).toBe('table_cell')
    expect(row.doc.resolve(row.selection.head).index(1)).toBe(3) // 第 4 行(新末行)
    const col = appendTableTr(st, TABLE_POS, 0, 1, 'col')!
    const $c = col.selection.$head
    expect($c.node($c.depth - 1).type.name).toBe('table_header')
    expect(col.doc.resolve(col.selection.head).index(2)).toBe(2) // 表头第 3 格(新末列)
  })

  it('without caret the selection outside the table is untouched', () => {
    const st = base()
    const tr = appendTableTr(st, TABLE_POS, 1, 1)!
    expect(tr.selection.head).toBe(st.selection.head)
  })

  it('refuses nonsense input', () => {
    const st = base()
    expect(appendTableTr(st, TABLE_POS, 0, 0)).toBeNull()
    expect(appendTableTr(st, TABLE_POS, -1, 1)).toBeNull()
    expect(appendTableTr(st, 0, 1, 0)).toBeNull() // 0 是段落,不是表
    expect(appendTableTr(st, 9999, 1, 0)).toBeNull()
  })
})

describe('moveTableRowTr', () => {
  const st = (): EditorState => stateOf(makeTable([['h1', 'h2'], ['r1', 'x'], ['r2', 'y'], ['r3', 'z']], [null, null]))

  it('reorders body rows; the header stays first', () => {
    const tr = moveTableRowTr(st(), TABLE_POS, 3, 1)!
    tr.doc.check()
    expect(grid(tr.doc).map((r) => r[0])).toEqual(['h1', 'r3', 'r1', 'r2'])
    const down = moveTableRowTr(st(), TABLE_POS, 1, 3)!
    expect(grid(down.doc).map((r) => r[0])).toEqual(['h1', 'r2', 'r3', 'r1'])
    expect(steps(tr)).toBe(1)
  })

  it('never moves the header row or into it', () => {
    expect(moveTableRowTr(st(), TABLE_POS, 0, 2)).toBeNull()
    expect(moveTableRowTr(st(), TABLE_POS, 2, 0)).toBeNull()
    expect(moveTableRowTr(st(), TABLE_POS, 2, 2)).toBeNull()
    expect(moveTableRowTr(st(), TABLE_POS, 1, 4)).toBeNull()
  })

  it('caret follows the moved row only when it was inside the table', () => {
    const s0 = st()
    const inCell = s0.apply(s0.tr.setSelection(TextSelection.near(s0.doc.resolve(tableCellPos(s0.doc, TABLE_POS, 3, 1)! + 2))))
    const tr = moveTableRowTr(inCell, TABLE_POS, 3, 1)!
    expect(tr.doc.resolve(tr.selection.head).index(1)).toBe(1)
    const outside = moveTableRowTr(s0, TABLE_POS, 3, 1)!
    expect(outside.selection.head).toBe(s0.selection.head)
  })
})

describe('moveTableColTr', () => {
  const st = (): EditorState => stateOf(makeTable([['a', 'b', 'c'], ['1', '2', '3']], [null, 'center', 'right']))

  it('moves the whole column, header and alignment included', () => {
    const tr = moveTableColTr(st(), TABLE_POS, 2, 0)!
    tr.doc.check()
    expect(grid(tr.doc)).toEqual([['c', 'a', 'b'], ['3', '1', '2']])
    expect(aligns(tr.doc, 0)).toEqual(['right', null, 'center'])
    expect(aligns(tr.doc, 1)).toEqual(['right', null, 'center'])
    const back = moveTableColTr(st(), TABLE_POS, 0, 2)!
    expect(grid(back.doc)[0]).toEqual(['b', 'c', 'a'])
    expect(steps(tr)).toBe(1)
  })

  it('refuses out of range and no-op moves', () => {
    expect(moveTableColTr(st(), TABLE_POS, 1, 1)).toBeNull()
    expect(moveTableColTr(st(), TABLE_POS, 3, 0)).toBeNull()
    expect(moveTableColTr(st(), TABLE_POS, 0, -1)).toBeNull()
  })
})

describe('tableMenuModel axis filter', () => {
  const s = stateOf(makeTable([['a', 'b'], ['1', '2'], ['3', '4']], [null, 'right']))
  it('row handle: only row operations, no alignment', () => {
    const m = tableMenuModel(s.doc, TABLE_POS, tableCellPos(s.doc, TABLE_POS, 1, 0), 'row')!
    expect(m.ops).toEqual(['rowAbove', 'rowBelow', 'deleteRow'])
    expect(m.align).toBeNull()
    const head = tableMenuModel(s.doc, TABLE_POS, tableCellPos(s.doc, TABLE_POS, 0, 0), 'row')!
    expect(head.ops).toEqual(['rowBelow']) // 表头:不能在上方插、不能删
  })
  it('column handle: only column operations plus alignment of that column', () => {
    const m = tableMenuModel(s.doc, TABLE_POS, tableCellPos(s.doc, TABLE_POS, 0, 1), 'col')!
    expect(m.ops).toEqual(['colLeft', 'colRight', 'deleteCol'])
    expect(m.align).toBe('right')
  })
  it('a handle with a stale anchor gives no menu', () => {
    expect(tableMenuModel(s.doc, TABLE_POS, null, 'row')).toBeNull()
  })
})
