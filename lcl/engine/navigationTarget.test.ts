import { describe, expect, it } from 'vitest'
import { navigationParams, navigationSig } from './navigationTarget'
import { identitySig } from './types'
describe('View navigation parameters', () => {
  it('preserves nested plugin targets and strips host metadata', () => {
    const input = { __type: 'plugin:test', __loc: 'main', target: { id: 'record-1', mode: 'full' }, query: 'abc' }
    const saved = navigationParams(input); input.target.id = 'record-2'
    expect(saved).toEqual({ target: { id: 'record-1', mode: 'full' }, query: 'abc' })
    expect(navigationSig(saved)).not.toBe(navigationSig(input))
  })
  it('canonicalizes key order and observes object ids without recording presentation changes', () => {
    expect(navigationSig({ target: { a: 1, b: 2 } })).toBe(navigationSig({ target: { b: 2, a: 1 } }))
    expect(identitySig({ recordId: 'one' })).not.toBe(identitySig({ recordId: 'two' }))
    expect(identitySig({ pdfPath: 'a.pdf', page: 1 })).toBe(identitySig({ pdfPath: 'a.pdf', page: 2 }))
  })
})
