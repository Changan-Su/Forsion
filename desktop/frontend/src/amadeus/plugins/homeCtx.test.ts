// ctx.home 的闸(主页插件化 B,2026-11-09):只给 HOST_VIEW_CLAIMS.homepage 指名的那个插件,而且它得能接管
// (核心插件 = 随包 builtin / preinstalled 且在 CORE_BUNDLE_IDS;或开发档 localStorage coreTrial)。普通插件拿不到,manifest 也申请不到。
// ctx.app.motion 是公开的,人人有。
// 负对照(已实跑红):注入条件去掉 canClaimHostView(…) → 「不在核心名单、也没开 coreTrial 的 forsion-home 拿不到」红。
import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../api', () => ({ get amadeus() { return undefined } }))

const { usePluginStore } = await import('./pluginStore')
type Ctx = import('./types').PluginContext
type Plugin = import('./types').AmadeusPlugin

function ctxOf(id: string, over: Partial<Plugin> = {}): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c }, ...over }])
  return ref!
}

beforeEach(() => {
  try { localStorage.removeItem('forsion.dev.coreTrial') } catch { /* node 环境没有 */ }
})

describe('ctx.home 只给接管主页的插件', () => {
  it('不在核心名单、也没开 coreTrial 的 forsion-home 拿不到', () => {
    expect(ctxOf('forsion-home').home).toBeUndefined()
  })

  it('开发档 coreTrial 写着它 → 有', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'forsion.dev.coreTrial' ? 'forsion-home' : null), setItem: () => {}, removeItem: () => {} })
    try {
      expect(typeof ctxOf('forsion-home').home?.mount).toBe('function')
      // 同样开着 coreTrial,换个 id(不是 HOST_VIEW_CLAIMS 指名的)照样没有
      expect(ctxOf('forsion-calendar').home).toBeUndefined()
    } finally { vi.unstubAllGlobals() }
  })

  it('普通插件声明什么能力都拿不到', () => {
    expect(ctxOf('my-home', { capabilities: ['spaces'] } as Partial<Plugin>).home).toBeUndefined()
  })

  it('ctx.app.motion 人人有,回 reduce / fadeOnly 两个布尔', () => {
    const m = ctxOf('any-plugin').app.motion?.()
    expect(m).toEqual({ reduce: expect.any(Boolean), fadeOnly: expect.any(Boolean) })
    expect(typeof ctxOf('any-plugin').app.subscribeMotion).toBe('function')
  })
})
