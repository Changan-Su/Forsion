import { describe, it, expect } from 'vitest'
import { pluginHostPath } from './hostPaths'
describe('plugin filesystem output capability', () => {
  const local = { unitPage: true, executionCapabilities: { host: true } }
  it('joins local Unit and desktop vaults, including Windows', () => {
    expect(pluginHostPath('/device/vault', '青鸟/assets', local)).toBe('/device/vault/青鸟/assets')
    expect(pluginHostPath('C:\\Vault', 'assets/video.mp4', { platform: 'win32' })).toBe('C:\\Vault/assets/video.mp4')
  })
  it('rejects cloud, virtual, unproven and unavailable hosts', () => {
    for (const root of ['cloud://id', '/vault', '/real']) expect(pluginHostPath(root, 'assets', { executionCapabilities: { host: false } })).toBeNull()
    expect(pluginHostPath('cloud://id', 'assets', local)).toBeNull()
    expect(pluginHostPath('/vault', 'assets', undefined)).toBeNull()
    expect(pluginHostPath('/vault', 'assets', { unitPage: true })).toBeNull()
  })
  it('does not let plugins construct escaped filesystem paths', () => {
    for (const path of ['../secret', 'a/../../b', '/etc', 'a\\..\\b', 'C:/x', 'a//b', 'a\0b']) expect(pluginHostPath('/vault', path, local)).toBeNull()
  })
})
