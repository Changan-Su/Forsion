import { describe, expect, it } from 'vitest'
import { asrBackendFor } from './asrSelection'
describe('per-call ASR routing', () => {
  it('allows a cloud recording while global voice stays local', () => expect(asrBackendFor('local', 'cloud', true)).toBe('cloud'))
  it('allows an offline recording while global voice stays cloud', () => expect(asrBackendFor('cloud', 'local', true)).toBe('local'))
  it('never silently sends an explicitly offline recording to cloud', () => expect(() => asrBackendFor('cloud', 'local', false)).toThrow(/not ready/))
  it('preserves the legacy default when no override is given', () => {
    expect(asrBackendFor('local', undefined, true)).toBe('local')
    expect(asrBackendFor('local', undefined, false)).toBe('cloud')
  })
})
