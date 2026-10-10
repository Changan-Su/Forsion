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

// macOS 安装窗口(DMG):说明文件曾被排到窗口外,用户要滚动才看得到(2.13.1 及更早)。这里钉住布局本身。
describe('mac dmg layout', () => {
  // Finder 里可视区比窗口矮:标题栏 32px;用户开了「显示路径栏 / 状态栏」时底部再少约 56px。
  // 一个图标连文件名占到中心往下 iconSize/2 + 53px。三个数都是 2026-10-10 在 macOS 27 上用
  // scripts/dmg-layout-preview.cjs 实测的:说明文件放 y=286 时窗口多出 7px 的滚动条,y=274 没有。
  const CHROME = 32 + 56
  const LABEL = 53
  const HALF_CELL = 70
  const offWindow = (c: { x: number; y: number }, iconSize: number, w: number, h: number) =>
    c.y - iconSize / 2 < 0 || c.y + iconSize / 2 + LABEL > h - CHROME || c.x - HALF_CELL < 0 || c.x + HALF_CELL > w
  const pngSize = (file: string) => {
    const png = readFileSync(join(__dirname, '..', 'build', file))
    return [png.readUInt32BE(16), png.readUInt32BE(20)]
  }

  it('keeps every icon and its file name inside the smallest visible area', () => {
    const dmg = require('../build/dmg-layout.cjs')
    // 有背景图时窗口大小取图的大小,window 被 dmg-builder 静默忽略 —— 写了只会骗人。
    expect(dmg.window).toBeUndefined()
    const [w, h] = pngSize(dmg.background)
    expect(pngSize(dmg.background.replace('.png', '@2x.png'))).toEqual([w * 2, h * 2])
    expect(dmg.contents).toHaveLength(3)
    for (const c of dmg.contents) {
      expect(offWindow(c, dmg.iconSize, w, h), `${c.path ?? 'app'} at ${c.x},${c.y} in ${w}x${h}`).toBe(false)
      if (c.type === 'file') expect(() => readFileSync(join(__dirname, '..', c.path))).not.toThrow()
    }
  })

  it('would have caught the 2.13.1 layout (window 540x380, help file at y=372)', () => {
    expect(offWindow({ x: 280, y: 372 }, 80, 540, 380)).toBe(true)
  })
})
