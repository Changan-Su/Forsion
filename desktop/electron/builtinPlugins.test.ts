import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedBuiltinBundles, builtinPluginIds, builtinBundleSources, activeBundleDir, pendingDirFor, _resetBuiltinIdsForTest, BUILTIN_BUNDLES, type BuiltinSource } from './builtinPlugins'
import { signDir, testKeyPair } from './bundleSignature.testutil'

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

const seed = () => seedBuiltinBundles(root, [src], { log: () => {} })

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

  it('负对照:源没有 manifest / id 非法 → 跳过且不记内置', async () => {
    await fs.rm(path.join(src, 'manifest.json'))
    expect((await seed()).skipped).toEqual([src])
    expect(builtinPluginIds().size).toBe(0)
    await write(src, { 'manifest.json': manifest('Bad Id!', '0.5.0') })
    expect((await seed()).skipped).toEqual([src])
    expect(await read(path.join(root, 'tangu-computer-use', 'main.js'))).toBeNull()
  })
})

describe('带主进程半身的包(desktop):换上之前先验签', () => {
  const key = testKeyPair()
  let ext: string
  const extSource = (): BuiltinSource => ({ pkg: '@forsion/extend', id: 'forsion-extend', platforms: ['darwin', 'win32', 'linux'], dir: ext, desktop: { entry: 'dist/desktop.mjs', signingKey: key.publicKeyPem } })
  const seedExt = (appVersion = '2.11.5') => seedBuiltinBundles(root, [extSource()], { appVersion, log: () => {} })
  const extManifest = (version: string) => JSON.stringify({ id: 'forsion-extend', version, apiVersion: 1, main: 'dist/main.js' })
  beforeEach(async () => {
    ext = path.join(tmp, 'bundled', 'extend')
    await write(ext, { 'manifest.json': extManifest('0.1.0'), 'dist/main.js': '// r', 'dist/desktop.mjs': 'export const registerCloud = () => {}' })
  })

  it('随包那份没签名 / 签名对不上 → 整包跳过,不装、不记内置;签过 → 正常播种', async () => {
    expect((await seedExt()).skipped).toEqual([ext])
    expect(builtinPluginIds().has('forsion-extend')).toBe(false)
    await signDir(ext, testKeyPair().privateKey)
    expect((await seedExt()).skipped).toEqual([ext])
    await signDir(ext, key.privateKey)
    expect((await seedExt()).installed).toEqual(['forsion-extend'])
    expect(await read(path.join(root, 'forsion-extend', 'SIGNATURE'))).not.toBeNull()
  })

  it('暂存区那份验不过 → 退回随包那份;签过的暂存区照常换上', async () => {
    await signDir(ext, key.privateKey)
    const pend = pendingDirFor(root, ext)
    await write(pend, { 'manifest.json': extManifest('0.2.0'), 'dist/main.js': '// r', 'dist/desktop.mjs': 'export const registerCloud = () => { /* evil */ }' })
    let r = await seedExt()
    expect(r.installed).toEqual(['forsion-extend'])
    expect(JSON.parse((await read(path.join(root, 'forsion-extend', 'manifest.json')))!).version).toBe('0.1.0')
    expect(await fs.readdir(root)).toEqual(['forsion-extend']) // 坏暂存区也清掉
    await write(pend, { 'manifest.json': extManifest('0.2.0'), 'dist/main.js': '// r', 'dist/desktop.mjs': 'export const registerCloud = () => { /* v2 */ }' })
    await signDir(pend, key.privateKey)
    r = await seedExt()
    expect(r.updated).toEqual(['forsion-extend'])
    expect(JSON.parse((await read(path.join(root, 'forsion-extend', 'manifest.json')))!).version).toBe('0.2.0')
  })

  it('已装同版本:不重验、不碰(用户目录里多出的文件保留)', async () => {
    await signDir(ext, key.privateKey)
    await seedExt()
    await fs.writeFile(path.join(root, 'forsion-extend', 'data.json'), '{}')
    expect((await seedExt()).kept).toEqual(['forsion-extend'])
    expect(await read(path.join(root, 'forsion-extend', 'data.json'))).toBe('{}')
  })
})

describe('npm 暂存区(.pending)', () => {
  const pend = () => pendingDirFor(root, src)
  const seedAt = (appVersion: string) => seedBuiltinBundles(root, [src], { appVersion, log: () => {} })

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
  it('打包版走 resources/bundled-plugins/<name>,dev 走 node_modules/<pkg>;清单项原样带上', () => {
    const packaged = builtinBundleSources({ isPackaged: true, resourcesPath: '/App/Contents/Resources', appPath: '/x', platform: 'darwin' })
    expect(packaged.map((s) => s.dir)).toEqual(['/App/Contents/Resources/bundled-plugins/tangu-computer-use', '/App/Contents/Resources/bundled-plugins/extend'])
    expect(packaged[1]).toMatchObject({ pkg: '@forsion/extend', id: 'forsion-extend', desktop: { entry: 'dist/desktop.mjs' } })
    expect(packaged[1].desktop?.signingKey).toMatch(/^-----BEGIN PUBLIC KEY-----\n/)
    expect(builtinBundleSources({ isPackaged: false, resourcesPath: '/x', appPath: '/repo/desktop', platform: 'win32' }).map((s) => s.dir))
      .toEqual(['/repo/desktop/node_modules/@forsion/tangu-computer-use', '/repo/desktop/node_modules/@forsion/extend'])
  })

  it('按清单项自己声明的 platforms 过滤:电脑操作不进 Linux,Forsion Extend 全平台', () => {
    expect(builtinBundleSources({ isPackaged: true, resourcesPath: '/r', appPath: '/x', platform: 'linux' }).map((s) => s.pkg)).toEqual(['@forsion/extend'])
    for (const b of BUILTIN_BUNDLES) expect(b.platforms.length, b.pkg).toBeGreaterThan(0)
  })
})
