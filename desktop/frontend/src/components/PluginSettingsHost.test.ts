// @vitest-environment happy-dom
/**
 * ctx.registerSettingsPage(方案 P4,2026-11-18)的生命周期,跑真 pluginStore + 真设置零件:
 *   注册 → 算「有设置」(左栏「插件设置」的判据)→ 设置页挂上、宿主零件画出来、回调接通
 *   → 停用:插件的收尾被调、页面换成「已停用 · 启用」、残留的 update / 回调不再生效、关着照样列在左栏
 *   → 在状态卡上点「启用」:setup 重跑、页面重新挂上。
 * 外加:registerSetting 行进「通用」组(宿主的工作文件夹排最后)、registerSettingsView 进自定义块。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal } from '../i18n'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { pluginsWithSettingsPanel } from '../amadeus/plugins/display'
import type { AmadeusPlugin, PluginContext, PluginSettingsPageSurface } from '../amadeus/plugins/types'
import type { PluginSettingsPageSchema } from '../../../shared/settingsPage'
import { ForsionPluginSettingsPage, PluginIdentityCard, forsionPluginSource, pluginMetaLine } from './PluginSettingsHost'
import { forsionPluginHasSettings, syncKnownPluginSettings } from './pluginSettingsNav'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  setLocaleGlobal('zh')
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, settings: [], settingsViews: [], settingsPages: [] })
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const render = (plugin: AmadeusPlugin) => act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ForsionPluginSettingsPage, { plugin }) })))
const current = (id: string) => usePluginStore.getState().plugins.find((p) => p.id === id)!
/** 左栏「插件设置」用的同一条判据(SettingsModal):在跑看注册了什么,关着看见过没有。 */
const listed = (id: string): boolean => {
  const s = usePluginStore.getState()
  const live = new Set(pluginsWithSettingsPanel(s.plugins, s.activeIds, s.settings, s.settingsViews, s.settingsPages).map((p) => p.id))
  const known = syncKnownPluginSettings(s.activeIds, live)
  return forsionPluginHasSettings(id, s.activeIds.includes(id), live, known)
}

describe('ctx.registerSettingsPage 生命周期', () => {
  it('注册 → 列进插件设置 → 停用收尾 → 状态卡上启用再挂', async () => {
    const counts = { setups: 0, mounts: 0, cleanups: 0 }
    const onSwitch = vi.fn()
    let lastPage: PluginSettingsPageSurface | null = null
    const schema = (title: string): PluginSettingsPageSchema => ({ groups: [{ id: 'timer', icon: 'clock', title, items: [
      { type: 'switch', id: 'auto', title: '自动开始下一轮', value: false, onChange: onSwitch },
    ] }] })
    const plugin: AmadeusPlugin = {
      id: 'pomodoro', name: '番茄钟', version: '1.4.2',
      setup(ctx: PluginContext) {
        counts.setups++
        ctx.registerSettingsPage!({
          title: () => '番茄钟', keywords: 'timer 计时',
          mount(page) { counts.mounts++; lastPage = page; page.update(schema('计时')); return () => { counts.cleanups++ } },
        })
      },
    }
    await act(async () => { usePluginStore.getState().init([plugin]) })
    expect(usePluginStore.getState().settingsPages.map((o) => [o.pluginId, o.item.id])).toEqual([['pomodoro', 'main']])
    expect(listed('pomodoro')).toBe(true)

    await render(current('pomodoro'))
    await flush()
    expect(counts.mounts).toBe(1)
    expect(host.querySelector('[data-plugin-identity="pomodoro"] .settings-panel-head strong')?.textContent).toBe('番茄钟')
    expect(host.querySelector('[data-plugin-identity="pomodoro"] .settings-panel-head p')?.textContent).toBe('v1.4.2 · 本地')
    const page = host.querySelector('[data-plugin-settings-page="pomodoro:main"]')!
    expect(page.querySelector('.settings-panel-head strong')?.textContent).toBe('计时')
    await act(async () => { page.querySelector<HTMLElement>('[role="switch"]')!.click() })
    expect(onSwitch).toHaveBeenCalledWith(true)
    // update 整份替换
    await act(async () => { lastPage!.update(schema('计时 · 新')) })
    expect(page.querySelector('.settings-panel-head strong')?.textContent).toBe('计时 · 新')

    // 停用:收尾被调,页换成状态卡;旧句柄的 update 不再画东西
    const stale = lastPage!
    await act(async () => { usePluginStore.getState().disable('pomodoro') })
    await flush()
    expect(counts.cleanups).toBe(1)
    expect(usePluginStore.getState().settingsPages).toEqual([])
    await render(current('pomodoro'))
    expect(host.querySelector('[data-plugin-settings-page]')).toBeNull()
    const card = host.querySelector('[data-plugin-settings-state="disabled"]')!
    expect(card.querySelector('strong')?.textContent).toBe('已停用')
    await act(async () => { stale.update(schema('不该出现')) })
    expect(host.textContent).not.toContain('不该出现')
    expect(listed('pomodoro'), '关着照样列在「插件设置」里').toBe(true)

    // 状态卡上的「启用」:setup 重跑,页面重新挂上
    await act(async () => { card.querySelector<HTMLElement>('.btn.primary')!.click() })
    await render(current('pomodoro'))
    await flush()
    expect(counts.setups).toBe(2)
    expect(counts.mounts).toBe(2)
    expect(host.querySelector('[data-plugin-settings-page="pomodoro:main"] .settings-panel-head strong')?.textContent).toBe('计时')
  })

  it('坏的注册被拒(要 title + mount);同 id 重注册覆盖', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let ctx!: PluginContext
    await act(async () => { usePluginStore.getState().init([{ id: 'p2', name: 'P2', version: '1', setup(c) { ctx = c } }]) })
    ctx.registerSettingsPage!({ title: 'x' } as never)
    expect(warn).toHaveBeenCalled()
    ctx.registerSettingsPage!({ id: 'a', title: 'A', mount() {} })
    ctx.registerSettingsPage!({ id: 'a', title: 'A2', mount() {} })
    expect(usePluginStore.getState().settingsPages.map((o) => o.item.title)).toEqual(['A2'])
  })
})

describe('旧接口落到同一页', () => {
  it('registerSetting → 「通用」组(工作文件夹最后),registerSettingsView → 自定义块,改值写回 localStorage', async () => {
    const viewMount = vi.fn((el: HTMLElement) => { el.innerHTML = '<div class="old-view">自绘</div>'; return () => {} })
    await act(async () => {
      usePluginStore.getState().init([{
        id: 'legacy', name: '旧插件', version: '2.0.0',
        setup(ctx) {
          ctx.registerSetting({ key: 'dark', type: 'boolean', label: '暗色', default: false })
          ctx.registerSettingsView!({ id: 'snips', title: '片段', mount: viewMount })
        },
      }])
    })
    await render(current('legacy'))
    await flush()
    const titles = [...host.querySelectorAll('.settings-panel-head strong')].map((n) => n.textContent)
    expect(titles).toEqual(['旧插件', '通用', '片段'])
    const rows = [...host.querySelectorAll('.settings-control-row strong')].map((n) => n.textContent)
    expect(rows[0]).toBe('暗色')
    expect(rows[rows.length - 1]).toBe(rows.find((r) => r !== '暗色')) // 工作文件夹是最后一行
    expect(host.querySelector('.plugin-settings-views .old-view')?.textContent).toBe('自绘')
    expect(viewMount).toHaveBeenCalledTimes(1)
    await act(async () => { host.querySelector<HTMLElement>('.settings-control-row [role="switch"]')!.click() })
    expect(localStorage.getItem('plugin.legacy.dark')).toBe('true')
    expect(host.querySelector('.settings-control-row [role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('身份卡:来源 = 内置 / 商店 / 本地;「打开插件」只在有去处时出', async () => {
    expect(forsionPluginSource({ id: 'x', builtin: true })).toBe('builtin')
    expect(forsionPluginSource({ id: 'y', dir: 'market-0b0c9a4e-1111-4222-8333-123456789abc' })).toBe('store')
    expect(forsionPluginSource({ id: 'z' })).toBe('local')
    expect(pluginMetaLine((k) => ({ 'plugsettings.source.store': '商店' } as Record<string, string>)[k] ?? k, '1.0.0', 'store')).toBe('v1.0.0 · 商店')
    const onOpen = vi.fn()
    await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(PluginIdentityCard, { pluginId: 'q', logo: null, name: 'Q', meta: 'v1', onOpen }) })))
    await act(async () => { host.querySelector<HTMLElement>('[data-plugin-open]')!.click() })
    expect(onOpen).toHaveBeenCalled()
    await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(PluginIdentityCard, { pluginId: 'q', logo: null, name: 'Q', meta: 'v1' }) })))
    expect(host.querySelector('[data-plugin-open]')).toBeNull()
  })
})
