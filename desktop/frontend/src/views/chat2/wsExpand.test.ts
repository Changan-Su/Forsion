import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXPAND_STEP, expandStepOf, parseExpandSteps, setExpandStep } from './wsExpand'

describe('wsExpand', () => {
  it('drops junk and out-of-list values', () => {
    expect(parseExpandSteps(null)).toEqual({})
    expect(parseExpandSteps('not json')).toEqual({})
    expect(parseExpandSteps('[10]')).toEqual({})
    expect(parseExpandSteps('{"a":20,"b":7,"c":"10"}')).toEqual({ a: 20 })
  })

  it('stores the step per project, defaulting to 10', () => {
    const m = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } })
    expect(expandStepOf('/p/a')).toBe(DEFAULT_EXPAND_STEP)
    setExpandStep('/p/a', 20)
    expect(expandStepOf('/p/a')).toBe(20)
    expect(expandStepOf('/p/b')).toBe(DEFAULT_EXPAND_STEP)
  })
})
