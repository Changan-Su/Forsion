/**
 * 插件数据文件夹的主进程半(ctx.storage,2026-11-26):真临时目录 + 真 fs。
 * 钉住:路径钳在插件文件夹里(`..` / 绝对路径 / 软链出逃都拒)、读失败 ≠ 没有、两层互不相见、
 * 清缓存只清 cache/、从库复制进来只做一次且不覆盖不同内容、库换了就拒。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storageVaultKey } from '@amadeus-shared/pluginStorage'
import { createPluginStorageHost, resolvePluginDataAsset } from './pluginStorage'

let tmp = '', base = '', vault = ''
let current: string | null = null
let opened: string[] = []
const host = () => createPluginStorageHost({ base: () => base, vaultRoot: () => current, openFolder: (abs) => { opened.push(abs) } })

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-storage-')))
  base = path.join(tmp, 'plugin-data')
  vault = path.join(tmp, 'vault')
  await fs.mkdir(vault, { recursive: true })
  current = vault
  opened = []
})
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

const td = new TextDecoder()

describe('read / write', () => {
  it('round-trips text and bytes, creating folders on demand', async () => {
    const h = host()
    await h.handle({ id: 'demo', op: 'write', path: 'drafts/a.json', data: '{"x":1}' })
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'drafts/a.json' })).toBe('{"x":1}')
    await h.handle({ id: 'demo', op: 'write', path: 'cache/shot.png', data: new Uint8Array([1, 2, 3]) })
    const b = await h.handle({ id: 'demo', op: 'readBytes', path: 'cache/shot.png' }) as Uint8Array
    expect([...b]).toEqual([1, 2, 3])
    expect(await fs.readFile(path.join(base, 'demo', 'drafts', 'a.json'), 'utf8')).toBe('{"x":1}')
  })

  it('appends, and concurrent writes to one file all land in order', async () => {
    const h = host()
    await Promise.all([1, 2, 3, 4].map((n) => h.handle({ id: 'demo', op: 'append', path: 'log.txt', data: `${n}\n` })))
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'log.txt' })).toBe('1\n2\n3\n4\n')
    await Promise.all(['a', 'b', 'c'].map((x) => h.handle({ id: 'demo', op: 'write', path: 'w.txt', data: x })))
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'w.txt' })).toBe('c')
    expect((await fs.readdir(path.join(base, 'demo'))).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('missing → null; any other read error is thrown, not treated as empty', async () => {
    const h = host()
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'nope.txt' })).toBeNull()
    expect(await h.handle({ id: 'demo', op: 'stat', path: 'nope.txt' })).toBeNull()
    await h.handle({ id: 'demo', op: 'write', path: 'dir/x.txt', data: 'x' })
    await expect(h.handle({ id: 'demo', op: 'readText', path: 'dir' })).rejects.toThrow() // EISDIR ≠ 没有
  })

  it('rejects paths that leave the folder, bad ids and the reserved vaults/ folder', async () => {
    const h = host()
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '/a', '\\a', 'C:/x', 'c:\\x', '\\\\srv\\x', '//srv/x', 'a//b', './a', '', 'vaults/x']) {
      await expect(h.handle({ id: 'demo', op: 'write', path: bad, data: 'x' }), bad).rejects.toThrow()
    }
    await expect(h.handle({ id: '../demo', op: 'readText', path: 'a' })).rejects.toThrow('Invalid plugin id')
    await expect(h.handle({ id: 'Demo', op: 'readText', path: 'a' })).rejects.toThrow('Invalid plugin id')
    await expect(h.handle({ id: 'demo', op: 'remove', path: '' })).rejects.toThrow()
    expect(await h.handle({ id: 'demo', op: 'list', path: 'missing/' })).toEqual([]) // 末尾斜杠照收
  })

  it('refuses to follow a symlink planted inside the folder that points outside', async () => {
    const h = host()
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'S')
    await fs.mkdir(path.join(base, 'demo'), { recursive: true })
    await fs.symlink(outside, path.join(base, 'demo', 'link'))
    await expect(h.handle({ id: 'demo', op: 'readText', path: 'link/secret.txt' })).rejects.toThrow('leaves its folder')
    await expect(h.handle({ id: 'demo', op: 'write', path: 'link/new.txt', data: 'x' })).rejects.toThrow('leaves its folder')
    await expect(fs.access(path.join(outside, 'new.txt'))).rejects.toThrow()
    expect(await h.handle({ id: 'demo', op: 'list' })).toEqual([]) // 软链不列
  })
})

describe('list / stat / move / remove', () => {
  it('lists one level, sorted, hiding temp files and the vault partition', async () => {
    const h = host()
    await h.handle({ id: 'demo', op: 'write', path: 'b.txt', data: 'bb' })
    await h.handle({ id: 'demo', op: 'write', path: 'a/inner.txt', data: 'x' })
    await h.handle({ id: 'demo', vault, op: 'write', path: 'v.txt', data: 'v' })
    await fs.writeFile(path.join(base, 'demo', 'c.txt.tmp-1-2'), 'half')
    const top = await h.handle({ id: 'demo', op: 'list' }) as Array<{ name: string; kind: string; size: number; path: string }>
    expect(top.map((e) => [e.name, e.kind, e.size])).toEqual([['a', 'folder', 0], ['b.txt', 'file', 2]])
    const inner = await h.handle({ id: 'demo', op: 'list', path: 'a' }) as Array<{ path: string }>
    expect(inner.map((e) => e.path)).toEqual(['a/inner.txt'])
    expect(await h.handle({ id: 'demo', op: 'list', path: 'missing' })).toEqual([])
    expect(await h.handle({ id: 'demo', op: 'stat', path: 'a' })).toMatchObject({ kind: 'folder', size: 0 })
  })

  it('moves without overwriting, refuses a folder into itself, removes recursively', async () => {
    const h = host()
    await h.handle({ id: 'demo', op: 'write', path: 'a/x.txt', data: 'x' })
    await h.handle({ id: 'demo', op: 'write', path: 'b.txt', data: 'b' })
    await expect(h.handle({ id: 'demo', op: 'move', path: 'a/x.txt', to: 'b.txt' })).rejects.toThrow('already exists')
    await expect(h.handle({ id: 'demo', op: 'move', path: 'a', to: 'a/sub' })).rejects.toThrow('into itself')
    await h.handle({ id: 'demo', op: 'move', path: 'a', to: 'z/a2' })
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'z/a2/x.txt' })).toBe('x')
    await h.handle({ id: 'demo', op: 'remove', path: 'z' })
    expect(await h.handle({ id: 'demo', op: 'stat', path: 'z' })).toBeNull()
    await h.handle({ id: 'demo', op: 'remove', path: 'never-existed' }) // 不存在照样成功
  })
})

describe('review fixes (2026-11-26 Codex)', () => {
  it('reserved names are case-insensitive; the vault layer reserves .forsion-imports', async () => {
    const h = host()
    await expect(h.handle({ id: 'demo', op: 'write', path: 'Vaults/x/state.json', data: 'x' })).rejects.toThrow(TypeError)
    await expect(h.handle({ id: 'demo', vault, op: 'write', path: '.forsion-imports/m.json', data: '{}' })).rejects.toThrow(TypeError)
    await expect(h.handle({ id: 'demo', vault, op: 'remove', path: '.Forsion-Imports' })).rejects.toThrow(TypeError)
    await h.handle({ id: 'demo', op: 'write', path: '.forsion-imports/ok.json', data: '1' }) // 跟应用那层不保留它
  })

  it('a file whose name starts with ".." is a normal file, not an escape', async () => {
    const h = host()
    await h.handle({ id: 'demo', op: 'write', path: '..drafts', data: 'd' })
    expect(await h.handle({ id: 'demo', op: 'readText', path: '..drafts' })).toBe('d')
    await h.handle({ id: 'demo', op: 'remove', path: '..drafts' })
    expect(resolvePluginDataAsset(base, '/demo/..drafts')).toBe(path.join(base, 'demo', '..drafts'))
  })

  it('concurrent moves to the same target: exactly one wins, nothing is overwritten', async () => {
    const h = host()
    await h.handle({ id: 'demo', op: 'write', path: 'a', data: 'A' })
    await h.handle({ id: 'demo', op: 'write', path: 'b', data: 'B' })
    const r = await Promise.allSettled([h.handle({ id: 'demo', op: 'move', path: 'a', to: 'out' }), h.handle({ id: 'demo', op: 'move', path: 'b', to: 'out' })])
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'rejected'])
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'out' })).toBe('A')
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'b' })).toBe('B')
  })

  it('write then append under a different letter case keep their order (one queue per plugin)', async () => {
    const h = host()
    await Promise.all([
      h.handle({ id: 'demo', op: 'write', path: 'log.txt', data: 'base\n' }),
      h.handle({ id: 'demo', op: 'append', path: 'log.txt', data: 'tail\n' }),
    ])
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'log.txt' })).toBe('base\ntail\n')
  })

  it('clear cache leaves a regular file named cache alone and does not follow a vaults symlink', async () => {
    const h = host()
    await h.handle({ id: 'demo', op: 'write', path: 'cache', data: 'KEEP' })
    const outside = path.join(tmp, 'elsewhere')
    await fs.mkdir(path.join(outside, 'proj', 'cache'), { recursive: true })
    await fs.writeFile(path.join(outside, 'proj', 'cache', 'x'), 'X')
    await fs.symlink(outside, path.join(base, 'demo', 'vaults'))
    expect(await h.handle({ id: 'demo', op: 'usage' })).toMatchObject({ cacheBytes: 0 })
    await h.handle({ id: 'demo', op: 'clearCache' })
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'cache' })).toBe('KEEP')
    expect(await fs.readFile(path.join(outside, 'proj', 'cache', 'x'), 'utf8')).toBe('X')
  })

  it('two imports of the same migration run one after the other: the second is already-done', async () => {
    const h = host()
    await fs.mkdir(path.join(vault, 'Plugins', 'demo', 'd'), { recursive: true })
    await fs.writeFile(path.join(vault, 'Plugins', 'demo', 'd', 'a'), 'A')
    const req = (to: string) => ({ id: 'demo', op: 'import' as const, vault, from: 'Plugins/demo/d', to, migration: 'same', allowed: ['Plugins/demo'], into: 'app' as const })
    const [a, b] = await Promise.all([h.handle(req('one')), h.handle(req('two'))]) as Array<{ status: string }>
    expect([a.status, b.status]).toEqual(['complete', 'already-done'])
    expect(await h.handle({ id: 'demo', op: 'stat', path: 'two' })).toBeNull()
  })

  it('an unrecognised record or a non-folder .forsion-imports rejects instead of re-running', async () => {
    const h = host()
    await fs.mkdir(path.join(vault, 'Plugins', 'demo'), { recursive: true })
    await fs.writeFile(path.join(vault, 'Plugins', 'demo', 'a'), 'A')
    const layer = path.join(base, 'demo', 'vaults', storageVaultKey(vault))
    const req = (migration: string) => ({ id: 'demo', op: 'import' as const, vault, from: 'Plugins/demo/a', to: 'a', migration, allowed: ['Plugins/demo'], into: 'app' as const })
    await fs.mkdir(path.join(layer, '.forsion-imports'), { recursive: true })
    await fs.writeFile(path.join(layer, '.forsion-imports', 'm1.json'), '{}')
    await expect(h.handle(req('m1'))).rejects.toThrow('Unrecognised import record')
    await fs.rm(path.join(layer, '.forsion-imports'), { recursive: true })
    await fs.writeFile(path.join(layer, '.forsion-imports'), 'not a folder')
    await expect(h.handle(req('m2'))).rejects.toThrow()
    expect(await h.handle({ id: 'demo', op: 'stat', path: 'a' })).toBeNull() // 什么都没复制
  })
})

describe('vault layer', () => {
  it('lives under vaults/<key>/, is invisible from the app layer, and refuses once the vault changed', async () => {
    const h = host()
    await h.handle({ id: 'demo', vault, op: 'write', path: 'state.json', data: '1' })
    expect(await fs.readFile(path.join(base, 'demo', 'vaults', storageVaultKey(vault), 'state.json'), 'utf8')).toBe('1')
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'state.json' })).toBeNull()
    current = path.join(tmp, 'other')
    await expect(h.handle({ id: 'demo', vault, op: 'readText', path: 'state.json' })).rejects.toThrow('Vault changed')
    current = null
    await expect(h.handle({ id: 'demo', vault, op: 'write', path: 'x', data: '1' })).rejects.toThrow('Vault changed')
  })
})

describe('usage / clearCache / reveal', () => {
  it('counts both layers and clears only cache/ folders', async () => {
    const h = host()
    expect(await h.handle({ id: 'demo', op: 'usage' })).toEqual({ bytes: 0, cacheBytes: 0 })
    await h.handle({ id: 'demo', op: 'write', path: 'keep.txt', data: '12345' })
    await h.handle({ id: 'demo', op: 'write', path: 'cache/a.bin', data: new Uint8Array(10) })
    await h.handle({ id: 'demo', vault, op: 'write', path: 'cache/b.bin', data: new Uint8Array(7) })
    await h.handle({ id: 'demo', vault, op: 'write', path: 'v.txt', data: 'abc' })
    expect(await h.handle({ id: 'demo', op: 'usage' })).toEqual({ bytes: 25, cacheBytes: 17 })
    expect(await h.handle({ id: 'demo', op: 'clearCache' })).toEqual({ bytes: 8, cacheBytes: 0 })
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'keep.txt' })).toBe('12345')
    expect(await h.handle({ id: 'demo', vault, op: 'readText', path: 'v.txt' })).toBe('abc')
  })

  it('reveal opens the folder only when it exists', async () => {
    const h = host()
    expect(await h.handle({ id: 'demo', op: 'reveal' })).toBe(false)
    await h.handle({ id: 'demo', op: 'write', path: 'a', data: '1' })
    expect(await h.handle({ id: 'demo', op: 'reveal' })).toBe(true)
    expect(opened).toEqual([path.join(base, 'demo')])
  })
})

describe('importFromVault', () => {
  const imp = (over: Record<string, unknown> = {}) => ({
    id: 'demo', op: 'import' as const, vault, from: 'Plugins/demo/drafts', to: 'drafts', migration: 'drafts-v1',
    allowed: ['Plugins/demo'], into: 'app' as const, ...over,
  })

  beforeEach(async () => {
    await fs.mkdir(path.join(vault, 'Plugins', 'demo', 'drafts', 'sub'), { recursive: true })
    await fs.writeFile(path.join(vault, 'Plugins', 'demo', 'drafts', 'a.json'), 'A')
    await fs.writeFile(path.join(vault, 'Plugins', 'demo', 'drafts', 'sub', 'b.png'), 'B')
  })

  it('copies once, keeps the originals, and reports already-done afterwards', async () => {
    const h = host()
    expect(await h.handle(imp())).toEqual({ status: 'complete', copied: 2, skipped: [] })
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'drafts/sub/b.png' })).toBe('B')
    expect(await fs.readFile(path.join(vault, 'Plugins', 'demo', 'drafts', 'a.json'), 'utf8')).toBe('A') // 原件留着
    await fs.writeFile(path.join(vault, 'Plugins', 'demo', 'drafts', 'c.json'), 'C')
    expect(await h.handle(imp())).toEqual({ status: 'already-done', copied: 2, skipped: [] })
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'drafts/c.json' })).toBeNull()
    const log = JSON.parse(await fs.readFile(path.join(base, 'demo', 'vaults', storageVaultKey(vault), '.forsion-imports', 'drafts-v1.json'), 'utf8'))
    expect(log).toMatchObject({ status: 'complete', copied: 2, from: 'Plugins/demo/drafts', to: 'drafts' })
    // 完成记录不出现在库那一层的列表里
    expect(await h.handle({ id: 'demo', vault, op: 'list' })).toEqual([])
  })

  it('never overwrites a target with different content; same content counts as copied', async () => {
    const h = host()
    await h.handle({ id: 'demo', op: 'write', path: 'drafts/a.json', data: 'MINE' })
    await h.handle({ id: 'demo', op: 'write', path: 'drafts/sub/b.png', data: 'B' })
    expect(await h.handle(imp())).toEqual({ status: 'complete', copied: 1, skipped: ['drafts/a.json'] })
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'drafts/a.json' })).toBe('MINE')
  })

  it('missing source → missing, nothing recorded (a later run still imports)', async () => {
    const h = host()
    expect(await h.handle(imp({ from: 'Plugins/demo/none' }))).toEqual({ status: 'missing', copied: 0, skipped: [] })
    expect(await h.handle(imp({ from: 'Plugins/demo/none', migration: 'drafts-v1' }))).toMatchObject({ status: 'missing' })
    expect(await h.handle(imp())).toMatchObject({ status: 'complete', copied: 2 })
  })

  it('an unreadable completion record is an error, not "never done"', async () => {
    const h = host()
    const logDir = path.join(base, 'demo', 'vaults', storageVaultKey(vault), '.forsion-imports')
    await fs.mkdir(logDir, { recursive: true })
    await fs.writeFile(path.join(logDir, 'drafts-v1.json'), '') // 零字节(断电)
    await expect(h.handle(imp())).rejects.toThrow()
    expect(await h.handle({ id: 'demo', op: 'stat', path: 'drafts' })).toBeNull()
  })

  it('only reads from this plugin\'s own folders, validates the id, and checks the vault', async () => {
    const h = host()
    await fs.mkdir(path.join(vault, 'Notes'), { recursive: true })
    await expect(h.handle(imp({ from: 'Notes' }))).rejects.toThrow('working folder')
    await expect(h.handle(imp({ from: 'Plugins/demo-evil' }))).rejects.toThrow('working folder')
    await expect(h.handle(imp({ from: 'Plugins/demo/../../x' }))).rejects.toThrow()
    await expect(h.handle(imp({ migration: '../x' }))).rejects.toThrow('Invalid migration id')
    await expect(h.handle(imp({ vault: path.join(tmp, 'other') }))).rejects.toThrow('Vault changed')
  })

  it('imports a single file to a file path, and into the vault layer', async () => {
    const h = host()
    expect(await h.handle(imp({ from: 'Plugins/demo/drafts/a.json', to: 'one.json', migration: 'one' }))).toMatchObject({ status: 'complete', copied: 1 })
    expect(await h.handle({ id: 'demo', op: 'readText', path: 'one.json' })).toBe('A')
    await expect(h.handle(imp({ from: 'Plugins/demo/drafts/a.json', to: '', migration: 'two' }))).rejects.toThrow('target file path')
    expect(await h.handle(imp({ into: 'vault', to: '', migration: 'v' }))).toMatchObject({ status: 'complete', copied: 2 })
    expect(await h.handle({ id: 'demo', vault, op: 'readText', path: 'a.json' })).toBe('A')
  })

  it('does not write into reserved folders (vaults/ on the app layer)', async () => {
    const h = host()
    await fs.mkdir(path.join(vault, 'Plugins', 'demo', 'vaults'), { recursive: true })
    await fs.writeFile(path.join(vault, 'Plugins', 'demo', 'vaults', 'x.txt'), 'X')
    const r = await h.handle(imp({ from: 'Plugins/demo', to: '', migration: 'all' })) as { skipped: string[] }
    expect(r.skipped).toContain('vaults/x.txt')
    await expect(fs.access(path.join(base, 'demo', 'vaults', 'x.txt'))).rejects.toThrow()
  })
})

describe('resolvePluginDataAsset', () => {
  it('maps <id>/<path> into the folder and rejects escapes', () => {
    expect(resolvePluginDataAsset(base, '/demo/cache/a.png')).toBe(path.join(base, 'demo', 'cache', 'a.png'))
    expect(resolvePluginDataAsset(base, `/demo/vaults/${storageVaultKey(vault)}/x.png`)).toBe(path.join(base, 'demo', 'vaults', storageVaultKey(vault), 'x.png'))
    for (const bad of ['/demo', '/demo/', '/../x', '/demo/../other/x', '/Demo/x', '/demo/a//b']) expect(resolvePluginDataAsset(base, bad), bad).toBeNull()
  })
})
