// P1-K7a:「在哪运行」选择器 / 设备分组的两道闸(规格 K7 §3.9 真值表;安全不变式 S1 —— 设备页无条件关)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installEngineHost } from '../services/engine/targets'
import { rosterAvailable, runLocationsAvailable } from './runtime'
import { formatRunLocation, HOME, parseRunLocation, sameLocation } from '../services/runLocation'

const UNIT = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'

function host(loggedIn = true): void {
  installEngineHost({
    cfg: () => ({ backendUrl: 'https://api.test/api', token: loggedIn ? 'tok' : '' } as never),
    desktopConfig: () => ({ cloudApiBase: 'https://api.test/api' } as never),
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('rosterAvailable / runLocationsAvailable (§3.9)', () => {
  const unitsList = async () => ({ status: 200, json: { units: [] } })
  it.each([
    // [宿主, 名册, 选择器 / 分组]
    ['mobile app', { tangu: { mobile: true, cloudWeb: true, unitsList } }, true, true],
    ['mobile dev web', { tangu: { mobile: true, cloudWeb: true, unitsList } }, true, true],
    ['Electron desktop (U1: no remote targets in the main window)', { tangu: { unitsList } }, true, false],
    ['Tangu Web (U2: no roster bridge)', { tangu: { cloudWeb: true } }, false, false],
    ['device page on desktop', { tangu: { unitPage: true, unitsList } }, false, false],
    ['device page, ?ui=mobile', { tangu: { unitPage: true, mobile: true, cloudWeb: true, unitsList } }, false, false],
  ])('%s', (_name, win, roster, picker) => {
    host()
    vi.stubGlobal('window', win)
    expect(rosterAvailable()).toBe(roster)
    expect(runLocationsAvailable()).toBe(picker)
  })

  it('signed out on the phone → no picker (no hub credential)', () => {
    host(false)
    vi.stubGlobal('window', { tangu: { mobile: true, cloudWeb: true, unitsList: async () => ({ status: 200, json: null }) } })
    expect(rosterAvailable()).toBe(true)
    expect(runLocationsAvailable()).toBe(false)
  })
})

describe('RunLocation helpers', () => {
  it('round-trips and lowercases unit ids', () => {
    const l = parseRunLocation(`unit:${UNIT.toUpperCase()}`)
    expect(l).toEqual({ kind: 'unit', unitId: UNIT })
    expect(formatRunLocation(l)).toBe(`unit:${UNIT}`)
    expect(formatRunLocation(HOME)).toBe('')
    expect(parseRunLocation({ kind: 'unit', unitId: UNIT })).toEqual({ kind: 'unit', unitId: UNIT })
    expect(sameLocation(parseRunLocation(`unit:${UNIT}`), { kind: 'unit', unitId: UNIT })).toBe(true)
  })

  it.each([undefined, null, '', 'cloud', 'unit:', 'unit:x', 'unit:../../etc', 'unit:a b c d e f g', { kind: 'cloud' }, { kind: 'unit' }, { kind: 'unit', unitId: 7 }, 42])('bad input %j → HOME', (v) => {
    expect(parseRunLocation(v)).toEqual(HOME)
  })
})
