/**
 * engineCapsState(本机引擎态 → 名册 caps.engine)。上报器本身随 UnitHost 搬进了 @forsion/extend(test/vitest/unitCaps.test.ts),
 * 映射是本机引擎的事,留在宿主。跑法:npx vitest run electron/unitHubSeam.test.ts
 */
import { describe, it, expect } from 'vitest'
import { engineCapsState, pairingWriters, selfUnitIdMemo, type UnitPairing } from './unitHubSeam'

describe('engineCapsState', () => {
  it('maps the backend state, the seed gate and the product profile', () => {
    expect(engineCapsState({ agentBackend: false, backend: 'ready', seeded: true })).toBe('external')
    expect(engineCapsState({ agentBackend: true, backend: 'ready', seeded: true })).toBe('ready')
    // 种子没做完:unitWeb 对远端回 503 ENGINE_NOT_READY → 手机上应是「在启动」而不是「可用」
    expect(engineCapsState({ agentBackend: true, backend: 'ready', seeded: false })).toBe('starting')
    expect(engineCapsState({ agentBackend: true, backend: 'starting', seeded: true })).toBe('starting')
    expect(engineCapsState({ agentBackend: true, backend: 'stopped', seeded: true })).toBe('stopped')
    expect(engineCapsState({ agentBackend: true, backend: 'crashed', seeded: true })).toBe('stopped')
  })
})

describe('pairingWriters', () => {
  it('重建 / 换号之后,旧实例迟到的 savePairing / clearPairing 不动新配对', async () => {
    let current = 'old'
    let stored: UnitPairing | null = { unitId: 'old', secret: 's0' }
    const write = async (p: UnitPairing | null): Promise<void> => { stored = p }
    const oldW = pairingWriters(() => current === 'old', write)
    current = 'new' // 停用 / 换号 → doRefreshUnitHost 建出新实例
    const newW = pairingWriters(() => current === 'new', write)
    await newW.savePairing({ unitId: 'new', secret: 's1' })
    await oldW.savePairing({ unitId: 'old', secret: 's-late' }) // 旧实例的入册回包迟到
    await oldW.clearPairing() // 旧实例迟到的 403 判决
    expect(stored).toEqual({ unitId: 'new', secret: 's1' })
    await newW.clearPairing()
    expect(stored).toBeNull()
  })
})

describe('selfUnitIdMemo(units:hostStatus.selfUnitId)', () => {
  it('没读到过配对 = 不知道(null);读到 / 登记后记住', () => {
    const m = selfUnitIdMemo()
    expect(m.get()).toBeNull()
    m.note(null)
    m.note(undefined)
    expect(m.get()).toBeNull()
    m.note({ unitId: 'u-me', secret: 's' })
    expect(m.get()).toBe('u-me')
  })
  it('互联关掉 / 清配对(note(null))不抹掉;重新登记换成新 id', () => {
    const m = selfUnitIdMemo()
    m.note({ unitId: 'u-old', secret: 's' })
    m.note(null)
    expect(m.get()).toBe('u-old')
    m.note({ unitId: 'u-new', secret: 's2' })
    expect(m.get()).toBe('u-new')
  })
  it('坏值不认', () => {
    const m = selfUnitIdMemo()
    m.note({ unitId: '', secret: 's' })
    m.note({ unitId: 42 as unknown as string, secret: 's' })
    expect(m.get()).toBeNull()
  })
})
