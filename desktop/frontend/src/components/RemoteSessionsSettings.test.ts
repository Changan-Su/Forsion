// @vitest-environment happy-dom
/**
 * 设置 › 远程会话(P1 · K4):门控、父开关 / 设备凭据置灰、全自动须勾「我了解风险」才写、信任列表与撤销、扩展槽按 order 渲染。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteSessionsSettings, registerRemoteSettingsSection, remoteSessionsApi } from './RemoteSessionsSettings'
import { LocaleProvider, setLocaleGlobal } from '../i18n'
import type { RemoteSessionsApi, RemoteSessionsView } from '../../../shared/remoteSessions'

const UNIT = '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f'
const makeView = (over: Partial<RemoteSessionsView> = {}): RemoteSessionsView => ({
  hostEnabled: true, enabled: true, permitted: true, maxApprovalMode: 'auto-edit', trusted: [], pending: [], ...over,
})

let host: HTMLDivElement
let root: Root
let view: RemoteSessionsView
let pushChanged: ((v: RemoteSessionsView) => void) | null
const api = {
  get: vi.fn<RemoteSessionsApi['get']>(),
  setEnabled: vi.fn<RemoteSessionsApi['setEnabled']>(),
  setMaxApprovalMode: vi.fn<RemoteSessionsApi['setMaxApprovalMode']>(),
  revoke: vi.fn<RemoteSessionsApi['revoke']>(),
  onChanged: vi.fn<RemoteSessionsApi['onChanged']>(),
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  setLocaleGlobal('zh')
  view = makeView()
  pushChanged = null
  api.get.mockReset().mockImplementation(async () => view)
  api.setEnabled.mockReset().mockImplementation(async (on) => (view = { ...view, enabled: on }))
  api.setMaxApprovalMode.mockReset().mockImplementation(async (m) => (view = { ...view, maxApprovalMode: m }))
  api.revoke.mockReset().mockImplementation(async (p) => (view = { ...view, trusted: view.trusted.filter((r) => (r.principal === 'account' ? p !== 'account' : r.unitId !== p)) }))
  api.onChanged.mockReset().mockImplementation((cb) => { pushChanged = cb; return () => { pushChanged = null } })
  window.tangu = { platform: 'darwin', remoteSessions: api, secretStorageStatus: vi.fn().mockResolvedValue({ level: 'plaintext', backend: 'basic_text', locked: [], restartRequired: false, lastError: null }) } as unknown as Window['tangu']
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete window.tangu
})

async function mount(): Promise<void> {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(RemoteSessionsSettings) })))
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel)
const sw = (): HTMLButtonElement => q<HTMLButtonElement>('[data-setting-anchor="remote-sessions-switch"] [role="switch"]')!
const cap = (m: string): HTMLButtonElement => q<HTMLButtonElement>(`[data-cap="${m}"]`)!
const text = (): string => host.textContent ?? ''

describe('RemoteSessionsSettings', () => {
  it('门控:设备页 / 云端 Web / 移动端没有这一页,组件不画、不读', async () => {
    for (const flag of ['unitPage', 'cloudWeb', 'mobile'] as const) {
      ;(window.tangu as Record<string, unknown>)[flag] = true
      expect(remoteSessionsApi(), flag).toBeUndefined()
      await mount()
      expect(host.innerHTML, flag).toBe('')
      delete (window.tangu as Record<string, unknown>)[flag]
    }
    expect(api.get).not.toHaveBeenCalled()
    expect(remoteSessionsApi()).toBe(api)
  })

  it('三块锚点都在;开关跟随 enabled && permitted;写 G9 说明;推送替换视图', async () => {
    await mount()
    for (const a of ['remote-sessions-switch', 'remote-approval-cap', 'remote-trusted-devices']) expect(q(`[data-setting-anchor="${a}"]`), a).not.toBeNull()
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(q('[data-rs-scope]')!.textContent).toContain('不影响其他设备浏览这台电脑上的文件和智库')
    await act(async () => sw().click())
    expect(api.setEnabled).toHaveBeenCalledWith(false)
    expect(sw().getAttribute('aria-checked')).toBe('false')
    await act(async () => pushChanged!(makeView({ enabled: true })))
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  it('父开关关:子开关置灰并提示先打开「允许其他设备连接本机」', async () => {
    view = makeView({ hostEnabled: false, enabled: false, permitted: null }) // 父开关关着主进程不问 K5
    await mount()
    expect(sw().disabled).toBe(true)
    expect(q('[data-rs-need-host]')!.textContent).toContain('允许其他设备连接本机')
    expect(q('[data-rs-insecure]')).toBeNull() // null = 未知,不画「未加密」提示
    expect(q('[data-secrets]')).toBeNull()
    // 开关存档开着、后来关了互联:照实显示存档意愿(开),但置灰
    view = makeView({ hostEnabled: false, enabled: true, permitted: null })
    await act(async () => pushChanged!(view))
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(sw().disabled).toBe(true)
    expect(q('[data-rs-insecure]')).toBeNull()
  })

  it('R-24:设备凭据未加密(permitted=false)→ 开关显示关、置灰,挂 SecretStorageNotice;主进程拒绝时提示换成本地化那句', async () => {
    view = makeView({ enabled: true, permitted: false })
    await mount()
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(sw().disabled).toBe(true)
    expect(q('[data-rs-insecure]')).not.toBeNull()
    expect(q('[data-secrets="plaintext"]')).not.toBeNull() // K5 的提示组件
    // 主进程那边的拒绝(竞态:点的时候还允许,落到主进程时已不允许)
    view = makeView({ enabled: false, permitted: true })
    await act(async () => pushChanged!(view))
    api.setEnabled.mockRejectedValueOnce(new Error("Error invoking remote method 'remoteSessions:setEnabled': Error: secret-store-insecure"))
    await act(async () => sw().click())
    expect(q('[role="alert"]')!.textContent).toContain('设备凭据还没有加密保存')
  })

  it('审批档:只读 / 自动编辑点了就写;选全自动先就地确认,勾「我了解风险」之前确认键不可点、不写盘;确认后常驻警示', async () => {
    await mount()
    expect(cap('auto-edit').getAttribute('aria-checked')).toBe('true')
    await act(async () => cap('readonly').click())
    expect(api.setMaxApprovalMode).toHaveBeenLastCalledWith('readonly')
    await act(async () => cap('full-auto').click())
    expect(api.setMaxApprovalMode).toHaveBeenCalledTimes(1)
    const box = q('[data-rs-fullauto-confirm]')!
    expect(box.textContent).toContain('替你批准它自己的请求')
    const confirm = [...box.querySelectorAll('button')].find((b) => b.textContent?.includes('改为全自动'))!
    expect(confirm.disabled).toBe(true)
    await act(async () => confirm.click())
    expect(api.setMaxApprovalMode).toHaveBeenCalledTimes(1)
    // 取消:收回、不写
    await act(async () => [...box.querySelectorAll('button')].find((b) => b.textContent === '取消')!.click())
    expect(q('[data-rs-fullauto-confirm]')).toBeNull()
    expect(cap('readonly').getAttribute('aria-checked')).toBe('true')
    // 再选、勾选、确认
    await act(async () => cap('full-auto').click())
    const ack = q<HTMLInputElement>('[data-rs-fullauto-confirm] input[type="checkbox"]')!
    await act(async () => ack.click())
    const confirm2 = [...q('[data-rs-fullauto-confirm]')!.querySelectorAll('button')].find((b) => b.textContent?.includes('改为全自动'))!
    expect(confirm2.disabled).toBe(false)
    await act(async () => confirm2.click())
    expect(api.setMaxApprovalMode).toHaveBeenLastCalledWith('full-auto')
    expect(q('[data-rs-fullauto-confirm]')).toBeNull()
    expect(q('[data-rs-fullauto-warn]')!.textContent).toContain('审批不再保证来自真人')
  })

  it('信任列表:账号行(迁移预置标注)+ 设备行(本机记下的名字)+ 等待确认;撤销调主进程;空态', async () => {
    view = makeView({
      trusted: [
        { principal: 'account', confirmedAt: 1, preconfirmed: true },
        { principal: 'unit', unitId: UNIT, name: '小米 14', kind: 'phone', platform: 'android', registeredAt: '2026-09-20T08:00:00.000Z', confirmedAt: Date.now() - 60_000 },
      ],
      pending: [{ principal: 'unit', unitId: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e61', name: '书房 PC', kind: 'desktop', since: 1 }],
    })
    await mount()
    const list = q('[data-setting-anchor="remote-trusted-devices"]')!.textContent!
    expect(list).toContain('本账号的浏览器与网页版')
    expect(list).toContain('更新时自动允许')
    expect(list).toContain('小米 14')
    expect(list).toContain('手机 · android')
    expect(list).toContain('书房 PC')
    expect(q('[data-rs-pending]')!.textContent).toBe('等待确认')
    await act(async () => q<HTMLButtonElement>(`[data-rs-revoke="${UNIT}"]`)!.click())
    expect(api.revoke).toHaveBeenLastCalledWith(UNIT)
    await act(async () => q<HTMLButtonElement>('[data-rs-revoke="account"]')!.click())
    expect(api.revoke).toHaveBeenLastCalledWith('account')
    await act(async () => pushChanged!(makeView()))
    expect(text()).toContain('还没有设备')
  })

  it('扩展槽(R-12):注册的区块按 order 渲染在三块之后,注销即消失', async () => {
    const offB = registerRemoteSettingsSection({ id: 'b', order: 200, render: () => React.createElement('section', { 'data-slot': 'b' }, 'B') })
    const offA = registerRemoteSettingsSection({ id: 'remote-safety', order: 100, render: () => React.createElement('section', { 'data-slot': 'a' }, 'A') })
    await mount()
    const slots = [...host.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot'))
    expect(slots).toEqual(['a', 'b'])
    const all = [...host.querySelectorAll('[data-setting-anchor], [data-slot]')].map((e) => e.getAttribute('data-setting-anchor') ?? e.getAttribute('data-slot'))
    expect(all).toEqual(['remote-sessions-switch', 'remote-approval-cap', 'remote-trusted-devices', 'a', 'b'])
    await act(async () => { offA() })
    expect([...host.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot'))).toEqual(['b'])
    offB()
  })

  it('en:没有汉字漏出', async () => {
    setLocaleGlobal('en')
    view = makeView({ maxApprovalMode: 'full-auto', trusted: [{ principal: 'account', confirmedAt: 1, preconfirmed: false }] })
    await mount()
    expect(/[一-鿿]/.test(text())).toBe(false)
    expect(text()).toContain('Allow remote sessions')
  })
})
