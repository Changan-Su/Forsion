import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { backendDependencyFilter } = require('../build/backend-dependencies.cjs')
const { createFilter } = require('app-builder-lib/out/util/filter.js')
const { Minimatch } = require('minimatch')

describe('backend production packaging', () => {
  it('uses builder matching to remove dev-only trees while retaining shared and optional runtime dependencies', () => {
    const lock = { lockfileVersion: 3, packages: {
      '': {},
      'node_modules/typescript': { dev: true },
      'node_modules/@types/node': { dev: true },
      'node_modules/shared': { dev: false },
      'node_modules/native': { optional: true },
      'node_modules/runtime/node_modules/dev-tool': { dev: true },
    } }
    const root = resolve('/fixture/node_modules')
    const filter = createFilter(root, backendDependencyFilter(lock).map((p: string) => new Minimatch(p, { dot: true })))
    for (const name of ['typescript', 'typescript/lib/tsc.js', '@types/node/index.d.ts', 'runtime/node_modules/dev-tool/index.js']) {
      expect(filter(join(root, name), { isDirectory: () => !name.endsWith('.js') && !name.endsWith('.ts') })).toBe(false)
    }
    for (const name of ['shared/index.js', 'native/build/Release/addon.node', 'runtime/index.js']) {
      expect(filter(join(root, name), { isDirectory: () => false })).toBe(true)
    }
  })

  it('fails closed for missing lock metadata or runtime dependencies nested inside excluded trees', () => {
    expect(() => backendDependencyFilter({ lockfileVersion: 1 })).toThrow()
    expect(() => backendDependencyFilter({ lockfileVersion: 3, packages: {
      'node_modules/tool': { dev: true },
      'node_modules/tool/node_modules/runtime': {},
    } })).toThrow('Production dependency would be excluded')
  })
})

const mocks = vi.hoisted(() => ({ quitAndInstall: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true }, BrowserWindow: {} }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: mocks } }))
vi.mock('./forsionHome', () => ({ forsionHomeDir: () => '/fixture' }))

describe('update installer visibility', () => {
  it.each(['win32', 'linux', 'darwin'])('%s keeps the correct installation behavior', async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    mocks.quitAndInstall.mockClear()
    try {
      Object.defineProperty(process, 'platform', { value: platform })
      const { installUpdate } = await import('./updater')
      installUpdate()
      if (platform === 'darwin') expect(mocks.quitAndInstall).not.toHaveBeenCalled()
      else expect(mocks.quitAndInstall).toHaveBeenCalledWith(platform !== 'win32', true)
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
})
