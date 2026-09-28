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
const { usePluginStore } = await import('./pluginStore')

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

  it('对照:普通插件照旧认 localStorage 的「关」', async () => {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(['third']))
    usePluginStore.getState().syncDisabledPreferences()
    env.sources = [src({ id: 'third' })]
    await usePluginStore.getState().loadExternal()
    expect(usePluginStore.getState().activeIds).not.toContain('third')
  })
})
