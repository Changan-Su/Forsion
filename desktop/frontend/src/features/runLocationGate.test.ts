// P1-K7a:「在哪运行」选择器 / 设备分组的两道闸(规格 K7 §3.9 真值表;安全不变式 S1 —— 设备页无条件关)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installEngineHost, refreshDesktopRelay, resetFocusForTests } from '../services/engine/targets'
import { rosterAvailable, runLocationsAvailable } from './runtime'
import { formatRunLocation, HOME, parseRunLocation, sameLocation } from '../services/runLocation'

const UNIT = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'

function host(loggedIn = true): void {
  installEngineHost({
    cfg: () => ({ backendUrl: 'https://api.test/api', token: loggedIn ? 'tok' : '' } as never),
    desktopConfig: () => ({ cloudApiBase: 'https://api.test/api' } as never),
  })
}

afterEach(() => { vi.unstubAllGlobals(); resetFocusForTests() })

describe('rosterAvailable / runLocationsAvailable (§3.9)', () => {
  const unitsList = async () => ({ status: 200, json: { units: [] } })
  it.each([
    // [宿主, 名册, 选择器 / 分组]
    ['mobile app', { tangu: { mobile: true, cloudWeb: true, unitsList } }, true, true],
    ['mobile dev web', { tangu: { mobile: true, cloudWeb: true, unitsList } }, true, true],
    ['Electron desktop before the main-process relay is in (signed out / still booting)', { tangu: { unitsList } }, true, false],
    ['Tangu Web (U2: no roster bridge)', { tangu: { cloudWeb: true } }, false, false],
    ['device page on desktop', { tangu: { unitPage: true, unitsList } }, false, false],
    ['device page, ?ui=mobile', { tangu: { unitPage: true, mobile: true, cloudWeb: true, unitsList } }, false, false],
  ])('%s', (_name, win, roster, picker) => {
    host()
    vi.stubGlobal('window', win)
    expect(rosterAvailable()).toBe(roster)
    expect(runLocationsAvailable()).toBe(picker)
  })

  // 2026-10-14(K7 U1 改判):桌面主窗口经主进程的本机中转口也能把会话建到别的电脑上;设备页那一道照旧关。
  describe('Electron desktop as a caller', () => {
    const relay = { base: 'http://127.0.0.1:41234', token: 'boot-secret', accountId: 'acct' }
    it('main window: the gate opens once the relay arrives, and closes again when it goes away (sign-out)', async () => {
      host()
      let answer: typeof relay | null = relay
      vi.stubGlobal('window', { tangu: { unitsList, unitRelay: async () => answer } })
      expect(runLocationsAvailable()).toBe(false)
      expect(await refreshDesktopRelay()).toBe(true)
      expect(runLocationsAvailable()).toBe(true)
      expect(await refreshDesktopRelay()).toBe(false) // 没变 → 调用方不必清远端状态
      answer = null
      expect(await refreshDesktopRelay()).toBe(true)
      expect(runLocationsAvailable()).toBe(false)
    })

    it('device page never asks for the relay (§4.7 b6), even if the bridge is there', async () => {
      host()
      const unitRelay = vi.fn(async () => relay)
      vi.stubGlobal('window', { tangu: { unitPage: true, unitsList, unitRelay } })
      expect(await refreshDesktopRelay()).toBe(false)
      expect(unitRelay).not.toHaveBeenCalled()
      expect(runLocationsAvailable()).toBe(false)
    })

    it.each([
      ['a non-loopback base', { ...relay, base: 'https://evil.example' }],
      ['a loopback look-alike', { ...relay, base: 'http://127.0.0.1.evil.example:80' }],
      ['a base with a path', { ...relay, base: 'http://127.0.0.1:41234/x' }],
      ['an empty token', { ...relay, token: '' }],
    ])('refuses %s (the per-boot secret must only ever go to this machine)', async (_n, bad) => {
      host()
      vi.stubGlobal('window', { tangu: { unitsList, unitRelay: async () => bad } })
      await refreshDesktopRelay()
      expect(runLocationsAvailable()).toBe(false)
    })
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
