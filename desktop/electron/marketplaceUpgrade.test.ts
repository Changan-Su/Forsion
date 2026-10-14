import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { checkMarketPackage } from './marketInstall'
import { effectivePluginId } from '../shared/products'
import { assertMarketplaceRequirements, compareAppVersions } from '../shared/marketplace'

describe('marketplace package requirements and identity', () => {
  const archive = (manifest: object) => new JSZip().file('repo/manifest.json', JSON.stringify(manifest)).file('repo/main.js', 'export default {}').generateAsync({ type: 'nodebuffer' })
  it('checks package requirements before any filesystem mutation, including exclusive maximum and protected IDs', async () => {
    const bytes = await archive({ id: 'same-id', version: '1.0.0', minAppVersion: '2.13.0', maxAppVersion: '3.0.0', platforms: ['desktop'] })
    await expect(checkMarketPackage(bytes, 'amadeus-plugin', '2.13.4', 'macos')).resolves.toBeUndefined()
    for (const [version, platform] of [['2.12.9', 'macos'], ['3.0.0', 'macos'], ['2.13.4', 'android']]) await expect(checkMarketPackage(bytes, 'amadeus-plugin', version, platform)).rejects.toThrow('install:')
    await expect(checkMarketPackage(bytes, 'amadeus-plugin', '2.13.4', 'macos', new Set(['same-id']))).rejects.toThrow('builtin')
    await expect(checkMarketPackage(await archive({ minAppVersion: 'broken' }), 'amadeus-plugin', '2.13.4', 'macos')).rejects.toThrow('invalid')
    expect(() => assertMarketplaceRequirements({ platforms: 'desktop' as any }, '2.13.4', 'macos')).toThrow('invalid')
  })
  it('isolates identical manifest IDs for new entries and preserves legacy plugin IDs', () => {
    const one = 'market-11111111-1111-4111-8111-111111111111', two = 'market-22222222-2222-4222-8222-222222222222'
    expect(effectivePluginId(one, 'same-id')).toBe(one)
    expect(effectivePluginId(two, 'same-id')).toBe(two)
    expect(effectivePluginId('legacy-dir', 'same-id')).toBe('same-id')
  })
  it('compares semantic prereleases correctly and rejects malformed version bounds', () => {
    expect(compareAppVersions('2.13.0-beta.2', '2.13.0-beta.11')).toBe(-1)
    expect(compareAppVersions('2.13.0-beta.11', '2.13.0')).toBe(-1)
    for (const invalid of ['2.13', '2.13.0-alpha..x', '2.13.0-01', '2.13.0+build..1']) expect(compareAppVersions(invalid, '2.13.0')).toBeNull()
  })
})
