import { describe, expect, it } from 'vitest'
import { normalizeFloatingPanelOpenOptions } from './floatingPanel'

describe('normalizeFloatingPanelOpenOptions', () => {
  it('accepts one builtin target and clamps unsafe geometry', () => {
    expect(normalizeFloatingPanelOpenOptions({
      id: ' settings ', title: ' Settings ', builtin: 'settings', width: 99999, height: 20,
      params: { tab: 'plugins' },
    })).toEqual(expect.objectContaining({
      id: 'settings', title: 'Settings', builtin: 'settings', width: 1800, height: 360,
      params: { tab: 'plugins' },
    }))
  })

  it('accepts a namespaced plugin view but rejects ambiguous or malformed targets', () => {
    expect(normalizeFloatingPanelOpenOptions({
      id: 'plugin:clock:face', title: 'Clock', view: { type: 'plugin:clock:face', params: { zone: 'UTC' } },
    })?.view).toEqual({ type: 'plugin:clock:face', params: { zone: 'UTC' } })
    expect(normalizeFloatingPanelOpenOptions({ id: 'x', title: 'X', builtin: 'market', view: { type: 'x' } })).toBeUndefined()
    expect(normalizeFloatingPanelOpenOptions({ id: 'x', title: 'X' })).toBeUndefined()
  })
})
