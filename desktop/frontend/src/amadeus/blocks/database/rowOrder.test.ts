import { describe, expect, it } from 'vitest'
import { dropAfter, dropAfterX, moveColumn, moveRow, sameOrder } from './rowOrder'

const R = (...ids: string[]) => ids.map((id) => ({ id }))
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id)

describe('moveRow', () => {
  it('往下拖:插到目标之后', () => expect(ids(moveRow(R('a', 'b', 'c'), 'a', 'c', true))).toEqual(['b', 'c', 'a']))
  it('往下拖:插到目标之前', () => expect(ids(moveRow(R('a', 'b', 'c'), 'a', 'c', false))).toEqual(['b', 'a', 'c']))
  it('往上拖:插到目标之前', () => expect(ids(moveRow(R('a', 'b', 'c'), 'c', 'a', false))).toEqual(['c', 'a', 'b']))
  it('往上拖:插到目标之后', () => expect(ids(moveRow(R('a', 'b', 'c'), 'c', 'a', true))).toEqual(['a', 'c', 'b']))

  // 摘掉源行后目标下标会左移,拿旧下标算就会差一位(往下拖时表现为「少走一格」)
  it('相邻往下拖不差一位', () => expect(ids(moveRow(R('a', 'b', 'c'), 'a', 'b', true))).toEqual(['b', 'a', 'c']))

  it('拖到自己身上 → 同一个引用(调用方据此跳过写盘)', () => {
    const rows = R('a', 'b')
    expect(moveRow(rows, 'a', 'a', true)).toBe(rows)
  })
  it('id 不存在 → 同一个引用', () => {
    const rows = R('a', 'b')
    expect(moveRow(rows, 'x', 'a', true)).toBe(rows)
    expect(moveRow(rows, 'a', 'x', true)).toBe(rows)
  })
  it('不改原数组', () => {
    const rows = R('a', 'b', 'c')
    moveRow(rows, 'a', 'c', true)
    expect(ids(rows)).toEqual(['a', 'b', 'c'])
  })
})

describe('dropAfter', () => {
  const rect = { top: 100, height: 40 }
  it('上半 → 之前', () => expect(dropAfter(110, rect)).toBe(false))
  it('下半 → 之后', () => expect(dropAfter(130, rect)).toBe(true))
  it('正中间算之前(边界稳定,不来回跳)', () => expect(dropAfter(120, rect)).toBe(false))
})

describe('dropAfterX(列拖拽)', () => {
  const rect = { left: 200, width: 120 }
  it('左半 → 之前', () => expect(dropAfterX(230, rect)).toBe(false))
  it('右半 → 之后', () => expect(dropAfterX(300, rect)).toBe(true))
  it('正中间算之前(与 dropAfter 同口径,边界不来回跳)', () => expect(dropAfterX(260, rect)).toBe(false))
})

// 列序就是 db.columns 的数组序,与行共用 moveRow —— 这里钉住「列形状的元素也走得通」,
// 免得日后有人给 moveRow 加个 rows 专属字段把列这条路弄断。
describe('moveRow 用于列', () => {
  const C = (...ids: string[]) => ids.map((id) => ({ id, name: id, type: 'text' }))
  it('把第 4 列拖到第 2 列前面', () =>
    expect(ids(moveRow(C('名称', '状态', '工时', '单价'), '单价', '状态', false))).toEqual(['名称', '单价', '状态', '工时']))
  it('拖到末列之后', () =>
    expect(ids(moveRow(C('名称', '状态', '工时'), '状态', '工时', true))).toEqual(['名称', '工时', '状态']))
})

describe('sameOrder(「这一手其实没动」的判据)', () => {
  it('拖到自己身上:moveRow 给原引用,自然同序', () => {
    const cols = R('a', 'b', 'c')
    expect(sameOrder(moveRow(cols, 'b', 'b', true), cols)).toBe(true)
  })
  it('⚠️ 摘出又插回原位:是**内容相同的新数组**,只比引用会漏 —— sameOrder 必须判出没动', () => {
    const cols = R('a', 'b', 'c')
    const moved = moveRow(cols, 'a', 'b', false) // a 插到 b 之前 = a 还在原位
    expect(moved).not.toBe(cols) // 引用变了
    expect(sameOrder(moved, cols)).toBe(true) // 但顺序没变
  })
  it('真的动了 → false', () => {
    const cols = R('a', 'b', 'c')
    expect(sameOrder(moveRow(cols, 'a', 'b', true), cols)).toBe(false)
  })
})

describe('moveColumn(首列=标题列的权威闸)', () => {
  const C = (...ids: string[]) => ids.map((id) => ({ id }))
  it('首列不能被拖走 → 原样返回', () => {
    const cols = C('名称', '状态', '工时')
    expect(moveColumn(cols, '名称', '工时', true)).toBe(cols)
  })
  it('别的列拖到首列(哪怕 after=false)也只能落它右边', () =>
    expect(ids(moveColumn(C('名称', '状态', '工时'), '工时', '名称', false))).toEqual(['名称', '工时', '状态']))
  it('普通列之间照常前后插', () => {
    expect(ids(moveColumn(C('名称', '状态', '工时'), '工时', '状态', false))).toEqual(['名称', '工时', '状态'])
    expect(ids(moveColumn(C('名称', '状态', '工时'), '状态', '工时', true))).toEqual(['名称', '工时', '状态'])
  })
  // 这条是 Codex 抓的 high 的回归:同一个调用被**重放到首列已经变了的新数据上**,闸必须跟着新数据走。
  // 写成纯函数就是为了让这条结构性成立 —— 判据只可能来自传进来的那份 columns。
  it('重放到「首列已被外部换掉」的数据上:闸按新首列判', () => {
    const fresh = C('工时', '名称', '状态') // 外部把「工时」变成了首列
    expect(moveColumn(fresh, '工时', '状态', true)).toBe(fresh) // 它现在是首列 → 拖不走
    expect(ids(moveColumn(fresh, '状态', '工时', false))).toEqual(['工时', '状态', '名称']) // 也插不到它前面
  })
})
