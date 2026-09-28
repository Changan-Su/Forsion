import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ nativeImage: {} }))
import { parseMdfindBundles } from './appIcons'

describe('parseMdfindBundles', () => {
  it('路径带空格;同一 id 多份时优先 /Applications 与系统目录', () => {
    const out = [
      '/Users/me/p/node_modules/electron/dist/Electron.app   kMDItemCFBundleIdentifier = com.github.Electron',
      '/Applications/Google Chrome.app   kMDItemCFBundleIdentifier = com.google.Chrome',
      '/Users/me/Downloads/Google Chrome.app   kMDItemCFBundleIdentifier = com.google.Chrome',
      '/System/Library/CoreServices/Finder.app   kMDItemCFBundleIdentifier = com.apple.finder',
      '/Users/me/Applications/Finder.app   kMDItemCFBundleIdentifier = com.apple.finder',
      'garbage line',
      '',
    ].join('\n')
    const m = parseMdfindBundles(out, '/Users/me')
    expect(m.get('com.google.Chrome')).toBe('/Applications/Google Chrome.app')
    expect(m.get('com.apple.finder')).toBe('/System/Library/CoreServices/Finder.app')
    expect(m.get('com.github.Electron')).toBe('/Users/me/p/node_modules/electron/dist/Electron.app')
    expect(m.size).toBe(3)
  })
})
