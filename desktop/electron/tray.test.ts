import { describe, expect, it, vi } from 'vitest'

const menus = vi.hoisted(() => [] as unknown[])
vi.mock('electron', () => ({
  app: { getPreferredSystemLanguages: () => ['zh-Hans-CN'], isPackaged: false },
  // 托盘桩:只记下每次 setContextMenu 收到的模板(Menu.buildFromTemplate 原样回传),供「切语言重建菜单」断言
  Tray: class { setToolTip(): void {} setContextMenu(m: unknown): void { menus.push(m) } on(): void {} },
  Menu: { buildFromTemplate: (t: unknown) => t }, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}))

import { createTray, setTrayLocale, trayLang, trayMenuTemplate, type TrayHandlers } from './tray'
import { initMainLocale, setMainLocale } from './mainI18n'
import type { ComputerHistoryState } from '../shared/computerHistory'

const base: TrayHandlers = { show: vi.fn(), checkUpdates: vi.fn(), quit: vi.fn() }
const st = (over: Partial<ComputerHistoryState>): ComputerHistoryState =>
  ({ v: 1, enabled: true, pausedUntil: null, status: 'recording', since: 0, updatedAt: 0, platform: 'darwin', dataGen: 0, ...over })
const labels = (items: Electron.MenuItemConstructorOptions[]) => items.filter((i) => i.type !== 'separator').map((i) => i.label)

describe('tray', () => {
  it('语言按系统首选:zh* → 中文,其余英文', () => {
    expect(trayLang(['zh-Hant-TW', 'en-US'])).toBe('zh')
    expect(trayLang(['en-US', 'zh-CN'])).toBe('en')
    expect(trayLang([])).toBe('en')
    expect(trayLang()).toBe('zh') // 缺省读 app.getPreferredSystemLanguages()
  })

  it('界面语言(渲染层手选 / IP 校正)优先于系统语言;没设 / 非法值回落系统', () => {
    expect(trayLang(['zh-CN'], 'en')).toBe('en') // 中文系统上手选英文
    expect(trayLang(['en-US'], 'zh')).toBe('zh')
    expect(trayLang(['zh-CN'], null)).toBe('zh')
    try {
      setTrayLocale('en')
      expect(trayLang()).toBe('en')
      setTrayLocale('fr')
      expect(trayLang()).toBe('zh') // 非 zh/en = 没设 → 系统(mock 为 zh-Hans-CN)
      setTrayLocale('en')
      setTrayLocale(null) // ui:sync 里的 null = 删键 = 回到跟随系统
      expect(trayLang()).toBe('zh')
    } finally {
      setTrayLocale(null)
    }
  })

  it('三项基础菜单双语;电脑历史关着时不出现', () => {
    expect(labels(trayMenuTemplate(base, 'en'))).toEqual(['Show Forsion', 'Check for updates', 'Quit Forsion'])
    expect(labels(trayMenuTemplate(base, 'zh'))).toEqual(['显示 Forsion', '检查更新', '退出 Forsion'])
    const off = { ...base, computerHistory: { state: () => st({ enabled: false, status: 'off' }), pauseHour: vi.fn(), resume: vi.fn() } }
    expect(labels(trayMenuTemplate(off, 'en'))).toHaveLength(3)
  })

  it('录制中 → 状态行 + 暂停 1 小时;暂停中 → 暂停到几点 + 恢复', () => {
    const pauseHour = vi.fn(), resume = vi.fn()
    let state = st({})
    const h = { ...base, computerHistory: { state: () => state, pauseHour, resume } }
    const rec = trayMenuTemplate(h, 'en')
    expect(labels(rec)).toEqual(['Show Forsion', 'Check for updates', 'Computer history: recording', 'Pause computer history for 1 hour', 'Quit Forsion'])
    expect(rec.find((i) => i.label === 'Computer history: recording')?.enabled).toBe(false)
    ;(rec.find((i) => i.label === 'Pause computer history for 1 hour')!.click as () => void)()
    expect(pauseHour).toHaveBeenCalled()

    const now = new Date(2026, 8, 27, 14, 0).getTime()
    state = st({ status: 'paused', pausedUntil: new Date(2026, 8, 27, 15, 30).getTime() })
    const paused = trayMenuTemplate(h, 'zh', now)
    expect(labels(paused)).toContain('电脑历史：已暂停至 15:30')
    ;(paused.find((i) => i.label === '恢复电脑历史')!.click as () => void)()
    expect(resume).toHaveBeenCalled()
    state = st({ status: 'paused', pausedUntil: new Date(2026, 8, 28, 0, 0).getTime() })
    expect(labels(trayMenuTemplate(h, 'en', now))).toContain('Computer history: paused until 9/28 00:00')
  })

  it('语言来源是 mainI18n:setMainLocale 切语言 → 托盘菜单自动重建为对应语言(P1-K5)', () => {
    initMainLocale({ systemLanguages: () => ['zh-Hans-CN'] }) // 同 main.ts:注入系统首选语言
    try {
      createTray(base)
      const last = () => labels(menus[menus.length - 1] as Electron.MenuItemConstructorOptions[])
      expect(last()).toEqual(['显示 Forsion', '检查更新', '退出 Forsion'])
      setMainLocale('en')
      expect(trayLang()).toBe('en')
      expect(last()).toEqual(['Show Forsion', 'Check for updates', 'Quit Forsion'])
      const n = menus.length
      setMainLocale('en') // 同值不重建
      expect(menus.length).toBe(n)
      setTrayLocale(null) // 旧名仍可用(= setMainLocale),回到跟随系统
      expect(last()).toEqual(['显示 Forsion', '检查更新', '退出 Forsion'])
    } finally {
      setMainLocale(null)
      initMainLocale({ systemLanguages: () => [] })
    }
  })
})

// P1-K2:远程段(文案 main.remoteSafety.tray.*,zh / en 同构)
import type { RemoteTrayView } from './remoteSafety'
describe('tray 远程段(P1-K2)', () => {
  const view = (over: Partial<RemoteTrayView> = {}): RemoteTrayView => ({
    capable: true, locked: false, activeLabel: null, activeCount: 0, waitingApproval: false,
    hotkey: { accelerator: 'Control+Alt+Shift+.', registered: true }, ...over,
  })
  const remote = (v: RemoteTrayView) => ({ view: () => v, stopAll: vi.fn(), unlock: vi.fn(), openSettings: vi.fn() })

  it('空闲 + 能远程:只有「停止全部远程任务」,热键只显示不注册;在最前面、后跟分隔线', () => {
    const r = remote(view())
    const items = trayMenuTemplate({ ...base, remote: r }, 'zh')
    expect(items[0]).toMatchObject({ label: '停止全部远程任务', accelerator: 'Control+Alt+Shift+.', registerAccelerator: false })
    expect(items[1]).toEqual({ type: 'separator' })
    ;(items[0].click as () => void)()
    expect(r.stopAll).toHaveBeenCalled()
  })

  it('不能远程、没在跑、没锁 → 不出远程段', () => {
    expect(labels(trayMenuTemplate({ ...base, remote: remote(view({ capable: false })) }, 'en'))).toEqual(['Show Forsion', 'Check for updates', 'Quit Forsion'])
  })

  it('在跑:禁用标签带设备名 / 多个 / 等待', () => {
    expect(labels(trayMenuTemplate({ ...base, remote: remote(view({ activeLabel: 'Pixel', activeCount: 1 })) }, 'en')).slice(0, 2))
      .toEqual(['Remote session running · Pixel', 'Stop all remote tasks'])
    const zh = trayMenuTemplate({ ...base, remote: remote(view({ activeLabel: 'Pixel', activeCount: 3, waitingApproval: true })) }, 'zh')
    expect(zh[0]).toMatchObject({ label: '远程会话运行中 · Pixel 等 2 个（等你处理）', enabled: false })
    expect(trayMenuTemplate({ ...base, remote: remote(view({ activeLabel: 'Pixel', activeCount: 2, waitingApproval: true })) }, 'en')[0].label)
      .toBe('Remote session running · Pixel and 1 more (waiting for you)')
  })

  it('锁定:常驻「停止全部」+「远程访问已锁定」+「解锁远程访问…」(即使不能远程)', () => {
    const r = remote(view({ capable: false, locked: true }))
    const items = trayMenuTemplate({ ...base, remote: r }, 'en')
    expect(labels(items).slice(0, 3)).toEqual(['Stop all remote tasks', 'Remote access locked', 'Unlock remote access…'])
    expect(items[1].enabled).toBe(false)
    ;(items[2].click as () => void)()
    expect(r.unlock).toHaveBeenCalled()
  })

  it('热键没注册上 → 失败可见 + 「更改快捷键…」打开设置;「停止全部」不带 accelerator', () => {
    const r = remote(view({ hotkey: { accelerator: 'Control+Alt+Shift+.', registered: false } }))
    const items = trayMenuTemplate({ ...base, remote: r }, 'zh')
    expect(labels(items).slice(0, 3)).toEqual(['停止全部远程任务', '急停快捷键不可用', '更改快捷键…'])
    expect(items[0].accelerator).toBeUndefined()
    ;(items[2].click as () => void)()
    expect(r.openSettings).toHaveBeenCalled()
  })

  it('view 抛异常 → 不出远程段(菜单照常)', () => {
    expect(labels(trayMenuTemplate({ ...base, remote: { view: () => { throw new Error('x') }, stopAll: vi.fn(), unlock: vi.fn(), openSettings: vi.fn() } }, 'en')))
      .toEqual(['Show Forsion', 'Check for updates', 'Quit Forsion'])
  })
})
