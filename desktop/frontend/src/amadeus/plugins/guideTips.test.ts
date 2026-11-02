/** 上手提示(guideTips.ts):manifest 消毒 + 「出不出、出哪条」的纯函数。DOM / 计时那半在 scripts/guide-tips.check.cjs(真 Electron)。 */
import { describe, expect, it } from 'vitest'
import { sanitizeGuide, type PluginGuideTip } from '../../../../shared/amadeus/ipc'
import { GUIDE_DAILY_MAX, IDLE_MS, OPEN_DELAY_MS, pickTip, type GuideCandidate, type GuideInput } from './guideTips'

describe('sanitizeGuide', () => {
  it('keeps a well-formed tip and its English mirror', () => {
    const g = sanitizeGuide({ tips: [{ id: 'drag', at: 'todo-row', style: 'ring', title: '拖', text: '拖到日历上', when: { visible: ['calendar-grid'] }, done: ['todo.schedule', 'app:note.create'], platform: 'desktop', en: { title: 'Drag', text: 'Drag it' } }] })
    expect(g).toEqual({ tips: [{ id: 'drag', at: 'todo-row', style: 'ring', title: '拖', text: '拖到日历上', when: { visible: ['calendar-grid'] }, done: ['todo.schedule', 'app:note.create'], platform: 'desktop', en: { title: 'Drag', text: 'Drag it' } }] })
  })
  it('drops bad tips one by one, never the whole list', () => {
    const g = sanitizeGuide({ tips: [
      { id: 'Bad Id', at: 'x', style: 'line', text: 't' },
      { id: 'ring-no-title', at: 'x', style: 'ring', text: 't' },
      { id: 'bad-when', at: 'x', style: 'line', text: 't', when: { nope: 1 } }, // 写了 when 但认不出:丢,不降级成手动
      { id: 'no-text', at: 'x', style: 'line' },
      { id: 'ok', at: 'x', style: 'line', text: 't', when: { count: 'todo.create', atLeast: 3 } },
      { id: 'ok', at: 'y', style: 'line', text: 'dup' },
    ] })
    expect(g?.tips.map((t) => t.id)).toEqual(['ok'])
    expect(g?.tips[0].when).toEqual({ count: 'todo.create', atLeast: 3 })
  })
  it('counts 12 valid tips, so junk early in the list cannot eat real ones', () => {
    const junk = Array.from({ length: 20 }, () => ({ id: 'x y' }))
    const real = Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, at: 'a', style: 'line', text: 't' }))
    expect(sanitizeGuide({ tips: [...junk, ...real] })?.tips.length).toBe(12)
  })
  it('clamps open.times and defaults it to 1', () => {
    expect(sanitizeGuide({ tips: [{ id: 'a', at: 'a', style: 'line', text: 't', when: { open: 'todo' } }] })?.tips[0].when).toEqual({ open: 'todo', times: 1 })
  })
  it('returns undefined for nothing usable', () => {
    expect(sanitizeGuide(undefined)).toBeUndefined()
    expect(sanitizeGuide({ tips: [] })).toBeUndefined()
    expect(sanitizeGuide({ tips: 'x' })).toBeUndefined()
  })
})

const tip = (o: Partial<PluginGuideTip> = {}): PluginGuideTip => ({ id: 'a', at: 'anchor', style: 'line', text: '提示', en: { text: 'Tip' }, when: { visible: ['anchor'] }, ...o })
const NOW = 1_000_000
const cand = (o: Partial<GuideCandidate> = {}): GuideCandidate => ({
  pluginId: 'p', tip: tip(), seen: null, muted: null, learned: false, condOk: true, requested: false, anchorSince: NOW - OPEN_DELAY_MS, hostShown: false, ...o,
})
const input = (o: Partial<GuideInput> = {}, cands: GuideCandidate[] = [cand()]): GuideInput => ({
  now: NOW, enabled: true, busy: false, dayCount: 0, lastInput: NOW - IDLE_MS, en: false, mobile: false, candidates: cands, ...o,
})

describe('pickTip', () => {
  it('shows an eligible tip', () => {
    expect(pickTip(input())?.tip.id).toBe('a')
  })
  it('respects the global gates', () => {
    expect(pickTip(input({ enabled: false }))).toBeNull()
    expect(pickTip(input({ busy: true }))).toBeNull() // 弹窗 / 向导 / 别的圈注
    expect(pickTip(input({ dayCount: GUIDE_DAILY_MAX }))).toBeNull()
    expect(pickTip(input({ dayCount: undefined }))).toBeNull() // 读不了当天计数 = 不知道,不出
    expect(pickTip(input({ lastInput: NOW - IDLE_MS + 1 }))).toBeNull() // 正在打字
  })
  it('never shows what is seen, muted, learned, or unreadable', () => {
    expect(pickTip(input({}, [cand({ seen: '2026-11-02' })]))).toBeNull()
    expect(pickTip(input({}, [cand({ muted: '2026-11-02' })]))).toBeNull()
    expect(pickTip(input({}, [cand({ learned: true })]))).toBeNull()
    expect(pickTip(input({}, [cand({ seen: undefined })]))).toBeNull()
    expect(pickTip(input({}, [cand({ muted: undefined })]))).toBeNull()
  })
  it('waits for the anchor, its 2 s, and one tip per view opening', () => {
    expect(pickTip(input({}, [cand({ anchorSince: null })]))).toBeNull()
    expect(pickTip(input({}, [cand({ anchorSince: NOW - OPEN_DELAY_MS + 1 })]))).toBeNull()
    expect(pickTip(input({}, [cand({ hostShown: true })]))).toBeNull()
  })
  it('needs its condition, unless the plugin asked for it', () => {
    expect(pickTip(input({}, [cand({ condOk: false })]))).toBeNull()
    expect(pickTip(input({}, [cand({ condOk: false, requested: true })]))?.tip.id).toBe('a')
  })
  it('skips a tip with no English in an English UI instead of showing Chinese', () => {
    expect(pickTip(input({ en: true }, [cand({ tip: tip({ en: undefined }) })]))).toBeNull()
    expect(pickTip(input({ en: true }, [cand({ tip: tip({ style: 'ring', title: '标题', en: { text: 'x' } }) })]))).toBeNull() // 圈注缺英文标题
    expect(pickTip(input({ en: true }))?.tip.id).toBe('a')
  })
  it('honours platform', () => {
    expect(pickTip(input({ mobile: true }, [cand({ tip: tip({ platform: 'desktop' }) })]))).toBeNull()
    expect(pickTip(input({ mobile: false }, [cand({ tip: tip({ platform: 'mobile' }) })]))).toBeNull()
  })
  it('takes the first eligible one in order', () => {
    const c = pickTip(input({}, [cand({ tip: tip({ id: 'x' }), seen: 'd' }), cand({ tip: tip({ id: 'y' }) }), cand({ tip: tip({ id: 'z' }) })]))
    expect(c?.tip.id).toBe('y')
  })
})
