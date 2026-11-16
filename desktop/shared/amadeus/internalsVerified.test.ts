// manifest internalsVerified 的清洗(2026-11-16):只比到次版本,只用于标注。
import { describe, expect, it } from 'vitest'
import { PLUGIN_CAPABILITIES, sanitizeInternalsVerified } from './ipc'

describe('sanitizeInternalsVerified', () => {
  it('收字符串或数组,归一到 主.次、去重', () => {
    expect(sanitizeInternalsVerified('2.14.2')).toEqual(['2.14'])
    expect(sanitizeInternalsVerified(['2.14', '2.14.3', ' 2.15 ', '02.016'])).toEqual(['2.14', '2.15', '2.16'])
  })
  it('不认识的静默丢,全丢光给 undefined', () => {
    expect(sanitizeInternalsVerified(['latest', 2.14, '2', '2.x', null])).toBeUndefined()
    expect(sanitizeInternalsVerified({ v: '2.14' })).toBeUndefined()
  })
  it('最多 8 项', () => {
    expect(sanitizeInternalsVerified(Array.from({ length: 20 }, (_, i) => `2.${i}`))).toHaveLength(8)
  })
  it('两级能力在白名单里', () => {
    expect(PLUGIN_CAPABILITIES).toEqual(expect.arrayContaining(['internals', 'internals-raw']))
  })
})
