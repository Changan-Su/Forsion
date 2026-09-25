import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { checkBuiltinUpdates, registryOrder, tarballUrl, NPM_MIRROR, NPM_OFFICIAL, type RegistryFetch } from './builtinUpdates'
import { seedBuiltinBundles, pendingDirFor, _resetBuiltinIdsForTest } from './builtinPlugins'

const PKG = '@forsion/tangu-computer-use'
const R1 = 'https://r1.test'
const R2 = 'https://r2.test'

/** 手写 ustar:npm tarball 只有 `package/` 下的普通文件。 */
function tarHeader(name: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii')
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
function tgz(files: Record<string, string | { data: string; mode: number }>): Buffer {
  const blocks: Buffer[] = []
  for (const [rel, f] of Object.entries(files)) {
    const data = Buffer.from(typeof f === 'string' ? f : f.data)
    blocks.push(tarHeader(`package/${rel}`, data.length, typeof f === 'string' ? 0o644 : f.mode), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}
const manifest = (id: string, version: string, extra: object = {}): string => JSON.stringify({ id, version, apiVersion: 1, main: 'main.js', ...extra })
const pkgFiles = (version: string, extra: object = {}, id = 'tangu-computer-use') => ({
  'manifest.json': manifest(id, version, extra),
  'main.js': `v${version}`,
  'prebuilt/macos/arm64/bridge': { data: 'helper', mode: 0o755 },
})
const sri = (buf: Buffer): string => `sha512-${createHash('sha512').update(buf).digest('base64')}`
const packument = (version: string, integrity: string): Response =>
  new Response(JSON.stringify({ 'dist-tags': { latest: version }, versions: { [version]: { dist: { integrity, tarball: 'https://elsewhere.test/x.tgz' } } } }))

/** registry 路由表;没登记的一律 404。记录请求顺序,好断言走了哪条路。 */
function registry(routes: Record<string, () => Response>): { fetch: RegistryFetch; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url) => {
      calls.push(url)
      return routes[url]?.() ?? new Response('not found', { status: 404 })
    },
  }
}
const serve = (reg: string, version: string, buf: Buffer, integrity = sri(buf)): Record<string, () => Response> => ({
  [`${reg}/@forsion%2ftangu-computer-use`]: () => packument(version, integrity),
  [tarballUrl(reg, PKG, version)]: () => new Response(new Uint8Array(buf)),
})

let tmp: string
let src: string
let root: string
let logs: string[]
beforeEach(async () => {
  _resetBuiltinIdsForTest()
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-updates-'))
  src = path.join(tmp, 'bundled', 'tangu-computer-use')
  root = path.join(tmp, 'home', 'plugins')
  logs = []
  for (const [dir, version] of [[src, '0.5.5'], [path.join(root, 'tangu-computer-use'), '0.5.5']] as const) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'manifest.json'), manifest('tangu-computer-use', version))
    await fs.writeFile(path.join(dir, 'main.js'), `v${version}`)
  }
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const check = (fetch: RegistryFetch, extra: Partial<Parameters<typeof checkBuiltinUpdates>[0]> = {}) =>
  checkBuiltinUpdates({ pluginsRoot: root, sources: [src], appVersion: '2.11.5', registries: [R1, R2], fetch, platform: 'darwin', log: (m) => logs.push(m), ...extra })
const pending = (): string => pendingDirFor(root, src)

describe('checkBuiltinUpdates', () => {
  it('npm 上有更新版:下载进暂存区(保留可执行位),下次播种换上并清掉暂存区', async () => {
    const buf = tgz(pkgFiles('0.5.6'))
    const reg = registry(serve(R1, '0.5.6', buf))
    expect(await check(reg.fetch)).toEqual(['tangu-computer-use@0.5.6'])
    expect(JSON.parse(await fs.readFile(path.join(pending(), 'manifest.json'), 'utf8')).version).toBe('0.5.6')
    if (process.platform !== 'win32') expect((await fs.stat(path.join(pending(), 'prebuilt/macos/arm64/bridge'))).mode & 0o111).not.toBe(0)
    expect(reg.calls.some((u) => u.includes('elsewhere.test'))).toBe(false) // 不跟 packument 里的 tarball URL
    // 暂存区对两边加载器不可见:plugins/ 下除已装那份外只有点开头的目录
    expect((await fs.readdir(root)).filter((n) => !n.startsWith('.'))).toEqual(['tangu-computer-use'])

    const r = await seedBuiltinBundles(root, [src], { platform: 'darwin', appVersion: '2.11.5', log: (m) => logs.push(m) })
    expect(r.updated).toEqual(['tangu-computer-use'])
    expect(await fs.readFile(path.join(root, 'tangu-computer-use', 'main.js'), 'utf8')).toBe('v0.5.6')
    expect(await fs.readdir(root)).toEqual(['tangu-computer-use'])
    expect(logs.some((l) => l.includes('npm 更新'))).toBe(true)
  })

  it('已有暂存 0.5.6 再来 0.5.7:整目录换位,.pending/ 里不留 staging / old 残渣', async () => {
    const v6 = tgz(pkgFiles('0.5.6'))
    const v7 = tgz(pkgFiles('0.5.7'))
    expect(await check(registry(serve(R1, '0.5.6', v6)).fetch)).toEqual(['tangu-computer-use@0.5.6'])
    await fs.writeFile(path.join(pending(), 'only-in-0.5.6.txt'), 'old')
    expect(await check(registry(serve(R1, '0.5.7', v7)).fetch)).toEqual(['tangu-computer-use@0.5.7'])
    expect(await fs.readFile(path.join(pending(), 'main.js'), 'utf8')).toBe('v0.5.7')
    expect(await fs.stat(path.join(pending(), 'only-in-0.5.6.txt')).then(() => true, () => false)).toBe(false)
    expect(await fs.readdir(path.dirname(pending()))).toEqual(['tangu-computer-use'])
  })

  it('已是最新:只问 packument,不下载', async () => {
    const reg = registry(serve(R1, '0.5.5', tgz(pkgFiles('0.5.5'))))
    expect(await check(reg.fetch)).toEqual([])
    expect(reg.calls).toEqual([`${R1}/@forsion%2ftangu-computer-use`])
  })

  it('负对照:integrity 对不上 / 包内 id 不符 / 路径穿越 → 暂存区什么都不写', async () => {
    const good = tgz(pkgFiles('0.5.6'))
    for (const [name, buf, integrity] of [
      ['integrity', good, sri(tgz(pkgFiles('0.5.7')))],
      ['id', tgz(pkgFiles('0.5.6', {}, 'other-plugin')), undefined],
      ['traversal', tgz({ ...pkgFiles('0.5.6'), '../../../escape.js': 'x' }), undefined],
    ] as const) {
      logs = []
      expect(await check(registry(serve(R1, '0.5.6', buf, integrity)).fetch), name).toEqual([])
      expect(await fs.stat(pending()).then(() => true, () => false), name).toBe(false)
      expect(logs.join('\n'), name).toContain('检查更新失败')
    }
    expect(await fs.stat(path.join(tmp, 'home', 'escape.js')).then(() => true, () => false)).toBe(false)
  })

  it('宿主太旧(minAppVersion):不写暂存区,同一进程里不再重下', async () => {
    const buf = tgz(pkgFiles('0.5.8', { minAppVersion: '9.0.0' }))
    const reg = registry(serve(R1, '0.5.8', buf))
    expect(await check(reg.fetch)).toEqual([])
    expect(await fs.stat(pending()).then(() => true, () => false)).toBe(false)
    expect(logs.join('\n')).toContain('9.0.0')
    await check(reg.fetch)
    expect(reg.calls.filter((u) => u.endsWith('.tgz'))).toHaveLength(1)
  })

  it('registry 回退:第一个 503 → 第二个答复,tarball 先从答复的那个下;代理站回 HTML 也不当 tgz', async () => {
    const buf = tgz(pkgFiles('0.5.6'))
    const reg = registry({
      [`${R1}/@forsion%2ftangu-computer-use`]: () => new Response('busy', { status: 503 }),
      [`${R2}/@forsion%2ftangu-computer-use`]: () => packument('0.5.6', sri(buf)),
      [tarballUrl(R2, PKG, '0.5.6')]: () => new Response('<html>rate limited</html>'),
      [tarballUrl(R1, PKG, '0.5.6')]: () => new Response(new Uint8Array(buf)),
    })
    expect(await check(reg.fetch)).toEqual(['tangu-computer-use@0.5.6'])
    expect(reg.calls.filter((u) => u.endsWith('.tgz'))).toEqual([tarballUrl(R2, PKG, '0.5.6'), tarballUrl(R1, PKG, '0.5.6')])
  })

  it('不播种的平台不查;镜像开关决定 registry 顺序', async () => {
    const reg = registry(serve(R1, '0.5.6', tgz(pkgFiles('0.5.6'))))
    expect(await check(reg.fetch, { platform: 'linux' })).toEqual([])
    expect(reg.calls).toEqual([])
    expect(registryOrder('china')).toEqual([NPM_MIRROR, NPM_OFFICIAL])
    expect(registryOrder(undefined)).toEqual([NPM_OFFICIAL, NPM_MIRROR])
  })
})

describe('minitar 两份一致', () => {
  it('desktop 这份的正文逐字等于引擎那份(解第三方字节的安全边界,拒收规则不能漂移)', () => {
    const body = (file: string, header: number) => readFileSync(file, 'utf8').split('\n').slice(header).join('\n')
    expect(body(path.join(__dirname, 'minitar.ts'), 5)).toBe(body(path.join(__dirname, '../../tangu-agent/src/plugins/minitar.ts'), 1))
  })
})
