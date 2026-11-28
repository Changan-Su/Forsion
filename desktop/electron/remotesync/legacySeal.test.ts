import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLegacyGate, type LegacyHoldState } from './legacySeal'

const held = (): LegacyHoldState => ({ holder: 'v2', archived: true })
const none = (): LegacyHoldState => ({ holder: null, archived: false })

describe('legacy remotesync gate', () => {
  afterEach(() => vi.useRealTimers())

  it('nothing held: never blocks, even before the hand-shake', async () => {
    const g = createLegacyGate({ loadHold: async () => none(), saveHold: async () => {} })
    await g.ready()
    expect(g.blocked()).toBe(false)
    g.extendLoaded(true)
    expect(g.blocked()).toBe(false)
  })

  it('held: blocks while the hand-shake is pending, hands back when Extend stays silent past the deadline', async () => {
    vi.useFakeTimers()
    const g = createLegacyGate({ loadHold: async () => held(), saveHold: async () => {}, handshakeMs: 1000 })
    await g.ready()
    expect(g.blocked()).toBe(true)
    g.extendLoaded(true)
    vi.advanceTimersByTime(999)
    expect(g.blocked()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(g.blocked()).toBe(false)
    expect(g.state().handshake).toBe('released')
  })

  it('a late hand-shake after hand-back blocks again and waits for the legacy round that started meanwhile', async () => {
    const g = createLegacyGate({ loadHold: async () => held(), saveHold: async () => {} })
    await g.ready()
    g.extendLoaded(false)
    expect(g.blocked()).toBe(false)
    const end = g.begin() // remotesync 在交还期间开了一轮
    let shook = false
    const shake = g.touch().then(() => { shook = true })
    await Promise.resolve(); await Promise.resolve()
    expect(g.blocked()).toBe(true) // 新的轮次马上被拦
    expect(shook).toBe(false) // v2 要等在途那一轮
    end()
    await shake
    expect(shook).toBe(true)
  })

  it('seal persists the hold once and an unreadable state is retried, never overwritten blindly', async () => {
    const saves: LegacyHoldState[] = []
    let reads = 0
    const g = createLegacyGate({ loadHold: async () => { reads++; if (reads === 1) throw new Error('EIO'); return none() }, saveHold: async (h) => { saves.push(h) } })
    await g.ready()
    expect(g.state().hold).toBe('unknown')
    expect(g.blocked()).toBe(true)
    await g.seal()
    expect(saves).toEqual([{ holder: 'v2', archived: false }])
    await g.seal()
    expect(saves).toHaveLength(1)
    await g.markArchived('/archive', 5)
    expect(saves[1]).toEqual({ holder: 'v2', archived: true, archivedAt: 5, archiveDir: '/archive' })
    await g.unseal()
    expect(saves[2]).toEqual({ holder: null, archived: true, archivedAt: 5, archiveDir: '/archive' })
    expect(g.blocked()).toBe(false)
  })
})
