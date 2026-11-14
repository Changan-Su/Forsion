import { describe, expect, it } from 'vitest'
import { pickUnitRoute, remoteUnitId, unitPanelModel } from './unitPanelModel'
import type { UnitInfo } from '../types'

const u = (id: string, online: boolean, extra: Partial<UnitInfo> = {}): UnitInfo =>
  ({ id, name: id, platform: 'darwin', icon: null, online, lanUrl: null, ...extra })

describe('pickUnitRoute (temporary rule: relay whenever online)', () => {
  it('online → tunnel, even when LAN and P2P are available', () => {
    expect(pickUnitRoute(u('a', true, { lanUrl: 'http://10.0.0.2:8791' }), { lanOk: true, p2p: true })).toBe('tunnel')
    expect(pickUnitRoute(u('a', true), { lanOk: false, p2p: false })).toBe('tunnel')
  })
  it('offline → null, a probed LAN address does not count yet', () => {
    expect(pickUnitRoute(u('a', false, { lanUrl: 'http://10.0.0.2:8791' }), { lanOk: true, p2p: true })).toBeNull()
  })
})

describe('remoteUnitId', () => {
  it('reads the device id from any via, and never from addr: keys', () => {
    expect(remoteUnitId('u-1:tunnel')).toBe('u-1')
    expect(remoteUnitId('u-1:lan')).toBe('u-1')
    expect(remoteUnitId('addr:http://10.0.0.2:8791/')).toBeNull()
    expect(remoteUnitId(null)).toBeNull()
  })
})

describe('unitPanelModel', () => {
  const units = [u('mba', true), u('pc', false), u('host', true), u('phone', true, { kind: 'phone' }), u('mini', false, { lanUrl: 'http://10.0.0.3:8791' })]
  const base = { units, hostUnitId: 'host', lanOk: { mini: true }, p2p: true, remote: { active: false, key: null } }

  it('drops this computer and phones; online rows outside, offline folded, roster order kept', () => {
    const m = unitPanelModel(base)
    expect(m.localCurrent).toBe(true)
    expect(m.rows.map((r) => r.key)).toEqual(['mba'])
    expect(m.rows[0]).toMatchObject({ via: 'tunnel', current: false })
    expect(m.offline.map((r) => r.key)).toEqual(['pc', 'mini'])
  })

  it('the device being viewed is checked and never folded, even when it went offline', () => {
    const m = unitPanelModel({ ...base, remote: { active: true, key: 'pc:tunnel' } })
    expect(m.localCurrent).toBe(false)
    expect(m.rows.map((r) => [r.key, r.current])).toEqual([['mba', false], ['pc', true]])
    expect(m.offline.map((r) => r.key)).toEqual(['mini'])
  })

  it('a device opened over another via (settings page LAN row) still counts as current', () => {
    const m = unitPanelModel({ ...base, remote: { active: true, key: 'mba:lan' } })
    expect(m.rows.find((r) => r.key === 'mba')?.current).toBe(true)
  })

  it('a hidden surface (back on this computer) checks this computer again', () => {
    const m = unitPanelModel({ ...base, remote: { active: false, key: 'mba:tunnel' } })
    expect(m.localCurrent).toBe(true)
    expect(m.rows.every((r) => !r.current)).toBe(true)
  })

  it('a typed-in address target shows as its own current row only while viewed', () => {
    const viewing = unitPanelModel({ ...base, remote: { active: true, key: 'addr:http://10.0.0.9:8791/', name: '10.0.0.9:8791' } })
    expect(viewing.rows.at(-1)).toEqual({ kind: 'addr', key: 'addr:http://10.0.0.9:8791/', name: '10.0.0.9:8791', current: true })
    expect(unitPanelModel({ ...base, remote: { active: false, key: 'addr:http://10.0.0.9:8791/' } }).rows.some((r) => r.kind === 'addr')).toBe(false)
  })

  it('no roster (signed out / not loaded) → no device rows at all', () => {
    expect(unitPanelModel({ ...base, units: null })).toMatchObject({ rows: [], offline: [] })
    expect(unitPanelModel({ ...base, units: undefined })).toMatchObject({ rows: [], offline: [] })
  })
})
