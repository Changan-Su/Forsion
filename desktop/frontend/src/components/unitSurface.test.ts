// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { addrLabel, normalizeUnitAddress, REMOTE_ACCOUNT_SELECTORS, unitSurfaceWhole, UNIT_SURFACE_WHOLE } from './UnitSwitcher'

describe('normalizeUnitAddress', () => {
  it('adds the scheme and a trailing slash to the path only', () => {
    expect(normalizeUnitAddress('192.168.1.5:8791')).toBe('http://192.168.1.5:8791/')
    expect(normalizeUnitAddress(' http://host:3260/web ')).toBe('http://host:3260/web/')
    expect(normalizeUnitAddress('https://host/web/')).toBe('https://host/web/')
  })
  it('keeps #fragment and ?query intact', () => {
    expect(normalizeUnitAddress('http://host:3260/#unit-owner=abc')).toBe('http://host:3260/#unit-owner=abc')
    expect(normalizeUnitAddress('http://host:3260#unit-owner=abc')).toBe('http://host:3260/#unit-owner=abc')
    expect(normalizeUnitAddress('http://host:3260/web?x=1#t=2')).toBe('http://host:3260/web/?x=1#t=2')
  })
  it('rejects empty / bare scheme / garbage', () => {
    expect(normalizeUnitAddress('')).toBeNull()
    expect(normalizeUnitAddress('http://')).toBeNull()
    expect(normalizeUnitAddress('http://exa mple:99999')).toBeNull()
  })
})

describe('surface switch', () => {
  it('one constant decides the form; the harness override can only turn it off', () => {
    expect(unitSurfaceWhole()).toBe(UNIT_SURFACE_WHOLE)
    ;(window as any).__forsionUnitSurfacePart = true
    expect(unitSurfaceWhole()).toBe(false)
    delete (window as any).__forsionUnitSurfacePart
  })
  it('hides the remote account card by the classes AccountCard renders', () => {
    expect([...REMOTE_ACCOUNT_SELECTORS]).toEqual(['.rb .ribbon-account', '.rb .account-card'])
  })
})

describe('addrLabel', () => {
  it('shows host (+ path) only — never the query or the #unit-owner secret', () => {
    expect(addrLabel('http://127.0.0.1:3260/web/#unit-owner=secret')).toBe('127.0.0.1:3260/web')
    expect(addrLabel('http://192.168.1.77:8791/')).toBe('192.168.1.77:8791')
    expect(addrLabel('https://host/x/?token=1')).toBe('host/x')
  })
})
