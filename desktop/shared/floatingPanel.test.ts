import { describe, expect, it } from 'vitest'
import { normalizeFloatingPanelOpenOptions, normalizeMainAction } from './floatingPanel'

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

  it('旁聊 btw:窄面板缺省几何 + 会话归属只收非空字符串', () => {
    const btw = normalizeFloatingPanelOpenOptions({ id: 'btw:s1', title: 'BTW', builtin: 'btw', sessionId: ' s1 ' })
    expect(btw).toEqual(expect.objectContaining({ builtin: 'btw', sessionId: 's1', width: 440, height: 640, minWidth: 360, minHeight: 420 }))
    expect(normalizeFloatingPanelOpenOptions({ id: 'btw:s1', title: 'BTW', builtin: 'btw', sessionId: '  ' })).not.toHaveProperty('sessionId')
    expect(normalizeFloatingPanelOpenOptions({ id: 'settings', title: 'S', builtin: 'settings', sessionId: 42 })).not.toHaveProperty('sessionId')
  })
})

describe('normalizeMainAction', () => {
  it('只放行白名单动作;载荷只给声明过的动作,且须是不超长的非空字符串', () => {
    expect(normalizeMainAction('reset-layout', 'junk')).toEqual({ action: 'reset-layout' })
    expect(normalizeMainAction('space-removed', 'probe-space')).toEqual({ action: 'space-removed', payload: 'probe-space' })
    expect(normalizeMainAction('chat-draft', 'x'.repeat(20000))?.payload).toHaveLength(20000)
    expect(normalizeMainAction('chat-draft', 'x'.repeat(20001))).toBeUndefined()
    expect(normalizeMainAction('chat-quote', 'answer')).toEqual({ action: 'chat-quote', payload: 'answer' })
    expect(normalizeMainAction('chat-quote', '')).toBeUndefined()
    expect(normalizeMainAction('space-removed', '')).toBeUndefined()
    expect(normalizeMainAction('space-removed', { id: 'x' })).toBeUndefined()
    expect(normalizeMainAction('quit', undefined)).toBeUndefined()
  })
})
