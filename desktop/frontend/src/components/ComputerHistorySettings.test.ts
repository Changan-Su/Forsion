// @vitest-environment happy-dom
import React, { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerHistorySettings, computerHistoryApi } from './ComputerHistorySettings'
import { LocaleProvider, setLocaleGlobal } from '../i18n'
import type {
  ComputerHistoryApi, ComputerHistoryExclude, ComputerHistorySession, ComputerHistoryState, ComputerHistoryView,
} from '../../../shared/computerHistory'
import type { DesktopPermissionsSnapshot } from '../types'

const NOW = new Date(2026, 8, 27, 15, 0).getTime()
const MIN = 60_000

/** 主进程每拍一张快照 rev +1;页面只收更大的,所以假 API 造的每份 View 也得递增。 */
let revSeq = 0
function makeView(state: Partial<ComputerHistoryState> = {}, exclude: Partial<ComputerHistoryExclude> = {}): ComputerHistoryView {
  return {
    state: { v: 1, enabled: true, pausedUntil: null, status: 'recording', since: NOW - 30 * MIN, updatedAt: NOW, platform: 'darwin', dataGen: 0, ...state },
    exclude: { apps: [], domains: [], ...exclude },
    root: '/Users/me/.forsion-dev/computer-history',
    keepDays: 7,
    rev: ++revSeq,
  }
}

let host: HTMLDivElement
let root: Root
let mounted: boolean
let view: ComputerHistoryView
let pushChanged: ((v: ComputerHistoryView) => void) | null
const unsubscribe = vi.fn()
const api = {
  get: vi.fn<ComputerHistoryApi['get']>(),
  setEnabled: vi.fn<ComputerHistoryApi['setEnabled']>(),
  pause: vi.fn<ComputerHistoryApi['pause']>(),
  resume: vi.fn<ComputerHistoryApi['resume']>(),
  clear: vi.fn<ComputerHistoryApi['clear']>(),
  setExclude: vi.fn<ComputerHistoryApi['setExclude']>(),
  recent: vi.fn<ComputerHistoryApi['recent']>(),
  recentApps: vi.fn<ComputerHistoryApi['recentApps']>(),
  appIcons: vi.fn<ComputerHistoryApi['appIcons']>(),
  days: vi.fn<ComputerHistoryApi['days']>(),
  reveal: vi.fn<ComputerHistoryApi['reveal']>(),
  onChanged: vi.fn<ComputerHistoryApi['onChanged']>(),
}
const permissionsStatus = vi.fn<() => Promise<DesktopPermissionsSnapshot>>()
const permissionRequest = vi.fn<(id: string, options?: unknown) => Promise<DesktopPermissionsSnapshot>>()
const snapshot = (over: Partial<DesktopPermissionsSnapshot> = {}): DesktopPermissionsSnapshot => ({
  platform: 'darwin', appName: 'Forsion', computerUseAvailable: true, helperInstalled: true, helperRunning: true,
  permissions: { computerAccessibility: 'denied', computerScreen: 'unverified', microphone: 'granted', camera: 'granted', screen: 'granted' },
  ...over,
})

const sessions: ComputerHistorySession[] = [
  { start: NOW - 50 * MIN, end: NOW - 40 * MIN, app: 'Safari', bundleId: 'com.apple.Safari', title: 'Docs', url: 'https://docs.example.com/guide', typed: ['secret draft'] },
  { start: NOW - 20 * MIN, end: NOW - 5 * MIN, app: 'Notes', bundleId: 'com.apple.Notes', title: 'Groceries', typed: [] },
  { start: NOW - 26 * 60 * MIN, end: NOW - 25 * 60 * MIN, app: 'Mail', bundleId: 'com.apple.mail', title: 'Yesterday', typed: [] },
]

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  setLocaleGlobal('zh')
  view = makeView()
  pushChanged = null
  const resolveView = () => Promise.resolve(view)
  api.get.mockReset().mockImplementation(resolveView)
  api.setEnabled.mockReset().mockImplementation(async (on) => (view = makeView({ enabled: on, status: on ? 'recording' : 'off' }, view.exclude)))
  api.pause.mockReset().mockImplementation(async () => (view = makeView({ status: 'paused', pausedUntil: NOW + 30 * MIN }, view.exclude)))
  api.resume.mockReset().mockImplementation(async () => (view = makeView({}, view.exclude)))
  api.clear.mockReset().mockImplementation(resolveView)
  api.setExclude.mockReset().mockImplementation(async (exclude) => (view = { ...view, exclude, rev: ++revSeq }))
  api.recent.mockReset().mockResolvedValue(sessions)
  api.recentApps.mockReset().mockResolvedValue([{ name: 'Safari', bundleId: 'com.apple.Safari' }, { name: 'Health', bundleId: 'com.apple.Health' }])
  api.appIcons.mockReset().mockResolvedValue({ 'com.apple.Notes': 'data:image/png;base64,AAAA', 'com.apple.Safari': null })
  api.days.mockReset().mockResolvedValue(['2026-09-27', '2026-09-26', '2026-09-24'])
  api.reveal.mockReset().mockResolvedValue(undefined)
  unsubscribe.mockReset()
  api.onChanged.mockReset().mockImplementation((cb) => { pushChanged = cb; return unsubscribe })
  permissionsStatus.mockReset().mockResolvedValue(snapshot())
  permissionRequest.mockReset().mockResolvedValue(snapshot())
  window.tangu = {
    platform: 'darwin',
    computerHistory: api,
    desktopPermissionsStatus: permissionsStatus,
    desktopPermissionRequest: permissionRequest,
    desktopPermissionsVerify: vi.fn(),
    desktopPermissionsCloseGuide: vi.fn().mockResolvedValue(undefined),
  } as unknown as Window['tangu']
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
})
afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
  host.remove()
  delete window.tangu
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function mount(strict = false) {
  let element: React.ReactElement = React.createElement(LocaleProvider, { children: React.createElement(ComputerHistorySettings, { mode: 'light', anchor: 'computer-history' }) })
  if (strict) element = React.createElement(StrictMode, {}, element)
  await act(async () => root.render(element))
}
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('button')]
async function click(label: string) {
  const button = buttons().find((b) => b.textContent?.trim() === label)
  expect(button, `Missing button: ${label}`).toBeTruthy()
  expect(button!.disabled).toBe(false)
  await act(async () => button!.click())
}
const text = (): string => host.textContent ?? ''

describe('ComputerHistorySettings', () => {
  it('按天回看:选昨天 → 读昨天整天,只画昨天的段;空的一天说「这一天没有记录」', async () => {
    await mount()
    const sel = host.querySelector<HTMLSelectElement>('select.ch-day')!
    // 只列有记录的日子:今天 / 昨天 / 9-24(9-25 没记录,不列)
    expect([...sel.options].map((o) => o.value)).toEqual(['0', '1', '3'])
    expect([...sel.options].map((o) => o.textContent).slice(0, 2)).toEqual(['今天', '昨天'])
    const pick = async (v: string): Promise<void> => {
      await act(async () => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    }
    await pick('1')
    const yStart = new Date(2026, 8, 26).getTime()
    expect(api.recent).toHaveBeenLastCalledWith(24, yStart + 24 * 60 * MIN)
    const rows = [...host.querySelectorAll('.ch-block')].map((li) => li.textContent)
    expect(rows).toHaveLength(3) // 夹具里昨天只有 13:00–14:00 的 Mail → 13:40 / 13:20 / 13:00 三段;今天的两段不画
    expect(rows[0]).toContain('13:40')
    expect(rows.every((r) => r!.includes('Yesterday'))).toBe(true)
    api.recent.mockResolvedValueOnce([])
    await pick('3')
    expect(text()).toContain('这一天没有记录')
  })

  it('读状态、订阅推送,卸载时退订;预览只列今天且不露输入的文字', async () => {
    await mount(true)
    expect(api.get).toHaveBeenCalled()
    expect(api.onChanged).toHaveBeenCalled()
    expect(host.querySelector('[data-setting-anchor="computer-history"]')).not.toBeNull()
    expect(text()).toContain('记录中')
    expect(text()).toContain('/Users/me/.forsion-dev/computer-history')
    expect(text()).toContain('7 天')
    const rows = [...host.querySelectorAll('.ch-block')].map((li) => li.textContent)
    expect(rows).toHaveLength(2) // 14:40 段 + 14:00 段(Safari 恰好收在 14:20,不溢进下一段)
    expect(rows[0]).toContain('Notes') // 新的在前
    expect(rows[0]).toContain('14:40')
    expect(rows[1]).toContain('docs.example.com')
    expect(api.appIcons).toHaveBeenCalledWith(['com.apple.Safari', 'com.apple.Notes', 'com.apple.mail'])
    expect(host.querySelector('.ch-block img.ch-app-icon')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(host.querySelectorAll('.ch-block')[1].querySelector('.ch-app-icon--letter')?.textContent).toBe('S') // 取不到图标 → 首字母
    expect(text()).not.toContain('Yesterday')
    expect(text()).not.toContain('secret draft')
    expect(api.recent).toHaveBeenLastCalledWith(15, NOW) // 只读零点到现在(NOW = 15:00),不多读昨天的文件
    await act(async () => pushChanged!(makeView({ status: 'disconnected' })))
    expect(host.querySelector('[data-ch-status]')?.getAttribute('data-ch-status')).toBe('disconnected')
    expect(text()).toContain('正在自动重连')
    await act(async () => root.unmount())
    mounted = false
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('开关、暂停(传时长)与恢复', async () => {
    view = makeView({ enabled: false, status: 'off' })
    await mount()
    expect(text()).toContain('已关闭')
    const hasPause = (): boolean => buttons().some((b) => b.textContent?.trim() === '30 分钟')
    expect(hasPause()).toBe(false) // 关着时不给暂停
    const flip = async () => act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    // 从关到开先就地复述同意要点,确认了才开录;取消不写
    await flip()
    expect(api.setEnabled).not.toHaveBeenCalled()
    expect(text()).toContain('开始记录电脑历史？')
    expect(text()).toContain('未加密保存 7 天')
    expect(text()).toContain('Forsion 云端')
    expect(text()).toContain('工作日志（Journal）不会随之删除') // 清除只删记录:引用过它的对话与 Muse 的笔记要另删
    await click('取消')
    expect(host.querySelector('.ch-confirm--consent')).toBeNull()
    await flip()
    await click('开启记录')
    expect(api.setEnabled).toHaveBeenCalledWith(true)
    expect(host.querySelector('.ch-confirm--consent')).toBeNull()
    expect(hasPause()).toBe(true)
    await click('30 分钟')
    expect(api.pause).toHaveBeenCalledWith(30 * MIN)
    expect(text()).toContain('已暂停到 15:30')
    await click('恢复记录')
    expect(api.resume).toHaveBeenCalledTimes(1)
    expect(text()).toContain('记录中')
    await click('到明天')
    expect(api.pause).toHaveBeenLastCalledWith('tomorrow')
    // 关掉不需要确认
    await flip()
    expect(api.setEnabled).toHaveBeenLastCalledWith(false)
  })

  it('清除要先确认,确认时才按当前时刻算起点', async () => {
    await mount()
    await click('最近 1 小时')
    expect(api.clear).not.toHaveBeenCalled()
    expect(text()).toContain('删除最近 1 小时的电脑历史？')
    expect(text()).toContain('请另行删除这些对话')
    await click('取消')
    expect(api.clear).not.toHaveBeenCalled()
    await click('最近 1 小时')
    vi.setSystemTime(NOW + 5 * MIN)
    const recentCalls = api.recent.mock.calls.length
    await click('删除')
    expect(api.clear).toHaveBeenCalledWith({ sinceMs: NOW + 5 * MIN - 60 * MIN })
    expect(api.recent.mock.calls.length).toBe(recentCalls + 1) // 清完重拉预览
    expect(text()).toContain('已清除')
    await click('全部')
    await click('删除')
    expect(api.clear).toHaveBeenLastCalledWith({ all: true })
  })

  it('预览只认最后一次请求:清除后的重拉不被清除前发出、晚到的旧结果盖回去', async () => {
    await mount()
    let resolveStale!: (v: ComputerHistorySession[]) => void
    api.recent.mockImplementationOnce(() => new Promise((r) => { resolveStale = r }))
    await click('刷新') // 旧请求挂着
    api.recent.mockResolvedValueOnce([])
    await click('全部')
    await click('删除') // 清完重拉 → 空
    expect(host.querySelectorAll('.ch-block')).toHaveLength(0)
    await act(async () => resolveStale(sessions)) // 旧结果晚到
    expect(host.querySelectorAll('.ch-block')).toHaveLength(0)
    expect(text()).toContain('今天还没有记录')
  })

  it('排除 App:从最近用过的里添加、芯片上移除', async () => {
    await mount()
    const select = host.querySelector<HTMLSelectElement>('.ch-add select')!
    expect([...select.options].map((o) => o.value)).toEqual(['', 'com.apple.Safari', 'com.apple.Health'])
    await act(async () => {
      select.value = 'com.apple.Health'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.setExclude).toHaveBeenCalledWith({ apps: ['com.apple.Health'], domains: [] })
    const chip = host.querySelector<HTMLElement>('[data-bundle-id="com.apple.Health"]')!
    expect(chip.textContent).toContain('Health')
    await act(async () => chip.querySelector('button')!.click())
    expect(api.setExclude).toHaveBeenLastCalledWith({ apps: [], domains: [] })
  })

  it('排除 App:没被记过的也能手填 Bundle ID 先排除,校验 + 去重', async () => {
    api.recentApps.mockResolvedValue([]) // 首次开启:还没有最近用过的 App
    view = makeView({}, { apps: ['com.apple.Safari'] })
    await mount()
    expect(host.querySelector<HTMLSelectElement>('.ch-add select')!.disabled).toBe(true)
    const form = host.querySelector<HTMLFormElement>('form[data-ch-add="app"]')!
    const input = form.querySelector('input')!
    const submit = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => form.requestSubmit())
    }
    await submit('Health')
    expect(api.setExclude).not.toHaveBeenCalled()
    expect(text()).toContain('请输入有效的 Bundle ID')
    await submit('com.apple.safari')
    expect(api.setExclude).not.toHaveBeenCalled()
    expect(text()).toContain('这个 App 已经在列表里了')
    await submit(' com.apple.Health ')
    expect(api.setExclude).toHaveBeenCalledWith({ apps: ['com.apple.Safari', 'com.apple.Health'], domains: [] })
    expect(input.value).toBe('')
  })

  it('排除网站:校验并规范化域名,重复与非法不写', async () => {
    view = makeView({}, { domains: ['example.com'] })
    await mount()
    const input = host.querySelector<HTMLInputElement>('form[data-ch-add="site"] input')!
    const submit = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => host.querySelector<HTMLFormElement>('form[data-ch-add="site"]')!.requestSubmit())
    }
    await submit('not a domain')
    expect(api.setExclude).not.toHaveBeenCalled()
    expect(text()).toContain('请输入有效的域名')
    await submit('https://www.Example.com/login')
    expect(api.setExclude).not.toHaveBeenCalled()
    expect(text()).toContain('已经在列表里')
    await submit('https://mail.bank.co.uk/inbox')
    expect(api.setExclude).toHaveBeenCalledWith({ apps: [], domains: ['example.com', 'mail.bank.co.uk'] })
    expect(input.value).toBe('')
  })

  it('缺辅助功能权限:给提示并挂只含辅助功能的权限卡(不给屏幕录制与验证)', async () => {
    view = makeView({ status: 'no_permission' })
    await mount()
    expect(text()).toContain('需要辅助功能权限')
    expect(text()).toContain('tangu-computer-use')
    expect(permissionsStatus).toHaveBeenCalled()
    expect(host.querySelector('[data-permission="computerAccessibility"]')).not.toBeNull()
    expect(host.querySelector('[data-permission="computerScreen"]')).toBeNull()
    expect(host.querySelector('.desktop-permissions-verify')).toBeNull()
  })

  it('helper 未安装:权限卡给「安装并设置权限」,点了走安装;正常录制时不挂卡', async () => {
    permissionsStatus.mockResolvedValue(snapshot({ helperInstalled: false, helperRunning: false, helperError: 'not-installed' }))
    view = makeView({ status: 'helper_missing' })
    await mount()
    expect(text()).toContain('用下方按钮安装助手')
    const install = host.querySelector<HTMLButtonElement>('.ch-permission [data-permission="computerAccessibility"] button')
    expect(install?.textContent?.trim()).toBe('安装并设置权限')
    await act(async () => install!.click())
    expect(permissionRequest).toHaveBeenCalledWith('computerAccessibility', expect.objectContaining({ mode: 'light' }))
    await act(async () => root.unmount())
    root = createRoot(host)
    view = makeView()
    await mount()
    expect(host.querySelector('.ch-permission')).toBeNull()
  })

  it('helper 过旧:卡上的按钮走更新 / 重启;进行中回到前台不触发重连,结束后才重读', async () => {
    view = makeView({ status: 'helper_outdated' })
    await mount()
    expect(text()).toContain('活动监视器') // 更新后仍卡住的出路写清楚,不再让人「先升级 Forsion」
    expect(text()).not.toContain('先升级 Forsion')
    const button = host.querySelector<HTMLButtonElement>('.ch-permission [data-permission="computerAccessibility"] button')
    expect(button?.textContent?.trim()).toBe('打开系统设置') // 旧助手在跑且答得上 permissionStatus;提示不许承诺卡上没有的按钮
    let finish!: (s: DesktopPermissionsSnapshot) => void
    permissionRequest.mockImplementationOnce(() => new Promise((r) => { finish = r }))
    await act(async () => button!.click())
    expect(permissionRequest).toHaveBeenCalledWith('computerAccessibility', expect.anything())
    const gets = api.get.mock.calls.length
    // 原生「更新并重启助手」对话框关掉 → 窗口回到前台:此时绝不能 get()(主进程会在失败态立即重连并拉起旧版)
    await act(async () => window.dispatchEvent(new Event('focus')))
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(api.get.mock.calls.length).toBe(gets)
    // 状态在更新途中跳成 disconnected 也不卸卡(卡片卸载会关掉主进程那边的请求,还会顺手 get() 触发重连)
    view = makeView({ status: 'disconnected' })
    await act(async () => pushChanged!(view))
    expect(host.querySelector('.ch-permission')).not.toBeNull()
    expect(api.get.mock.calls.length).toBe(gets)
    await act(async () => finish(snapshot()))
    expect(api.get.mock.calls.length).toBe(gets + 1)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(api.get.mock.calls.length).toBe(gets + 2)
  })

  it('云端 Web / 移动端 / 设备页:没有这一页,组件什么都不画', async () => {
    for (const flag of ['cloudWeb', 'mobile', 'unitPage'] as const) {
      ;(window.tangu as Record<string, unknown>)[flag] = true
      expect(computerHistoryApi(), flag).toBeUndefined()
      await mount()
      expect(host.innerHTML, flag).toBe('')
      expect(api.get).not.toHaveBeenCalled()
      await act(async () => root.unmount())
      root = createRoot(host)
      delete (window.tangu as Record<string, unknown>)[flag]
    }
    expect(computerHistoryApi()).toBe(api)
  })

  it('非 macOS:只说明「目前仅支持 macOS」,不读不写', async () => {
    ;(window.tangu as { platform?: string }).platform = 'win32'
    await mount()
    expect(text()).toContain('目前仅支持 macOS')
    expect(api.get).not.toHaveBeenCalled()
    expect(host.querySelector('[role="switch"]')).toBeNull()
  })

  it('主进程回 unsupported 同样收起控件', async () => {
    view = makeView({ status: 'unsupported', enabled: false })
    await mount()
    expect(text()).toContain('目前仅支持 macOS')
    expect(host.querySelector('[role="switch"]')).toBeNull()
  })

  it('写失败就地报错,读失败可重试', async () => {
    api.setEnabled.mockRejectedValueOnce(new Error("Error invoking remote method 'computerHistory:setEnabled': Error: disk full"))
    await mount()
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('disk full')
    await act(async () => root.unmount())
    root = createRoot(host)
    api.get.mockRejectedValueOnce(new Error('IPC unavailable'))
    await mount()
    expect(text()).toContain('IPC unavailable')
    await click('重试')
    expect(text()).toContain('记录中')
  })

  it('只收更新的 View(creview ui #1):晚到的旧 get() 回包与写结果不盖掉新的推送', async () => {
    await mount()
    const status = (): string | null | undefined => host.querySelector('[data-ch-status]')?.getAttribute('data-ch-status')
    // 旧快照(暂停)先拍、推送(托盘恢复 → 记录中)后拍;get() 回包晚于推送到达
    const stale = makeView({ status: 'paused', pausedUntil: NOW + 30 * MIN })
    const fresh = makeView({ status: 'recording' })
    let resolveGet!: (v: ComputerHistoryView) => void
    api.get.mockImplementationOnce(() => new Promise((r) => { resolveGet = r }))
    await act(async () => window.dispatchEvent(new Event('focus')))
    await act(async () => pushChanged!(fresh))
    await act(async () => resolveGet(stale))
    expect(status()).toBe('recording')
    // 写操作的回包同理:暂停的结果先拍,之后的推送先到
    let resolvePause!: (v: ComputerHistoryView) => void
    api.pause.mockImplementationOnce(() => new Promise((r) => { resolvePause = r }))
    const paused = makeView({ status: 'paused', pausedUntil: NOW + 30 * MIN })
    await click('30 分钟')
    await act(async () => pushChanged!(makeView({ status: 'recording' })))
    await act(async () => resolvePause(paused))
    expect(status()).toBe('recording')
    // 更新的照收
    await act(async () => pushChanged!(makeView({ status: 'disconnected' })))
    expect(status()).toBe('disconnected')
  })

  it('「关闭」没能保存:页顶提示正在重试、重启前可能恢复记录;保存成功后提示消失', async () => {
    await mount()
    await act(async () => pushChanged!({ ...makeView({ enabled: false, status: 'off' }), persistError: 'EROFS: read-only file system' }))
    const alert = host.querySelector('[data-ch-persist-error]')
    expect(alert?.textContent).toContain('EROFS: read-only file system')
    expect(alert?.textContent).toContain('正在自动重试')
    expect(alert?.textContent).toContain('重启 Forsion')
    // 暂停 / 收紧排除表落不成也走这条提示(creview C):文案不能只说「关闭」
    expect(alert?.textContent).toContain('暂停')
    expect(alert?.textContent).toContain('排除')
    await act(async () => pushChanged!(makeView({ enabled: false, status: 'off' })))
    expect(host.querySelector('[data-ch-persist-error]')).toBeNull()
  })

  it('state.json 没能更新(creview3 #2):页顶提示状态文件写不进、正在重试,附错误原文;写上后提示消失', async () => {
    await mount()
    await act(async () => pushChanged!({ ...makeView({ enabled: false, status: 'off' }), stateError: 'EACCES: permission denied, open; EACCES: permission denied, unlink' }))
    const alert = host.querySelector('[data-ch-state-error]')
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toContain('EACCES: permission denied, unlink')
    expect(alert?.textContent).toContain('state.json')
    expect(alert?.textContent).toContain('正在自动重试')
    expect(host.querySelector('[data-ch-persist-error]')).toBeNull() // 与「配置没保存」是两回事
    await act(async () => pushChanged!(makeView({ enabled: false, status: 'off' })))
    expect(host.querySelector('[data-ch-state-error]')).toBeNull()
  })

  it('助手更新进行中(creview ui #2):清除与排除表控件锁住(它们会让主进程重订阅),回车提交也不写;结束后解锁', async () => {
    view = makeView({ status: 'helper_outdated' }, { apps: ['com.apple.Safari'], domains: ['example.com'] })
    await mount()
    let finish!: (s: DesktopPermissionsSnapshot) => void
    permissionRequest.mockImplementationOnce(() => new Promise((r) => { finish = r }))
    await act(async () => host.querySelector<HTMLButtonElement>('.ch-permission [data-permission="computerAccessibility"] button')!.click())
    const clearButtons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[data-clear]')]
    const lockables = (): Array<HTMLButtonElement | HTMLSelectElement> => [
      ...clearButtons(),
      host.querySelector<HTMLButtonElement>('[data-bundle-id="com.apple.Safari"] button')!,
      host.querySelector<HTMLButtonElement>('[data-domain="example.com"] button')!,
      host.querySelector<HTMLSelectElement>('.ch-add select')!,
    ]
    expect(clearButtons()).toHaveLength(4)
    expect(lockables().every((el) => el.disabled)).toBe(true)
    const form = host.querySelector<HTMLFormElement>('form[data-ch-add="site"]')!
    const input = form.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'bank.cn')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    await act(async () => form.requestSubmit())
    expect(api.setExclude).not.toHaveBeenCalled()
    await act(async () => finish(snapshot()))
    expect(lockables().every((el) => !el.disabled)).toBe(true)
  })

  it('等用户处理时:「刷新状态」在首张面板的状态行,权限卡是同页面板(无自带工具条),暂停不给', async () => {
    permissionsStatus.mockResolvedValue(snapshot({ helperInstalled: false, helperRunning: false, helperError: 'not-installed' }))
    for (const status of ['helper_missing', 'no_permission', 'helper_outdated'] as const) {
      view = makeView({ status })
      await mount()
      const panels = [...host.querySelectorAll('.settings-panel')]
      const refresh = host.querySelector<HTMLButtonElement>('[data-ch-refresh-status]')
      expect(refresh?.textContent?.trim(), status).toBe('刷新状态')
      expect(panels[0].contains(refresh), `${status}: 刷新在首张面板里`).toBe(true)
      expect(refresh!.closest('.settings-control-row')?.textContent, status).toContain(status === 'no_permission' ? '需要辅助功能权限' : 'Computer Use 助手')
      const card = host.querySelector('.ch-permission')!
      expect(card.classList.contains('settings-panel'), status).toBe(true)
      expect(card.querySelector('.settings-panel-head')?.textContent, status).toContain('Computer Use 助手')
      expect(card.querySelector('.desktop-permissions-toolbar'), `${status}: 卡上不再单独画刷新`).toBeNull()
      expect(host.querySelector('.ch-btn-row'), `${status}: 录不了就不给暂停`).toBeNull()
      expect([...host.querySelectorAll('.settings-control-copy strong')].map((s) => s.textContent), status).not.toContain('暂停记录')
      await act(async () => root.unmount())
      root = createRoot(host)
    }
    // 点「刷新状态」= 重读电脑历史状态 + 让权限卡重读快照
    view = makeView({ status: 'helper_missing' })
    await mount()
    const gets = api.get.mock.calls.length
    const reads = permissionsStatus.mock.calls.length
    await act(async () => host.querySelector<HTMLButtonElement>('[data-ch-refresh-status]')!.click())
    expect(api.get.mock.calls.length).toBe(gets + 1)
    expect(permissionsStatus.mock.calls.length).toBe(reads + 1)
  })

  it('断线重连中:照样能暂停(随时会录上),状态行给「刷新状态」;正常录制时没有它', async () => {
    await mount()
    expect(host.querySelector('[data-ch-refresh-status]')).toBeNull()
    expect(host.querySelector('.ch-btn-row')).not.toBeNull()
    await act(async () => pushChanged!(makeView({ status: 'disconnected' })))
    expect(host.querySelector('.ch-btn-row')).not.toBeNull()
    expect(host.querySelector('.ch-permission')).toBeNull()
    const gets = api.get.mock.calls.length
    await act(async () => host.querySelector<HTMLButtonElement>('[data-ch-refresh-status]')!.click())
    expect(api.get.mock.calls.length).toBe(gets + 1)
    await click('30 分钟')
    expect(api.pause).toHaveBeenCalledWith(30 * MIN)
    // 已暂停:暂停行收起,状态行只给「恢复记录」
    expect(host.querySelector('.ch-btn-row')).toBeNull()
    expect(host.querySelector('[data-ch-refresh-status]')).toBeNull()
  })

  it('助手更新进行中「刷新状态」禁用(它会 get() → 主进程立刻重连,把旧助手拉起来)', async () => {
    view = makeView({ status: 'helper_outdated' })
    await mount()
    let finish!: (s: DesktopPermissionsSnapshot) => void
    permissionRequest.mockImplementationOnce(() => new Promise((r) => { finish = r }))
    await act(async () => host.querySelector<HTMLButtonElement>('.ch-permission [data-permission="computerAccessibility"] button')!.click())
    expect(host.querySelector<HTMLButtonElement>('[data-ch-refresh-status]')!.disabled).toBe(true)
    await act(async () => finish(snapshot()))
    expect(host.querySelector<HTMLButtonElement>('[data-ch-refresh-status]')!.disabled).toBe(false)
  })

  it('「会记录」里 ⌘ / ⌃ 在句中,⌘ / ⌃ 用不换行空格粘住下一个词(折行不会让符号落在行尾)', async () => {
    await mount()
    expect(text()).toContain('以及按住 ⌘\u00a0或 ⌃\u00a0的快捷键（如 ⌘S）')
    expect(text()).not.toContain('⌘ / ⌃')
    await act(async () => root.unmount())
    root = createRoot(host)
    setLocaleGlobal('en')
    await mount()
    expect(text()).toContain('keyboard shortcuts that use ⌘\u00a0or ⌃\u00a0(such as ⌘S)')
  })

  it('回到前台时重读状态(从系统设置授权回来)', async () => {
    await mount()
    const before = api.get.mock.calls.length
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(api.get.mock.calls.length).toBe(before + 1)
  })
})
