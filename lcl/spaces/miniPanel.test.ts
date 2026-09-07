import { describe, it, expect } from 'vitest'
import { parseSpaceJson } from './userSpaces.core'
const opts = { isViewRegistered: (type: string) => type === 'full', appVersion: '2.9.7', reservedIds: [] }
const base = { id: 'test-space', name: { zh: '测试', en: 'Test' }, layout: { main: [{ type: 'full' }] } }
const parse = (mini?: unknown) => parseSpaceJson(JSON.stringify({ ...base, mini }), opts)
describe('Space Mini opt-in contract', () => {
  it('keeps legacy recipes unadapted', () => {
    const result = parse()
    expect(result.ok && result.spec.mini).toBeUndefined()
  })
  it('retains the explicit adapter and parameters even before its optional view is loaded', () => {
    const mini = { name: { zh: '快捷', en: 'Quick' }, view: { type: 'plugin:test:mini', params: { limit: 5 } }, mainView: { type: 'full' } }
    const result = parse(mini)
    expect(result.ok && result.spec.mini).toEqual(mini)
  })
  it.each([true, [], {}, { view: { type: 'full' }, mainView: { type: 'full' } },
    { view: { type: 'mini', params: [] }, mainView: { type: 'full' } }])('rejects malformed or unadapted declarations: %j', (mini) => {
    expect(parse(mini).ok).toBe(false)
  })
})
