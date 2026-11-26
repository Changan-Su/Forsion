/**
 * ctx.storage 的渲染层半(2026-11-26):绑插件 id 与库、整理字节、url 同步拼地址、停用后拒绝、importFromVault 的来源与层。
 */
import { describe, expect, it, vi } from 'vitest'
import { storageVaultKey, type PluginStorageRequest } from '@amadeus-shared/pluginStorage'
import { createPluginStorage } from './pluginStorageCtx'

function setup(over: Partial<Parameters<typeof createPluginStorage>[0]> = {}) {
  const calls: PluginStorageRequest[] = []
  let alive = true
  let vault: string | null = '/V'
  const storage = createPluginStorage({
    pluginId: 'demo',
    alive: () => alive,
    call: vi.fn(async (r: PluginStorageRequest) => { calls.push(r); return r.op === 'readBytes' ? new Uint8Array([7]).buffer : null }),
    url: (id, rel) => `amadeus-asset://plugin-data/${id}/${rel}`,
    vaultRoot: () => vault,
    importRoots: () => ['Plugins/demo', 'Notes/Demo'],
    ...over,
  })
  return { storage, calls, kill: () => { alive = false }, setVault: (v: string | null) => { vault = v } }
}

describe('ctx.storage (renderer half)', () => {
  it('binds the plugin id; the app layer carries no vault', async () => {
    const { storage, calls } = setup()
    await storage.write('a.txt', 'hi')
    await storage.list()
    expect(calls).toEqual([
      { id: 'demo', op: 'write', path: 'a.txt', data: 'hi' },
      { id: 'demo', op: 'list', path: '' },
    ])
  })

  it('passes bytes as a tight Uint8Array (sub-views copied, ArrayBuffer wrapped); rejects other data', async () => {
    const { storage, calls } = setup()
    const big = new Uint8Array([1, 2, 3, 4, 5])
    await storage.write('a', big.subarray(1, 3))
    await storage.write('b', new Uint16Array([1]).buffer)
    const [a, b] = calls.map((c) => (c as { data: Uint8Array }).data)
    expect([...a]).toEqual([2, 3])
    expect(a.buffer.byteLength).toBe(2)
    expect(b).toBeInstanceOf(Uint8Array)
    await expect(storage.write('c', { not: 'bytes' } as unknown as string)).rejects.toThrow(TypeError)
  })

  it('readBytes always resolves to a Uint8Array (or null)', async () => {
    const { storage } = setup()
    const out = await storage.readBytes('x')
    expect(out).toBeInstanceOf(Uint8Array)
    expect([...out!]).toEqual([7])
  })

  it('vault() binds the current vault; its url() goes under vaults/<key>/', async () => {
    const { storage, calls, setVault } = setup()
    const v = storage.vault()!
    await v.readText('s.json')
    expect(calls[0]).toEqual({ id: 'demo', vault: '/V', op: 'readText', path: 's.json' })
    expect(v.vault()).toBe(v)
    expect(v.url('img/a b.png')).toBe(`amadeus-asset://plugin-data/demo/vaults/${storageVaultKey('/V')}/img/a b.png`)
    expect(storage.url('cache/x.png')).toBe('amadeus-asset://plugin-data/demo/cache/x.png')
    setVault(null)
    expect(storage.vault()).toBeNull()
  })

  it('url() validates the path synchronously and is null when the host cannot serve files', () => {
    const { storage } = setup()
    expect(() => storage.url('../x')).toThrow(TypeError)
    expect(() => storage.url('vaults/x')).toThrow(TypeError)
    expect(setup({ url: undefined }).storage.url('a.png')).toBeNull()
  })

  it('rejects every call after the plugin is turned off', async () => {
    const { storage, calls, kill } = setup()
    const v = storage.vault()!
    kill()
    await expect(storage.readText('a')).rejects.toThrow('plugin-disposed')
    await expect(v.write('a', 'x')).rejects.toThrow('plugin-disposed')
    await expect(storage.importFromVault({ id: 'm1', from: 'Plugins/demo/x' })).rejects.toThrow('plugin-disposed')
    expect(calls).toEqual([])
    expect(storage.url('a.png')).toBeNull()
    expect(storage.vault()).toBeNull()
    expect(v.vault()).toBeNull()
  })

  it('hostPath: only when the engine runs on this computer; validates the path; null after disable', async () => {
    const off = setup()
    expect(await off.storage.hostPath!('tools')).toBeNull() // 缺省没开本机执行这道门
    await expect(off.storage.hostPath!('../x')).rejects.toThrow(TypeError) // 门关着也照样拒不合法路径
    await expect(off.storage.hostPath!(null as unknown as string)).rejects.toThrow(TypeError) // null 不当根
    expect(off.calls).toEqual([])
    const calls: PluginStorageRequest[] = []
    let alive = true
    const on = createPluginStorage({
      pluginId: 'demo', alive: () => alive, hostExec: () => true,
      call: async (r) => { calls.push(r); return '/abs/demo/tools' },
      vaultRoot: () => '/V', importRoots: () => [],
    })
    expect(await on.hostPath!('tools')).toBe('/abs/demo/tools')
    expect(await on.vault()!.hostPath!()).toBe('/abs/demo/tools')
    expect(calls).toEqual([{ id: 'demo', op: 'hostPath', path: 'tools' }, { id: 'demo', vault: '/V', op: 'hostPath', path: '' }])
    await expect(on.hostPath!('../x')).rejects.toThrow(TypeError)
    await expect(on.hostPath!('vaults/x')).rejects.toThrow(TypeError)
    alive = false
    expect(await on.hostPath!('tools')).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('hostPath: a reply that lands after disable or an engine switch is dropped', async () => {
    let alive = true, local = true
    let release!: (v: string) => void
    const s = createPluginStorage({
      pluginId: 'demo', alive: () => alive, hostExec: () => local,
      call: () => new Promise((r) => { release = r as (v: string) => void }),
      vaultRoot: () => null, importRoots: () => [],
    })
    const a = s.hostPath!('tools')
    local = false; release('/abs/demo/tools')
    expect(await a).toBeNull()
    local = true
    const b = s.hostPath!('tools')
    alive = false; release('/abs/demo/tools')
    expect(await b).toBeNull()
  })

  it('importFromVault sends this plugin\'s folders and the target layer', async () => {
    const { storage, calls, setVault } = setup()
    await storage.importFromVault({ id: 'drafts-v1', from: 'Plugins/demo/drafts', to: 'drafts' })
    await storage.vault()!.importFromVault({ id: 'state-v1', from: 'Plugins/demo/state.json', to: 'state.json' })
    expect(calls).toEqual([
      { id: 'demo', op: 'import', vault: '/V', from: 'Plugins/demo/drafts', to: 'drafts', migration: 'drafts-v1', allowed: ['Plugins/demo', 'Notes/Demo'], into: 'app' },
      { id: 'demo', op: 'import', vault: '/V', from: 'Plugins/demo/state.json', to: 'state.json', migration: 'state-v1', allowed: ['Plugins/demo', 'Notes/Demo'], into: 'vault' },
    ])
    setVault(null)
    await expect(storage.importFromVault({ id: 'x', from: 'Plugins/demo' })).rejects.toThrow('No vault')
  })
})
