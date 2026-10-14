import { afterEach, describe, expect, it, vi } from 'vitest'

const load = async (linear: boolean, reduced = false) => {
  vi.resetModules()
  vi.stubGlobal('CSS', { supports: () => linear })
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce') }))
  return import('./spring')
}
afterEach(() => vi.unstubAllGlobals())

describe('spring', () => {
  it('starts at 0 and ends at 1; a release with speed is further along early than one from rest', async () => {
    const { springAt, SPRING_PAGE } = await load(true)
    expect(springAt(0, 0, SPRING_PAGE)).toBeCloseTo(0, 6)
    expect(springAt(1.2, 0, SPRING_PAGE)).toBeCloseTo(1, 2)
    expect(springAt(0.05, 8, SPRING_PAGE)).toBeGreaterThan(springAt(0.05, 0, SPRING_PAGE) + 0.15)
  })
  it('a page spring released from rest never passes the end; a row spring does, once, a little', async () => {
    const { springAt, SPRING_PAGE, SPRING_ROW } = await load(true)
    const ts = Array.from({ length: 70 }, (_, i) => i / 60)
    expect(Math.max(...ts.map((t) => springAt(t, 0, SPRING_PAGE)))).toBeLessThanOrEqual(1)
    const peak = Math.max(...ts.map((t) => springAt(t, 0, SPRING_ROW)))
    expect(peak).toBeGreaterThan(1.01)
    expect(peak).toBeLessThan(1.1)
  })
  it('a fast release toward the end gets there sooner; clamp stops it there', async () => {
    const { springEasing, SPRING_PAGE } = await load(true)
    const rest = springEasing(0, SPRING_PAGE, { clamp: true })!
    const flick = springEasing(12, SPRING_PAGE, { clamp: true })!
    expect(flick.ms).toBeLessThan(rest.ms)
    expect(rest.easing).toMatch(/^linear\(0, [\d., ]+, 1\)$/)
    const pts = flick.easing.slice(7, -1).split(', ').map(Number)
    expect(Math.max(...pts)).toBe(1)
    expect(pts.at(-1)).toBe(1)
  })
  it('clamped: a release moving away from the end does not swing back behind its start', async () => {
    const { springEasing, SPRING_PAGE } = await load(true)
    const pts = springEasing(-6, SPRING_PAGE, { clamp: true })!.easing.slice(7, -1).split(', ').map(Number)
    expect(Math.min(...pts)).toBe(0)
  })
  it('give: a flick past the end swings no further than the wall, and an absurd speed does not fly off', async () => {
    const { springEasing, SPRING_ROW } = await load(true)
    for (const v0 of [3, 40, 1e9]) {
      const pts = springEasing(v0, SPRING_ROW, { give: 0.1 })!.easing.slice(7, -1).split(', ').map(Number)
      expect(Math.max(...pts)).toBeLessThanOrEqual(1.1)
      expect(Math.max(...pts)).toBeGreaterThan(1) // still a bounce
      expect(pts.at(-1)).toBe(1)
    }
  })
  it('no linear() or reduced motion: null, the caller keeps its own curve', async () => {
    expect((await load(false)).springEasing(0, { response: 0.4, damping: 1 })).toBeNull()
    expect((await load(true, true)).springEasing(0, { response: 0.4, damping: 1 })).toBeNull()
  })
})
