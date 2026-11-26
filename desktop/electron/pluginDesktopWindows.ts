/**
 * 插件桌面小窗的主进程那半(2026-11-26,方案页 docs/ToBeImproved/插件桌面小窗方案_2026-11-26;契约在 shared/desktopWindow.ts)。
 *
 * 流程:主窗渲染层 prepare(插件 id、key、尺寸…)→ 这里过护栏、第一次询问,发一个一次性的窗口名 → 渲染层
 * window.open('about:blank', 名字) → 主窗的 window-open 处理器只放行这个名字,按 desktopFloat.ts 那组选项开子窗
 * (透明、无边框、不进任务栏、不可聚焦,mac 是 panel 型)→ did-create-window 里登记。窗口里的东西全由主窗那份插件实例画。
 *
 * 只认主窗:Mini / 独立窗 / Floating Panel 里的插件实例要开,渲染层先问 grant 再回落(见 pluginDesktopWindow.ts);
 * 小窗的生命挂在主窗页面上 —— 主窗重载 / 崩了 / 关了,这里把小窗全关掉(插件下次 setup 会再开,位置按 key 记着)。
 *
 * 读不出来 = 不知道(CLAUDE.md「读写用户数据」):授权文件读不出来就照样问、问完不写回;位置文件读不出来就放缺省位置、
 * 之后也不写回(不拿一个坏文件去盖)。文件不存在 = 空,照常写。
 *
 * ⚠️ macOS:Electron 的 type:'panel' 只给普通 NSWindow 加「不激活」样式位,AppKit 只对真 NSPanel 认它 —— 点小窗会把
 * Forsion 激活到前台(desktopFloat.ts 开头,11-08 实机)。所以鼠标进到宠物上(点穿关掉的那一刻)记下当时的前台应用,
 * 松手后若前台正是 Forsion 自己(= 这一下点击激活的),把那个应用切回去;核和切在同一次原生调用里(同听写的 handBack)。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails, WebContents } from 'electron'
import {
  DESKTOP_WINDOW_FRAME_PREFIX, DESKTOP_WINDOW_LIMIT, clampDesktopBounds, clampDesktopSize, defaultDesktopBounds, desktopWindowIdent,
  normalizePrepareRequest, screenOf,
  type DesktopRect, type DesktopScreen, type DesktopWindowGrant, type DesktopWindowPrepareReply,
} from '../shared/desktopWindow'

export interface DesktopWindowRow { id: string; pluginId: string; pluginName: string; title: string; visible: boolean }

export interface PluginDesktopDeps {
  userDataDir: string
  platform: NodeJS.Platform
  /** 主窗的 webContents(没有 / 已销毁 = null)。只有它能开小窗。 */
  mainContents(): WebContents | null
  /** 屏幕表(electron screen,逻辑像素)。 */
  screens(): DesktopScreen[]
  /** 鼠标所在那块屏的工作区:第一次开、没记住位置时放这里。 */
  cursorWorkArea(): DesktopRect
  /** 第一次询问(挂主窗的对话框):true = 允许。 */
  confirm(plugin: { id: string; name: string }): Promise<boolean>
  /** 名册变了(托盘重建)。 */
  onChanged(): void
  /** macOS 前台应用读写(听写那份 macDriver);别的平台 null。 */
  mac?: { front(): Promise<{ pid: number } | null>; activate(pid: number, onlyIfFront?: number): Promise<boolean> } | null
  selfPid?: number
  log?(msg: string): void
}

interface Entry {
  id: string
  ident: string
  pluginId: string
  pluginName: string
  key: string
  title: string
  frameName: string
  pin: boolean
  /** 窗口此刻在哪(换屏时宿主夹过的)。 */
  bounds: DesktopRect
  /** 用户 / 插件摆的位置:记进位置文件的是它。拔掉副屏时窗口被夹回主屏,这份不动,插回来下次开回原处。 */
  userBounds: DesktopRect
  win: BrowserWindow | null
  /** 宿主已叫它关、Electron 还没关完:不再算「开着」(同 key 能马上重开)、不算上限。 */
  closing: boolean
  ignoring: boolean
  /** mac:鼠标进到宠物上那一刻的前台应用(松手后交还)。 */
  front: number | null
  frontAt: number
  expire: ReturnType<typeof setTimeout> | null
}

type ReadResult<T> = { ok: true; data: T } | { ok: 'missing' } | { ok: false }

function readJson<T>(file: string, valid: (v: unknown) => v is T): ReadResult<T> {
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { ok: 'missing' } : { ok: false } }
  try { const v = JSON.parse(raw) as unknown; return valid(v) ? { ok: true, data: v } : { ok: false } } catch { return { ok: false } }
}
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

interface GrantsFile { version: 1; grants: Record<string, 'allow' | 'deny'> }
interface PositionsFile { version: 1; bounds: Record<string, DesktopRect> }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isGrants = (v: unknown): v is GrantsFile => isObj(v) && v.version === 1 && isObj(v.grants)
const isRect = (v: unknown): v is DesktopRect => isObj(v) && ['x', 'y', 'width', 'height'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k] as number))
const isPositions = (v: unknown): v is PositionsFile => isObj(v) && v.version === 1 && isObj(v.bounds)
const sameRect = (a: DesktopRect, b: DesktopRect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

export const GRANTS_FILE = 'plugin-desktop-grants.json'
export const POSITIONS_FILE = 'plugin-desktop-windows.json'
const PENDING_MS = 10_000
const FRONT_TTL_MS = 1_000

export function createPluginDesktopWindows(d: PluginDesktopDeps) {
  const grantsPath = path.join(d.userDataDir, GRANTS_FILE)
  const positionsPath = path.join(d.userDataDir, POSITIONS_FILE)
  const entries = new Map<string, Entry>() // id → 开着的
  const pending = new Map<string, Entry>() // 窗口名 → 等 window.open 的
  const asking = new Map<string, Promise<boolean>>()
  const mac = d.platform === 'darwin'
  const clickThrough = d.platform === 'darwin' || d.platform === 'win32'
  let hiddenAll = false
  let seq = 0

  // ── 位置记忆:启动后第一次用时读一次;读不出来 = 本次运行都不写回 ──
  let positions: Record<string, DesktopRect> | null = null
  /** 位置文件里认不出来的条目:原样留着、原样写回(读不懂 ≠ 没有)。 */
  let foreignPositions: Record<string, unknown> = {}
  let positionsWritable = true
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const loadPositions = (): Record<string, DesktopRect> => {
    if (positions) return positions
    const r = readJson(positionsPath, isPositions)
    if (r.ok === true) {
      positions = Object.fromEntries(Object.entries(r.data.bounds).filter(([, b]) => isRect(b))) as Record<string, DesktopRect>
      foreignPositions = Object.fromEntries(Object.entries(r.data.bounds).filter(([, b]) => !isRect(b)))
    }
    else { positions = {}; if (r.ok === false) { positionsWritable = false; d.log?.('[desktop-window] positions file unreadable; using defaults, not writing back') } }
    return positions
  }
  const persistNow = (): void => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    if (!positionsWritable || !positions) return
    try { writeJsonAtomic(positionsPath, { version: 1, bounds: { ...foreignPositions, ...positions } }) } catch (e) { d.log?.(`[desktop-window] write positions failed: ${e}`) }
  }
  const remember = (e: Entry): void => {
    const p = loadPositions()
    p[e.ident] = { ...e.userBounds }
    delete foreignPositions[e.ident]
    if (!persistTimer) persistTimer = setTimeout(persistNow, 500)
  }

  // ── 授权 ──
  const readGrants = (): ReadResult<GrantsFile> => readJson(grantsPath, isGrants)
  const grantOf = (pluginId: string): DesktopWindowGrant => {
    const r = readGrants()
    if (r.ok !== true) return null
    const g = r.data.grants[pluginId]
    return g === 'allow' || g === 'deny' ? g : null
  }
  /** 写成了才 true(撤回要据此告诉设置页:没写成 = 盘上还是「允许」)。 */
  const writeGrant = (pluginId: string, value: 'allow' | 'deny' | null): boolean => {
    const r = readGrants()
    if (r.ok === false) { d.log?.('[desktop-window] grants file unreadable; not writing back'); return false }
    const grants = r.ok === true ? { ...r.data.grants } : {}
    if (value) grants[pluginId] = value
    else delete grants[pluginId]
    try { writeJsonAtomic(grantsPath, { version: 1, grants }); return true } catch (e) { d.log?.(`[desktop-window] write grants failed: ${e}`); return false }
  }
  const ensureGrant = async (pluginId: string, pluginName: string): Promise<boolean> => {
    const r = readGrants()
    if (r.ok === true) {
      const g = r.data.grants[pluginId]
      if (g === 'allow') return true
      if (g === 'deny') return false
    }
    const already = asking.get(pluginId)
    if (already) return already
    const ask = d.confirm({ id: pluginId, name: pluginName }).catch(() => false).then((yes) => {
      if (r.ok !== false) writeGrant(pluginId, yes ? 'allow' : 'deny') // 读不出来:问了也不写回
      return yes
    }).finally(() => asking.delete(pluginId))
    asking.set(pluginId, ask)
    return ask
  }

  const alive = (e: Entry): boolean => !!e.win && !e.win.isDestroyed()
  const live = (e: Entry): boolean => alive(e) && !e.closing
  const byIdent = (ident: string): Entry | undefined => [...entries.values()].find((e) => e.ident === ident && live(e))
  const countOf = (pluginId: string): number =>
    [...entries.values()].filter((e) => e.pluginId === pluginId && live(e)).length + [...pending.values()].filter((e) => e.pluginId === pluginId).length
  /** 主窗换页一次加一:换页前发出、还在等询问的 prepare 回来时作废(不替已经没了的那一页占名额)。 */
  let pageGen = 0
  const isMain = (sender: WebContents | null | undefined): boolean => {
    const m = d.mainContents()
    return !!m && !m.isDestroyed() && !!sender && sender === m
  }
  const reply = (e: Entry, existing: boolean): DesktopWindowPrepareReply =>
    ({ ok: true, id: e.id, frameName: e.frameName, existing, bounds: { ...e.bounds }, screens: d.screens(), clickThrough })

  async function prepare(sender: WebContents | null | undefined, raw: unknown): Promise<DesktopWindowPrepareReply> {
    const req = normalizePrepareRequest(raw)
    if (!req) return { ok: false, reason: 'unavailable' }
    const ident = desktopWindowIdent(req.pluginId, req.key)
    // 只有主窗能开;别的窗口来问 = 那边的插件实例跑 setup:开着就说一声(它报 ok、什么都不做),不问授权、不开窗
    if (!isMain(sender)) return byIdent(ident) ? { ok: false, reason: 'elsewhere' } : { ok: false, reason: 'unavailable' }
    const open = byIdent(ident)
    if (open) return reply(open, true) // 同插件同 key 已开着:不抢前、不闪,只把名字交回去让渲染层找回它
    const gen = pageGen
    if (!(await ensureGrant(req.pluginId, req.pluginName))) return { ok: false, reason: 'denied' }
    if (gen !== pageGen || !isMain(sender)) return { ok: false, reason: 'unavailable' } // 问的时候主窗换了页
    const raced = byIdent(ident) ?? [...pending.values()].find((e) => e.ident === ident)
    if (raced) return reply(raced, alive(raced))
    if (countOf(req.pluginId) >= DESKTOP_WINDOW_LIMIT) return { ok: false, reason: 'limit', limit: DESKTOP_WINDOW_LIMIT }
    const screens = d.screens()
    const remembered = loadPositions()[ident]
    let bounds: DesktopRect
    let userBounds: DesktopRect
    if (remembered) {
      const s = screenOf(remembered, screens)
      const size = s ? clampDesktopSize(req, s.workArea) : { width: req.width, height: req.height }
      userBounds = { x: remembered.x, y: remembered.y, ...size } // 记的那块屏这会儿不在:先夹到现有的屏,记的位置不动
      bounds = clampDesktopBounds(userBounds, screens)
    } else {
      const area = d.cursorWorkArea()
      bounds = clampDesktopBounds(defaultDesktopBounds(clampDesktopSize(req, area), area), screens)
      userBounds = { ...bounds }
    }
    const e: Entry = {
      id: `dw${++seq}`, ident, pluginId: req.pluginId, pluginName: req.pluginName, key: req.key, title: req.title,
      frameName: `${DESKTOP_WINDOW_FRAME_PREFIX}${randomUUID()}`, pin: req.pin, bounds, userBounds, win: null, closing: false, ignoring: false, front: null, frontAt: 0, expire: null,
    }
    e.expire = setTimeout(() => { if (pending.get(e.frameName) === e) pending.delete(e.frameName) }, PENDING_MS)
    pending.set(e.frameName, e)
    return reply(e, false)
  }

  /** 主窗 window-open 处理器的前一道:是我们的名字 → 放行 / 拒;不是 → null(交给原来的处理器)。 */
  function handleWindowOpen(details: Pick<HandlerDetails, 'frameName' | 'url'>):
    | { action: 'deny' }
    | { action: 'allow'; outlivesOpener: false; overrideBrowserWindowOptions: BrowserWindowConstructorOptions }
    | null {
    if (!details.frameName?.startsWith(DESKTOP_WINDOW_FRAME_PREFIX)) return null
    const e = pending.get(details.frameName)
    if (!e || (details.url && details.url !== 'about:blank')) return { action: 'deny' }
    return {
      action: 'allow', outlivesOpener: false,
      overrideBrowserWindowOptions: {
        ...e.bounds, title: e.title || e.pluginName, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
        hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, ...(mac ? { type: 'panel' as const } : {}), focusable: false, acceptFirstMouse: true, alwaysOnTop: e.pin,
      },
    }
  }

  function onDidCreateWindow(win: BrowserWindow, details: { frameName: string }): void {
    const e = pending.get(details.frameName)
    if (!e) { if (details.frameName?.startsWith(DESKTOP_WINDOW_FRAME_PREFIX)) win.destroy(); return }
    pending.delete(details.frameName)
    if (e.expire) clearTimeout(e.expire)
    e.expire = null
    e.win = win
    entries.set(e.id, e)
    try { win.setMenu?.(null) } catch { /* mac 没有窗口菜单 */ }
    if (e.pin) win.setAlwaysOnTop(true, mac ? 'floating' : 'screen-saver')
    // 跟着用户换桌面;不盖在全屏应用上(护栏)
    if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (ev) => ev.preventDefault())
    // 子窗页面里的 window.moveTo / resizeTo 不认:挪窗只走控制器(过护栏)
    win.webContents.on('content-bounds-updated', (ev) => ev.preventDefault())
    // beforeunload 拦不住宿主关窗(托盘关、撤回授权、插件停用)
    win.webContents.on('will-prevent-unload', (ev) => ev.preventDefault())
    // prepare 和这里之间屏幕可能变了(拔掉了大屏):按现在的屏再夹一遍
    e.bounds = clampDesktopBounds(e.bounds, d.screens())
    // Windows 分数缩放下透明窗起手会大几个 DIP(同 Mini):建好再按内容框摆一次
    win.setBounds(e.bounds)
    win.on('closed', () => {
      if (entries.get(e.id) !== e) return
      entries.delete(e.id)
      remember(e)
      persistNow()
      const m = d.mainContents()
      if (m && !m.isDestroyed()) m.send('desktopWindow:closed', e.id)
      d.onChanged()
    })
    if (!hiddenAll) win.showInactive()
    remember(e)
    d.onChanged()
  }

  function setBounds(sender: WebContents | null | undefined, id: unknown, rect: unknown): DesktopRect | null {
    if (!isMain(sender) || typeof id !== 'string' || !isObj(rect)) return null
    const e = entries.get(id)
    if (!e || !alive(e)) return null
    const next = clampDesktopBounds({ ...e.bounds, ...rect }, d.screens())
    if (next.x !== e.bounds.x || next.y !== e.bounds.y || next.width !== e.bounds.width || next.height !== e.bounds.height) {
      e.bounds = next
      e.win!.setBounds(next)
    }
    if (!sameRect(e.userBounds, next)) { e.userBounds = { ...next }; remember(e) }
    return { ...e.bounds }
  }

  function passThrough(sender: WebContents | null | undefined, id: unknown, ignore: unknown): void {
    if (!isMain(sender) || typeof id !== 'string') return
    const e = entries.get(id)
    if (!e || !alive(e)) return
    const next = clickThrough && ignore === true
    if (next !== e.ignoring) {
      e.ignoring = next
      if (next) e.frontAt = 0 // 鼠标离开了宠物:下次进来重新记前台(这期间用户可能换了应用)
      if (next) e.win!.setIgnoreMouseEvents(true, { forward: true })
      else e.win!.setIgnoreMouseEvents(false)
    }
    // 鼠标在宠物上(渲染层停着时每秒报一次「接住」,整扇接住的模式也报):记下此刻的前台应用 —— 还没点,前台还是用户在用的那个
    if (!next && mac && d.mac && Date.now() - e.frontAt > FRONT_TTL_MS) {
      e.frontAt = Date.now()
      void d.mac.front().then((f) => { e.front = f?.pid ?? null }).catch(() => { e.front = null })
    }
  }

  /** 渲染层:一次点按 / 拖动在小窗上结束了。mac 上把这一下激活的 Forsion 交还给原来的应用。 */
  function released(sender: WebContents | null | undefined, id: unknown): void {
    if (!isMain(sender) || typeof id !== 'string' || !mac || !d.mac) return
    const e = entries.get(id)
    const self = d.selfPid ?? process.pid
    if (!e || !e.front || e.front === self) return
    void d.mac.activate(e.front, self).catch(() => false)
  }

  function close(id: string): void {
    const e = entries.get(id)
    if (!e || !alive(e) || e.closing) return
    e.closing = true
    e.win!.close()
  }
  function closePlugin(pluginId: string): void {
    for (const e of [...entries.values()]) if (e.pluginId === pluginId) close(e.id)
    for (const [name, e] of [...pending]) if (e.pluginId === pluginId) { if (e.expire) clearTimeout(e.expire); pending.delete(name) }
  }
  function closeAll(): void {
    pageGen++
    for (const e of [...entries.values()]) close(e.id)
    for (const e of pending.values()) if (e.expire) clearTimeout(e.expire)
    pending.clear()
  }

  /** 主窗页面换了(重载 / 导航)、崩了、没了:小窗里的东西是那一页画的,一起关(插件下次 setup 再开)。 */
  function attachMain(wc: WebContents): void {
    wc.on('did-start-navigation', (_e: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => { if (isMainFrame && !isInPlace) closeAll() })
    wc.on('render-process-gone', () => closeAll())
    wc.on('destroyed', () => closeAll())
  }

  /** 插拔显示器 / 改缩放:每扇重新夹一遍,屏幕表推给主窗。 */
  function screensChanged(): void {
    const screens = d.screens()
    for (const e of entries.values()) {
      if (!alive(e)) continue
      // 从用户摆的位置夹(屏插回来时回到原处);只挪窗,不改记住的位置
      const next = clampDesktopBounds(e.userBounds, screens)
      if (!sameRect(next, e.bounds)) {
        e.bounds = next
        e.win!.setBounds(next)
      }
    }
    const m = d.mainContents()
    if (m && !m.isDestroyed()) m.send('desktopWindow:screensChanged', screens)
  }

  function setHidden(hidden: boolean): void {
    hiddenAll = hidden
    for (const e of entries.values()) {
      if (!alive(e)) continue
      if (hidden) e.win!.hide()
      else e.win!.showInactive()
    }
    d.onChanged()
  }

  function list(): DesktopWindowRow[] {
    return [...entries.values()].filter(alive).map((e) => ({ id: e.id, pluginId: e.pluginId, pluginName: e.pluginName, title: e.title, visible: e.win!.isVisible() }))
  }

  /** 撤回:关掉这个插件的小窗;返回授权文件写成了没有(没写成 = 盘上还是原样,设置页别显示成已撤回)。 */
  function revoke(pluginId: string): boolean {
    closePlugin(pluginId)
    return writeGrant(pluginId, null)
  }

  return {
    prepare, handleWindowOpen, onDidCreateWindow, setBounds, passThrough, released, close, closePlugin, closeAll, attachMain,
    screensChanged, setHidden, hidden: () => hiddenAll, list, grantOf, revoke, clickThrough, persistNow,
    /** 测试用 */
    _entries: entries, _pending: pending,
  }
}

export type PluginDesktopWindows = ReturnType<typeof createPluginDesktopWindows>
