// 导出 CSV 的展平口径(渲染层):可见列 × 已筛选行 → 字符串矩阵。转义/注入防护在 shared/db/csv.test.ts。
import { describe, expect, it } from 'vitest'
import type { DbColumn, DbFile, DbRow } from '@amadeus-shared/db/schema'
import { buildDbCsv, csvCellText, csvFileName, csvMatrix } from './csvExport'
import './propertyTypes.builtins' // side-effect:注册 autonumber / created / calendarDate…(resolveBaseType 要认)

const TARGET: DbFile = {
  version: 1,
  name: '库存表',
  columns: [
    { id: 's_name', name: '货物名称', type: 'text' },
    { id: 's_sku', name: '编号', type: 'autonumber', prefix: 'SKU-' },
  ],
  rows: [
    { id: 's01', cells: { s_name: 'Intel i5', s_sku: 1 } },
    { id: 's02', cells: { s_name: 'RTX 4060', s_sku: 2 } },
  ],
}
const ctx = { targetDb: (p: string): DbFile | null => (p === '库存表.db' ? TARGET : null) }

const col = (c: DbColumn): DbColumn => c
const row = (cells: Record<string, unknown>): DbRow => ({ id: 'r1', cells: cells as DbRow['cells'] })

describe('csvCellText 单格展平口径', () => {
  it('数字列:配了格式就带格式(所见即所得);没配 = 原样 String(n)', () => {
    const plain = col({ id: 'n', name: '运费', type: 'number' })
    const fmt = col({ id: 'n', name: '运费', type: 'number', precision: 2, unitPrefix: '¥', unitSuffix: '元' })
    expect(csvCellText(row({ n: 1500 }), plain, ctx)).toBe('1500')
    expect(csvCellText(row({ n: 1500 }), fmt, ctx)).toBe('¥1,500.00元')
    expect(csvCellText(row({}), fmt, ctx)).toBe('') // 空值不写成 ¥0.00元
  })

  it('计算列(公式/引用)取物化后的显示值,数字同样照列配置格式化', () => {
    const f = col({ id: 'f', name: '总计', type: 'formula', formula: 'x', precision: 2, unitPrefix: '¥' })
    expect(csvCellText(row({ f: 125196 }), f, ctx)).toBe('¥125,196.00')
    const lk = col({ id: 'l', name: '出库行', type: 'lookup' })
    expect(csvCellText(row({ l: '张三-CPU、李四-内存' }), lk, ctx)).toBe('张三-CPU、李四-内存')
    expect(csvCellText(row({ l: ['a', 'b'] }), lk, ctx)).toBe('a, b') // 多值 lookup 展平
    expect(csvCellText(row({}), lk, ctx)).toBe('')
    expect(csvCellText(row({ l: '#错误' }), lk, ctx)).toBe('#错误') // 哨兵原样,不美化成空
  })

  it('关联列:取目标行的芯片文案(titleCol),不是行 id;多值展平', () => {
    const single = col({ id: 'r', name: '配件', type: 'rowlink', refDb: '库存表.db' })
    const multi = col({ id: 'r', name: '配件', type: 'rowlink', refDb: '库存表.db', multiple: true })
    const byNo = col({ id: 'r', name: '配件', type: 'rowlink', refDb: '库存表.db', titleCol: 's_sku' })
    expect(csvCellText(row({ r: 's01' }), single, ctx)).toBe('Intel i5')
    expect(csvCellText(row({ r: ['s01', 's02'] }), multi, ctx)).toBe('Intel i5, RTX 4060')
    expect(csvCellText(row({ r: 's02' }), byNo, ctx)).toBe('SKU-2') // titleCol 指自动编号 → 带前缀
    expect(csvCellText(row({}), single, ctx)).toBe('')
  })

  it('关联列:目标库没加载 / 行已删 → 退回行 id(不是空格子,导出得看得出「有东西但解析不了」)', () => {
    const gone = col({ id: 'r', name: '配件', type: 'rowlink', refDb: '不存在.db' })
    expect(csvCellText(row({ r: 's01' }), gone, ctx)).toBe('s01')
    const dead = col({ id: 'r', name: '配件', type: 'rowlink', refDb: '库存表.db' })
    expect(csvCellText(row({ r: 's99' }), dead, ctx)).toBe('s99')
  })

  it('可编辑投影列(lookupKind=links)按关联列展平,不是按 lookup 文本', () => {
    const proj = col({ id: 'p', name: '出库(投影)', type: 'lookup', refDb: '库存表.db', lookupBackCol: 'x', lookupKind: 'links' })
    expect(csvCellText(row({ p: ['s01', 's02'] }), proj, ctx)).toBe('Intel i5, RTX 4060')
  })

  it('附件列:两形态都展平(旧单值 / 新多值)', () => {
    const f = col({ id: 'a', name: '附件', type: 'file' })
    expect(csvCellText(row({ a: '.amadeus/a.png' }), f, ctx)).toBe('.amadeus/a.png')
    expect(csvCellText(row({ a: ['.amadeus/a.png', '.amadeus/b.pdf'] }), f, ctx)).toBe('.amadeus/a.png, .amadeus/b.pdf')
    expect(csvCellText(row({}), f, ctx)).toBe('')
  })

  it('勾选 → TRUE/FALSE(可再导入回来);多选 → 逗号展平;自动编号带前缀;created 的 T 换空格', () => {
    expect(csvCellText(row({ c: true }), col({ id: 'c', name: '完成', type: 'checkbox' }), ctx)).toBe('TRUE')
    expect(csvCellText(row({}), col({ id: 'c', name: '完成', type: 'checkbox' }), ctx)).toBe('FALSE')
    expect(csvCellText(row({ m: ['红', '蓝'] }), col({ id: 'm', name: '标签', type: 'multiselect' }), ctx)).toBe('红, 蓝')
    expect(csvCellText(row({ a: 12 }), col({ id: 'a', name: '订单号', type: 'autonumber', prefix: 'ORD-' }), ctx)).toBe('ORD-12')
    expect(csvCellText(row({ t: '2026-03-15T09:31' }), col({ id: 't', name: '创建', type: 'created' }), ctx)).toBe('2026-03-15 09:31')
    expect(csvCellText(row({ t: '2026-03-15T09:31' }), col({ id: 't', name: '修改', type: 'updated' }), ctx)).toBe('2026-03-15 09:31')
  })

  it('插件注册的自定义类型走 baseType(todo=checkbox / calendarDate=text),未知类型回退文本', () => {
    expect(csvCellText(row({ d: true }), col({ id: 'd', name: '待办', type: 'todo' }), ctx)).toBe('TRUE')
    expect(csvCellText(row({ d: '2026-09-02T10:00/2026-09-02T11:00' }), col({ id: 'd', name: '日期', type: 'calendarDate' }), ctx))
      .toBe('2026-09-02T10:00/2026-09-02T11:00')
    expect(csvCellText(row({ z: 'x' }), col({ id: 'z', name: '第三方', type: 'nobody-knows' }), ctx)).toBe('x')
  })
})

describe('csvMatrix / buildDbCsv', () => {
  const cols: DbColumn[] = [
    { id: 'c1', name: '客户', type: 'text' },
    { id: 'c2', name: '金额', type: 'number', precision: 2, unitPrefix: '¥' },
    { id: 'c3', name: '备注', type: 'text' },
  ]
  const rows: DbRow[] = [
    { id: 'r1', cells: { c1: '张三', c2: 1234, c3: 'a,b' } },
    { id: 'r2', cells: { c1: '=1+1', c2: -50, c3: '第一行\n第二行' } },
  ]

  it('首行 = 列名;只导给进来的列与行(可见列 × 已筛选行由调用方定)', () => {
    expect(csvMatrix(cols, rows, ctx)).toEqual([
      ['客户', '金额', '备注'],
      ['张三', '¥1,234.00', 'a,b'],
      ['=1+1', '-¥50.00', '第一行\n第二行'],
    ])
    expect(csvMatrix(cols, [], ctx)).toEqual([['客户', '金额', '备注']]) // 空表也出表头
  })

  it('整份 CSV:注入防护 + 引号 + 换行 + 中文一起过', () => {
    expect(buildDbCsv(cols, rows, ctx)).toBe(
      '客户,金额,备注\r\n' +
      '张三,"¥1,234.00","a,b"\r\n' +
      // -¥50.00 没有千分位逗号 → 不必加引号;货币符号让它豁免注入防护(不加 ')
      "'=1+1,-¥50.00,\"第一行\n第二行\"\r\n",
    )
  })

  it('只导可见列:调用方传裁剪过的列集,输出跟着少一列', () => {
    expect(csvMatrix([cols[0]], rows, ctx)).toEqual([['客户'], ['张三'], ['=1+1']])
  })
})

describe('csvFileName', () => {
  it('剥掉路径与保留字符;空名兜底', () => {
    expect(csvFileName('订单总表')).toBe('订单总表')
    expect(csvFileName('a/b:c*d')).toBe('a b c d')
    expect(csvFileName('')).toBe('database')
    expect(csvFileName('///')).toBe('database')
  })
})
