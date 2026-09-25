import { describe, expect, it } from 'vitest'
import type { ThemeManifest } from '../theme/registry'
import { inferFont, inferShape } from './ThemeCard'

const m = (over: Omit<Partial<ThemeManifest>, 'preview'> & { preview?: Partial<ThemeManifest['preview']> }): ThemeManifest =>
  ({ id: 'x', name: 'X', version: '1', author: 'a', ...over, preview: { background: '#fff', accent: '#000', ...(over.preview || {}) } }) as ThemeManifest

// U-16:磁盘主题 manifest 常不写 preview.shape(kami、用户改过的 soft)—— 以前一律画成 paper,几张卡一模一样。
describe('ThemeCard preview inference', () => {
  it('显式 shape 优先', () => {
    expect(inferShape(m({ tags: ['soft'], preview: { shape: 'compact' } }))).toBe('compact')
  })
  it('soft 类:tags 或浮卡信号 panelGap>0', () => {
    expect(inferShape(m({ tags: ['lcl', 'soft', 'rounded'] }))).toBe('soft')
    expect(inferShape(m({ tags: ['custom'], panelGap: 8 }))).toBe('soft')
  })
  it('glass / compact 由 tags 推出;panelGap:0 不算浮卡', () => {
    expect(inferShape(m({ tags: ['glass'], panelGap: 0 }))).toBe('glass')
    expect(inferShape(m({ tags: ['compact'] }))).toBe('compact')
  })
  it('kami 类(paper + serif):结构 paper、字形衬线', () => {
    const kami = m({ tags: ['paper', 'serif'] })
    expect(inferShape(kami)).toBe('paper')
    expect(inferFont(kami)).toBe('serif')
  })
  it('Genesis 的 tags mono 指单色配色,不推成等宽;显式 font 优先', () => {
    expect(inferFont(m({ tags: ['lcl', 'paper', 'mono'] }))).toBe('sans')
    expect(inferFont(m({ tags: ['serif'], preview: { font: 'mono' } }))).toBe('mono')
  })
})
