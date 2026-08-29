/**
 * 「内置插件」:内置浏览器 / 内置终端 / 日历。默认开启,可在 设置 → Forsion 插件 顶部的「内置」区关掉。
 *
 * 为什么不是真外置插件:外置插件 API 是 `new Function(setup(ctx))` + 纯 DOM mount + CSP,
 * 拿不到 <webview>(要主进程开 webviewTag)、拿不到 PTY(要原生模块 + IPC),日历那三个视图更是
 * 直接吃全库多维表聚合。所以做成宿主原生视图,只在插件页以插件形态露出并可开关 ——
 * 用户看到的形态一致,不为几个内置能力去扩插件 API 的攻击面。
 *
 * 关闭 = 先关掉工作台里该类型的全部实例,再反注册视图与命令(Dockview 的 components map
 * 收缩时不能留活面板,与 pluginViews.tsx 同款纪律)。
 */
import React, { Suspense } from 'react'
import { create } from 'zustand'
import { Globe, TerminalSquare } from 'lucide-react'
import { registerView, unregisterView, addCommand, removeCommand, useWorkspace, getView, Skeleton } from '@lcl/engine'
import { lazyRetry } from '../lazyRetry'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { useUnitRemote } from '../components/UnitSwitcher'
import { windowKind } from '../windowKind'
import { PluginLogo } from '../components/PluginLogo'
import { calendarAvailable, installCalendarSpace, installCalendarViews, removeCalendarSpace } from './calendar'
import { homepageAvailable, installHomepageSpace, installHomepageViews, removeHomepageSpace } from './homepage'

// 懒载:xterm(约 300KB)只在真开终端时才解析;顺带让这个模块能被 node 环境的单测导入
// (xterm 的 UMD 包在模块顶层就摸 `self`)。
const BrowserView = lazyRetry(() => import('./browserView').then((m) => ({ default: m.BrowserView })))
const TerminalView = lazyRetry(() => import('./terminalView').then((m) => ({ default: m.TerminalView })))

registerMessages({
  // 小节标题与说明已上移到插件页统一的「内置插件」区(settings.amadeusPlugins.builtinTitle/builtinHint),
  // 那一区同时管宿主原生能力和编辑器内置插件,不能只说宿主这一半。
  'browser.title': { zh: '浏览器', en: 'Browser' },
  'browser.desc': { zh: '在应用内打开网页与本地 HTML,不用切出去。', en: 'Open web pages and local HTML inside the app.' },
  'browser.open': { zh: '打开浏览器', en: 'Open browser' },
  'browser.back': { zh: '后退', en: 'Back' },
  'browser.forward': { zh: '前进', en: 'Forward' },
  'browser.reload': { zh: '刷新', en: 'Reload' },
  'browser.stop': { zh: '停止', en: 'Stop' },
  'browser.placeholder': { zh: '输入网址或搜索词', en: 'Enter a URL or search' },
  'browser.openExternal': { zh: '用系统浏览器打开', en: 'Open in system browser' },
  'browser.failed': { zh: '加载失败:{msg}', en: 'Load failed: {msg}' },
  'browser.inAppLinks': { zh: '应用内链接用内置浏览器打开', en: 'Open in-app links in the built-in browser' },
  'terminal.title': { zh: '终端', en: 'Terminal' },
  'terminal.desc': { zh: '应用内的真终端(登录 shell,支持 vim/top/ssh)。', en: 'A real terminal inside the app (login shell; vim/top/ssh work).' },
  'terminal.open': { zh: '打开终端', en: 'Open terminal' },
  'terminal.exited': { zh: '进程已退出(code {code})', en: 'Process exited (code {code})' },
  'terminal.restart': { zh: '重新启动', en: 'Restart' },
  'terminal.unavailable': { zh: '终端不可用:node-pty 原生模块未就绪。', en: 'Terminal unavailable: the node-pty native module is not ready.' },
})

const tr = (k: string, vars?: Record<string, unknown>): string => useApp.getState().tr(k, vars)

// ── 开关持久化(localStorage;默认开)────────────────────────────────────────
const key = (id: string): string => `builtin.${id}.enabled`
const LINKS_KEY = 'builtin.browser.inAppLinks'
function readFlag(k: string): boolean {
  try { return localStorage.getItem(k) !== '0' } catch { return true } // 隐私模式 → 按默认开
}
function writeFlag(k: string, on: boolean): void {
  try { localStorage.setItem(k, on ? '1' : '0') } catch { /* 隐私模式:本次会话生效即可 */ }
}

/** 关掉工作台里该类型的**全部**实例(主区 + 两侧),为反注册清场:Dockview 的 components map
 *  收缩时不能留活面板。⚠️`closeSideView` 一次只关**第一个**匹配面板(engine/dockviewStore),
 *  同侧拖了两个同类型面板时单调一次会漏 → 循环到关光为止(带上限,防 close 失败时死循环)。 */
function closeLeafsOfType(type: string): void {
  const ws = useWorkspace.getState()
  for (const tab of ws.mainTabs) if (tab.type === type) ws.closeLeaf(tab.id)
  for (const side of ['left', 'right'] as const) {
    for (let i = 0; i < 16; i++) {
      const before = sideCount(type, side)
      if (!before) break
      ws.closeSideView(side, type)
      if (sideCount(type, side) >= before) break // 没关掉就别转下去了
    }
  }
}

/** 某侧还剩几个该类型的面板(读 dockview 真实 panel 表,`mainTabs` 只覆盖主区)。 */
function sideCount(type: string, side: 'left' | 'right'): number {
  const api = (useWorkspace.getState() as unknown as { api?: { panels?: Array<{ params?: Record<string, unknown> }> } }).api
  return (api?.panels ?? []).filter((p) => p.params?.__type === type && p.params?.__loc === side).length
}

interface BuiltinDef {
  id: string
  /** 视图注册名(= 命令/Space 引用名);开关时按这份清单清场 + 反注册。 */
  types: string[]
  name(): string
  description(): string
  /** 宿主具备所需能力才注册:web/移动端跑同一套渲染层,但既没有 <webview> 也没有 PTY。 */
  available(): boolean
  install(): void
  /** 贡献 Space 的内置插件:**只在运行时开关时**调(启动那次由 registerSpaces 按槽位注册,
   *  见 builtins/calendar 的注释)。实现须幂等。 */
  installSpace?(): void
  removeSpace?(): void
}

export const BUILTINS: BuiltinDef[] = [
  {
    id: 'browser',
    types: ['browser'],
    name: () => tr('browser.title'),
    description: () => tr('browser.desc'),
    available: () => !!window.tangu, // Electron preload 在场 = <webview> 可用
    install() {
      registerView({ type: 'browser', kind: 'page', displayName: () => tr('browser.title'), icon: Globe, factory: (props) => <Suspense fallback={<Skeleton variant="document" />}><BrowserView {...props} /></Suspense>, closable: true, singleton: false })
      addCommand({ id: 'builtin-browser-open', title: () => tr('browser.open'), icon: Globe, keywords: 'browser web url 浏览器 网页', run: () => openBrowser() })
    },
  },
  {
    id: 'terminal',
    types: ['terminal'],
    name: () => tr('terminal.title'),
    description: () => tr('terminal.desc'),
    available: () => !!window.tangu?.pty,
    install() {
      registerView({ type: 'terminal', kind: 'page', displayName: () => tr('terminal.title'), icon: TerminalSquare, factory: (props) => <Suspense fallback={<Skeleton variant="document" />}><TerminalView {...props} /></Suspense>, closable: true, singleton: false })
      addCommand({ id: 'builtin-terminal-open', title: () => tr('terminal.open'), icon: TerminalSquare, keywords: 'terminal shell console 终端 命令行', run: () => openTerminal() })
    },
  },
  {
    id: 'home',
    types: ['homepage'],
    name: () => tr('space.home'),
    description: () => tr('home.builtinDesc'),
    available: homepageAvailable,
    install: installHomepageViews,
    installSpace: installHomepageSpace,
    removeSpace: removeHomepageSpace,
  },
  {
    id: 'calendar',
    types: ['calendar', 'todo-list', 'calendar-config'],
    name: () => tr('space.calendar'),
    description: () => tr('calendar.builtinDesc'),
    available: calendarAvailable,
    install: installCalendarViews,
    installSpace: installCalendarSpace,
    removeSpace: removeCalendarSpace,
  },
]

/** 某内置插件当前开着吗(直读持久化开关):启动期 spaces.tsx 要在 store 建起来之前就问这一句。 */
export const builtinEnabled = (id: string): boolean => readFlag(key(id))

function applyBuiltin(def: BuiltinDef, on: boolean): void {
  if (on) {
    if (!getView(def.types[0])) def.install()
    def.installSpace?.()
    return
  }
  // 先撤 Space(停在里面就切走 → 顺带把日历布局存进命名槽),再清场反注册视图:
  // Dockview 的 components map 收缩时不能留活面板。
  def.removeSpace?.()
  for (const t of def.types) { closeLeafsOfType(t); unregisterView(t) }
  removeCommand(`builtin-${def.id}-open`) // 无此命令时 no-op(日历不注册命令)
}

interface BuiltinState {
  enabled: Record<string, boolean>
  /** 应用内 http(s) 链接是否走内置浏览器(关 = 照旧转系统浏览器)。 */
  inAppLinks: boolean
  toggle(id: string, on: boolean): void
  setInAppLinks(on: boolean): void
}

export const useBuiltins = create<BuiltinState>((set, get) => ({
  enabled: Object.fromEntries(BUILTINS.map((b) => [b.id, readFlag(key(b.id))])),
  inAppLinks: readFlag(LINKS_KEY),
  toggle: (id, on) => {
    const def = BUILTINS.find((b) => b.id === id)
    if (!def || !def.available()) return
    writeFlag(key(id), on)
    applyBuiltin(def, on)
    set({ enabled: { ...get().enabled, [id]: on } })
  },
  setInAppLinks: (on) => { writeFlag(LINKS_KEY, on); set({ inAppLinks: on }) },
}))

/** 外链去哪:遵「应用内链接」开关 —— 开着走内置浏览器标签,否则交给系统浏览器。
 *  主进程回投的外链(onOpenUrl)与渲染层自己拦下的链接(聊天网页引用条 Desk 走不通时)
 *  必须**同一个出口**,否则两条路的开关语义会悄悄分叉。 */
export function routeExternalUrl(url: string): void {
  const s = useBuiltins.getState()
  if (s.inAppLinks && s.enabled.browser && windowKind() !== 'mini') {
    // 设备远程面(UnitRemoteSurface)开着时必须先退场:回投来的新标签(含远程页里 window.open
    // 的附件,见 main.ts did-attach-webview)会开在远程面**底下**,观感=点了没反应。
    const remote = useUnitRemote.getState()
    if (remote.active) remote.hide()
    openBrowser(url)
  } else void window.tangu?.openExternal?.(url)
}

/** 在 mini 窗之外开一个内置浏览器标签;内置浏览器关着 / 无工作台 → 退回系统浏览器。 */
export function openBrowser(url?: string): void {
  if (!getView('browser') || windowKind() === 'mini') {
    if (url) void window.tangu?.openExternal?.(url)
    return
  }
  useWorkspace.getState().openView('browser', url ? { url } : {}, 'main', { newTab: true })
}

/** 开一个内置终端标签(cwd 可选:调用方有工作目录就传,否则家目录)。 */
export function openTerminal(cwd?: string): void {
  if (!getView('terminal')) return
  useWorkspace.getState().openView('terminal', cwd ? { cwd } : {}, 'main', { newTab: true })
}

/** 本机绝对路径 → file:// URL。逐段编码(空格/#/? 都要转义),Windows 盘符段 `C:` 原样留。
 *  UNC(`\\server\share\x`)的规范形态是 `file://server/share/x` —— 主机名进 authority,
 *  不能当成普通路径段多加两道斜杠。 */
export function fileUrlOf(path: string): string {
  const p = path.replace(/\\/g, '/')
  const enc = (seg: string): string => (/^[a-z]:$/i.test(seg) ? seg : encodeURIComponent(seg))
  if (p.startsWith('//')) { // UNC:第一段是主机名
    const [host, ...rest] = p.slice(2).split('/')
    return 'file://' + encodeURIComponent(host) + (rest.length ? '/' + rest.map(enc).join('/') : '/')
  }
  const body = p.split('/').map(enc).join('/')
  return 'file://' + (body.startsWith('/') ? '' : '/') + body
}

/** 本地 .html/.htm → 内置浏览器。走**本地 http 令牌根**而不是 file://:file: 页面是不透明源,
 *  `fetch('./model.glb')` 一律被拦(three.js 之类的加载器就死在这),真实 http 源才跑得起来。
 *  拿不到挂根能力(旧宿主)才退回 file://。内置浏览器关着 → 返回 false,调用方走自己原来的路径。 */
export function openLocalHtml(path: string): boolean {
  if (!getView('browser') || windowKind() === 'mini') return false // mini 窗没有工作台可开标签
  const open = (url: string): void => { useWorkspace.getState().openView('browser', { url }, 'main', { newTab: true }) }
  const serve = window.tangu?.codePreviewServePath
  if (!serve) { open(fileUrlOf(path)); return true }
  void serve(path).then((r) => open(r.url)).catch(() => open(fileUrlOf(path)))
  return true
}

let installed = false

/** 装一次:接主进程回投的外链 + 按持久化开关注册内置视图/命令。installEngine 里调(且放最前)。 */
export function installBuiltins(): void {
  if (installed) return

  // ⚠️外链路由**第一件事**就接上:主进程已经不再自己 openExternal 了,这个 listener 没装成
  // 就等于全应用外链失效。放在视图注册之前,任一 registerView 抛错也炸不到它。
  window.tangu?.onOpenUrl?.(routeExternalUrl)
  installed = true // listener 已就位才算装上(装失败允许下次重试)

  // 另一个窗口改了开关 → 本窗口跟着生效(每个渲染进程各有一份 store,只读 localStorage 快照
  // 会让 detached 窗继续用早已被关掉的内置能力)。
  window.addEventListener('storage', (e) => {
    if (e.key === LINKS_KEY) { useBuiltins.setState({ inAppLinks: readFlag(LINKS_KEY) }); return }
    const def = BUILTINS.find((b) => key(b.id) === e.key)
    if (!def || !def.available()) return
    const on = readFlag(key(def.id))
    if (useBuiltins.getState().enabled[def.id] === on) return
    applyBuiltin(def, on)
    useBuiltins.setState({ enabled: { ...useBuiltins.getState().enabled, [def.id]: on } })
  })

  const { enabled } = useBuiltins.getState()
  for (const def of BUILTINS) if (enabled[def.id] && def.available()) def.install()
}

// ── 设置 → Forsion 插件「内置」区里的宿主原生那几张卡 ──────────────────────
// 只吐卡片、不带外层容器与小节标题:调用方(AmadeusPluginsTab)把这几张和编辑器内置插件
// (Callout/字数统计)排进**同一列**,用户看到的是一个「内置」区而不是两处零件。
// 卡片样式一律走 .plugin-card,与外置插件同款 —— 别再在这里写 inline style。
export const BuiltinPluginsSection: React.FC = () => {
  const { t } = useI18n()
  const enabled = useBuiltins((s) => s.enabled)
  const inAppLinks = useBuiltins((s) => s.inAppLinks)
  const toggle = useBuiltins((s) => s.toggle)
  const setInAppLinks = useBuiltins((s) => s.setInAppLinks)
  const list = BUILTINS.filter((b) => b.available())
  if (!list.length) return null // web/移动端没有 webview/PTY,这几张卡整个不出现

  return (
    <>
      {list.map((b) => (
        <div key={b.id} className="plugin-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <PluginLogo />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b style={{ fontSize: 13 }}>{b.name()}</b>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{b.description()}</div>
            </div>
            <input type="checkbox" checked={!!enabled[b.id]} onChange={(e) => toggle(b.id, e.target.checked)} style={{ cursor: 'pointer' }} />
          </div>
          {b.id === 'browser' && enabled.browser && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={inAppLinks} onChange={(e) => setInAppLinks(e.target.checked)} />
              {t('browser.inAppLinks')}
            </label>
          )}
        </div>
      ))}
    </>
  )
}
