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

  it('seal and unseal take turns: an unseal sent while seal waits for the round neither saves nor reopens the gate, and seal never returns open', async () => {
    const saves: LegacyHoldState[] = []
    const g = createLegacyGate({ loadHold: async () => ({ holder: 'v2', archived: false }), saveHold: async (h) => { saves.push(h) } })
    await g.ready()
    g.extendLoaded(false) // 这次启动交还:旧的一轮可以开
    const end = g.begin()
    let openAtReturn: boolean | null = null
    const seal = g.seal().then(() => { openAtReturn = !g.blocked() })
    await new Promise((r) => setTimeout(r, 5))
    const unseal = g.unseal()
    await new Promise((r) => setTimeout(r, 5))
    expect(saves).toEqual([]) // 排在 seal 后面
    expect(g.blocked()).toBe(true)
    end()
    await seal
    expect(openAtReturn).toBe(false)
    await unseal
    expect(saves).toEqual([{ holder: null, archived: false }])
    expect(g.blocked()).toBe(false)
  })

  it('exclusive: waits for the round in flight, keeps the gate shut for its whole body, refuses when not held, and marks archived inside without deadlock', async () => {
    const saves: LegacyHoldState[] = []
    const g = createLegacyGate({ loadHold: async () => ({ holder: 'v2', archived: false }), saveHold: async (h) => { saves.push(h) } })
    await g.ready()
    g.extendLoaded(false)
    expect(g.blocked()).toBe(false)
    const end = g.begin()
    let release!: () => void
    const hold = new Promise<void>((r) => { release = r })
    let entered = false
    const ex = g.exclusive(async (h) => { entered = true; await hold; await h.markArchived('/archive', 7); return 'done' })
    await new Promise((r) => setTimeout(r, 5))
    expect(entered).toBe(false) // 等在途那一轮
    expect(g.blocked()).toBe(true) // 等的时候闸就关着
    end()
    await new Promise((r) => setTimeout(r, 5))
    expect(entered).toBe(true)
    const unseal = g.unseal()
    await new Promise((r) => setTimeout(r, 5))
    expect(g.blocked()).toBe(true)
    expect(saves).toEqual([])
    release()
    expect(await ex).toBe('done')
    await unseal
    expect(saves).toEqual([{ holder: 'v2', archived: true, archivedAt: 7, archiveDir: '/archive' }, { holder: null, archived: true, archivedAt: 7, archiveDir: '/archive' }])
    await expect(g.exclusive(async () => 'x')).rejects.toThrow('legacy-not-sealed')
  })

  it('an unreadable hold state is logged as a fixed code, never with the file text', async () => {
    const logs: string[] = []
    const g = createLegacyGate({ loadHold: async () => { throw new SyntaxError('Unexpected token \'i\', ..."cessKey":fixture-sec"... is not valid JSON') }, saveHold: async () => {}, log: (m) => logs.push(m) })
    await g.ready()
    expect(g.state().hold).toBe('unknown')
    expect(logs.join('\n')).not.toContain('fixture-sec')
  })
})
