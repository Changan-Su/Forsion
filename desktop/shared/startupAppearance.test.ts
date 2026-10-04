import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, patchAppearance, readAppearance, MAX_IMAGE_LENGTH } from './startupAppearance'
const image = 'data:image/png;base64,aGVsbG8='
describe('startup appearance storage boundary', () => {
  it('rejects executable/remote assets, excessive payloads and invalid switches', () => {
    for (const bad of ['https://example.com/logo.png', 'javascript:alert(1)', 'data:text/html;base64,aA==', image + 'a'.repeat(MAX_IMAGE_LENGTH)]) {
      expect(() => patchAppearance(DEFAULT_APPEARANCE, { splash: { id: 'x', label: 'x', image: bad } })).toThrow()
    }
    expect(() => patchAppearance(DEFAULT_APPEARANCE, { animation: 'url(evil)' })).toThrow()
    expect(() => patchAppearance(DEFAULT_APPEARANCE, { nativeIcon: 'true' })).toThrow()
  })
  it('retains unrelated fields and strips unexpected asset fields', () => {
    const changed = patchAppearance(DEFAULT_APPEARANCE, { icon: { id: 'upload', label: 'Mine', image, code: '<script>' } })
    expect(changed.icon).toEqual({ id: 'upload', label: 'Mine', image })
    expect(patchAppearance(changed, { showSplash: false }).icon).toEqual(changed.icon)
    expect(patchAppearance(changed, { icon: null }).icon).toBeNull()
  })
  it('invalid or unknown persisted versions boot with defaults', () => {
    expect(readAppearance({ version: 2, showSplash: false })).toEqual(DEFAULT_APPEARANCE)
    expect(readAppearance({ version: 1, icon: { image: 'bad' } })).toEqual(DEFAULT_APPEARANCE)
  })
})
