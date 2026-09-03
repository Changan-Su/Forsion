/** rowLink.ts 纯逻辑:芯片文案按 titleCol / 自动编号带前缀 / 计算列回落首列;删行只清同文件自引用;关联列失效清依赖 lookup。 */
import { describe, expect, it, beforeEach } from 'vitest'
import { setLocaleGlobal } from '../../../i18n'
import type { DbFile } from '@amadeus-shared/db/schema'
import { detachLookups, dropSelfRefs, isSelfRefCol, linkLabel, resolveTreeCol, rowLinkIds, selfPathSet, titleColOf, treeColsOf } from './rowLink'

const ORDERS: DbFile = {
  version: 1, name: '订单',
  columns: [
    { id: 'cust', name: '客户', type: 'text' },
    { id: 'no', name: '订单号', type: 'autonumber', prefix: 'ORD-' },
    { id: 'total', name: '总计', type: 'formula', formula: '1' },
    { id: 'lines', name: '出库行', type: 'lookup', refDb: '出库.db', lookupBackCol: 'x', lookupCol: 'y' },
    { id: 'tags', name: '标签', type: 'multiselect', options: ['a', 'b'] },
  ],
  rows: [
    { id: 'o1', cells: { cust: '张三', no: 1, tags: ['a', 'b'] } },
    { id: 'o2', cells: { no: 2 } },
  ],
}

describe('linkLabel / titleColOf', () => {
  // linkLabel 的空值文案已 i18n 化 → 显式钉住语言,断言才有确定含义
  beforeEach(() => { setLocaleGlobal('zh') })

  it('缺省 = 首列;titleCol 指定列;自动编号带前缀(不是裸数字)', () => {
    expect(linkLabel(ORDERS, ORDERS.rows[0])).toBe('张三')
    expect(linkLabel(ORDERS, ORDERS.rows[0], 'no')).toBe('ORD-1')
    expect(linkLabel(ORDERS, ORDERS.rows[0], 'tags')).toBe('a, b')
    expect(linkLabel(ORDERS, ORDERS.rows[1])).toBe('未命名') // 首列空
    expect(linkLabel(ORDERS, ORDERS.rows[1], 'no')).toBe('ORD-2')
  })
  it('titleCol 指向计算列 / 不存在的列 → 回落首列(计算列磁盘无值,别显示一整列「未命名」)', () => {
    expect(titleColOf(ORDERS, 'total')?.id).toBe('cust')
    expect(titleColOf(ORDERS, 'lines')?.id).toBe('cust')
    expect(titleColOf(ORDERS, 'nope')?.id).toBe('cust')
    expect(linkLabel(ORDERS, ORDERS.rows[0], 'total')).toBe('张三')
    expect(linkLabel({ ...ORDERS, columns: [] }, ORDERS.rows[0])).toBe('未命名')
  })
  it('rowLinkIds:string / string[] / 脏值', () => {
    expect(rowLinkIds('a')).toEqual(['a'])
    expect(rowLinkIds(['a', '', 'b'])).toEqual(['a', 'b'])
    expect(rowLinkIds(3)).toEqual([])
    expect(rowLinkIds(undefined)).toEqual([])
  })
})

const SELF = '任务.db'
const tasks = (): DbFile => ({
  version: 1, name: '任务',
  columns: [
    { id: 't', name: '标题', type: 'text' },
    { id: 'parent', name: '父任务', type: 'rowlink', refDb: SELF },
    { id: 'deps', name: '依赖', type: 'rowlink', refDb: './任务.db', multiple: true },
    { id: 'proj', name: '项目', type: 'rowlink', refDb: '项目.db' },
  ],
  rows: [
    { id: 'a', cells: { t: 'A', proj: 'a' } }, // proj 指向别的表里恰好同名的 id 'a':不是自引用,不许动
    { id: 'b', cells: { t: 'B', parent: 'a', deps: ['a', 'c'], proj: 'a' } },
    { id: 'c', cells: { t: 'C', parent: 'b', deps: ['a'] } },
  ],
})

describe('dropSelfRefs(删行只清同文件自引用)', () => {
  it('删 a → parent 单值删键、deps 多值摘掉 a(空了删键);指向别表的 rowlink 即使 id 撞名也不动', () => {
    const d0 = tasks()
    const d = dropSelfRefs({ ...d0, rows: d0.rows.filter((r) => r.id !== 'a') }, 'a', [SELF])
    const b = d.rows.find((r) => r.id === 'b')!
    const c = d.rows.find((r) => r.id === 'c')!
    expect(b.cells.parent).toBeUndefined()
    expect(b.cells.deps).toEqual(['c'])
    expect(b.cells.proj).toBe('a') // 跨文件不级联
    expect(c.cells.deps).toBeUndefined()
    expect(c.cells.parent).toBe('b')
    expect(d0.rows[1].cells.deps).toEqual(['a', 'c']) // 不原地改
  })
  it('路径口径:refDb 带 ./ 也算本表;selfPaths 没一个匹配(负对照)→ 原样返回同一引用', () => {
    const d0 = tasks()
    const same = dropSelfRefs(d0, 'a', ['别的.db'])
    expect(same).toBe(d0)
    const d = dropSelfRefs(d0, 'a', ['任务.db'])
    expect(d.rows[1].cells.deps).toEqual(['c']) // './任务.db' 归一后命中
  })
  it('没人引用被删行 → 返回同一引用(不产生多余保存点)', () => {
    const d0 = tasks()
    expect(dropSelfRefs(d0, 'zzz', [SELF])).toBe(d0)
  })
})

describe('detachLookups(关联列换目标表 / 删列 → 正向 lookup 待重新配置;改类型不经这里,是休眠)', () => {
  const cols: DbFile['columns'] = [
    { id: 't', name: '标题', type: 'text' },
    { id: 'rel', name: '配件', type: 'rowlink', refDb: '配件.db' },
    { id: 'rel2', name: '供应商', type: 'rowlink', refDb: '供应商.db' },
    { id: 'p', name: '单价', type: 'lookup', lookupRel: 'rel', lookupCol: 'price' },
    { id: 's', name: '供应商名', type: 'lookup', lookupRel: 'rel2', lookupCol: 'name' },
    { id: 'back', name: '反向', type: 'lookup', refDb: '配件.db', lookupBackCol: 'rel', lookupCol: 'n' },
  ]
  it('只清 lookupRel 指向该列的正向 lookup(lookupRel + lookupCol 一起清),别的列原样', () => {
    const out = detachLookups(cols, 'rel')
    const p = out.find((c) => c.id === 'p')!
    expect(p.lookupRel).toBeUndefined()
    expect(p.lookupCol).toBeUndefined()
    expect(p.type).toBe('lookup') // 列本身保留
    expect(out.find((c) => c.id === 's')).toBe(cols[4]) // 负对照:依赖别的关联列的不动
    expect(out.find((c) => c.id === 'back')).toBe(cols[5]) // 反向 lookup 不带 lookupRel,不动
  })
  it('没人依赖 → 返回同一数组引用', () => {
    expect(detachLookups(cols, 'rel2x')).toBe(cols)
  })
})

describe('自指关联列判据(层级树父列 / 删行清理共用)', () => {
  const SELF = ['任务/任务表.db']
  const cols: DbFile['columns'] = [
    { id: 't', name: '文本', type: 'text' },
    { id: 'parent', name: '父任务', type: 'rowlink', refDb: './任务/任务表.db' }, // 带 ./ 前缀,归一后才等于本表
    { id: 'blocks', name: '阻塞', type: 'rowlink', refDb: '任务\\任务表.db' }, // 反斜杠口径
    { id: 'other', name: '订单', type: 'rowlink', refDb: '订单总表.db' }, // 指向别的表
    { id: 'notrel', name: '类型', type: 'multiselect' }, // 不是关联列
    { id: 'back', name: '反向', type: 'lookup', refDb: '任务/任务表.db', lookupBackCol: 'parent' }, // lookup 不是 rowlink
  ]
  it('只认 type=rowlink 且 refDb 归一后指回本表;路径口径(./ 与 \\)一并归一', () => {
    const self = selfPathSet(SELF)
    expect(cols.map((c) => isSelfRefCol(c, self))).toEqual([false, true, true, false, false, false])
    expect(treeColsOf(cols, SELF).map((c) => c.id)).toEqual(['parent', 'blocks'])
    expect(treeColsOf(cols, ['别的.db'])).toEqual([]) // 负对照:selfPaths 不对 → 一列都不算自指
  })
  it('resolveTreeCol:列不在 / 不是自指列 / treeCol 缺 → null(静默回平铺,不报错)', () => {
    expect(resolveTreeCol(cols, 'parent', SELF)?.id).toBe('parent')
    expect(resolveTreeCol(cols, undefined, SELF)).toBe(null)
    expect(resolveTreeCol(cols, 'gone', SELF)).toBe(null)
    expect(resolveTreeCol(cols, 'other', SELF)).toBe(null) // 指向别的表
    expect(resolveTreeCol(cols, 'notrel', SELF)).toBe(null) // 改过类型
    expect(resolveTreeCol(cols, 'back', SELF)).toBe(null) // 反向 lookup 带 refDb,但不是 rowlink
  })
})
