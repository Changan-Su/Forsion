import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadBuiltinDesktopEntries, type CloudHost } from './cloudHost'
import type { BuiltinSource } from './builtinPlugins'
import { signDir, testKeyPair } from './bundleSignature.testutil'

const key = testKeyPair()
let tmp: string
let root: string
let src: string
let logs: string[]
const write = async (dir: string, files: Record<string, string>): Promise<void> => {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), body)
  }
}
const manifest = (version: string, extra: object = {}, id = 'forsion-extend'): string => JSON.stringify({ id, version, apiVersion: 1, main: 'dist/main.js', ...extra })
/** 入口把收到的 host 挂到 globalThis,测试从那里断言;每份用不同的标记区分装的是哪一份。 */
const entry = (tag: string): string => `export function registerCloud(host) { globalThis.__extendLoaded = { tag: ${JSON.stringify(tag)}, host }; host.handle('account:quota', async () => ({ status: 401, json: null })) }`
const source = (): BuiltinSource => ({ pkg: '@forsion/extend', id: 'forsion-extend', platforms: ['darwin', 'win32', 'linux'], dir: src, desktop: { entry: 'dist/desktop.mjs', signingKey: key.publicKeyPem } })
const handled: string[] = []
const host: CloudHost = {
  getCloud: async () => ({ base: 'https://cloud.test', token: '' }),
  handle: (channel) => { handled.push(channel) },
  openExternal: async () => {},
  isTrustedSender: () => true,
  log: (m) => logs.push(m),
  projectsRoot: () => '/tmp/projects',
  transpileForServe: () => null,
  mimeOf: () => undefined,
  setPreviewHooks: () => {},
  readCreds: () => ({ cloudUrl: '', token: '' }),
  accountId: () => null,
  registerRemoteSyncBackend: () => {},
  homeDir: () => '/tmp/forsion-home',
  appVersion: () => '2.11.5',
  broadcast: () => {},
  accountBackendState: async () => null,
  accountTransition: (fn) => fn(),
  accountCommit: async () => {},
  accountClear: async () => {},
  writeCreds: () => {},
  onExternalCredsChange: () => {},
  setTokenRefresher: () => {},
  setAmadeusSyncFactory: () => {},
}
const imported: string[] = []
const load = () => loadBuiltinDesktopEntries({
  pluginsRoot: root, sources: [source()], appVersion: '2.11.5', host, log: (m) => logs.push(m), tempRoot: tmp,
  importer: (file) => { imported.push(file); return import(/* @vite-ignore */ `${pathToFileURL(file).href}?t=${Date.now()}`) },
})

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-host-'))
  root = path.join(tmp, 'plugins')
  src = path.join(tmp, 'bundled', 'extend')
  logs = []
  handled.length = 0
  delete (globalThis as Record<string, unknown>).__extendLoaded
  await write(src, { 'manifest.json': manifest('0.1.0'), 'dist/main.js': '// r', 'dist/desktop.mjs': entry('bundled') })
  await signDir(src, key.privateKey)
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('loadBuiltinDesktopEntries', () => {
  it('签过的随包副本:验过的字节写进一次性私有临时文件再 import(不是从可写的插件目录 import),registerCloud 拿到宿主接缝并注册通道', async () => {
    imported.length = 0
    expect(await load()).toEqual(['forsion-extend'])
    const g = (globalThis as Record<string, any>).__extendLoaded
    expect(g?.tag).toBe('bundled')
    expect(g?.host).toBe(host)
    expect(handled).toEqual(['account:quota'])
    expect(logs.join('\n')).toContain('已装载 forsion-extend@0.1.0')
    expect(imported).toHaveLength(1)
    expect(path.dirname(imported[0])).toMatch(new RegExp(`^${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cloud-host-`))
    expect(await fs.stat(imported[0]).then(() => true, () => false)).toBe(false) // 用完即删
  })

  it('负对照:manifest.json 没被签到(只签入口)→ 拒(未签的 minAppVersion / 版本号能改装载判断)', async () => {
    await signDir(src, key.privateKey, ['dist/desktop.mjs', 'dist/main.js'])
    expect(await load()).toEqual([])
    expect(logs.join('\n')).toContain('manifest.json is not covered')
  })

  it('已装副本(npm 更新换上的新版)优先于随包:装已装那份', async () => {
    const installed = path.join(root, 'forsion-extend')
    await write(installed, { 'manifest.json': manifest('0.2.0'), 'dist/main.js': '// r', 'dist/desktop.mjs': entry('installed') })
    await signDir(installed, key.privateKey)
    expect(await load()).toEqual(['forsion-extend'])
    expect((globalThis as Record<string, any>).__extendLoaded?.tag).toBe('installed')
  })

  it('已装副本被改过(用户目录可写):退回随包那份,云端面不消失', async () => {
    const installed = path.join(root, 'forsion-extend')
    await write(installed, { 'manifest.json': manifest('0.2.0'), 'dist/main.js': '// r', 'dist/desktop.mjs': entry('evil') })
    expect(await load()).toEqual(['forsion-extend'])
    expect((globalThis as Record<string, any>).__extendLoaded?.tag).toBe('bundled')
    expect(logs.join('\n')).toContain('验签失败')
  })

  it('负对照:入口被改 / 未签名 / 换了签名密钥 / manifest id 不符 / 宿主太旧 / 入口没导出 registerCloud → 不装,不抛,原因进 log', async () => {
    const cases: Array<[string, () => Promise<void>, string]> = [
      ['tamper', async () => { await write(src, { 'dist/desktop.mjs': entry('evil') }) }, '验签失败'],
      ['unsigned', async () => { await fs.rm(path.join(src, 'SIGNATURE')) }, '验签失败'],
      ['other key', async () => { await signDir(src, testKeyPair().privateKey) }, '验签失败'],
      ['id', async () => { await write(src, { 'manifest.json': manifest('0.1.0', {}, 'someone-else') }); await signDir(src, key.privateKey) }, 'id=someone-else'],
      ['minApp', async () => { await write(src, { 'manifest.json': manifest('0.1.0', { minAppVersion: '9.0.0' }) }); await signDir(src, key.privateKey) }, '宿主 ≥ 9.0.0'],
      ['no export', async () => { await write(src, { 'manifest.json': manifest('0.1.0'), 'dist/desktop.mjs': 'export const nothing = 1' }); await signDir(src, key.privateKey) }, '没有导出 registerCloud'],
    ]
    for (const [name, mutate, reason] of cases) {
      logs = []
      delete (globalThis as Record<string, unknown>).__extendLoaded
      await mutate()
      expect(await load(), name).toEqual([])
      expect((globalThis as Record<string, unknown>).__extendLoaded, name).toBeUndefined()
      expect(logs.join('\n'), name).toContain(reason)
    }
  })

  it('清单项没有 desktop 字段(电脑操作那类)→ 根本不碰', async () => {
    const { desktop: _d, ...cu } = source()
    expect(await loadBuiltinDesktopEntries({ pluginsRoot: root, sources: [cu], appVersion: '2.11.5', host, tempRoot: tmp, log: (m) => logs.push(m) })).toEqual([])
    expect(logs).toEqual([])
  })
})
