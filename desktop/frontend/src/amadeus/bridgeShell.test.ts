/**
 * 桌面 window.amadeus 转发壳(智库同步第 3 步 U3a,零行为那一包):
 * - 没有 amadeusLocal(网页 / 台架 / 自带 preload)什么都不做;window.amadeus 已被别人装好不盖;只读键、会抛的 getter 不抛;
 * - 装上以后读 / 调 / `in` / 枚举 / 订阅 / 替换方法都和直接用本机桥一样;冻结的本机桥上枚举不撞 Proxy 不变式;
 * - 模块求值即装(main.tsx 紧跟 seed 的那条副作用 import)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AmadeusApi } from '@amadeus-shared/ipc'
import { installBridgeShell } from './bridgeShell'

/** 假本机桥:几个方法 + 一个真订阅(回取消函数)+ hostCaps / scopedTextWrites 这类非函数成员。 */
function fakeLocal() {
  const listeners = new Set<(p: string) => void>()
  const api = {
    listPages: vi.fn(async () => ['a.md']),
    savePage: vi.fn(async () => {}),
    onExternalChange: (cb: (p: string) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    hostCaps: { revealInFileManager: true },
    scopedTextWrites: true as const,
  }
  return { api: api as unknown as AmadeusApi & typeof api, emit: (p: string) => { for (const l of [...listeners]) l(p) }, listeners }
}
type Win = { amadeus?: AmadeusApi; amadeusLocal?: AmadeusApi }

describe('installBridgeShell: leaves other hosts alone', () => {
  it('no amadeusLocal → does nothing (web, harness, the vault-integrity preload)', () => {
    const empty: Win = {}
    expect(installBridgeShell(empty)).toBe(false)
    expect('amadeus' in empty).toBe(false)
    const cb = { listPages: async () => [] } as unknown as AmadeusApi
    const web: Win = { amadeus: cb }
    expect(installBridgeShell(web)).toBe(false)
    expect(web.amadeus).toBe(cb)
  })

  it('window.amadeus already installed by someone else is not overwritten, even with amadeusLocal present', () => {
    const other = { listPages: async () => [] } as unknown as AmadeusApi
    const w: Win = { amadeus: other, amadeusLocal: fakeLocal().api }
    expect(installBridgeShell(w)).toBe(false)
    expect(w.amadeus).toBe(other)
  })

  it('a read-only amadeus key or a throwing getter does not throw (module evaluation must never fail)', () => {
    const ro = { amadeusLocal: fakeLocal().api } as Win
    Object.defineProperty(ro, 'amadeus', { value: undefined, writable: false, configurable: true })
    expect(() => installBridgeShell(ro)).not.toThrow()
    expect(installBridgeShell(ro)).toBe(false)
    expect(ro.amadeus).toBeUndefined()
    const getterOnly = { amadeusLocal: fakeLocal().api } as Win
    Object.defineProperty(getterOnly, 'amadeus', { get: () => undefined, configurable: true }) // 没有 setter:严格模式赋值抛
    expect(installBridgeShell(getterOnly)).toBe(false)
    const throwing = { amadeusLocal: fakeLocal().api } as Win
    Object.defineProperty(throwing, 'amadeus', { get: () => { throw new Error('boom') }, configurable: true })
    expect(installBridgeShell(throwing)).toBe(false)
  })
})

describe('installBridgeShell: forwards to the local bridge', () => {
  it('reads, calls, `in`, enumeration and spread look exactly like the local bridge', async () => {
    const { api } = fakeLocal()
    const w: Win = { amadeusLocal: api }
    expect(installBridgeShell(w)).toBe(true)
    const shell = w.amadeus!
    expect(shell).not.toBe(api)
    expect(shell.listPages).toBe(api.listPages)
    expect(await shell.listPages()).toEqual(['a.md'])
    expect(api.listPages).toHaveBeenCalledTimes(1)
    expect(shell.hostCaps).toBe(api.hostCaps)
    expect(shell.scopedTextWrites).toBe(true)
    expect('savePage' in shell).toBe(true)
    expect('activeVaultGet' in shell).toBe(false) // 能力探测照旧:本机桥没有的成员就是没有
    expect(shell.activeVaultGet).toBeUndefined()
    expect(Object.keys(shell)).toEqual(Object.keys(api))
    expect({ ...shell }).toEqual({ ...api })
    expect(Object.getPrototypeOf(shell)).toBe(Object.getPrototypeOf(api))
  })

  it('subscriptions go to the local bridge and unsubscribe there', () => {
    const local = fakeLocal()
    const w: Win = { amadeusLocal: local.api }
    installBridgeShell(w)
    const got: string[] = []
    const off = w.amadeus!.onExternalChange((p) => got.push(p))
    local.emit('a.md')
    expect(got).toEqual(['a.md'])
    expect(local.listeners.size).toBe(1)
    off()
    expect(local.listeners.size).toBe(0)
    local.emit('b.md')
    expect(got).toEqual(['a.md'])
  })

  it('assignments and deletes land on the local bridge (harness method swaps keep working)', async () => {
    const { api } = fakeLocal()
    const w: Win = { amadeusLocal: api }
    installBridgeShell(w)
    const swapped = vi.fn(async () => ['z.md'])
    w.amadeus!.listPages = swapped
    expect(api.listPages).toBe(swapped)
    expect(await w.amadeus!.listPages()).toEqual(['z.md'])
    delete (w.amadeus as { hostCaps?: unknown }).hostCaps
    expect('hostCaps' in api).toBe(false)
    expect(w.amadeus!.hostCaps).toBeUndefined()
  })

  it('a frozen local bridge (contextBridge copies may be immutable): enumeration works, writes fail just as they would directly', () => {
    const api = Object.freeze({ ...fakeLocal().api }) as AmadeusApi
    const w: Win = { amadeusLocal: api }
    installBridgeShell(w)
    const shell = w.amadeus!
    expect(Object.keys(shell)).toEqual(Object.keys(api)) // 非 configurable 的描述符照实报会撞不变式
    expect(Object.getOwnPropertyDescriptor(shell, 'listPages')?.value).toBe(api.listPages)
    expect(() => { 'use strict'; (api as { listPages: unknown }).listPages = 1 }).toThrow(TypeError)
    expect(() => { 'use strict'; (shell as { listPages: unknown }).listPages = 1 }).toThrow(TypeError)
    expect(shell.listPages).toBe(api.listPages)
  })
})

describe('module side effect', () => {
  const g = globalThis as { window?: unknown }
  afterEach(() => { delete g.window; vi.resetModules() })

  it('importing the module installs the shell on window when amadeusLocal is there, and is a no-op otherwise', async () => {
    const { api } = fakeLocal()
    g.window = { amadeusLocal: api }
    vi.resetModules()
    await import('./bridgeShell')
    const win = g.window as Win
    expect(win.amadeus).not.toBe(api)
    expect(win.amadeus!.listPages).toBe(api.listPages)
    g.window = {}
    vi.resetModules()
    await import('./bridgeShell')
    expect('amadeus' in (g.window as Win)).toBe(false)
  })
})
