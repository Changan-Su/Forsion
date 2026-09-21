import { describe, expect, it } from 'vitest'
import { normalizeMiniOpenOptions } from './miniPanel'

describe('normalizeMiniOpenOptions', () => {
  it('keeps legacy Space/session targets', () => {
    expect(normalizeMiniOpenOptions({ sessionId: ' s1 ', spaceId: 'tangu', params: { follow: true } }))
      .toEqual({ sessionId: 's1', spaceId: 'tangu', params: { follow: true }, view: undefined, mainView: undefined, title: undefined })
  })

  it('accepts direct plugin Mini and main targets', () => {
    expect(normalizeMiniOpenOptions({
      title: 'Timer', view: { type: 'plugin:timer:mini', params: { id: 1 } },
      mainView: { type: 'plugin:timer:main' },
    })).toEqual({
      title: 'Timer', sessionId: undefined, spaceId: undefined, params: undefined,
      view: { type: 'plugin:timer:mini', params: { id: 1 } }, mainView: { type: 'plugin:timer:main', params: undefined },
    })
  })

  it('rejects empty targets', () => expect(normalizeMiniOpenOptions({ title: 'none' })).toBeUndefined())
})
