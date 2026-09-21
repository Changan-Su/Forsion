import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

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

/** 内置 Node 的 npm 为什么要在 electron-builder.config.cjs 里单列一条 extraResources ——
 *  这两条钉的是 **electron-builder 自己的行为**:哪天上游改了(不再无条件丢根下 node_modules),
 *  第一条会红,那时那条补丁才可以删。2026-09-19 Windows 线上实报:npx → MODULE_NOT_FOUND + 空等 30s。 */
describe('bundled Node npm survives extraResources copy', () => {
  const all = [new Minimatch('**/*', { dot: true })]
  const dir = { isDirectory: () => true }
  const file = { isDirectory: () => false }

  it('drops the node_modules directly under `from` (where Windows keeps npm) but keeps lib/node_modules', () => {
    const src = resolve('/fixture/build/node')
    const filter = createFilter(src, all)
    expect(filter(join(src, 'node_modules'), dir)).toBe(false)        // Windows 平铺:npm 就在这层
    expect(filter(join(src, 'lib', 'node_modules'), dir)).toBe(true)  // 类 Unix:深一层,不受影响
    expect(filter(join(src, 'node.exe'), file)).toBe(true)
  })

  it('keeps everything when node_modules itself is the `from` (the config entry that fixes it)', () => {
    const src = resolve('/fixture/build/node/node_modules')
    const filter = createFilter(src, all)
    expect(filter(src, dir)).toBe(true)
    expect(filter(join(src, 'npm', 'bin', 'npx-cli.js'), file)).toBe(true)
  })

  // 上面两条只钉 electron-builder 的行为,删了配置里那一条照样绿 —— 所以这里直接读配置源码。
  // 不 require:electron-builder.config.cjs 在缺 unit-web-dist 时会抛,而测试 job 跑在 build:unitweb 之前。
  it('electron-builder.config.cjs still ships the bundled npm as its own extraResources entry', () => {
    const cfg = readFileSync(join(__dirname, '..', 'electron-builder.config.cjs'), 'utf8')
    expect(cfg).toContain("{ from: 'build/node/node_modules', to: 'node/node_modules' }")
  })
})
