/** formLogic.ts 纯逻辑:字段集剔除隐藏/计算/盖章列;必填只认字段集内的列;清洗剥域外键与空值。 */
import { describe, expect, it } from 'vitest'
import type { DbColumn } from '@amadeus-shared/db/schema'
import { cleanDraft, formDefaults, formFields, isBlank, missingRequired } from './formLogic'

const COLS: DbColumn[] = [
  { id: 'cust', name: '客户', type: 'text' },
  { id: 'no', name: '订单号', type: 'autonumber', prefix: 'ORD-' },
  { id: 'status', name: '状态', type: 'select', options: ['未确认', '已确认'] },
  { id: 'created', name: '创建', type: 'created' },
  { id: 'ship', name: '运费', type: 'number' },
  { id: 'cpu', name: 'CPU', type: 'rowlink', refDb: '库存.db' },
  { id: 'price', name: '单价', type: 'lookup', lookupRel: 'cpu', lookupCol: 'p' },
  { id: 'total', name: '总计', type: 'formula', formula: '{运费}+1' },
  { id: 'agree', name: '同意', type: 'checkbox' },
]

describe('formFields', () => {
  it('字段集 = 列序 − hidden − 计算列 − 盖章列', () => {
    expect(formFields(COLS, {}).map((c) => c.id)).toEqual(['cust', 'status', 'ship', 'cpu', 'agree'])
    expect(formFields(COLS, { hidden: ['ship', 'cpu'] }).map((c) => c.id)).toEqual(['cust', 'status', 'agree'])
  })
  it('负对照:把盖章/计算列改成普通类型后它们就回到字段集(证明剔除是按类型判的,不是按名)', () => {
    const plain = COLS.map((c) => ({ ...c, type: 'text' }))
    expect(formFields(plain, {}).length).toBe(COLS.length)
  })
})

describe('isBlank', () => {
  it('缺/null/空串/全空白/空数组/false 算空;0、非空串、true、非空数组不算', () => {
    for (const v of [undefined, null, '', '   ', [], false]) expect(isBlank(v)).toBe(true)
    for (const v of [0, 'x', true, ['a'], -1]) expect(isBlank(v)).toBe(false)
  })
})

describe('missingRequired', () => {
  const fields = formFields(COLS, { hidden: ['ship'] })
  it('必填为空 → 返回该字段;填了 → 空', () => {
    expect(missingRequired(fields, ['cust', 'status'], { status: '未确认' }).map((c) => c.id)).toEqual(['cust'])
    expect(missingRequired(fields, ['cust', 'status'], { cust: ' 张三 ', status: '未确认' })).toEqual([])
  })
  it('全空白串视为未填', () => {
    expect(missingRequired(fields, ['cust'], { cust: '   ' }).map((c) => c.id)).toEqual(['cust'])
  })
  it('required 指向隐藏列 / 盖章列 / 计算列 / 不存在的列 → 忽略,不会把表单卡死', () => {
    expect(missingRequired(fields, ['ship', 'no', 'total', 'ghost'], {})).toEqual([])
  })
  it('required 缺/空 → 永不拦', () => {
    expect(missingRequired(fields, undefined, {})).toEqual([])
    expect(missingRequired(fields, [], {})).toEqual([])
  })
})

describe('cleanDraft / formDefaults', () => {
  const fields = formFields(COLS, {})
  it('只保留字段集里的键,剥 undefined/null;0 与 false 保留', () => {
    expect(cleanDraft({ cust: '张三', ship: 0, agree: false, status: undefined, cpu: null }, fields)).toEqual({ cust: '张三', ship: 0, agree: false })
  })
  it('defaults 混进盖章列 / 计算列 / 未知键 → 全部剥掉(否则计算列键落盘破「计算列不落盘」)', () => {
    expect(formDefaults({ form: { defaults: { status: '未确认', no: 999, total: 1, price: 2, created: '2026-01-01T00:00', ghost: 'x' } } }, fields)).toEqual({ status: '未确认' })
  })
  it('负对照:字段集若不剔除计算列,计算列默认值就会漏进草稿(证明剥的依据是字段集)', () => {
    const noFilter = COLS // 直接把全列当字段集
    expect(formDefaults({ form: { defaults: { total: 1 } } }, noFilter)).toEqual({ total: 1 })
  })
  it('form 缺 → 空草稿', () => {
    expect(formDefaults({}, fields)).toEqual({})
  })
})
