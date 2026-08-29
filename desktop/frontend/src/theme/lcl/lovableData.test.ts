import { describe, expect, it } from 'vitest'
import { customAccentVars, customBgVars, customSkinVars } from './lovableData'

type RGB = [number, number, number]

function rgb(value: string): RGB {
  if (value.startsWith('#')) {
    const raw = value.slice(1)
    const hex = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB
  }
  const values = value.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (!values || values.length !== 3) throw new Error(`Unsupported color: ${value}`)
  return values as RGB
}

function luminance(color: RGB): number {
  const channel = (v: number): number => {
    const n = v / 255
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2])
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('customSkinVars — semantic contrast pairs', () => {
  const seeds = ['#8b7fd6', '#ffffff', '#000000', '#ff0000', '#00ff00']

  for (const dark of [false, true]) {
    for (const seed of seeds) {
      it(`${dark ? 'dark' : 'light'} ${seed} keeps accent text and both fill pairs at AA`, () => {
        const vars = customSkinVars(seed, dark)
        for (const surface of ['--bg', '--sidebar-bg', '--bg-card']) {
          expect(contrast(vars['--accent-ink'], vars[surface]), `${surface}`).toBeGreaterThanOrEqual(4.5)
        }
        expect(contrast(vars['--on-accent'], vars['--accent']), 'raw accent fill').toBeGreaterThanOrEqual(4.5)
        expect(contrast(vars['--on-accent'], vars['--accent-hover']), 'hover accent fill').toBeGreaterThanOrEqual(4.5)
        expect(contrast(vars['--on-accent-ink'], vars['--accent-ink']), 'readable accent fill').toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

describe('customSkinVars — independent background seed', () => {
  const backgrounds = ['#000000', '#ffffff', '#ff0000', '#00ffff', '#8b7fd6']

  for (const dark of [false, true]) {
    const faint = dark ? '#a39e98' : '#726c67'
    for (const background of backgrounds) {
      it(`${dark ? 'dark' : 'light'} ${background} stays in the selected mode's readable surface range`, () => {
        const vars = customSkinVars('#8b7fd6', dark, background)
        for (const surface of ['--bg', '--sidebar-bg', '--bg-card']) {
          expect(contrast(faint, vars[surface]), `${surface}`).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }

  it('显式暗色背景保留色温但不会把大面积舞台染成高彩度色块', () => {
    const [r, g, b] = rgb(customBgVars('#ff0000', true, true)['--bg'])
    const channelDelta = r - Math.max(g, b)
    expect(channelDelta).toBeGreaterThan(8)
    expect(channelDelta).toBeLessThan(24)
  })
})

describe('主题色 / 背景色两轴各管一半 token', () => {
  it('两轴的键互不相交,合起来正好等于旧的整套自定义配色', () => {
    const accent = Object.keys(customAccentVars('#3366ff', false))
    const bg = Object.keys(customBgVars('#f0eef8', false, true))
    expect(accent.filter((k) => bg.includes(k))).toEqual([])
    expect([...accent, ...bg].sort()).toEqual(Object.keys(customSkinVars('#3366ff', false, '#f0eef8')).sort())
  })

  it('换背景色不动 accent 家族,换主题色不动表面 —— 否则两轴又耦合回去了', () => {
    const a1 = customAccentVars('#3366ff', false)
    const a2 = customAccentVars('#3366ff', false)
    expect(a1).toEqual(a2)
    expect(customBgVars('#f0eef8', false, true)).not.toEqual(customBgVars('#e8f5ee', false, true))
    expect(customAccentVars('#3366ff', false)).not.toEqual(customAccentVars('#ff6633', false))
  })

  it('自定义主题色在任何背景预设上都保 AA:按最不利表面取 ink', () => {
    // 预设里最暗的浅色面(薰衣草侧栏)与最亮的暗色面 —— 全部背景选项都不会比它们更难读。
    for (const [seed, dark, surface] of [['#ffd166', false, '#e5d5ef'], ['#1b3a6b', true, '#363639']] as const) {
      expect(contrast(customAccentVars(seed, dark)['--accent-ink'], surface)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
