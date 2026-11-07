// 渲染层报来的外观(给 Forsion Clip 跟随):只收命名过的颜色 id 与 light / dark,其余丢弃。
import { describe, expect, it } from 'vitest'
import { normalizeUiAppearance } from './uiSync'

describe('normalizeUiAppearance', () => {
  it('收命名颜色与明暗', () => {
    expect(normalizeUiAppearance({ skin: 'sage', bg: 'cream', mode: 'dark' })).toEqual({ skin: 'sage', bg: 'cream', mode: 'dark' })
  })
  it('自定义色、怪 id、怪明暗、非对象一律 null', () => {
    expect(normalizeUiAppearance({ skin: 'custom', bg: 'ink', mode: 'light' })).toBeNull()
    expect(normalizeUiAppearance({ skin: 'Sage', bg: 'ink', mode: 'light' })).toBeNull()
    expect(normalizeUiAppearance({ skin: 'ink', bg: 'ink;color:red', mode: 'light' })).toBeNull()
    expect(normalizeUiAppearance({ skin: 'ink', bg: 'ink', mode: 'dim' })).toBeNull()
    expect(normalizeUiAppearance('ink')).toBeNull()
    expect(normalizeUiAppearance(null)).toBeNull()
  })
})
