import { describe, expect, it } from 'vitest'
import { FormulaError, computeLookup, evalFormula, evalRowFormulas } from './formula'
import type { CellValue, DbColumn } from './schema'

const get = (cells: Record<string, CellValue>) => (name: string): CellValue => {
  if (!(name in cells)) throw new FormulaError(`未知列 {${name}}`)
  return cells[name]
}

describe('evalFormula', () => {
  it('算术与优先级', () => {
    expect(evalFormula('1+2*3', get({}))).toBe(7)
    expect(evalFormula('(1+2)*3', get({}))).toBe(9)
    expect(evalFormula('10%3', get({}))).toBe(1)
    expect(evalFormula('-2*3', get({}))).toBe(-6)
  })
  it('列引用:{名} 与裸单词', () => {
    const g = get({ 价格: 10, 数量: 3 })
    expect(evalFormula('{价格}*{数量}', g)).toBe(30)
    expect(evalFormula('价格*数量', g)).toBe(30)
  })
  it('空单元格按 0 参与算术、按空串参与拼接(飞书口径)', () => {
    const g = get({ a: null, b: 5, s: null })
    expect(evalFormula('{a}+{b}', g)).toBe(5)
    expect(evalFormula('{a}*{b}', g)).toBe(0)
    expect(evalFormula('"x"+{s}', g)).toBe('x')
  })
  it('+ 的双语义:双数值系加法,含字符串则拼接', () => {
    expect(evalFormula('1+2', get({}))).toBe(3)
    expect(evalFormula('"a"+"b"', get({}))).toBe('ab')
    expect(evalFormula('{t}+1', get({ t: 'v' }))).toBe('v1')
  })
  it('比较与逻辑', () => {
    expect(evalFormula('2>1 && 1==1', get({}))).toBe(true)
    expect(evalFormula('2<1 || "a"=="b"', get({}))).toBe(false)
    expect(evalFormula('!false', get({}))).toBe(true)
    expect(evalFormula('"b">"a"', get({}))).toBe(true)
  })
  it('函数族', () => {
    expect(evalFormula('if(2>1,"高","低")', get({}))).toBe('高')
    expect(evalFormula('round(3.14159, 2)', get({}))).toBe(3.14)
    expect(evalFormula('min(3,1,2)', get({}))).toBe(1)
    expect(evalFormula('max(3,1,2)', get({}))).toBe(3)
    expect(evalFormula('len("abc")', get({}))).toBe(3)
    expect(evalFormula('len({tags})', get({ tags: ['a', 'b'] }))).toBe(2)
    expect(evalFormula('upper("ab")+lower("CD")', get({}))).toBe('ABcd')
    expect(evalFormula('contains("hello","ell")', get({}))).toBe(true)
    expect(evalFormula('replace("a-b-c","-","+")', get({}))).toBe('a+b+c')
    expect(evalFormula('concat("a",1,true)', get({}))).toBe('a1true')
    expect(evalFormula('empty({x})', get({ x: null }))).toBe(true)
    expect(evalFormula('number("12")+1', get({}))).toBe(13)
    expect(evalFormula('text(12)+"!"', get({}))).toBe('12!')
  })
  it('日期:today 注入 + days 差值(calendarDate 区间取 start)', () => {
    const opts = { today: '2026-09-01' }
    expect(evalFormula('today()', get({}), opts)).toBe('2026-09-01')
    expect(evalFormula('days({due}, today())', get({ due: '2026-09-04' }), opts)).toBe(3)
    expect(evalFormula('days({due}, today())', get({ due: '2026-08-30T10:00/2026-08-31' }), opts)).toBe(-2)
  })
  it('错误:语法/未知列/未知函数/除零/非数字算术', () => {
    expect(() => evalFormula('1+', get({}))).toThrow(FormulaError)
    expect(() => evalFormula('{没有}', get({}))).toThrow('未知列')
    expect(() => evalFormula('nope(1)', get({}))).toThrow('未知函数')
    expect(() => evalFormula('1/0', get({}))).toThrow('除以 0')
    expect(() => evalFormula('1%0', get({}))).toThrow('除以 0') // NaN 会让 == 悄悄判相等,必须拒
    expect(() => evalFormula('{t}*2', get({ t: 'abc' }))).toThrow('不是数字')
    expect(() => evalFormula('{名', get({}))).toThrow('未闭合')
  })
})

describe('evalRowFormulas', () => {
  const cols = (defs: Array<Partial<DbColumn> & { id: string }>): DbColumn[] =>
    defs.map((d) => ({ name: d.id, type: 'text', ...d }) as DbColumn)

  it('按列名解析引用;错误折算 #错误 不连坐', () => {
    const columns = cols([
      { id: 'c1', name: '单价', type: 'number' },
      { id: 'c2', name: '数量', type: 'number' },
      { id: 'f1', name: '小计', type: 'formula', formula: '{单价}*{数量}' },
      { id: 'f2', name: '坏的', type: 'formula', formula: '{不存在}+1' },
    ])
    const out = evalRowFormulas(columns, { c1: 4, c2: 5 })
    expect(out.f1).toBe(20)
    expect(out.f2).toBe('#错误')
  })
  it('公式引用公式(递归);循环引用 → #循环', () => {
    const chain = cols([
      { id: 'n', name: '基数', type: 'number' },
      { id: 'a', name: '倍', type: 'formula', formula: '{基数}*2' },
      { id: 'b', name: '再倍', type: 'formula', formula: '{倍}*2' },
    ])
    expect(evalRowFormulas(chain, { n: 3 })).toEqual({ a: 6, b: 12 })
    const cyc = cols([
      { id: 'a', name: 'A', type: 'formula', formula: '{B}+1' },
      { id: 'b', name: 'B', type: 'formula', formula: '{A}+1' },
    ])
    const out = evalRowFormulas(cyc, {})
    expect(out.a).toBe('#循环')
    expect(out.b).toBe('#循环')
  })
  it('空表达式 → null;非公式列不出现在结果里', () => {
    const columns = cols([
      { id: 't', name: '文本' },
      { id: 'f', name: '空公式', type: 'formula', formula: '' },
    ])
    const out = evalRowFormulas(columns, { t: 'x' })
    expect(out).toEqual({ f: null })
  })
})

describe('computeLookup', () => {
  it('first/count/sum/avg/join;空值剔除', () => {
    const vs: CellValue[] = ['a', null, 'b', '']
    expect(computeLookup(vs, undefined)).toBe('a')
    expect(computeLookup(vs, 'count')).toBe(2)
    expect(computeLookup(vs, 'join')).toBe('a、b')
    expect(computeLookup([1, 2, null, 3], 'sum')).toBe(6)
    expect(computeLookup([1, 2, 3], 'avg')).toBe(2)
    expect(computeLookup([], 'avg')).toBe(null)
    expect(computeLookup([], undefined)).toBe(null)
  })
})
