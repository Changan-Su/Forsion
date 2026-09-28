import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { editContextAt, toolbarShape } from './menuContext'

// 最小 schema:只要祖先链上的名字 / tableRole / code 与生产一致即可(menuContext 只看这些)。
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    code_block: { group: 'block', content: 'text*', code: true },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph block*' },
    table: { group: 'block', content: 'table_row+', tableRole: 'table' },
    table_row: { content: 'table_cell+', tableRole: 'row' },
    table_cell: { content: 'paragraph+', tableRole: 'cell' },
    text: {},
  },
})
const { doc, paragraph: p, code_block: code, bullet_list: ul, list_item: li, table, table_row: tr, table_cell: td } = schema.nodes
const t = (s: string) => schema.text(s)

/** 文档里第一处 text 的内部位置。 */
function posOf(d: ReturnType<typeof doc.create>, s: string): number {
  let hit = -1
  d.descendants((n, pos) => { if (hit < 0 && n.isText && n.text === s) hit = pos + 1; return hit < 0 })
  return hit
}

describe('editContextAt / toolbarShape(I-19:工具栏按上下文露按钮)', () => {
  const d = doc.create(null, [
    p.create(null, t('top')),
    code.create(null, t('code')),
    ul.create(null, [li.create(null, [p.create(null, t('item'))])]),
    table.create(null, [tr.create(null, [td.create(null, [p.create(null, t('cell'))])])]),
  ])
  it('顶层段落:全露', () => {
    const c = editContextAt(d.resolve(posOf(d, 'top')))
    expect(c.topLevel).toBe(true)
    expect(toolbarShape(c)).toEqual({ turnInto: true, format: true, link: true, color: true, align: true })
  })
  it('代码块:只留「转换为」(格式 / 链接 / 颜色 / 对齐在代码里全都无效)', () => {
    const c = editContextAt(d.resolve(posOf(d, 'code')))
    expect(c.code).toBe(true)
    expect(toolbarShape(c)).toEqual({ turnInto: true, format: false, link: false, color: false, align: false })
  })
  it('单元格:不列「转换为」(会劈表)与段落对齐(会往格子里写 span)', () => {
    const c = editContextAt(d.resolve(posOf(d, 'cell')))
    expect(c.tableCell).toBe(true)
    expect(c.topLevel).toBe(false)
    expect(toolbarShape(c)).toEqual({ turnInto: false, format: true, link: true, color: true, align: false })
  })
  it('列表项:认得出,不是顶层', () => {
    const c = editContextAt(d.resolve(posOf(d, 'item')))
    expect(c.listItem).toBe(true)
    expect(c.topLevel).toBe(false)
  })
})
