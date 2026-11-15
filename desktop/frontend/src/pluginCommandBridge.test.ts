// @vitest-environment happy-dom
/**
 * 插件命令(2026-11-16):registerCommand 回 disposer、同 id 原位替换,命令桥跟着加 / 换 / 撤;
 * 插件默认键(hotkey)只在没人用这个键时进命令表,撞上内置命令 / 用户的键就不进,键空出来自己生效;
 * ctx.net 只在宿主桥有 pluginNetRequest 时注入,失败还原成带 code 的 Error,停用后在途请求作废。
 * 负对照(实跑过):桥里把 hotkey 无条件透传 → 「撞上内置命令不进命令表」与分发那条红;
 * disposer 改成按 id 撤 → 「旧 disposer 碰不到替换后的那条」红;只重加变了的那条 → 「顺序不漂」红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalPluginSource, PluginNetIpcResult } from '@amadeus-shared/ipc'

const env = vi.hoisted(() => ({
  sources: [] as ExternalPluginSource[],
  net: null as null | ((pluginId: string, url: string, init?: unknown) => Promise<PluginNetIpcResult>),
}))
vi.mock('./amadeus/api', () => ({
  amadeus: {
    listPlugins: async () => env.sources,
    listPages: async () => [],
    listFiles: async () => [],
    get pluginNetRequest() { return env.net ?? undefined },
  },
}))
const { usePluginStore } = await import('./amadeus/plugins/pluginStore')
const { installPluginCommandBridge } = await import('./pluginCommandBridge')
const { usePluginHotkeys } = await import('./pluginHotkeyStore')
const { addCommand, removeCommand, useCommandStore, useShortcuts, installHotkeys } = await import('@lcl/engine')

type Ctx = {
  registerCommand(c: { id: string; title: string; run(): void; hotkey?: string }): () => void
  net?: { request(url: string, init?: unknown): Promise<{ status: number; text(): string; json<T>(): T; bytes: Uint8Array; url: string }> }
}
const g = globalThis as unknown as { __ctx: Ctx; __ran: string[] }
const st = () => usePluginStore.getState()
const engine = (id: string) => useCommandStore.getState().commands.filter((c) => c.id === id)
const load = async (id = 'tpl'): Promise<Ctx> => {
  env.sources = [{ id, name: id, version: '1.0.0', apiVersion: 1, code: 'globalThis.__ctx = ctx' }]
  await st().loadExternal()
  return g.__ctx
}
const run = (name: string) => () => void g.__ran.push(name)

let uninstall: (() => void) | null = null
beforeEach(() => {
  localStorage.clear()
  useShortcuts.getState().resetAll()
  usePluginStore.setState({ plugins: [], activeIds: [], disabledIds: [], disposers: {}, lastSetupError: {}, initialized: false, themes: [], commands: [] })
  useCommandStore.setState({ commands: [] })
  env.sources = []
  env.net = null
  g.__ran = []
  uninstall = installPluginCommandBridge()
})
afterEach(() => { uninstall?.(); uninstall = null })

describe('registerCommand: disposer and same-id replace', () => {
  it('replaces in place, and only the latest disposer removes it', async () => {
    const ctx = await load()
    const off1 = ctx.registerCommand({ id: 'a', title: 'One', run: run('one') })
    ctx.registerCommand({ id: 'b', title: 'B', run: run('b') })
    const off2 = ctx.registerCommand({ id: 'a', title: 'Two', run: run('two') })
    expect(st().commands.map((o) => [o.item.id, o.item.title])).toEqual([['a', 'Two'], ['b', 'B']])
    expect(engine('amadeus:tpl:a').map((c) => c.title)).toEqual(['Two'])
    off1() // 被替换掉的那次登记:空操作
    expect(engine('amadeus:tpl:a')).toHaveLength(1)
    useCommandStore.getState().run('amadeus:tpl:a')
    expect(g.__ran).toEqual(['two'])
    off2()
    expect(st().commands.map((o) => o.item.id)).toEqual(['b'])
    expect(engine('amadeus:tpl:a')).toHaveLength(0)
    off2() // 幂等
    expect(engine('amadeus:tpl:b')).toHaveLength(1)
  })

  it('keeps engine order stable across a replace and a hotkey switching on', async () => {
    const ctx = await load()
    ctx.registerCommand({ id: 'a', title: 'A', run: run('a') })
    ctx.registerCommand({ id: 'b', title: 'B', hotkey: 'mod+shift+y', run: run('b') })
    ctx.registerCommand({ id: 'c', title: 'C', run: run('c') })
    addCommand({ id: 'holder', title: 'Holder', hotkey: 'mod+shift+y', run: run('holder') })
    const order = () => useCommandStore.getState().commands.filter((c) => c.id.startsWith('amadeus:tpl:')).map((c) => c.id)
    expect(order()).toEqual(['amadeus:tpl:a', 'amadeus:tpl:b', 'amadeus:tpl:c'])
    ctx.registerCommand({ id: 'a', title: 'A2', run: run('a2') })
    expect(order()).toEqual(['amadeus:tpl:a', 'amadeus:tpl:b', 'amadeus:tpl:c'])
    removeCommand('holder') // b 的默认键生效
    expect(engine('amadeus:tpl:b')[0].hotkey).toBe('mod+shift+y')
    expect(order()).toEqual(['amadeus:tpl:a', 'amadeus:tpl:b', 'amadeus:tpl:c'])
  })

  it('disposers and registrations after the plugin is disabled do nothing', async () => {
    const ctx = await load()
    const off = ctx.registerCommand({ id: 'a', title: 'A', run: run('a') })
    st().disable('tpl')
    expect(engine('amadeus:tpl:a')).toHaveLength(0)
    const late = ctx.registerCommand({ id: 'z', title: 'Z', run: run('z') })
    expect(st().commands).toEqual([])
    expect(engine('amadeus:tpl:z')).toHaveLength(0)
    off(); late()
    st().enable('tpl')
    await vi.waitFor(() => expect(st().activeIds).toContain('tpl'))
    const fresh = g.__ctx
    fresh.registerCommand({ id: 'a', title: 'A2', run: run('a2') })
    off() // 上一代的 disposer 碰不到这一代
    expect(engine('amadeus:tpl:a').map((c) => c.title)).toEqual(['A2'])
  })
})

describe('plugin default hotkeys', () => {
  it('a free default goes into the command table and fires', async () => {
    const ctx = await load()
    ctx.registerCommand({ id: 'a', title: 'A', hotkey: 'Mod+Shift+Y', run: run('a') })
    expect(engine('amadeus:tpl:a')[0].hotkey).toBe('mod+shift+y')
    expect(usePluginHotkeys.getState().states['amadeus:tpl:a']).toEqual({ hotkey: 'mod+shift+y', active: true })
    const offKeys = installHotkeys()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Y', code: 'KeyY', metaKey: true, shiftKey: true }))
    offKeys()
    expect(g.__ran).toEqual(['a'])
  })

  it('a default that hits a built-in stays out of the table; the built-in keeps the key; freeing it activates the default', async () => {
    addCommand({ id: 'builtin', title: 'Built-in', hotkey: 'mod+shift+y', run: run('builtin') })
    const ctx = await load()
    ctx.registerCommand({ id: 'a', title: 'A', hotkey: 'mod+shift+y', run: run('a') })
    expect(engine('amadeus:tpl:a')[0].hotkey).toBeUndefined()
    expect(usePluginHotkeys.getState().states['amadeus:tpl:a']).toEqual({ hotkey: 'mod+shift+y', active: false, conflict: { kind: 'command', id: 'builtin' } })
    const offKeys = installHotkeys()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Y', code: 'KeyY', metaKey: true, shiftKey: true }))
    expect(g.__ran).toEqual(['builtin'])
    // 用户把内置命令改到别的键 → 插件默认键生效
    useShortcuts.getState().setOverride('builtin', 'mod+alt+b')
    expect(engine('amadeus:tpl:a')[0].hotkey).toBe('mod+shift+y')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Y', code: 'KeyY', metaKey: true, shiftKey: true }))
    expect(g.__ran).toEqual(['builtin', 'a'])
    offKeys()
    // 用户给另一条命令设了这个键 → 默认键再让位
    addCommand({ id: 'other', title: 'Other', run: run('other') })
    useShortcuts.getState().setOverride('other', 'mod+shift+y')
    expect(engine('amadeus:tpl:a')[0].hotkey).toBeUndefined()
    expect(usePluginHotkeys.getState().states['amadeus:tpl:a']).toMatchObject({ active: false, conflict: { id: 'other' } })
    // 内置命令后来才注册(懒注册)也会把默认键挤掉;撤掉又回来
    useShortcuts.getState().clearOverride('other')
    expect(engine('amadeus:tpl:a')[0].hotkey).toBe('mod+shift+y')
    addCommand({ id: 'late', title: 'Late', hotkey: 'mod+shift+y', run: run('late') })
    expect(engine('amadeus:tpl:a')[0].hotkey).toBeUndefined()
    removeCommand('late')
    expect(engine('amadeus:tpl:a')[0].hotkey).toBe('mod+shift+y')
  })

  it("the user's own binding for the plugin command wins over its default", async () => {
    const ctx = await load()
    ctx.registerCommand({ id: 'a', title: 'A', hotkey: 'mod+shift+y', run: run('a') })
    useShortcuts.getState().setOverride('amadeus:tpl:a', 'mod+alt+j')
    const offKeys = installHotkeys()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Y', code: 'KeyY', metaKey: true, shiftKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', metaKey: true, altKey: true }))
    offKeys()
    expect(g.__ran).toEqual(['a'])
  })

  it('an invalid default is ignored with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = await load()
    ctx.registerCommand({ id: 'a', title: 'A', hotkey: 'y', run: run('a') })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hotkey'))
    expect(engine('amadeus:tpl:a')[0].hotkey).toBeUndefined()
    expect(usePluginHotkeys.getState().states['amadeus:tpl:a']).toBeUndefined()
    warn.mockRestore()
  })
})

describe('ctx.net', () => {
  it('is absent when the host bridge has no pluginNetRequest (web / mobile)', async () => {
    const ctx = await load()
    expect(ctx.net).toBeUndefined()
  })

  it('passes the plugin id, rebuilds text/json, and rejects with the main-process code', async () => {
    const calls: unknown[][] = []
    env.net = async (...a) => {
      calls.push(a)
      return a[1] === 'https://api.example.com/bad'
        ? { ok: false, code: 'net_domain_not_declared', message: 'api.example.com is not in the list' }
        : { ok: true, status: 200, headers: { 'content-type': 'application/json' }, bytes: new TextEncoder().encode('{"x":1}'), url: String(a[1]) }
    }
    const ctx = await load()
    const r = await ctx.net!.request('https://api.example.com/ok', { method: 'POST', body: 'b', headers: { a: 'b' }, timeoutMs: 5 })
    expect([r.status, r.text(), r.json<{ x: number }>().x, r.url]).toEqual([200, '{"x":1}', 1, 'https://api.example.com/ok'])
    expect(calls[0]).toEqual(['tpl', 'https://api.example.com/ok', { method: 'POST', headers: { a: 'b' }, body: 'b', timeoutMs: 5 }])
    await expect(ctx.net!.request('https://api.example.com/bad')).rejects.toMatchObject({ code: 'net_domain_not_declared', name: 'PluginNetError' })
  })

  it('a request in flight when the plugin is disabled rejects', async () => {
    let release: (r: PluginNetIpcResult) => void = () => {}
    env.net = () => new Promise((res) => { release = res })
    const ctx = await load()
    const p = ctx.net!.request('https://api.example.com/')
    st().disable('tpl')
    release({ ok: true, status: 200, headers: {}, bytes: new Uint8Array(), url: 'https://api.example.com/' })
    await expect(p).rejects.toThrow(/disabled/)
    await expect(ctx.net!.request('https://api.example.com/')).rejects.toThrow(/disabled/)
  })
})
