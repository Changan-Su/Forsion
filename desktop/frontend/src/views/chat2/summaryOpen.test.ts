import { describe, expect, it } from 'vitest'
import { fitCards, MIN_BODY, openOf, stepOpen, type CardSig, type FitCard } from './summaryOpen'

const sig = (id: string, count: number, dflt = false, live?: boolean): CardSig => ({ id, count, dflt, live })

describe('stepOpen', () => {
  it('first sight of a session uses steady-state defaults, not "new content"', () => {
    const s = stepOpen(undefined, [sig('progress', 3, true), sig('sources', 4), sig('scope', 1)], false)
    expect(openOf(s, 'progress', false)).toBe(true)
    expect(openOf(s, 'sources', true)).toBe(false)
    expect(openOf(s, 'scope', true)).toBe(false)
  })

  it('growth opens a card; a card that appears with content opens', () => {
    let s = stepOpen(undefined, [sig('scope', 1)], true)
    s = stepOpen(s, [sig('scope', 1), sig('sources', 2)], true)
    expect(openOf(s, 'sources', false)).toBe(true)
    s = stepOpen(s, [sig('scope', 2), sig('sources', 2)], true)
    expect(openOf(s, 'scope', false)).toBe(true)
  })

  it('a card that appears while idle (history / cwd still loading) uses its default, not "new content"', () => {
    let s = stepOpen(undefined, [], false)
    s = stepOpen(s, [sig('scope', 1), sig('sources', 3), sig('outputs', 2, true)], false)
    expect(['scope', 'sources', 'outputs'].map((id) => openOf(s, id, true))).toEqual([false, false, true])
    s = stepOpen(s, [sig('scope', 2), sig('sources', 3), sig('outputs', 2, true)], false) // 加了个工作文件夹:没在跑也算新东西
    expect(openOf(s, 'scope', false)).toBe(true)
  })

  it('sources close when the run ends even if their count changed on that same step', () => {
    let s = stepOpen(undefined, [], false)
    s = stepOpen(s, [sig('sources', 1)], true)
    s = stepOpen(s, [sig('sources', 2)], false)
    expect(openOf(s, 'sources', true)).toBe(false)
  })

  it('a plugin card that appears with no count follows defaultCollapsed; a later count bump opens it', () => {
    let s = stepOpen(undefined, [sig('scope', 1)], false)
    s = stepOpen(s, [sig('scope', 1), sig('plugin:x', 0, false)], false)
    expect(openOf(s, 'plugin:x', true)).toBe(false)
    s = stepOpen(s, [sig('scope', 1), sig('plugin:x', 2, false)], false)
    expect(openOf(s, 'plugin:x', false)).toBe(true)
  })

  it('a user collapse holds for the rest of the run and resets when the next run starts', () => {
    let s = stepOpen(undefined, [], false)
    s = stepOpen(s, [sig('sources', 1)], true)
    s = { ...s, user: { sources: false } }
    s = stepOpen(s, [sig('sources', 3)], true)
    expect(openOf(s, 'sources', true)).toBe(false)
    s = stepOpen(s, [sig('sources', 3)], false) // 跑完
    s = stepOpen(s, [sig('sources', 4)], true) // 下一轮开跑 + 新来源
    expect(s.user).toEqual({})
    expect(openOf(s, 'sources', false)).toBe(true)
  })

  it('background closes when nothing is live; sources close when the run ends; outputs and progress stay', () => {
    let s = stepOpen(undefined, [], false)
    s = stepOpen(s, [sig('progress', 2, true), sig('bg', 1, false, true), sig('outputs', 1, true), sig('sources', 2)], true)
    expect(['progress', 'bg', 'outputs', 'sources'].map((id) => openOf(s, id, false))).toEqual([true, true, true, true])
    s = stepOpen(s, [sig('progress', 2, true), sig('bg', 1, false, false), sig('outputs', 1, true), sig('sources', 2)], false)
    expect(['progress', 'bg', 'outputs', 'sources'].map((id) => openOf(s, id, false))).toEqual([true, false, true, false])
  })

  it('progress opens again when a run starts even if its count did not change', () => {
    let s = stepOpen(undefined, [sig('progress', 2, true)], false)
    s = { ...s, auto: { progress: false } }
    s = stepOpen(s, [sig('progress', 2, true)], true)
    expect(openOf(s, 'progress', false)).toBe(true)
  })

  it('a card that disappears and comes back counts as new', () => {
    let s = stepOpen(undefined, [sig('outputs', 1, true)], true)
    s = { ...s, auto: { outputs: false } }
    s = stepOpen(s, [], true)
    s = stepOpen(s, [sig('outputs', 1, true)], true)
    expect(openOf(s, 'outputs', false)).toBe(true)
  })

  it('newest growth gets the highest tick', () => {
    let s = stepOpen(undefined, [], true)
    s = stepOpen(s, [sig('sources', 1)], true)
    s = stepOpen(s, [sig('sources', 1), sig('outputs', 1)], true)
    expect(s.last.outputs).toBeGreaterThan(s.last.sources)
  })
})

const card = (id: string, open: boolean, last: number, body: number, squeezable = true): FitCard => ({ id, open, squeezable, last, head: 47, body })

describe('fitCards', () => {
  it('fits → nothing changes', () => {
    expect(fitCards([card('progress', true, 0, 100, false), card('sources', true, 1, 100)], 600)).toEqual({ squeezed: [], cap: {} })
  })

  it('squeezes the auto-opened card that has been quiet longest, never progress', () => {
    const r = fitCards([card('progress', true, 9, 200, false), card('bg', true, 1, 120), card('outputs', true, 3, 200), card('sources', true, 5, 200)], 600)
    expect(r.squeezed).toEqual(['bg', 'outputs'])
  })

  it('keeps the newest open and shrinks its own body (not 240) by the overflow', () => {
    // progress 47+226,sources 47+140,另两张收着 47×2,间隔 30 → 584;车道 560 → 超 24
    const r = fitCards([card('progress', true, 0, 226, false), card('sources', true, 2, 140), card('bg', false, 0, 0), card('scope', false, 0, 0)], 560)
    expect(r.squeezed).toEqual([])
    expect(r.cap).toEqual({ sources: 140 - 24 })
  })

  it('the body cap never goes below MIN_BODY', () => {
    const r = fitCards([card('progress', true, 0, 400, false), card('sources', true, 2, 200)], 500)
    expect(r.cap.sources).toBe(MIN_BODY)
  })

  it('the newest card stays open (capped) even if it was squeezed last time', () => {
    // 来源上次被收、这次刚来了新东西(last 最大):其余都收了还放不下,也得留它开着缩正文
    const r = fitCards([card('progress', true, 0, 300, false), card('outputs', true, 1, 140), card('sources', true, 9, 140)], 450, 10, ['sources'])
    expect(r.squeezed).toEqual(['outputs'])
    expect(r.cap.sources).toBeGreaterThanOrEqual(MIN_BODY)
  })

  it('a card squeezed last time needs REOPEN_SLACK of room before it opens again', () => {
    const cards = [card('progress', true, 0, 200, false), card('outputs', true, 1, 100), card('sources', true, 2, 100)]
    // 全开 = 47×3 + 200 + 100 + 100 + 20 = 561
    expect(fitCards(cards, 570, 10, ['outputs']).squeezed).toEqual(['outputs'])
    expect(fitCards(cards, 590, 10, ['outputs']).squeezed).toEqual([])
  })
})
