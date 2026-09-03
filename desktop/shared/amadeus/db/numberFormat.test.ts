import { describe, expect, it } from 'vitest'
import { clampPrecision, formatNumber, hasNumberFormat } from './numberFormat'

describe('hasNumberFormat(opt-in 判据)', () => {
  it('三个字段一个没配 = 没配;空串前后缀也算没配', () => {
    expect(hasNumberFormat(undefined)).toBe(false)
    expect(hasNumberFormat({})).toBe(false)
    expect(hasNumberFormat({ unitPrefix: '', unitSuffix: '' })).toBe(false)
    expect(hasNumberFormat({ precision: 0 })).toBe(true) // 0 是有效小数位,不是「没配」
    expect(hasNumberFormat({ unitPrefix: '¥' })).toBe(true)
    expect(hasNumberFormat({ unitSuffix: '%' })).toBe(true)
  })
})

describe('formatNumber', () => {
  it('没配格式 → 与 String(n) 逐字相同(既有列的观感/仪器不许被动过)', () => {
    for (const n of [0, 1500, 112000, -7, 1.23456, 1e21]) {
      expect(formatNumber(n)).toBe(String(n))
      expect(formatNumber(n, {})).toBe(String(n))
    }
  })

  it('前缀 + 后缀 + 千分位', () => {
    expect(formatNumber(1234, { precision: 2, unitPrefix: '¥' })).toBe('¥1,234.00')
    expect(formatNumber(1500, { precision: 2, unitPrefix: '¥', unitSuffix: '元' })).toBe('¥1,500.00元')
    expect(formatNumber(3, { unitSuffix: '台' })).toBe('3台')
    expect(formatNumber(0.5, { unitSuffix: '%' })).toBe('0.5%')
  })

  it('precision=0 → 无小数点(不是「不格式化」)', () => {
    expect(formatNumber(1234.6, { precision: 0 })).toBe('1,235')
    expect(formatNumber(1234, { precision: 0, unitSuffix: '台' })).toBe('1,234台')
  })

  it('只配单位、不配 precision → 保留原有小数位,不被 Intl 默认的 3 位截断', () => {
    expect(formatNumber(1.23456, { unitPrefix: '¥' })).toBe('¥1.23456')
    expect(formatNumber(0.000001, { unitSuffix: '%' })).toBe('0.000001%')
  })

  it('负数:负号在最外层(-¥1,234.00元)', () => {
    expect(formatNumber(-1234, { precision: 2, unitPrefix: '¥', unitSuffix: '元' })).toBe('-¥1,234.00元')
    expect(formatNumber(-7, { precision: 0 })).toBe('-7')
  })

  it('0 与「四舍五入到 0」不带负号(不出 -0.00)', () => {
    expect(formatNumber(0, { precision: 2, unitPrefix: '¥' })).toBe('¥0.00')
    expect(formatNumber(-0.001, { precision: 2 })).toBe('0.00')
    expect(formatNumber(-0, { precision: 2 })).toBe('0.00')
    expect(formatNumber(-0.5, { precision: 0 })).toBe('-1') // 真的进到 1 了,负号要在
  })

  it('四舍五入边界(用二进制精确值,别拿 1.005 这种自带浮点噪音的做断言)', () => {
    expect(formatNumber(0.5, { precision: 0 })).toBe('1')
    expect(formatNumber(1.5, { precision: 0 })).toBe('2')
    expect(formatNumber(2.5, { precision: 0 })).toBe('3') // 半数远离零,不是银行家舍入
    expect(formatNumber(1.25, { precision: 1 })).toBe('1.3')
    expect(formatNumber(2.125, { precision: 2 })).toBe('2.13')
    expect(formatNumber(-2.5, { precision: 0 })).toBe('-3')
  })

  it('空值 → 空串(绝不显示成 ¥0.00:那是把「没填」和「填了 0」混成一个)', () => {
    expect(formatNumber(null, { precision: 2, unitPrefix: '¥' })).toBe('')
    expect(formatNumber(undefined, { precision: 2, unitPrefix: '¥' })).toBe('')
    expect(formatNumber('', { precision: 2, unitPrefix: '¥' })).toBe('')
  })

  it('非数字原样(列类型切换非破坏:格式化不吃旧数据)', () => {
    expect(formatNumber('abc', { precision: 2, unitPrefix: '¥' })).toBe('abc')
    expect(formatNumber('12,00', { precision: 2 })).toBe('12,00')
    expect(formatNumber(true, { precision: 2 })).toBe('true')
    expect(formatNumber(['a', 'b'], { precision: 2 })).toBe('a, b')
    expect(formatNumber(Number.NaN, { precision: 2 })).toBe('NaN')
    expect(formatNumber(Number.POSITIVE_INFINITY, { precision: 2 })).toBe('Infinity')
  })

  it('precision 越界被夹住(坏配置不该崩 Intl)', () => {
    expect(clampPrecision(-3)).toBe(0)
    expect(clampPrecision(99)).toBe(6)
    expect(clampPrecision(2.7)).toBe(2)
    expect(clampPrecision(undefined)).toBe(undefined)
    expect(clampPrecision(Number.NaN)).toBe(undefined)
    expect(formatNumber(1.23456789, { precision: 99 })).toBe('1.234568')
    expect(formatNumber(1.5, { precision: -3 })).toBe('2')
  })
})
