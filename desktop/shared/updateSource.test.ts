import { expect, it } from 'vitest'
import { parseMainland, parseSourcePref, parseWebsiteInstallers, sourceOrder, websiteCarries, websiteHas, websitePlatformFor } from './updateSource'

it('auto source goes by region: mainland website first, elsewhere GitHub first, unknown website first', () => {
  expect(sourceOrder('auto', true)).toEqual(['website', 'github'])
  expect(sourceOrder('auto', false)).toEqual(['github', 'website'])
  expect(sourceOrder('auto', null)).toEqual(['website', 'github'])
  expect(sourceOrder('github', true)).toEqual(['github', 'website'])
  expect(sourceOrder('website', false)).toEqual(['website', 'github'])
  expect(parseSourcePref('github')).toBe('github')
  expect(parseSourcePref(undefined)).toBe('auto')
  expect(parseSourcePref('nope')).toBe('auto')
})

it('reads mainland from the region endpoint, unknown country is null', () => {
  expect(parseMainland({ country: 'CN', mainland_china: true })).toBe(true)
  expect(parseMainland({ country: 'HK', mainland_china: false })).toBe(false)
  expect(parseMainland({ country: 'GB' })).toBe(false)
  expect(parseMainland({ country: null, mainland_china: false })).toBeNull()
  expect(parseMainland(null)).toBeNull()
})

it('parses website installers and drops malformed entries', () => {
  const site = parseWebsiteInstallers({ platforms: {
    windows: { filename: 'Forsion-2.13.4-x64.exe', size: 447947415, version: '2.13.4', sha512: 'abc==' },
    macos: { filename: 'Forsion-2.13.4-arm64.dmg', size: 509163663, version: 'v2.13.4' },
    android: null,
  } })
  expect(site).toEqual({
    windows: { version: '2.13.4', filename: 'Forsion-2.13.4-x64.exe', size: 447947415, sha512: 'abc==' },
    macos: { version: '2.13.4', filename: 'Forsion-2.13.4-arm64.dmg', size: 509163663 },
  })
  expect(parseWebsiteInstallers({ platforms: { windows: { version: 'latest' } } })).toEqual({})
  expect(parseWebsiteInstallers({ detail: 'oops' })).toBeNull()
})

it('maps packages to the website platform and only offers the website for standard Windows / mac', () => {
  expect(websitePlatformFor('darwin')).toBe('macos')
  expect(websitePlatformFor('linux')).toBe('windows')
  expect(websiteCarries('win32', true)).toBe(true)
  expect(websiteCarries('linux', true)).toBe(false)
  expect(websiteCarries('darwin', false)).toBe(false)
  const win = { version: '2.13.4', filename: 'Forsion-2.13.4-x64.exe' }
  expect(websiteHas(win, '2.13.4')).toBe(true)
  expect(websiteHas(win, '2.13.5')).toBe(false)
  expect(websiteHas({ ...win, filename: 'Forsion-NoExtend-2.13.4-x64.exe' }, '2.13.4')).toBe(false)
})
