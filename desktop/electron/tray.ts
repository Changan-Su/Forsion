/**
 * 系统托盘 / macOS 菜单栏图标。App 运行期常驻:关闭主窗只是隐藏到托盘(见 main.ts 的 close 拦截),
 * 由此处菜单「退出」或 before-quit 才真正退出。
 * 图标复用打包用的 build/icon.png(彩色品牌图);缩到 18px 适配托盘/菜单栏。
 * ponytail: 用彩色 App 图标而非 mac 模板图(不随明暗反色),要更贴 HIG 再画一张单色模板图换上。
 * 文案双语,跟随界面语言:渲染层把结论存在 localStorage `tangu_locale`(① 手选 / ③ IP 校正都写它),
 * main 在主窗载入后读一次、之后从 ui:sync 转进来(setTrayLocale);没有这个键 = 界面跟随系统,这里同样回落系统首选语言。
 * 电脑历史开着时多一行状态 + 「暂停 1 小时 / 恢复」(全机采集开着,关闭入口不能只藏在设置页里);
 * 状态变化由 main 调 refreshTrayMenu() 重建菜单。
 */
import { app, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import type { ComputerHistoryState } from '../shared/computerHistory'

export type TrayLang = 'zh' | 'en'

export interface TrayHandlers {
  show: () => void
  checkUpdates: () => void
  quit: () => void
  /** 电脑历史(可选:无 agent 后端的产品形态没有)。 */
  computerHistory?: {
    state: () => ComputerHistoryState | null
    pauseHour: () => void
    resume: () => void
  }
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null

const COPY = {
  zh: {
    show: '显示 Forsion', checkUpdates: '检查更新', quit: '退出 Forsion',
    chPause: '暂停电脑历史 1 小时', chResume: '恢复电脑历史',
    chRecording: '电脑历史：记录中', chPausedUntil: '电脑历史：已暂停至 {time}',
    chDisconnected: '电脑历史：未连接', chNoPermission: '电脑历史：需要辅助功能权限',
    chHelperMissing: '电脑历史：未安装辅助程序', chHelperOutdated: '电脑历史：辅助程序需要更新',
  },
  en: {
    show: 'Show Forsion', checkUpdates: 'Check for updates', quit: 'Quit Forsion',
    chPause: 'Pause computer history for 1 hour', chResume: 'Resume computer history',
    chRecording: 'Computer history: recording', chPausedUntil: 'Computer history: paused until {time}',
    chDisconnected: 'Computer history: not connected', chNoPermission: 'Computer history: needs Accessibility access',
    chHelperMissing: 'Computer history: helper not installed', chHelperOutdated: 'Computer history: helper needs an update',
  },
} as const

/** 渲染层界面语言的 localStorage 键(= frontend/src/types.ts 的 LOCALE_KEY;主进程不 import 渲染层)。 */
export const UI_LOCALE_PREF_KEY = 'tangu_locale'

/** 渲染层报来的界面语言;null = 渲染层没存(跟随系统)或还没读到。 */
let uiLocale: TrayLang | null = null

/** main 转进来的界面语言(主窗载入时读 localStorage、ui:sync 的 prefs);非 zh/en 一律当「没设」。变了就重建菜单。 */
export function setTrayLocale(value: unknown): void {
  const next = value === 'zh' || value === 'en' ? value : null
  if (next === uiLocale) return
  uiLocale = next
  refreshTrayMenu()
}

/** 界面语言优先;没有则系统首选语言 zh* → 中文,其余英文。 */
export function trayLang(preferred: readonly string[] = safePreferredLanguages(), ui: TrayLang | null = uiLocale): TrayLang {
  if (ui) return ui
  return /^zh\b/i.test(preferred[0] ?? '') ? 'zh' : 'en'
}
function safePreferredLanguages(): string[] {
  try { return app.getPreferredSystemLanguages() } catch { return [] }
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** 暂停到的时刻:当天只写 HH:MM,跨天带上 M/D。 */
function untilLabel(until: number, now: number): string {
  const d = new Date(until), n = new Date(now)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 纯函数:菜单模板(单测直接断言)。 */
export function trayMenuTemplate(h: TrayHandlers, lang: TrayLang, now = Date.now()): Electron.MenuItemConstructorOptions[] {
  const t = COPY[lang]
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: t.show, click: () => h.show() },
    { label: t.checkUpdates, click: () => h.checkUpdates() },
  ]
  const ch = h.computerHistory
  const st = ch?.state()
  if (ch && st && st.enabled && st.status !== 'off' && st.status !== 'unsupported') {
    const status = st.status === 'paused' && st.pausedUntil ? t.chPausedUntil.replace('{time}', untilLabel(st.pausedUntil, now))
      : st.status === 'recording' ? t.chRecording
      : st.status === 'no_permission' ? t.chNoPermission
      : st.status === 'helper_missing' ? t.chHelperMissing
      : st.status === 'helper_outdated' ? t.chHelperOutdated
      : t.chDisconnected
    items.push(
      { type: 'separator' },
      { label: status, enabled: false },
      st.status === 'paused'
        ? { label: t.chResume, click: () => ch.resume() }
        : { label: t.chPause, click: () => ch.pauseHour() },
    )
  }
  items.push({ type: 'separator' }, { label: t.quit, click: () => h.quit() })
  return items
}

function trayIcon(): Electron.NativeImage {
  // 打包态:icon.png 经 extraResources 复制为 resources/tray.png;dev 态直接读 build/icon.png。
  const path = app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(__dirname, '../../build/icon.png')
  const img = nativeImage.createFromPath(path)
  return img.isEmpty() ? img : img.resize({ width: 18, height: 18 })
}

export function createTray(h: TrayHandlers): void {
  if (tray) return
  handlers = h
  tray = new Tray(trayIcon())
  tray.setToolTip('Forsion')
  refreshTrayMenu()
  // win/linux:左键单击直接召回主窗(mac 单击默认弹菜单,遵循平台习惯不额外绑定)。
  if (process.platform !== 'darwin') tray.on('click', () => h.show())
}

/** 电脑历史状态变了 → 重建菜单(托盘还没建就什么都不做)。 */
export function refreshTrayMenu(): void {
  if (!tray || !handlers) return
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(handlers, trayLang())))
}
