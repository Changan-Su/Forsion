import { describe, expect, it } from 'vitest'
import { parseManifestRequires } from './manifestRequires'
import { installedPluginFields } from './pluginSource'

describe('parseManifestRequires', () => {
  it('keeps the array form', () => {
    expect(parseManifestRequires(['tangu', 'amadeus'])).toEqual({ plugins: ['tangu', 'amadeus'] })
  })

  it('reads the object form', () => {
    expect(parseManifestRequires({ plugins: ['tangu'], entitlement: 'business' })).toEqual({ plugins: ['tangu'], entitlement: 'business' })
    expect(parseManifestRequires({ entitlement: 'business' })).toEqual({ plugins: [], entitlement: 'business' })
    expect(parseManifestRequires({})).toEqual({ plugins: [] })
  })

  it('treats a missing value as nothing required', () => {
    expect(parseManifestRequires(undefined)).toEqual({ plugins: [] })
    expect(parseManifestRequires(null)).toEqual({ plugins: [] })
  })

  it.each([['a string', 'tangu'], ['a number', 1], ['plugins not a list', { plugins: 'tangu' }], ['an entitlement that is not a name', { entitlement: 'Business Plan' }], ['an entitlement that is not a string', { entitlement: 1 }]])('rejects %s', (_name, raw) => {
    expect(parseManifestRequires(raw)).toBeNull()
  })
})

describe('installedPluginFields', () => {
  const fields = (requires: unknown) => installedPluginFields({ id: 'p', requires }, 'p', 'p')

  it('carries the entitlement to the host', () => {
    expect(fields({ entitlement: 'business' }).entitlement).toBe('business')
  })

  it('has none for the array form or a bad value', () => {
    expect(fields(['tangu']).entitlement).toBeUndefined()
    expect(fields({ entitlement: 'Not Valid' }).entitlement).toBeUndefined()
    expect(fields(undefined).entitlement).toBeUndefined()
  })

  it('does not turn Unit package ids into desktop prerequisites, or a plugin would never activate', () => {
    expect(fields({ plugins: ['tangu'], entitlement: 'business' }).requiresPlugins).toBeUndefined()
    expect(fields(['tangu']).requiresPlugins).toBeUndefined()
  })

  it('leaves requiresPlugins working alongside it', () => {
    const f = installedPluginFields({ id: 'p', requires: { entitlement: 'business' }, requiresPlugins: ['other'] }, 'p', 'p')
    expect(f.requiresPlugins?.map((d) => d.id)).toEqual(['other'])
    expect(f.entitlement).toBe('business')
  })
})
