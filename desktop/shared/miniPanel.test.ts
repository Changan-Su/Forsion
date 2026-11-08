import { describe, expect, it } from 'vitest'
import { miniEntityKey, normalizeMiniOpenOptions } from './miniPanel'

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

describe('miniEntityKey (Mini 多开:按实体复用)', () => {
  it('one window per Space; params only retarget it', () => {
    expect(miniEntityKey({ spaceId: 'calendar' })).toBe('space:calendar')
    expect(miniEntityKey({ spaceId: 'calendar', params: { date: '2026-11-07' } })).toBe('space:calendar')
  })
  it('a chat session is identity, top-level or in the Tangu Space params', () => {
    expect(miniEntityKey({ sessionId: 's1' })).toBe('space:tangu#session:s1')
    expect(miniEntityKey({ spaceId: 'tangu', params: { sessionId: 's1' } })).toBe('space:tangu#session:s1')
    expect(miniEntityKey({ spaceId: 'tangu' })).toBe('space:tangu')
  })
  it('plugin direct views: one per view unless the caller passes a key', () => {
    expect(miniEntityKey({ view: { type: 'plugin:p:mini', params: { itemId: 1 } } })).toBe('view:plugin:p:mini')
    expect(miniEntityKey({ view: { type: 'plugin:p:mini', params: { itemId: 2 } } })).toBe('view:plugin:p:mini')
    expect(miniEntityKey({ view: { type: 'plugin:p:mini' }, key: 'note-a' })).toBe('view:plugin:p:mini#key:note-a')
  })
  it('the voice call is one window whatever the session / model', () => {
    expect(miniEntityKey({ view: { type: 'voice-call', params: { sessionId: 'a', model: 'm1' } } })).toBe('voice-call')
    expect(miniEntityKey({ view: { type: 'voice-call', params: { sessionId: 'b' } }, key: 'x' })).toBe('voice-call')
  })
  it('no target = the hotkey default', () => expect(miniEntityKey(undefined)).toBe('default'))
  it('normalizes key and duplicate', () => {
    expect(normalizeMiniOpenOptions({ spaceId: 'calendar', key: '  a ', duplicate: true })).toMatchObject({ key: 'a', duplicate: true })
    expect(normalizeMiniOpenOptions({ spaceId: 'calendar', duplicate: 'yes' })?.duplicate).toBeUndefined()
  })
})
