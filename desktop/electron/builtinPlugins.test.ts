import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedBuiltinBundles, builtinPluginIds, builtinBundleSources, activeBundleDir, pendingDirFor, _resetBuiltinIdsForTest } from './builtinPlugins'

const write = async (dir: string, files: Record<string, string>): Promise<void> => {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), body)
  }
}
const manifest = (id: string, version: string): string => JSON.stringify({ id, version, main: 'main.js' })
const read = (p: string): Promise<string | null> => fs.readFile(p, 'utf8').catch(() => null)

let tmp: string
let src: string
let root: string
beforeEach(async () => {
  _resetBuiltinIdsForTest()
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-plugins-'))
  src = path.join(tmp, 'bundled', 'tangu-computer-use')
  root = path.join(tmp, 'home', 'plugins')
  await write(src, { 'manifest.json': manifest('tangu-computer-use', '0.5.0'), 'main.js': 'v0.5.0', 'tangu-plugins/computer-use/dist/index.js': 'engine' })
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const seed = (platform: NodeJS.Platform = 'darwin') => seedBuiltinBundles(root, [src], { platform, log: () => {} })

describe('seedBuiltinBundles', () => {
  it('首次:整目录播种到 <root>/<id>,id 记为内置', async () => {
    const r = await seed()
    expect(r.installed).toEqual(['tangu-computer-use'])
    expect(await read(path.join(root, 'tangu-computer-use', 'main.js'))).toBe('v0.5.0')
    expect(await read(path.join(root, 'tangu-computer-use', 'tangu-plugins', 'computer-use', 'dist', 'index.js'))).toBe('engine')
    expect(builtinPluginIds().has('tangu-computer-use')).toBe(true)
    // 没留 staging / old 残渣
    expect((await fs.readdir(root)).sort()).toEqual(['tangu-computer-use'])
  })

  it('同版本:不碰(用户目录里多出来的文件原样保留)', async () => {
    await seed()
    const extra = path.join(root, 'tangu-computer-use', 'user-note.txt')
    await fs.writeFile(extra, 'mine')
    const r = await seed()
    expect(r.kept).toEqual(['tangu-computer-use'])
    expect(r.updated).toEqual([])
    expect(await read(extra)).toBe('mine')
    expect(builtinPluginIds().has('tangu-computer-use')).toBe(true) // 没替换也算内置
  })

  it('已装更旧:原子替换,旧版多余文件不残留', async () => {
    await write(path.join(root, 'tangu-computer-use'), { 'manifest.json': manifest('tangu-computer-use', '0.4.0'), 'main.js': 'v0.4.0', 'stale.js': 'gone' })
    const r = await seed()
    expect(r.updated).toEqual(['tangu-computer-use'])
    expect(await read(path.join(root, 'tangu-computer-use', 'main.js'))).toBe('v0.5.0')
    expect(await read(path.join(root, 'tangu-computer-use', 'stale.js'))).toBeNull()
    expect((await fs.readdir(root)).sort()).toEqual(['tangu-computer-use'])
  })

  it('已装更新(用户从市场装的 0.6.0):绝不降级,但仍标内置', async () => {
    await write(path.join(root, 'tangu-computer-use'), { 'manifest.json': manifest('tangu-computer-use', '0.6.0'), 'main.js': 'v0.6.0' })
    const r = await seed()
    expect(r.kept).toEqual(['tangu-computer-use'])
    expect(await read(path.join(root, 'tangu-computer-use', 'main.js'))).toBe('v0.6.0')
    expect(builtinPluginIds().has('tangu-computer-use')).toBe(true)
  })

  it('同 id 装在别的目录名下(市场按 slug 落目录):就地更新那份,不另开一份', async () => {
    await write(path.join(root, 'forsion-computer-use-market'), { 'manifest.json': manifest('tangu-computer-use', '0.4.0'), 'main.js': 'old' })
    const r = await seed()
    expect(r.updated).toEqual(['tangu-computer-use'])
    expect(await read(path.join(root, 'forsion-computer-use-market', 'main.js'))).toBe('v0.5.0')
    expect(await read(path.join(root, 'tangu-computer-use', 'main.js'))).toBeNull()
  })

  it('负对照:源没有 manifest / id 非法 → 跳过且不记内置;非 darwin/win32 → 整体不播', async () => {
    await fs.rm(path.join(src, 'manifest.json'))
    expect((await seed()).skipped).toEqual([src])
    expect(builtinPluginIds().size).toBe(0)
    await write(src, { 'manifest.json': manifest('Bad Id!', '0.5.0') })
    expect((await seed()).skipped).toEqual([src])
    await write(src, { 'manifest.json': manifest('tangu-computer-use', '0.5.0') })
    const linux = await seed('linux')
    expect(linux).toEqual({ installed: [], updated: [], kept: [], skipped: [] })
    expect(await read(path.join(root, 'tangu-computer-use', 'main.js'))).toBeNull()
  })
})

describe('npm 暂存区(.pending)', () => {
  const pend = () => pendingDirFor(root, src)
  const seedAt = (appVersion: string) => seedBuiltinBundles(root, [src], { platform: 'darwin', appVersion, log: () => {} })

  it('暂存区比随包旧(新 App 已带了更新的):用随包,暂存区清掉', async () => {
    await write(pend(), { 'manifest.json': manifest('tangu-computer-use', '0.4.9'), 'main.js': 'v0.4.9' })
    const r = await seedAt('2.11.5')
    expect(r.installed).toEqual(['tangu-computer-use'])
    expect(await read(path.join(root, 'tangu-computer-use', 'main.js'))).toBe('v0.5.0')
    expect(await fs.readdir(root)).toEqual(['tangu-computer-use'])
  })

  it('更新器被杀留下的 staging / old 半成品:下次播种一并清掉,不被当成更新', async () => {
    const leftovers = path.join(root, '.pending')
    await write(path.join(leftovers, '.tangu-computer-use.staging-4242'), { 'manifest.json': manifest('tangu-computer-use', '0.9.0') })
    await write(path.join(leftovers, '.tangu-computer-use.staging-4242.old'), { 'manifest.json': manifest('tangu-computer-use', '0.8.0') })
    const r = await seedAt('2.11.5')
    expect(r.installed).toEqual(['tangu-computer-use'])
    expect(await read(path.join(root, 'tangu-computer-use', 'main.js'))).toBe('v0.5.0')
    expect(await fs.readdir(root)).toEqual(['tangu-computer-use'])
  })

  it('负对照:暂存区宿主不兼容(minAppVersion / apiVersion)或 id 不符 → 不用它,且清掉', async () => {
    for (const [name, m] of [
      ['minApp', JSON.stringify({ id: 'tangu-computer-use', version: '0.6.0', minAppVersion: '9.0.0' })],
      ['api', JSON.stringify({ id: 'tangu-computer-use', version: '0.6.0', apiVersion: 2 })],
      ['id', manifest('someone-else', '0.6.0')],
    ] as const) {
      await fs.rm(root, { recursive: true, force: true })
      await write(pend(), { 'manifest.json': m, 'main.js': 'v0.6.0' })
      await seedAt('2.11.5')
      expect(await read(path.join(root, 'tangu-computer-use', 'main.js')), name).toBe('v0.5.0')
      expect(await fs.readdir(root), name).toEqual(['tangu-computer-use'])
    }
  })
})

describe('activeBundleDir', () => {
  it('已装同 id(哪怕目录名不同)→ 用已装那份;没装 → 随包来源', async () => {
    expect(await activeBundleDir(root, src)).toBe(src)
    await write(path.join(root, 'cu-from-market'), { 'manifest.json': manifest('tangu-computer-use', '0.6.0') })
    expect(await activeBundleDir(root, src)).toBe(path.join(root, 'cu-from-market'))
  })
})

describe('builtinBundleSources', () => {
  it('打包版走 resources/bundled-plugins/<name>,dev 走 node_modules/<pkg>', () => {
    expect(builtinBundleSources({ isPackaged: true, resourcesPath: '/App/Contents/Resources', appPath: '/x' }))
      .toEqual(['/App/Contents/Resources/bundled-plugins/tangu-computer-use'])
    expect(builtinBundleSources({ isPackaged: false, resourcesPath: '/x', appPath: '/repo/desktop' }))
      .toEqual(['/repo/desktop/node_modules/@forsion/tangu-computer-use'])
  })
})
