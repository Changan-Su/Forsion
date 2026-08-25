import { describe, expect, it } from 'vitest'
import { customSkinVars } from './lovableData'

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
})
