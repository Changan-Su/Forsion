import { describe, expect, it } from 'vitest'
import { parseTabTitleBar, tabTitleBarOptions } from './tabTitleBar'

describe('tab title bar', () => {
  it('enables native overlay only on Windows and preserves other platform chrome', () => {
    expect(tabTitleBarOptions('win32')).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000' } })
    expect(tabTitleBarOptions('darwin')).toEqual({ titleBarStyle: 'hiddenInset' })
    expect(tabTitleBarOptions('linux')).toEqual({ titleBarStyle: 'default' })
  })
  it('rejects invalid renderer geometry and colors before calling the OS', () => {
    for (const input of [null, {}, { height: NaN, symbolColor: '#ffffff' }, { height: 31.5, symbolColor: '#ffffff' },
      { height: 0, symbolColor: '#ffffff' }, { height: 129, symbolColor: '#ffffff' }, { height: 32, symbolColor: 'var(--text)' }]) {
      expect(parseTabTitleBar(input)).toBeNull()
    }
    expect(parseTabTitleBar({ height: 35, symbolColor: '#eeeeee' })).toEqual({ height: 35, symbolColor: '#eeeeee' })
  })
})
