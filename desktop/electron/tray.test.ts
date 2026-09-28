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
      setTrayLocale(null) // null = 回到跟随系统(渲染层的报告入口 uiLocaleSync 只转 zh/en,不会发 null)
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
