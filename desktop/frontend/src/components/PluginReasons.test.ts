// @vitest-environment happy-dom
/**
 * 遥测 v3 plugin_lifecycle.reason:停用开关的理由门、卸载确认框里的理由药丸、pluginStore 停用带理由 / quiet 不重报。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal } from '../i18n'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { AmadeusPlugin } from '../amadeus/plugins/types'
import { ReasonSwitch, UninstallReasonChips, reportEnginePluginToggle } from './PluginReasons'
import { PluginUninstallDialog } from './UninstallDialog'

let host: HTMLDivElement
let root: Root
let sent: Array<[string, Record<string, unknown>]>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  setLocaleGlobal('zh')
  sent = []
  ;(window as unknown as { tangu: unknown }).tangu = { telemetryReport: (k: string, p: Record<string, unknown>) => sent.push([k, p]) }
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, settings: [], settingsViews: [], settingsPages: [] })
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete (window as unknown as { tangu?: unknown }).tangu
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const render = (el: React.ReactElement) => act(async () => root.render(React.createElement(LocaleProvider, { children: el })))
const click = (el: Element | null) => act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const pop = () => document.querySelector('[data-disable-reasons]')

describe('ReasonSwitch:拨下先问理由', () => {
  it('从开拨到关:先浮出理由行,选了才关并带上理由;「直接停用」= 关、不带理由;拨开不问', async () => {
    const onChange = vi.fn()
    await render(React.createElement(ReasonSwitch, { checked: true, label: 'X', onChange }))
    await click(host.querySelector('[role="switch"]'))
    expect(onChange).not.toHaveBeenCalled()
    expect(pop()?.querySelectorAll('[data-reason]')).toHaveLength(5) // 四个理由 + 直接停用
    await click(pop()!.querySelector('[data-reason="slow"]'))
    expect(onChange).toHaveBeenLastCalledWith(false, 'slow')
    expect(pop()).toBeNull()

    await click(host.querySelector('[role="switch"]'))
    await click(pop()!.querySelector('[data-reason="none"]'))
    expect(onChange).toHaveBeenLastCalledWith(false, undefined)

    onChange.mockClear()
    await render(React.createElement(ReasonSwitch, { checked: false, label: 'X', onChange }))
    await click(host.querySelector('[role="switch"]'))
    expect(onChange).toHaveBeenCalledWith(true)
    expect(pop()).toBeNull()
  })
  it('开关贴着窗口底边:理由行翻到开关上面,按钮都在窗口里', async () => {
    const onChange = vi.fn()
    await render(React.createElement(ReasonSwitch, { checked: true, label: 'X', onChange }))
    const vh = window.innerHeight
    vi.spyOn(host.querySelector('span')!, 'getBoundingClientRect').mockReturnValue({ top: vh - 30, bottom: vh - 10, left: 0, right: 40, width: 40, height: 20, x: 0, y: vh - 30, toJSON: () => ({}) } as DOMRect)
    const real = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('[data-disable-reasons]') ? ({ top: 0, bottom: 100, left: 0, right: 300, width: 300, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect) : real.call(this)
    })
    await click(host.querySelector('[role="switch"]'))
    expect(parseFloat((pop() as HTMLElement).style.top)).toBe(vh - 30 - 6 - 100)
  })
  it('没有遥测通道(网页 / 手机 / 没装载 Extend):不问,一拨就关;卸载框里不画理由', async () => {
    delete (window as unknown as { tangu?: unknown }).tangu
    const onChange = vi.fn()
    await render(React.createElement(ReasonSwitch, { checked: true, label: 'X', onChange }))
    await click(host.querySelector('[role="switch"]'))
    expect(onChange).toHaveBeenCalledWith(false)
    expect(pop()).toBeNull()
    await render(React.createElement(UninstallReasonChips, { value: null, onChange: () => {} }))
    expect(host.querySelector('[data-uninstall-reasons]')).toBeNull()
  })
  it('取消 / 点别处 = 不关(开关照旧开着,什么都不报)', async () => {
    const onChange = vi.fn()
    await render(React.createElement(ReasonSwitch, { checked: true, label: 'X', onChange }))
    await click(host.querySelector('[role="switch"]'))
    await click(pop()!.querySelector('[data-reason-cancel]'))
    expect(pop()).toBeNull()
    await click(host.querySelector('[role="switch"]'))
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(pop()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('卸载确认框的理由药丸', () => {
  it('单选、再点取消;随「卸载」交出去,不选就不带', async () => {
    const picked: Array<string | null> = []
    await render(React.createElement(() => {
      const [v, setV] = React.useState<null | 'unused' | 'broken' | 'slow' | 'mistake'>(null)
      return React.createElement(UninstallReasonChips, { value: v, onChange: (r) => { setV(r); picked.push(r) } })
    }))
    const chip = (id: string) => host.querySelector(`[data-uninstall-reasons] [data-reason="${id}"]`)!
    await click(chip('broken'))
    expect(chip('broken').getAttribute('aria-pressed')).toBe('true')
    await click(chip('broken'))
    expect(picked).toEqual(['broken', null])

    const onConfirm = vi.fn()
    await render(React.createElement(PluginUninstallDialog, { name: 'P', onConfirm, onClose: () => {} }))
    const dlgChip = (id: string) => document.querySelector(`[data-uninstall-reasons] [data-reason="${id}"]`)!
    await click(dlgChip('mistake'))
    await click(document.querySelector('.dialog-btn[data-danger]'))
    expect(onConfirm).toHaveBeenLastCalledWith({ keepSettings: false, moveVault: false, keepOld: false, reason: 'mistake' })

    await render(React.createElement('div'))
    await render(React.createElement(PluginUninstallDialog, { name: 'P', onConfirm, onClose: () => {} }))
    await click(document.querySelector('.dialog-btn[data-danger]'))
    expect(onConfirm.mock.calls.at(-1)![0]).not.toHaveProperty('reason')
  })
})

describe('plugin_lifecycle 上报', () => {
  const plugin = (id: string): AmadeusPlugin => ({ id, name: id, version: '1.0.0', builtin: true, setup() {} } as AmadeusPlugin)
  it('pluginStore.disable 带理由;quiet 不报(调用方自己报过);enable 只在从关到开时报', () => {
    usePluginStore.getState().init([plugin('forsion-calendar'), plugin('forsion-todo')])
    sent = []
    usePluginStore.getState().disable('forsion-calendar', { reason: 'unused' })
    expect(sent).toEqual([['plugin_lifecycle', { pluginId: 'forsion-calendar', pluginOfficial: true, action: 'disable', reason: 'unused' }]])
    sent = []
    usePluginStore.getState().disable('forsion-todo', { quiet: true })
    usePluginStore.getState().enable('forsion-todo', { quiet: true })
    expect(sent).toEqual([])
    usePluginStore.getState().enable('forsion-calendar')
    expect(sent).toEqual([['plugin_lifecycle', { pluginId: 'forsion-calendar', pluginOfficial: true, action: 'enable' }]])
  })
  it('引擎插件开关:官方 / 内置报 id,侧载报 local;理由只跟着停用', () => {
    reportEnginePluginToggle({ id: 'forsion-calendar', source: 'builtin' }, false, 'broken')
    reportEnginePluginToggle({ id: 'my-own', source: 'user' }, true, 'broken')
    expect(sent).toEqual([
      ['plugin_lifecycle', { pluginId: 'forsion-calendar', pluginOfficial: true, action: 'disable', reason: 'broken' }],
      ['plugin_lifecycle', { pluginId: 'local', pluginOfficial: false, action: 'enable' }],
    ])
  })
})
