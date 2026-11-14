import { describe, expect, it } from 'vitest'
import { localPanelGroup, pickUnitRoute, readRememberedVia, rememberVia, remoteUnitId, unitPanelModel, unitWindowRosterState } from './unitPanelModel'
import type { UnitInfo } from '../types'
import type { LocalUnitRow, LocalUnitsSnapshot } from '../../../shared/localUnits'

const u = (id: string, online: boolean, extra: Partial<UnitInfo> = {}): UnitInfo =>
  ({ id, name: id, platform: 'darwin', icon: null, online, lanUrl: null, ...extra })

describe('pickUnitRoute', () => {
  const lanUnit = (online: boolean) => u('a', online, { lanUrl: 'http://10.0.0.2:8791' })
  const env = (lanOk: boolean, remembered: 'lan' | 'p2p' | 'tunnel' | null = null, p2p = true) => ({ lanOk, p2p, remembered })

  it('never chosen: relay while online, even when LAN and P2P are available', () => {
    expect(pickUnitRoute(lanUnit(true), env(true))).toEqual({ via: 'tunnel' })
    expect(pickUnitRoute(u('a', true), env(false))).toEqual({ via: 'tunnel' })
  })
  it('exception: cloud offline but LAN reachable → direct, not offline', () => {
    expect(pickUnitRoute(lanUnit(false), env(true))).toEqual({ via: 'lan' })
  })
  it('both unreachable → offline (null); a probe without a lanUrl does not count', () => {
    expect(pickUnitRoute(lanUnit(false), env(false))).toBeNull()
    expect(pickUnitRoute(u('a', false), env(true))).toBeNull()
  })
  it('remembered direct: used while the probe answers', () => {
    expect(pickUnitRoute(lanUnit(true), env(true, 'lan'))).toEqual({ via: 'lan' })
    expect(pickUnitRoute(lanUnit(false), env(true, 'lan'))).toEqual({ via: 'lan' })
  })
  it('remembered direct but the probe fails: relay and say so; offline when the relay is down too', () => {
    expect(pickUnitRoute(lanUnit(true), env(false, 'lan'))).toEqual({ via: 'tunnel', downgraded: true })
    expect(pickUnitRoute(lanUnit(false), env(false, 'lan'))).toBeNull()
  })
  it('remembered P2P: needs the cloud and a P2P bridge, else relay / direct exception', () => {
    expect(pickUnitRoute(u('a', true), env(false, 'p2p'))).toEqual({ via: 'p2p' })
    expect(pickUnitRoute(u('a', true), env(false, 'p2p', false))).toEqual({ via: 'tunnel' })
    expect(pickUnitRoute(lanUnit(false), env(true, 'p2p'))).toEqual({ via: 'lan' })
  })
  it('remembered relay behaves like never chosen', () => {
    expect(pickUnitRoute(lanUnit(true), env(true, 'tunnel'))).toEqual({ via: 'tunnel' })
    expect(pickUnitRoute(lanUnit(false), env(true, 'tunnel'))).toEqual({ via: 'lan' })
  })
})

describe('remembered via storage', () => {
  const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }
  it('round-trips the three vias, keyed by device id', () => {
    const s = mem()
    for (const v of ['lan', 'p2p', 'tunnel'] as const) { rememberVia('u1', v, s); expect(readRememberedVia('u1', s)).toBe(v) }
    expect(readRememberedVia('u2', s)).toBeNull()
  })
  it('unknown values and throwing storage read as never chosen, and nothing is written back', () => {
    const s = mem()
    s.m.set('forsion_unit_via:u1', 'wifi')
    expect(readRememberedVia('u1', s)).toBeNull()
    expect(s.m.get('forsion_unit_via:u1')).toBe('wifi')
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
    expect(readRememberedVia('u1', broken)).toBeNull()
    expect(() => rememberVia('u1', 'lan', broken)).not.toThrow()
    expect(readRememberedVia('u1', null)).toBeNull()
  })
  it('refuses unknown vias', () => {
    const s = mem()
    rememberVia('u1', 'wifi' as never, s)
    expect(s.m.size).toBe(0)
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

  it('drops this computer and phones; reachable rows outside (LAN-only counts), offline folded, roster order kept', () => {
    const m = unitPanelModel(base)
    expect(m.localCurrent).toBe(true)
    expect(m.rows.map((r) => [r.key, r.kind === 'unit' && r.via])).toEqual([['mba', 'tunnel'], ['mini', 'lan']])
    expect(m.offline.map((r) => r.key)).toEqual(['pc'])
  })

  it('applies remembered vias and marks a downgrade', () => {
    const m = unitPanelModel({ ...base, units: [u('mba', true, { lanUrl: 'http://10.0.0.5:8791' })], lanOk: {}, remembered: () => 'lan' })
    expect(m.rows[0]).toMatchObject({ via: 'tunnel', downgraded: true })
  })

  it('the device being viewed is checked and never folded, even when it went offline', () => {
    const m = unitPanelModel({ ...base, remote: { active: true, key: 'pc:tunnel' } })
    expect(m.localCurrent).toBe(false)
    expect(m.rows.map((r) => [r.key, r.current])).toEqual([['mba', false], ['pc', true], ['mini', false]])
    expect(m.offline.map((r) => r.key)).toEqual([])
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

describe('local Units: the "This computer" group (localPanelGroup / unitPanelModel.local)', () => {
  const row = (id: string, state: LocalUnitRow['state'], current = false): LocalUnitRow =>
    ({ id, name: id, icon: '', path: `/home/x/Forsion Units/${id}`, displayPath: `~/Forsion Units/${id}`, state, current })
  const snap = (over: Partial<LocalUnitsSnapshot> = {}): LocalUnitsSnapshot => ({
    self: { kind: 'default' },
    units: [row('lab', 'running'), row('demo', 'stopped'), row('old', 'missing'), row('copy', 'mismatch')],
    registry: 'ok', defaultParent: '/home/x/Forsion Units', defaultParentDisplay: '~/Forsion Units', ...over,
  })
  const base = { units: [], hostUnitId: null, lanOk: {}, p2p: false, remote: { active: false, key: null } }

  it('default Unit: every folder row in registry order, none checked; running / stopped usable, missing / mismatch not', () => {
    const g = localPanelGroup(snap(), false, false)
    expect(g.inFolder).toBe(false)
    expect(g.unreadable).toBe(false)
    expect(g.rows.map((r) => [r.unit.id, r.usable, r.checked, r.self])).toEqual([
      ['lab', true, false, false], ['demo', true, false, false], ['old', false, false, false], ['copy', false, false, false],
    ])
    expect(unitPanelModel({ ...base, local: { snapshot: snap() } }).localCurrent).toBe(true)
  })

  it('inside a folder Unit: its own row is checked, "This computer" is not; viewing a remote unchecks both', () => {
    const s = snap({ self: { kind: 'folder', id: 'lab', name: 'lab', icon: '', path: '/home/x/Forsion Units/lab', displayPath: '~/Forsion Units/lab' }, units: [row('lab', 'running', true), row('demo', 'stopped')] })
    const m = unitPanelModel({ ...base, local: { snapshot: s } })
    expect(m.localCurrent).toBe(false)
    expect(m.local.inFolder).toBe(true)
    expect(m.local.rows.map((r) => [r.unit.id, r.self, r.checked])).toEqual([['lab', true, true], ['demo', false, false]])
    const viewing = unitPanelModel({ ...base, local: { snapshot: s }, remote: { active: true, key: 'mba:tunnel' } })
    expect(viewing.localCurrent).toBe(false)
    expect(viewing.local.rows[0]).toMatchObject({ self: true, checked: false })
  })

  it('registry unreadable is not an empty registry: no rows from it, but the folder Unit still shows itself', () => {
    const g = localPanelGroup(snap({ registry: 'unreadable', units: [] }), false, false)
    expect(g).toMatchObject({ unreadable: true, rows: [] })
    const self = { kind: 'folder' as const, id: 'lab', name: 'Lab', icon: '🧪', path: '/p/lab', displayPath: '~/p/lab' }
    const inFolder = localPanelGroup(snap({ registry: 'unreadable', units: [], self }), false, false)
    expect(inFolder.unreadable).toBe(true)
    expect(inFolder.rows.map((r) => [r.unit.id, r.unit.name, r.self, r.checked, r.usable])).toEqual([['lab', 'Lab', true, true, true]])
  })

  it('a failed list() reads as unreadable (even before any snapshot), keeping the last known self', () => {
    expect(localPanelGroup(null, true, false)).toEqual({ inFolder: false, rows: [], unreadable: true })
    const self = { kind: 'folder' as const, id: 'lab', name: 'Lab', icon: '', path: '/p/lab', displayPath: '~/p/lab' }
    const g = localPanelGroup(snap({ self }), true, false)
    expect(g.unreadable).toBe(true)
    expect(g.rows.map((r) => r.unit.id)).toEqual(['lab'])
  })

  it('registry ok but without a row for itself: the folder Unit adds its own row first', () => {
    const self = { kind: 'folder' as const, id: 'me', name: 'Me', icon: '', path: '/p/me', displayPath: '~/p/me' }
    const g = localPanelGroup(snap({ self, units: [row('demo', 'stopped')] }), false, false)
    expect(g.rows.map((r) => [r.unit.id, r.self])).toEqual([['me', true], ['demo', false]])
  })

  it('no local Units on this host (no snapshot, no failure) → empty group, "This computer" behaves as before', () => {
    const m = unitPanelModel(base)
    expect(m.local).toEqual({ inFolder: false, rows: [], unreadable: false })
    expect(m.localCurrent).toBe(true)
  })
})

describe('unitWindowRosterState (Unit window)', () => {
  const den = u('den-12345', true)
  it('found / missing from a real roster', () => {
    expect(unitWindowRosterState({ status: 200, json: { units: [den] } }, 'den-12345')).toEqual({ state: 'found', unit: den, units: [den] })
    expect(unitWindowRosterState({ status: 200, json: { units: [den] } }, 'gone-12345')).toEqual({ state: 'missing' })
    expect(unitWindowRosterState({ status: 200, json: { units: [] } }, 'den-12345')).toEqual({ state: 'missing' })
  })
  it('signed out is its own state', () => {
    expect(unitWindowRosterState({ status: 401, json: null }, 'den-12345')).toEqual({ state: 'signedOut' })
  })
  it('a failed read is "unknown", never "missing"', () => {
    expect(unitWindowRosterState({ status: 502, json: null }, 'den-12345')).toEqual({ state: 'unknown' })
    expect(unitWindowRosterState({ status: 200, json: null }, 'den-12345')).toEqual({ state: 'unknown' })
    expect(unitWindowRosterState({ status: 200, json: {} }, 'den-12345')).toEqual({ state: 'unknown' })
  })
  it('no roster bridge is not "missing" either', () => {
    expect(unitWindowRosterState(undefined, 'den-12345')).toEqual({ state: 'noBridge' })
  })
  it('a remembered P2P route goes over the relay in the Unit window (no hole punching there)', () => {
    expect(pickUnitRoute(den, { lanOk: false, p2p: false, remembered: 'p2p' })).toEqual({ via: 'tunnel' })
  })
})
