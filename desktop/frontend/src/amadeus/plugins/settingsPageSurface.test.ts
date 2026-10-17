// @vitest-environment happy-dom
/**
 * ctx.ui.mountSettingsPage / mountSettingsItem(2026-10-17)的契约:画什么、手机上怎么排、输入中的值归谁、
 * 以及生命周期(update 原地、dispose 归还 el、插件停用 / 重载时宿主收、动态 import 落地前就停用不挂)。
 * React 与 mountHostReact 都是真的;手机形态用 window.tangu.mobile 切。
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNativeSheetPresenter } from '@lcl/engine'
import { mountPluginSettingsItem, mountPluginSettingsPage } from './settingsPageSurface'
import { usePluginStore } from './pluginStore'
import { setLocaleGlobal } from '../../i18n'
import type { PluginContext } from './types'
import type { PluginSettingsItem, PluginSettingsPageHandle, PluginSettingsPageSchema } from '../../../../shared/settingsPage'

let el: HTMLDivElement
let page: { dispose(): void } | undefined
const tangu = (window as unknown as { tangu?: unknown })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setLocaleGlobal('zh')
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  el = document.createElement('div'); document.body.append(el)
})
afterEach(async () => {
  await act(async () => { page?.dispose() })
  page = undefined; el.remove(); delete tangu.tangu
  installNativeSheetPresenter(null as never)
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const row = (title: string) => [...el.querySelectorAll<HTMLElement>('.settings-control-row')].find((r) => r.querySelector('strong')?.textContent === title)!
const click = (node: Element | null | undefined) => act(async () => { (node as HTMLElement).click() })
const type = (input: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

type Cb<V> = (v: V) => void | Promise<unknown>
const quota = (over: { onSwitch?: Cb<boolean>; onPick?: Cb<string>; onRedeem?: Cb<string>; onBuy?: Cb<number> } = {}): PluginSettingsPageSchema => ({
  groups: [
    { id: 'ai', icon: 'gauge', title: 'AI 额度', desc: '今日和本周', actions: [{ label: '充值', kind: 'primary', onClick: () => {} }], items: [
      { type: 'meters', id: 'm', meters: [{ label: '今日', value: 0.69, caption: '每天重置' }, { label: '本周', value: 1.7 }] },
      { type: 'button', id: 'reset', title: '额度重置卡', buttons: [{ label: '使用一张', onClick: () => {} }] },
      { type: 'stepper', id: 'buy', title: '用积分兑换', value: 1, min: 1, max: 3, button: { label: '兑换', onClick: (n) => over.onBuy?.(n) } },
    ] },
    { id: 'bg', title: '后台额度', items: [
      { type: 'switch', id: 'fallback', title: '用完后改用 AI 额度', value: false, onChange: (v) => over.onSwitch?.(v) },
      { type: 'choice', id: 'convert', title: '从 AI 额度转入', button: '转入…', options: [{ value: '5', label: '5%', detail: '+50k' }, { value: '10', label: '10%' }], onPick: (v) => over.onPick?.(v) },
      { type: 'value', id: 'balance', title: '余额', value: '1,280' },
    ] },
    { id: 'invite', title: '邀请与兑换', items: [
      { type: 'code', id: 'code', title: '我的邀请码', value: 'FX7Q2M', copyLabel: '复制' },
      { type: 'input', id: 'redeem', title: '兑换码', placeholder: '输入兑换码', button: { label: '兑换', onClick: (v) => over.onRedeem?.(v) } },
      { type: 'button', id: 'two', title: '两枚按钮', buttons: [{ label: 'A', onClick: () => {} }, { label: 'B', kind: 'danger', onClick: () => {} }] },
    ] },
  ],
})

describe('settings page description', () => {
  it('draws host panels, rows and the new parts with the narrow-screen fit on each row', async () => {
    await act(async () => { page = mountPluginSettingsPage(el, quota()) })
    expect([...el.querySelectorAll('.settings-panel-head strong')].map((n) => n.textContent)).toEqual(['AI 额度', '后台额度', '邀请与兑换'])
    expect(el.querySelector('.settings-panel-icon svg')).not.toBeNull()
    expect(el.querySelector('.settings-panel-actions .btn.primary')?.textContent).toBe('充值')
    expect([...el.querySelectorAll('[role="meter"]')].map((m) => m.getAttribute('aria-valuenow'))).toEqual(['69', '100'])
    expect(el.querySelector('.settings-meter small')?.textContent).toBe('每天重置')
    const fits = Object.fromEntries([...el.querySelectorAll<HTMLElement>('.settings-control-row')].map((r) => [r.querySelector('strong')!.textContent, r.dataset.fit]))
    expect(fits['额度重置卡']).toBe('inline')
    expect(fits['用积分兑换']).toBe('wrap')
    expect(fits['用完后改用 AI 额度']).toBe('inline')
    expect(fits['从 AI 额度转入']).toBe('wrap') // 桌面:两枚按钮一排
    expect(fits['余额']).toBe('inline')
    expect(fits['我的邀请码']).toBe('inline')
    expect(fits['兑换码']).toBe('wrap')
    expect(fits['两枚按钮']).toBe('wrap')
    expect(row('余额').querySelector('.settings-value')?.textContent).toBe('1,280')
    expect(row('我的邀请码').querySelector('.settings-code-chip')?.textContent).toBe('FX7Q2M')
    expect(row('从 AI 额度转入').querySelectorAll('.btn')).toHaveLength(2)
  })

  it('shows only the page state when one is given', async () => {
    const onRetry = vi.fn()
    await act(async () => { page = mountPluginSettingsPage(el, { state: { kind: 'error', title: '加载失败', action: { label: '重试', onClick: onRetry } } }) })
    expect(el.querySelector('.settings-panel')).toBeNull()
    expect(el.querySelector('.settings-state strong')?.textContent).toBe('加载失败')
    await click(el.querySelector('.settings-state .btn'))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('flips a switch at once and flips it back when the callback rejects', async () => {
    let reject!: (e: Error) => void
    const onSwitch = vi.fn(() => new Promise((_, r) => { reject = r }))
    await act(async () => { page = mountPluginSettingsPage(el, quota({ onSwitch })) })
    const sw = () => row('用完后改用 AI 额度').querySelector('[role="switch"]')!
    await click(sw())
    expect(onSwitch).toHaveBeenCalledWith(true)
    expect(sw().getAttribute('aria-checked')).toBe('true')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { reject(new Error('save failed')) })
    expect(sw().getAttribute('aria-checked')).toBe('false')
  })

  it('keeps typed text across update() unless the new description sets the value', async () => {
    const onRedeem = vi.fn()
    let h!: PluginSettingsPageHandle
    await act(async () => { h = page = mountPluginSettingsPage(el, quota({ onRedeem })) })
    const input = () => row('兑换码').querySelector('input')!
    const before = input()
    await type(input(), 'ABC-123')
    // 插件刷新了别的部分(没给 value):用户输入的留着,还是同一个 input
    await act(async () => { const s = quota({ onRedeem }); s.groups![0].items.unshift({ type: 'value', id: 'new', title: '新行', value: '1' }); h.update(s) })
    expect(input()).toBe(before)
    expect(input().value).toBe('ABC-123')
    await click(row('兑换码').querySelector('.btn'))
    expect(onRedeem).toHaveBeenCalledWith('ABC-123')
    // 兑换完插件清空:给了 value 就以它为准
    await act(async () => {
      const s = quota({ onRedeem })
      ;(s.groups![2].items[1] as Extract<PluginSettingsItem, { type: 'input' }>).value = ''
      h.update(s)
    })
    expect(input().value).toBe('')
  })

  it('steps within bounds and hands the number to the button', async () => {
    const onBuy = vi.fn()
    await act(async () => { page = mountPluginSettingsPage(el, quota({ onBuy })) })
    const r = row('用积分兑换')
    const [minus, plus] = r.querySelectorAll<HTMLButtonElement>('.settings-stepper button')
    expect(minus.disabled).toBe(true)
    await click(plus); await click(plus); await click(plus)
    expect(r.querySelector('output')?.textContent).toBe('3')
    expect(plus.disabled).toBe(true)
    await click(r.querySelector('.btn'))
    expect(onBuy).toHaveBeenCalledWith(3)
  })

  it('asks before a button with confirm runs', async () => {
    const onClick = vi.fn()
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await act(async () => { page = mountPluginSettingsItem(el, { type: 'button', id: 'out', title: '退出登录', buttons: [{ label: '退出', kind: 'danger', confirm: { title: '确定退出?', confirmLabel: '退出' }, onClick }] }) })
    await click(el.querySelector('.btn.danger'))
    await flush()
    expect(ask).toHaveBeenCalledOnce()
    expect(onClick).not.toHaveBeenCalled()
    ask.mockReturnValue(true)
    await click(el.querySelector('.btn.danger'))
    await flush()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('on phones a pick-to-run choice is one button and a half sheet (web fallback)', async () => {
    tangu.tangu = { mobile: true }
    const onPick = vi.fn()
    await act(async () => { page = mountPluginSettingsPage(el, quota({ onPick })) })
    const r = row('从 AI 额度转入')
    expect(r.dataset.fit).toBe('inline')
    expect(r.querySelectorAll('.btn')).toHaveLength(1)
    await click(r.querySelector('.btn'))
    const sheet = document.body.querySelector('.settings-parts-sheet')!
    expect(sheet.querySelector('.mb-sheet-head')?.textContent).toBe('从 AI 额度转入')
    expect(sheet.querySelector('.mb-sheet-row small')?.textContent).toBe('+50k')
    await click(sheet.querySelectorAll('.mb-sheet-row')[1])
    expect(onPick).toHaveBeenCalledWith('10')
    expect(document.body.querySelector('.settings-parts-sheet')).toBeNull()
  })

  it('on phones the choice goes to the native sheet when the host has one', async () => {
    tangu.tangu = { mobile: true }
    const onPick = vi.fn()
    const presenter = vi.fn(async (payload: { kind: string; sections?: Array<{ items: Array<{ id: string; detail?: string }> }> }) => {
      expect(payload.kind).toBe('menu')
      expect(payload.sections![0].items.map((i) => i.id)).toEqual(['5', '10'])
      return { id: '5' }
    })
    installNativeSheetPresenter(presenter as never)
    await act(async () => { page = mountPluginSettingsPage(el, quota({ onPick })) })
    await click(row('从 AI 额度转入').querySelector('.btn'))
    await flush()
    expect(presenter).toHaveBeenCalledOnce()
    expect(onPick).toHaveBeenCalledWith('5')
    expect(document.body.querySelector('.settings-parts-sheet')).toBeNull()
  })

  it('mounts a custom block once per id, keeps it across updates and cleans it up on dispose', async () => {
    const off = vi.fn()
    const mount = vi.fn((host: HTMLElement) => { host.append(Object.assign(document.createElement('span'), { className: 'mine', textContent: 'own' })); return off })
    const schema = (): PluginSettingsPageSchema => ({ groups: [{ id: 'g', title: 'G', items: [{ type: 'custom', id: 'c', mount }] }] })
    let h!: PluginSettingsPageHandle
    await act(async () => { h = mountPluginSettingsPage(el, schema()) })
    const mine = el.querySelector('.settings-parts-custom .mine')
    expect(mine?.textContent).toBe('own')
    await act(async () => { h.update(schema()) })
    expect(mount).toHaveBeenCalledOnce()
    expect(el.querySelector('.settings-parts-custom .mine')).toBe(mine)
    await act(async () => { h.dispose() })
    expect(el.childElementCount).toBe(0) // el 立刻还给插件
    await flush()
    expect(off).toHaveBeenCalledOnce()
    await act(async () => { h.update(schema()) }) // 卸载后的 update 无效
    expect(el.childElementCount).toBe(0)
  })

  it('a single item mounts on its own and updates in place', async () => {
    let h!: ReturnType<typeof mountPluginSettingsItem>
    await act(async () => { h = page = mountPluginSettingsItem(el, { type: 'value', id: 'v', title: '余额', value: '1' }) })
    const node = el.querySelector('.settings-value')
    await act(async () => { h.update({ type: 'value', id: 'v', title: '余额', value: '2' }) })
    expect(el.querySelector('.settings-value')).toBe(node)
    expect(node?.textContent).toBe('2')
  })
})

describe('ctx.ui settings mounts and the plugin lifecycle', () => {
  const schema = (onChange = vi.fn()): PluginSettingsPageSchema => ({ groups: [{ id: 'g', title: 'G', items: [{ type: 'switch', id: 's', title: 'S', value: false, onChange }] }] })

  it('rejects malformed calls synchronously', async () => {
    let ctx!: PluginContext
    await act(async () => { usePluginStore.getState().init([{ id: 'sp-shape', name: 'Shape', version: '1', setup(c) { ctx = c } }]) })
    expect(() => ctx.ui!.mountSettingsPage!({} as HTMLElement, schema())).toThrow(TypeError)
    expect(() => ctx.ui!.mountSettingsPage!(el, { groups: 'x' } as never)).toThrow(TypeError)
    expect(() => ctx.ui!.mountSettingsPage!(el, {} as never)).toThrow(TypeError)
    expect(() => ctx.ui!.mountSettingsItem!(el, { id: 'x' } as never)).toThrow(TypeError)
  })

  it('the host disables an already-mounted plugin without relying on its disposer', async () => {
    const onChange = vi.fn()
    await act(async () => {
      usePluginStore.getState().init([{ id: 'sp-mounted', name: 'Mounted', version: '1', setup(ctx) { ctx.ui!.mountSettingsPage!(el, schema(onChange)) } }])
    })
    await flush()
    const sw = el.querySelector<HTMLElement>('[role="switch"]')!
    expect(sw).not.toBeNull()
    await act(async () => { usePluginStore.getState().disable('sp-mounted') })
    expect(el.querySelector('[role="switch"]')).toBeNull()
    sw.click() // 旧节点上晚到的点击不再调插件
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disabling before the dynamic import lands mounts nothing, and a revoked ctx stays inert', async () => {
    let ctx!: PluginContext
    await act(async () => {
      usePluginStore.getState().init([{ id: 'sp-early', name: 'Early', version: '1', setup(c) { ctx = c; c.ui!.mountSettingsPage!(el, schema()) } }])
      usePluginStore.getState().disable('sp-early')
    })
    await flush()
    expect(el.querySelector('.settings-panel')).toBeNull()
    const late = ctx.ui!.mountSettingsItem!(el, { type: 'value', id: 'v', title: 'V', value: '1' })
    late.update({ type: 'value', id: 'v', title: 'V', value: '2' })
    await flush()
    expect(el.childElementCount).toBe(0)
  })

  it('re-enabling (a reload) tears down the old mount; the new instance mounts fresh', async () => {
    let n = 0
    const plugin = { id: 'sp-reload', name: 'Reload', version: '1', setup(c: PluginContext) { n++; c.ui!.mountSettingsItem!(el, { type: 'value', id: 'v', title: 'V', value: `run ${n}` }) } }
    await act(async () => { usePluginStore.getState().init([plugin]) })
    await flush()
    expect(el.querySelector('.settings-value')?.textContent).toBe('run 1')
    await act(async () => { usePluginStore.getState().disable('sp-reload') })
    expect(el.querySelector('.settings-value')).toBeNull()
    await act(async () => { usePluginStore.getState().enable('sp-reload') })
    await flush()
    expect([...el.querySelectorAll('.settings-value')].map((x) => x.textContent)).toEqual(['run 2'])
  })
})
