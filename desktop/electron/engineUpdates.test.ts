/**
 * 引擎 npm 热更新的桌面半边:下载 → 只落签名表里的文件 → 用引擎那份判定函数核对 → 按版本号并排落位;启动时收拾目录。
 * 判定函数用的是引擎源码里的真实现(tangu-agent/src/boot/overlay.ts),只把公钥换成测试钥匙。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import * as overlay from '../../tangu-agent/src/boot/overlay'
import type { CorePluginUpdate } from '../shared/corePlugins'
import { tarballUrl, type RegistryFetch } from './builtinUpdates'
import { _resetEngineUpdatesForTest, checkEngineUpdate, cleanEngineOverlays, engineOverlayRoot, loadEngineOverlayApi, setupEngineOverlay, ENGINE_PACKAGE, ENGINE_UPDATE_ID, type EngineOverlayApi } from './engineUpdates'

const REG = 'https://r1.test'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pub = publicKey.export({ type: 'spki', format: 'pem' }) as string
const api: EngineOverlayApi = {
  ...overlay,
  checkOverlay: (dir, bundledRoot) => overlay.checkOverlay(dir, bundledRoot, pub),
  selectOverlay: (engineRoot, bundledRoot, opts) => overlay.selectOverlay(engineRoot, bundledRoot, { ...opts, publicKeyPem: pub } as Parameters<typeof overlay.selectOverlay>[2]),
}
const DEPS = { express: '^4.18.2' }

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100, 8, 'ascii')
  h.write('0000000\0', 108, 8, 'ascii')
  h.write('0000000\0', 116, 8, 'ascii')
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  h.write('00000000000\0', 136, 12, 'ascii')
  h.write('0', 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  h.fill(0x20, 148, 156)
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return h
}
function tgz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = []
  for (const [rel, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    blocks.push(tarHeader(`package/${rel}`, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}
const runtimeFiles = (): Record<string, string> => ({
  ...Object.fromEntries(Object.values(overlay.ENGINE_ENTRIES).map((rel) => [rel, `// ${rel}\n`])),
  ...Object.fromEntries(overlay.SCHEMA_FILES.map((rel) => [rel, `// schema ${rel}\n`])),
})
const pkgJson = (version: string, extra: object = {}): string =>
  JSON.stringify({ name: ENGINE_PACKAGE, version, dependencies: DEPS, forsion: { minDesktop: '2.0.0' }, ...extra })
/** 一份签好名的包的文件表(含 SIGNATURE);unsigned 里的文件进 tarball 但不进签名表。 */
function signedPackage(version: string, opts: { pkg?: object; key?: typeof privateKey; unsigned?: Record<string, string> } = {}): Record<string, string> {
  const files = { 'package.json': pkgJson(version, opts.pkg), ...runtimeFiles(), 'skills/a/SKILL.md': '# a\n' }
  const hashes = Object.fromEntries(Object.entries(files).map(([rel, data]) => [rel, createHash('sha256').update(data).digest('hex')]))
  const sig = sign(null, Buffer.from(overlay.canonicalFiles(hashes), 'utf8'), opts.key ?? privateKey).toString('base64')
  return { ...files, ...opts.unsigned, SIGNATURE: JSON.stringify({ alg: 'ed25519', files: hashes, sig }) }
}
const sri = (buf: Buffer): string => `sha512-${createHash('sha512').update(buf).digest('base64')}`

let tmp: string
let bundledRoot: string
let engineRoot: string
let logs: string[]
let statuses: CorePluginUpdate[]
let calls: string[]

function write(root: string, files: Record<string, string>): void {
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), data)
  }
}
/** registry 上的 latest 是这份包;integrity 可以故意给错。 */
function registry(version: string, buf: Buffer, integrity = sri(buf)): RegistryFetch {
  const routes: Record<string, () => Response> = {
    [`${REG}/@forsion%2ftangu-agent`]: () => new Response(JSON.stringify({ 'dist-tags': { latest: version }, versions: { [version]: { dist: { integrity } } } })),
    [tarballUrl(REG, ENGINE_PACKAGE, version)]: () => new Response(new Uint8Array(buf)),
  }
  return async (url) => {
    calls.push(url)
    return routes[url]?.() ?? new Response('not found', { status: 404 })
  }
}
const run = (fetch: RegistryFetch, runningVersion: string | null = null): Promise<string | null> =>
  checkEngineUpdate({ engineRoot, bundledRoot, api, registries: [REG], fetch, runningVersion, log: (m) => logs.push(m), onStatus: (s) => statuses.push(s) })
const last = (): CorePluginUpdate => statuses[statuses.length - 1]
const downloads = (): number => calls.filter((u) => u.endsWith('.tgz')).length
const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort()

beforeEach(() => {
  _resetEngineUpdatesForTest()
  tmp = mkdtempSync(path.join(os.tmpdir(), 'engine-updates-'))
  bundledRoot = path.join(tmp, 'resources', 'tangu-server')
  engineRoot = engineOverlayRoot(path.join(tmp, 'home'))
  write(bundledRoot, { 'package.json': pkgJson('2.1.0'), ...runtimeFiles() })
  logs = []
  statuses = []
  calls = []
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('checkEngineUpdate', () => {
  it('npm 上的不比自带的新:什么都不下', async () => {
    expect(await run(registry('2.1.0', tgz(signedPackage('2.1.0'))))).toBeNull()
    expect(last()).toMatchObject({ id: ENGINE_UPDATE_ID, packageName: ENGINE_PACKAGE, phase: 'current', installedVersion: '2.1.0', latestVersion: '2.1.0' })
    expect(downloads()).toBe(0)
    expect(existsSync(engineRoot)).toBe(false)
  })

  it('有新版:下载、核对、落到 engine/<版本>/,只落签名表里的文件', async () => {
    const files = signedPackage('2.1.1', { unsigned: { 'src/index.ts': 'not shipped', 'dist/index.d.ts': 'not shipped' } })
    expect(await run(registry('2.1.1', tgz(files)))).toBe('2.1.1')
    expect(last()).toMatchObject({ phase: 'staged', installedVersion: '2.1.0', pendingVersion: '2.1.1', latestVersion: '2.1.1' })
    const dir = path.join(engineRoot, '2.1.1')
    expect(tree(dir)).toEqual(Object.keys(files).filter((f) => !f.startsWith('src/') && !f.endsWith('.d.ts')).sort())
    expect(api.selectOverlay(engineRoot, bundledRoot)).toEqual({ version: '2.1.1', dir })
    expect(readdirSync(engineRoot)).toEqual(['2.1.1']) // 没留下半成品目录
    expect(logs.join('\n')).toContain('2.1.0 → 2.1.1')
  })

  it('已经下好的不再下;界面上按「正在跑的那一版」区分「已下载待重启」与「已是最新」', async () => {
    const fetch = registry('2.1.1', tgz(signedPackage('2.1.1')))
    await run(fetch)
    expect(downloads()).toBe(1)
    expect(await run(fetch)).toBeNull() // 引擎还在跑自带的
    expect(last()).toMatchObject({ phase: 'staged', installedVersion: '2.1.0', pendingVersion: '2.1.1' })
    expect(await run(fetch, '2.1.1')).toBeNull() // 重启后跑的就是它
    expect(last()).toMatchObject({ phase: 'current', installedVersion: '2.1.1' })
    expect(last().pendingVersion).toBeUndefined()
    expect(downloads()).toBe(1)
  })

  it('tarball 对不上 registry 报的 sha512:报错,什么都不落', async () => {
    expect(await run(registry('2.1.1', tgz(signedPackage('2.1.1')), 'sha512-AAAA'))).toBeNull()
    expect(last()).toMatchObject({ phase: 'error', error: 'integrity mismatch' })
    expect(existsSync(path.join(engineRoot, '2.1.1'))).toBe(false)
  })

  it('不是我们的钥匙签的:报错,什么都不落(registry 的 sha512 对得上也没用)', async () => {
    const other = generateKeyPairSync('ed25519').privateKey
    expect(await run(registry('2.1.1', tgz(signedPackage('2.1.1', { key: other }))))).toBeNull()
    expect(last().phase).toBe('error')
    expect(last().error).toMatch(/^signature: /)
    expect(existsSync(engineRoot) ? readdirSync(engineRoot) : []).toEqual([])
  })

  it('没有 SIGNATURE 的包:报错', async () => {
    const { SIGNATURE: _dropped, ...unsignedFiles } = signedPackage('2.1.1')
    expect(await run(registry('2.1.1', tgz(unsignedFiles)))).toBeNull()
    expect(last()).toMatchObject({ phase: 'error', error: 'package has no SIGNATURE' })
  })

  it.each([
    ['依赖清单变了', { dependencies: { ...DEPS, pg: '^8.18.0' } }, 'deps'],
    ['要求更新的壳', { forsion: { minDesktop: '2.2.0' } }, 'host'],
  ])('签名没问题但这份安装包用不了(%s):标「暂无兼容的更新」,本进程里不再重下', async (_name, pkg, code) => {
    const fetch = registry('2.1.1', tgz(signedPackage('2.1.1', { pkg })))
    expect(await run(fetch)).toBeNull()
    expect(last().phase).toBe('incompatible')
    expect(logs.join('\n')).toContain(`(${code})`)
    expect(existsSync(engineRoot) ? readdirSync(engineRoot) : []).toEqual([])
    await run(fetch)
    expect(last().phase).toBe('incompatible')
    expect(downloads()).toBe(1)
  })

  it('建表文件变了的版本用不了', async () => {
    const files = signedPackage('2.1.1')
    files[overlay.SCHEMA_FILES[0]] = '// a new migration\n'
    const hashes = Object.fromEntries(Object.entries(files).filter(([rel]) => rel !== 'SIGNATURE').map(([rel, data]) => [rel, createHash('sha256').update(data).digest('hex')]))
    files.SIGNATURE = JSON.stringify({ alg: 'ed25519', files: hashes, sig: sign(null, Buffer.from(overlay.canonicalFiles(hashes), 'utf8'), privateKey).toString('base64') })
    expect(await run(registry('2.1.1', tgz(files)))).toBeNull()
    expect(last().phase).toBe('incompatible')
    expect(logs.join('\n')).toContain('(schema)')
  })

  it('记成坏版本的不下', async () => {
    api.markBad(engineRoot, '2.1.1', 'crashed on start')
    expect(await run(registry('2.1.1', tgz(signedPackage('2.1.1'))))).toBeNull()
    expect(last().phase).toBe('incompatible')
    expect(downloads()).toBe(0)
  })

  it('预发布版本不下', async () => {
    expect(await run(registry('2.1.1-rc.1', tgz(signedPackage('2.1.1'))))).toBeNull()
    expect(last().phase).toBe('current')
    expect(downloads()).toBe(0)
  })

  it('包里的版本号与 registry 报的 latest 对不上:报错', async () => {
    expect(await run(registry('2.1.2', tgz(signedPackage('2.1.1'))))).toBeNull()
    expect(last()).toMatchObject({ phase: 'error', error: 'package is 2.1.1, not 2.1.2' })
    expect(existsSync(path.join(engineRoot, '2.1.2'))).toBe(false)
  })

  it('同名目录是一份坏掉的残留:换成新下的', async () => {
    write(path.join(engineRoot, '2.1.1'), { 'package.json': 'garbage' })
    expect(await run(registry('2.1.1', tgz(signedPackage('2.1.1'))))).toBe('2.1.1')
    expect(api.selectOverlay(engineRoot, bundledRoot)?.version).toBe('2.1.1')
    expect(readdirSync(engineRoot)).toEqual(['2.1.1'])
  })

  it('registry 连不上:报错,不抛', async () => {
    expect(await run(async () => { throw new Error('offline') })).toBeNull()
    expect(last().phase).toBe('error')
  })
})

describe('cleanEngineOverlays', () => {
  it('留版本号最高的两份合格新版(终端里可能还开着跑上一版的 tangu);半成品、更旧的、不合格的都删;坏版本记录只留比自带新的', async () => {
    const fetch = (v: string): RegistryFetch => registry(v, tgz(signedPackage(v)))
    await run(fetch('2.1.1'))
    await run(fetch('2.1.2'))
    await run(fetch('2.1.4'))
    write(path.join(engineRoot, '2.1.5'), { 'package.json': 'garbage' })
    write(path.join(engineRoot, '.staging-999'), { 'x.js': 'half' })
    writeFileSync(path.join(engineRoot, 'bad.json'), JSON.stringify({ '2.0.5': 'old', '2.1.9': 'still newer than bundled' }))
    await cleanEngineOverlays(engineRoot, bundledRoot, api, (m) => logs.push(m))
    expect(readdirSync(engineRoot).sort()).toEqual(['2.1.2', '2.1.4', 'bad.json'])
    expect(JSON.parse(readFileSync(path.join(engineRoot, 'bad.json'), 'utf8'))).toEqual({ '2.1.9': 'still newer than bundled' })
    expect(logs.join('\n')).toContain('清掉 2.1.5')
  })

  it('记成坏版本的那份不占「留两份」的名额,直接删', async () => {
    const fetch = (v: string): RegistryFetch => registry(v, tgz(signedPackage(v)))
    await run(fetch('2.1.1'))
    await run(fetch('2.1.2'))
    await run(fetch('2.1.3'))
    api.markBad(engineRoot, '2.1.3', 'crashed on start')
    await cleanEngineOverlays(engineRoot, bundledRoot, api)
    expect(readdirSync(engineRoot).sort()).toEqual(['2.1.1', '2.1.2', 'bad.json'])
  })

  it('安装包升上去之后,不比它新的那份和它的坏记录一起清掉', async () => {
    await run(registry('2.1.1', tgz(signedPackage('2.1.1'))))
    api.markBad(engineRoot, '2.1.0', 'old')
    write(bundledRoot, { 'package.json': pkgJson('2.1.1') }) // 用户装了新安装包
    await cleanEngineOverlays(engineRoot, bundledRoot, api)
    expect(readdirSync(engineRoot)).toEqual([])
  })

  it('没有 engine 目录:不报错、不创建', async () => {
    await cleanEngineOverlays(engineRoot, bundledRoot, api, (m) => logs.push(m))
    expect(existsSync(engineRoot)).toBe(false)
    expect(logs).toEqual([])
  })
})

it('loadEngineOverlayApi:安装包里的引擎没带启动器(旧 dist)→ null', async () => {
  expect(await loadEngineOverlayApi(bundledRoot)).toBeNull()
})

describe('setupEngineOverlay(第一次拉起引擎之前)', () => {
  it('收拾目录,并给出「下次会跑哪一版 / 停用哪一版」两个动作', async () => {
    await run(registry('2.1.1', tgz(signedPackage('2.1.1'))))
    write(path.join(engineRoot, '.staging-1'), { 'x.js': 'half' })
    const handle = await setupEngineOverlay({ bundledRoot, forsionHome: path.join(tmp, 'home'), loadApi: async () => api })
    expect(handle).toMatchObject({ bundledRoot, root: engineRoot })
    expect(readdirSync(engineRoot)).toEqual(['2.1.1'])
    expect(handle!.control.active()).toBe('2.1.1')
    handle!.control.demote('2.1.1', 'failed to start')
    expect(handle!.control.active()).toBeNull()
    expect(api.readBad(engineRoot)).toEqual({ '2.1.1': 'failed to start' })
    // 停用之后更新器不再把它下回来
    expect(await run(registry('2.1.1', tgz(signedPackage('2.1.1'))))).toBeNull()
    expect(last().phase).toBe('incompatible')
  })

  it('安装包里的引擎没带启动器:返回 null,不碰磁盘', async () => {
    expect(await setupEngineOverlay({ bundledRoot, forsionHome: path.join(tmp, 'home') })).toBeNull()
    expect(existsSync(engineRoot)).toBe(false)
  })
})
