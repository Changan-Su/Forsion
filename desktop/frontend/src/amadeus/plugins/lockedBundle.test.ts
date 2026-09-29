// @vitest-environment happy-dom
/**
 * 带主进程半身的首方内置包(Forsion Extend)的渲染半身:启停跟着主进程那一半的开关(桌面配置 disabledBundles → 清单的 bundleOff)走,
 * 不看 localStorage。起因:0.3 起列表卡漏了 locked 闸,用户拨过的「关」留在 amadeus.plugins.disabled 里,主进程半身其实在跑 ——
 * 按 localStorage 判的话,Extend 挂进「Forsion 云端」的设置页永远出不来。
 * 负对照:把 applyPref 里 locked 那一支删掉 → 第一条红(旧的「关」赢)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

const env = vi.hoisted(() => ({ sources: [] as ExternalPluginSource[] }))
vi.mock('../api', () => ({
  amadeus: { listPlugins: async () => env.sources, listPages: async () => [], listFiles: async () => [] },
}))
const { usePluginStore, setResetCardCeremonyHandler } = await import('./pluginStore')

const DISABLED_KEY = 'amadeus.plugins.disabled'
const src = (over: Partial<ExternalPluginSource> & { id: string }): ExternalPluginSource => ({ name: over.id, version: '0.0.1', apiVersion: 1, code: '', ...over })
const disabledNow = (): string[] => JSON.parse(localStorage.getItem(DISABLED_KEY) || '[]')

beforeEach(() => {
  localStorage.clear()
  usePluginStore.setState({ plugins: [], activeIds: [], disabledIds: [], disposers: {}, lastSetupError: {}, initialized: false })
  env.sources = []
})

describe('locked 包的渲染半身跟主进程开关走', () => {
  it('主进程开着、localStorage 留着旧的「关」→ 照样激活,并把旧的「关」擦掉', async () => {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(['forsion-extend']))
    usePluginStore.getState().syncDisabledPreferences()
    env.sources = [src({ id: 'forsion-extend', preinstalled: true, locked: true, bundleOff: false })]
    await usePluginStore.getState().loadExternal()
    expect(usePluginStore.getState().activeIds).toContain('forsion-extend')
    expect(disabledNow()).not.toContain('forsion-extend')
  })

  it('主进程关着 → 不激活(localStorage 里没有它也一样)', async () => {
    env.sources = [src({ id: 'forsion-extend', preinstalled: true, locked: true, bundleOff: true })]
    await usePluginStore.getState().loadExternal()
    expect(usePluginStore.getState().activeIds).not.toContain('forsion-extend')
  })

  it('别的窗口拨了开关(storage 事件 → syncDisabledPreferences):locked 包不跟着拆装、也不把「开」写回 localStorage', async () => {
    env.sources = [src({ id: 'forsion-extend', preinstalled: true, locked: true, bundleOff: false })]
    await usePluginStore.getState().loadExternal()
    expect(usePluginStore.getState().activeIds).toContain('forsion-extend')
    localStorage.setItem(DISABLED_KEY, JSON.stringify(['forsion-extend'])) // 设置浮窗那边 disable() 写下的
    usePluginStore.getState().syncDisabledPreferences()
    expect(disabledNow()).toContain('forsion-extend')
    expect(usePluginStore.getState().activeIds).toContain('forsion-extend')
  })

  it('对照:普通插件照旧认 localStorage 的「关」', async () => {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(['third']))
    usePluginStore.getState().syncDisabledPreferences()
    env.sources = [src({ id: 'third' })]
    await usePluginStore.getState().loadExternal()
    expect(usePluginStore.getState().activeIds).not.toContain('third')
  })
})

// ctx.app.showResetCardCeremony:「你的额度已恢复」那张动画只让首方内置包弹,别的插件调了是 no-op。
// 落点是应用层登记的处理函数,不是公开窗口事件(插件能自己派发事件,Codex 评审 P1)。
// 负对照:删掉 pluginStore 里的 locked 判断 → 这条红(third 也进来)。
describe('ctx.app.showResetCardCeremony 只放行首方内置包', () => {
  it('locked 包 → 交给应用层;普通插件 → 不交', async () => {
    const seen: unknown[] = []
    setResetCardCeremonyHandler((r) => { seen.push(r) })
    const code = 'ctx.app.showResetCardCeremony({ before: { dailyLimit: 10, dailyRemaining: 0 }, after: { dailyLimit: 10, dailyRemaining: 10 }, remainingCards: 1 })'
    env.sources = [
      src({ id: 'forsion-extend', preinstalled: true, locked: true, bundleOff: false, code }),
      src({ id: 'third', code }),
    ]
    await usePluginStore.getState().loadExternal()
    setResetCardCeremonyHandler(null)
    expect(usePluginStore.getState().activeIds).toEqual(expect.arrayContaining(['forsion-extend', 'third']))
    expect(seen).toEqual([{ before: { dailyLimit: 10, dailyRemaining: 0 }, after: { dailyLimit: 10, dailyRemaining: 10 }, remainingCards: 1 }])
  })
})
