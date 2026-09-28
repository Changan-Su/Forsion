/**
 * 系统托盘 / macOS 菜单栏图标。App 运行期常驻:关闭主窗只是隐藏到托盘(见 main.ts 的 close 拦截),
 * 由此处菜单「退出」或 before-quit 才真正退出。
 * 图标复用打包用的 build/icon.png(彩色品牌图);缩到 18px 适配托盘/菜单栏。
 * ponytail: 用彩色 App 图标而非 mac 模板图(不随明暗反色),要更贴 HIG 再画一张单色模板图换上。
 * 文案双语,跟随界面语言:语言来源统一在 mainI18n.ts(P1-K5)—— 渲染层把四级链判完的**生效**语言经 ui:locale 报上来
 * (uiLocaleSync.ts,P1-KF;窗口载入前用上次的缓存);还没报过 = 回落系统首选语言。语言一变(onMainLocaleChange)
 * 就重建菜单。COPY 表留在这里(i18nCoverage M4 核对 zh/en 键集);
 * 别的包往托盘加的段(远程活动等)文案走各自的 defineMainMessages 片段,不往 COPY 里加键。
 * 电脑历史开着时多一行状态 + 「暂停 1 小时 / 恢复」(全机采集开着,关闭入口不能只藏在设置页里);
 * 状态变化由 main 调 refreshTrayMenu() 重建菜单。
 */
import { app, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import type { ComputerHistoryState } from '../shared/computerHistory'
import { mainLocaleOverride, mtFor, onMainLocaleChange, setMainLocale, UI_LOCALE_PREF_KEY as MAIN_UI_LOCALE_PREF_KEY } from './mainI18n'
import { REMOTE_SAFETY_MESSAGES, type RemoteTrayView } from './remoteSafety' // P1-K2:托盘远程段的文案片段(main.remoteSafety.tray.*)

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
  /** P1-K2 远程活动 / 急停(可选:无 agent 后端的产品形态不传)。文案走 main.remoteSafety.tray.*,不进 COPY 表(R-23)。 */
  remote?: {
    view: () => RemoteTrayView
    stopAll: () => void
    unlock: () => void
    openSettings: () => void
  }
}
void REMOTE_SAFETY_MESSAGES // 片段随 import 登记(mtFor 取得到)

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

/** 渲染层界面语言的 localStorage 键:真身在 mainI18n.ts,这里再导出一份保兼容。 */
export const UI_LOCALE_PREF_KEY = MAIN_UI_LOCALE_PREF_KEY

/** 旧名:= mainI18n.setMainLocale(非 zh/en 一律当「没设」)。菜单重建由下面的 onMainLocaleChange 订阅负责。 */
export const setTrayLocale: (value: unknown) => void = setMainLocale

/** 界面语言优先(缺省取 mainI18n 的覆盖值);没有则系统首选语言 zh* → 中文,其余英文。 */
export function trayLang(preferred: readonly string[] = safePreferredLanguages(), ui: TrayLang | null = mainLocaleOverride()): TrayLang {
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

/**
 * P1-K2 远程段(插在「显示 / 检查更新」之前):
 *   在跑 → 禁用标签「远程会话运行中 · {name}」(多个带「等 n 个」,有人在等批准再加一句);
 *   能远程 / 在跑 / 锁着 → 「停止全部远程任务」(accelerator 只显示热键、不在菜单里注册,registerAccelerator:false);
 *   锁着 → 禁用标签「远程访问已锁定」+「解锁远程访问…」;
 *   能远程但热键没注册上 → 禁用标签「急停快捷键不可用」+「更改快捷键…」(失败可见,D13)。
 */
export function remoteTrayItems(r: NonNullable<TrayHandlers['remote']>, lang: TrayLang): Electron.MenuItemConstructorOptions[] {
  let v: RemoteTrayView
  try { v = r.view() } catch { return [] }
  const m = (k: string, vars?: Record<string, string | number>): string => mtFor(lang, `main.remoteSafety.tray.${k}`, vars)
  const items: Electron.MenuItemConstructorOptions[] = []
  if (v.activeCount > 0 && v.activeLabel) {
    const head = v.activeCount > 1 ? m('runningMore', { name: v.activeLabel, n: v.activeCount - 1 }) : m('running', { name: v.activeLabel })
    items.push({ label: v.waitingApproval ? head + m('waiting') : head, enabled: false })
  }
  if (v.capable || v.activeCount > 0 || v.locked) {
    items.push({
      label: m('stopAll'), click: () => r.stopAll(),
      ...(v.hotkey.registered && v.hotkey.accelerator ? { accelerator: v.hotkey.accelerator, registerAccelerator: false } : {}),
    })
  }
  if (v.locked) items.push({ label: m('locked'), enabled: false }, { label: m('unlock'), click: () => r.unlock() })
  if (v.capable && !v.hotkey.registered) items.push({ label: m('hotkeyUnavailable'), enabled: false }, { label: m('changeHotkey'), click: () => r.openSettings() })
  return items.length ? [...items, { type: 'separator' }] : []
}

/** 纯函数:菜单模板(单测直接断言)。 */
export function trayMenuTemplate(h: TrayHandlers, lang: TrayLang, now = Date.now()): Electron.MenuItemConstructorOptions[] {
  const t = COPY[lang]
  const items: Electron.MenuItemConstructorOptions[] = [
    ...(h.remote ? remoteTrayItems(h.remote, lang) : []), // P1-K2
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

// 界面语言变了 → 重建菜单(托盘还没建时 refreshTrayMenu 自己是空操作)。
onMainLocaleChange(() => refreshTrayMenu())

/** P1-K2:菜单栏标题(仅 mac 显示文字:' 远程' / ' 已锁定')+ 所有平台的 tooltip。托盘还没建就什么都不做。 */
export function setTrayIndicator(title: string, tooltip: string): void {
  if (!tray) return
  try {
    if (process.platform === 'darwin') tray.setTitle(title)
    tray.setToolTip(tooltip || 'Forsion')
  } catch { /* 托盘已销毁 */ }
}

/** 电脑历史状态变了 → 重建菜单(托盘还没建就什么都不做)。 */
export function refreshTrayMenu(): void {
  if (!tray || !handlers) return
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(handlers, trayLang())))
}
