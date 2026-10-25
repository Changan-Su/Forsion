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
 * 在跑 / 等你的会话(借鉴 Comma 第三轮 2.6):会话名册在渲染层,各窗口经 tray:sessions 各报一份精简清单,main 并起来(mergeTrayReports → setTraySessions);
 * 菜单顶上列出(等你在前、最多 5 条,多的一行「还有 n 个…」),mac 菜单栏图标旁写个数(Windows 托盘不支持标题文字,只有菜单)。
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
  /** 在跑 / 等你的会话(可选:无 agent 后端的产品形态不传)。list 是渲染层报上来的清单;open = 显示主窗并打开那条会话。 */
  sessions?: {
    list: () => readonly TraySessionRow[]
    open: (sessionId: string) => void
  }
  /** 「新建 Mini 对话」(同全局快捷键 ⌘/Ctrl+⇧+M;可选)。accelerator = 热键真注册上了才给(菜单里只显示,不重复注册)。 */
  newMini?: {
    open: () => void
    accelerator: () => string | null
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

/** 渲染层报上来的一条会话(标题已按界面语言显示好)。 */
export interface TraySessionRow { id: string; title: string; state: 'run' | 'wait' }
/** 菜单顶上最多列几条(等你的排前)。 */
export const TRAY_SESSION_ROWS = 5
/** Mini 窗全局快捷键(main.ts 注册的那一个;菜单里只显示,不重复注册)。 */
export const MINI_ACCELERATOR = 'CommandOrControl+Shift+M'
const MAX_REPORTED_ROWS = 200

/** 渲染层经 IPC 送来的清单:形状不对的行丢掉,标题截短(菜单行太长会把整张菜单撑宽)。 */
export function sanitizeTraySessions(raw: unknown): TraySessionRow[] {
  if (!Array.isArray(raw)) return []
  const out: TraySessionRow[] = []
  const seen = new Set<string>()
  for (const r of raw.slice(0, MAX_REPORTED_ROWS)) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id || o.id.length > 64 || seen.has(o.id)) continue
    if (o.state !== 'run' && o.state !== 'wait') continue
    const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim() : ''
    seen.add(o.id)
    out.push({ id: o.id, title: title.length > 48 ? `${title.slice(0, 47)}…` : title, state: o.state })
  }
  return out
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null

const COPY = {
  zh: {
    show: '显示 Forsion', checkUpdates: '检查更新', quit: '退出 Forsion', newMini: '新建 Mini 对话',
    sessWait: '等你 · {n}', sessRun: '在跑 · {n}', sessMore: '还有 {n} 个…', sessUntitled: '未命名会话',
    chPause: '暂停电脑历史 1 小时', chResume: '恢复电脑历史',
    chRecording: '电脑历史：记录中', chPausedUntil: '电脑历史：已暂停至 {time}',
    chDisconnected: '电脑历史：未连接', chNoPermission: '电脑历史：需要辅助功能权限',
    chHelperMissing: '电脑历史：未安装辅助程序', chHelperOutdated: '电脑历史：辅助程序需要更新',
  },
  en: {
    show: 'Show Forsion', checkUpdates: 'Check for updates', quit: 'Quit Forsion', newMini: 'New Mini chat',
    sessWait: 'Needs you · {n}', sessRun: 'Running · {n}', sessMore: '{n} more…', sessUntitled: 'Untitled session',
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

/** 各窗口各报一份(主窗 / Mini / 独立窗各有自己的会话名册,在哪个窗口里起的 run 只有那个窗口先知道):按 id 并起来,
 *  任一窗口说「等你」就算等你;顺序 = 先报的窗口在前、同窗口内照原序,等你的整体排前。 */
export function mergeTrayReports(reports: Iterable<readonly TraySessionRow[]>): TraySessionRow[] {
  const byId = new Map<string, TraySessionRow>()
  for (const rows of reports) {
    for (const r of rows) {
      const cur = byId.get(r.id)
      if (!cur) byId.set(r.id, r)
      else if (cur.state === 'run' && r.state === 'wait') byId.set(r.id, { ...r, title: cur.title || r.title })
    }
  }
  const all = [...byId.values()]
  return [...all.filter((r) => r.state === 'wait'), ...all.filter((r) => r.state === 'run')]
}

/** Windows 菜单把 & 当助记符:标题里的 & 要写成 &&(mac 原样显示两个,所以只在 Windows 转义)。 */
const menuText = (s: string, platform: NodeJS.Platform): string => (platform === 'win32' ? s.replace(/&/g, '&&') : s)

/**
 * 在跑 / 等你段(插在最前面):「等你 · n」「在跑 · n」两个禁用小标题,各自下面是会话行(点了打开那条会话);
 * 一共最多 TRAY_SESSION_ROWS 条、等你的先占,小标题上的 n 是这一类的总数;列不下的写一行「还有 n 个…」,点了显示主窗。
 */
export function traySessionItems(s: NonNullable<TrayHandlers['sessions']>, show: () => void, lang: TrayLang, platform: NodeJS.Platform = process.platform): Electron.MenuItemConstructorOptions[] {
  let rows: readonly TraySessionRow[]
  try { rows = s.list() } catch { return [] }
  if (!rows.length) return []
  const t = COPY[lang]
  const wait = rows.filter((r) => r.state === 'wait')
  const run = rows.filter((r) => r.state === 'run')
  const shownWait = wait.slice(0, TRAY_SESSION_ROWS)
  const shownRun = run.slice(0, TRAY_SESSION_ROWS - shownWait.length)
  const row = (r: TraySessionRow): Electron.MenuItemConstructorOptions => ({ label: menuText(r.title || t.sessUntitled, platform), click: () => s.open(r.id) })
  const items: Electron.MenuItemConstructorOptions[] = []
  if (wait.length) items.push({ label: t.sessWait.replace('{n}', String(wait.length)), enabled: false }, ...shownWait.map(row))
  if (shownRun.length) items.push({ label: t.sessRun.replace('{n}', String(run.length)), enabled: false }, ...shownRun.map(row))
  const rest = rows.length - shownWait.length - shownRun.length
  if (rest > 0) items.push({ label: t.sessMore.replace('{n}', String(rest)), click: () => show() })
  return [...items, { type: 'separator' }]
}

function newMiniItem(m: NonNullable<TrayHandlers['newMini']>, label: string): Electron.MenuItemConstructorOptions {
  let acc: string | null = null
  try { acc = m.accelerator() } catch { /* 当没注册 */ }
  return { label, click: () => m.open(), ...(acc ? { accelerator: acc, registerAccelerator: false } : {}) }
}

/** 菜单栏图标旁的数(在跑 + 等你);0 = 不写。 */
export function traySessionCount(rows: readonly TraySessionRow[]): number {
  return rows.length
}

/** 纯函数:菜单模板(单测直接断言)。 */
export function trayMenuTemplate(h: TrayHandlers, lang: TrayLang, now = Date.now(), platform: NodeJS.Platform = process.platform): Electron.MenuItemConstructorOptions[] {
  const t = COPY[lang]
  const items: Electron.MenuItemConstructorOptions[] = [
    ...(h.sessions ? traySessionItems(h.sessions, () => h.show(), lang, platform) : []),
    ...(h.remote ? remoteTrayItems(h.remote, lang) : []), // P1-K2
    { label: t.show, click: () => h.show() },
    ...(h.newMini ? [newMiniItem(h.newMini, t.newMini)] : []),
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

// 菜单栏标题由两段拼成:在跑 / 等你的会话数(本文件)+ 远程指示(remoteSafety 经 setTrayIndicator 设)。各自只改自己那段。
let indicatorTitle = ''
let indicatorTooltip = ''
let sessionRows: TraySessionRow[] = []
let sessionSig = ''

/** 两段拼成的菜单栏标题:' 3' + ' 远程' → ' 3 远程';都没有 = ''。 */
export function composeTrayTitle(count: number, indicator: string): string {
  return `${count > 0 ? ` ${count}` : ''}${indicator}`
}

function applyTitle(): void {
  if (!tray) return
  try {
    if (process.platform === 'darwin') tray.setTitle(composeTrayTitle(traySessionCount(sessionRows), indicatorTitle))
    tray.setToolTip(indicatorTooltip || 'Forsion')
  } catch { /* 托盘已销毁 */ }
}

/** P1-K2:菜单栏标题(仅 mac 显示文字:' 远程' / ' 已锁定')+ 所有平台的 tooltip。托盘还没建就什么都不做。
 *  只换远程那段;会话数那段照旧拼在前面。 */
export function setTrayIndicator(title: string, tooltip: string): void {
  indicatorTitle = title || ''
  indicatorTooltip = tooltip || ''
  applyTitle()
}

/** 渲染层报上来的在跑 / 等你清单(已清洗)。没变就什么都不做;变了重建菜单 + 更新菜单栏的数。 */
export function setTraySessions(rows: TraySessionRow[]): void {
  const sig = JSON.stringify(rows)
  if (sig === sessionSig) return
  sessionSig = sig
  sessionRows = rows
  applyTitle()
  refreshTrayMenu()
}

/** 菜单的 sessions.list 读这里。 */
export function traySessions(): readonly TraySessionRow[] {
  return sessionRows
}

/** 电脑历史状态变了 → 重建菜单(托盘还没建就什么都不做)。 */
export function refreshTrayMenu(): void {
  if (!tray || !handlers) return
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(handlers, trayLang())))
}
