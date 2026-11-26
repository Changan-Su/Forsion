/**
 * 插件桌面小窗的渲染层那半(2026-11-26,方案页 docs/ToBeImproved/插件桌面小窗方案_2026-11-26;主进程 electron/pluginDesktopWindows.ts,
 * 契约 shared/desktopWindow.ts)。workspace.open 的 `{ float: 'desktop' }` + `form: 'bare'` 经 workspaceOpenHost 的 bare 接缝到这里。
 *
 * 「同进程子窗」(第 0 步实测过关,scripts/desktop-window-route.probe.cjs):主进程发一个一次性窗口名 → window.open('about:blank', 名字)
 * → 主窗这份插件实例直接把注册的视图 mount 进子窗。子窗里没有应用代码:样式从主窗 head 克隆过去(插件 addStyle 的也在),
 * <html> 的主题属性跟着主窗同步,换主题一起变。
 *
 * 只在主窗开:Mini / 独立窗各有一份插件实例,setup 都会跑 —— 那几扇窗里调用,小窗已经开着就报 ok(什么都不做),没开就 unavailable。
 * 同插件同 key 已开着 = 不抢前、不闪,只换参数(方案页第九节)。
 *
 * 跨窗口的代价(手册写明):视图里的元素属于子窗的 document,插件代码里的 `document` / `window` 仍指主窗;
 * 跨窗口 `instanceof HTMLElement` 判不对,宿主那些按 instanceof 核参数的挂载件(ctx.ui.mount* 等)暂不支持挂进小窗。
 */
import { getView, subscribeViews, type BareDesktopResult, type OpenOptions, type OpenTarget } from '@lcl/engine'
import { notePluginGesture, usePluginStore } from '@amadeus/plugins/pluginStore'
import { recordDevMountError } from '@amadeus/plugins/devRecords'
import { pluginDisplayName } from '@amadeus/plugins/display'
import { pluginText } from '@amadeus/plugins/pluginText'
import type { PluginDesktopWindowController, PluginViewLayout } from '@amadeus/plugins/types'
import { currentLocale } from './i18n'
import { windowKind } from './windowKind'
import { clampDesktopBounds, desktopWindowIdent, screenOf, type DesktopRect, type DesktopScreen } from '../../shared/desktopWindow'

type Api = NonNullable<NonNullable<typeof window.tangu>['desktopWindow']>

interface Rec {
  ident: string
  id: string
  pluginId: string
  win: Window
  params: Record<string, unknown>
  setParams(next: Record<string, unknown>): void
  close(): void
  closed: Promise<void>
}

const recs = new Map<string, Rec>() // ident → 开着的
const byId = new Map<string, Rec>()
const warned = new Set<string>()
let wired = false

function api(): Api | null {
  return typeof window !== 'undefined' ? window.tangu?.desktopWindow ?? null : null
}

/** 主进程关掉的(托盘、收回授权、主窗以外的原因):这边收尾。 */
function wire(a: Api): void {
  if (wired) return
  wired = true
  a.onClosed((id) => byId.get(id)?.close())
  a.onScreensChanged((screens, placed) => { latestScreens = screens; for (const fn of screenListeners) fn(placed ?? {}) })
}
let latestScreens: DesktopScreen[] = []
const screenListeners = new Set<(placed: Record<string, DesktopRect>) => void>()

/** 样式与 <html> 属性跟主窗走:克隆 head 里全部 style / link,主窗 head 一变(换主题、插件 addStyle)就重来一遍。 */
function mirrorTheme(child: Window): () => void {
  const d = child.document
  const base = d.createElement('base')
  base.href = document.baseURI
  d.head.append(base)
  const own = d.createElement('style')
  own.textContent = 'html,body{background:transparent!important;margin:0!important;padding:0!important;overflow:hidden!important;width:100%;height:100%}'
    + '.forsion-desktop-window{position:fixed;inset:0;overflow:hidden}'
  let clones: Node[] = []
  const copyHead = (): void => {
    for (const n of clones) n.parentNode?.removeChild(n)
    clones = [...document.head.querySelectorAll('style, link[rel="stylesheet"]')].map((n) => n.cloneNode(true))
    d.head.append(...clones, own) // 自己那条排最后:压过主题给 html / body 的底色
  }
  const copyRoot = (): void => {
    const src = document.documentElement, dst = d.documentElement
    for (const a of [...dst.attributes]) if (!src.hasAttribute(a.name)) dst.removeAttribute(a.name)
    for (const a of [...src.attributes]) dst.setAttribute(a.name, a.value)
    dst.dataset.window = 'desktop'
    d.body.className = document.body.className
  }
  copyHead()
  copyRoot()
  let queued = false
  const later = (fn: () => void): void => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; fn() })
  }
  const headObs = new MutationObserver(() => later(copyHead))
  headObs.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true })
  const rootObs = new MutationObserver(copyRoot)
  rootObs.observe(document.documentElement, { attributes: true })
  rootObs.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  return () => { headObs.disconnect(); rootObs.disconnect() }
}

const splitType = (type: string): { pluginId: string; viewId: string } | null => {
  const m = /^plugin:([^:]+):(.+)$/.exec(type)
  return m ? { pluginId: m[1], viewId: m[2] } : null
}

/** workspaceOpenHost 的 bare 接缝。 */
export async function openPluginDesktopWindow(req: { view: OpenTarget; key?: string; title?: string; size?: OpenOptions['size']; pin: boolean }): Promise<BareDesktopResult> {
  const a = api()
  const parts = splitType(req.view.type)
  if (!a || !parts) return { ok: false, reason: 'fallback' }
  const store = usePluginStore.getState()
  const plugin = store.plugins.find((p) => p.id === parts.pluginId)
  const def = store.views.find((v) => v.pluginId === parts.pluginId && v.item.id === parts.viewId)?.item
  if (!plugin || !def) return { ok: false, reason: 'unknown-view' }
  if (!plugin.capabilities?.includes('desktopWindow')) {
    if (!warned.has(plugin.id)) {
      warned.add(plugin.id)
      console.warn(`[plugin:${plugin.id}] desktop windows need "desktopWindow" in manifest capabilities; opening in the window instead`)
    }
    return { ok: false, reason: 'fallback' }
  }
  wire(a)
  const key = req.key ?? ''
  const ident = desktopWindowIdent(plugin.id, key)
  const params = { ...(req.view.params ?? {}) }
  const live = recs.get(ident)
  if (live) { live.setParams(params); return { ok: true, close: live.close, closed: live.closed } }
  const reply = await a.prepare({
    pluginId: plugin.id, pluginName: pluginDisplayName(plugin, currentLocale()), key,
    title: req.title ?? pluginText(def.title), width: req.size?.width ?? 160, height: req.size?.height ?? 160, pin: req.pin,
  })
  if (!reply.ok) {
    if (reply.reason === 'limit') return { ok: false, reason: 'limit', limit: reply.limit ?? 3 }
    if (reply.reason === 'denied') return { ok: false, reason: 'fallback' }
    return { ok: false, reason: 'unavailable' }
  }
  latestScreens = reply.screens
  const raced = recs.get(ident) // 等 prepare 的时候同一扇被开了(连调两次)
  if (raced) { raced.setParams(params); return { ok: true, close: raced.close, closed: raced.closed } }
  // 等询问框的时候插件被停用 / 重载了:手上这份视图定义已经作废,别挂(反注册的通知早就过去了,挂上去没人收)
  const now = usePluginStore.getState()
  const stillDef = now.plugins.some((p) => p.id === plugin.id) ? now.views.find((v) => v.pluginId === plugin.id && v.item.id === parts.viewId)?.item : undefined
  if (stillDef !== def || !getView(req.view.type)) { a.close(reply.id); return { ok: false, reason: 'unavailable' } }
  const win = window.open(reply.existing ? '' : 'about:blank', reply.frameName)
  let doc: Document | null = null
  try { doc = win?.document ?? null } catch { doc = null }
  // 子窗没开出来(名额过期被拒、被拦):退成窗口里的卡,别让插件什么都没有
  if (!win || !doc?.body) { a.close(reply.id); return { ok: false, reason: 'fallback' } }
  doc.body.replaceChildren() // existing:上一页画的旧内容
  for (const n of [...doc.head.childNodes]) n.parentNode?.removeChild(n)
  doc.title = req.title ?? pluginText(def.title)
  return { ok: true, ...mount(a, win, reply.id, ident, plugin.id, def, params, reply.bounds, reply.clickThrough) }
}

function mount(
  a: Api, win: Window, id: string, ident: string, pluginId: string,
  def: NonNullable<ReturnType<typeof usePluginStore.getState>['views'][number]>['item'],
  initialParams: Record<string, unknown>, initialBounds: DesktopRect, canClickThrough: boolean,
): { close: () => void; closed: Promise<void> } {
  const d = win.document
  const unmirror = mirrorTheme(win)
  const root = d.createElement('div')
  root.className = 'forsion-desktop-window'
  root.dataset.plugin = pluginId
  d.body.append(root)

  let alive = true
  let bounds = { ...initialBounds }
  let params = { ...initialParams }
  let cleanup: (() => void) | void
  const paramListeners = new Set<(p: Readonly<Record<string, unknown>>) => void>()
  const layoutListeners = new Set<(l: Readonly<PluginViewLayout>) => void>()
  const boundsListeners = new Set<(b: Readonly<DesktopRect>) => void>()
  const frames = new Set<number>()
  const check = (): void => { if (!alive) throw new Error('Desktop window has been closed') }
  const layout = (): PluginViewLayout => ({ width: bounds.width, height: bounds.height, visible: true, compact: false, phase: 'settled' })
  const screens = (): DesktopScreen[] => latestScreens
  /** push = false:主进程已经摆好了(换屏),只照收、不回送 —— 回送会走「用户 / 插件摆的」那条路,把临时位置记下来。 */
  const apply = (next: DesktopRect, notify = true, push = true): void => {
    const resized = next.width !== bounds.width || next.height !== bounds.height
    const moved = next.x !== bounds.x || next.y !== bounds.y
    if (!resized && !moved) return
    bounds = next
    if (push) a.setBounds(id, next)
    if (notify) for (const fn of boundsListeners) fn({ ...bounds })
    if (resized) for (const fn of layoutListeners) fn(layout())
  }
  const reclamp = (placed: Record<string, DesktopRect>): void => { const p = placed[id]; if (alive && p) apply({ ...p }, true, false) }
  screenListeners.add(reclamp)

  // ── 点穿:'shape' = 鼠标在视图里的元素上才接住,空白处落到下面的应用;'none' = 整扇接住;'all' = 整扇点穿 ──
  let mode: 'shape' | 'none' | 'all' = canClickThrough ? 'shape' : 'none'
  let hitTest: ((x: number, y: number) => boolean) | null = null
  let ignoring: boolean | null = null
  let pressed = false
  let hoverPing = 0
  const setIgnore = (next: boolean): void => {
    if (!canClickThrough) next = false
    // 停在宠物上(接住)时每秒再报一次:主进程据此记下「点之前的前台应用」,mac 上松手交还(整扇接住的模式也靠它)
    if (next === ignoring && (next || Date.now() - hoverPing < 1000)) return
    if (!next) hoverPing = Date.now()
    ignoring = next
    a.passThrough(id, next)
  }
  const isHit = (x: number, y: number): boolean => {
    if (hitTest) { try { return !!hitTest(x, y) } catch { return true } }
    const t = d.elementFromPoint(x, y)
    return !!t && t !== root && t !== d.body && t !== d.documentElement && root.contains(t)
  }
  const evaluate = (x: number, y: number): void => {
    if (pressed) return
    setIgnore(mode === 'all' ? true : mode === 'none' ? false : !isHit(x, y))
  }
  // 鼠标停着不动、宠物自己走到它底下(或走开):没有 mousemove,定时按最后的位置再判一次(鼠标离开窗口就停)
  let lastPt: { x: number; y: number } | null = null
  const onMove = (e: MouseEvent): void => { lastPt = { x: e.clientX, y: e.clientY }; evaluate(e.clientX, e.clientY) }
  const onLeave = (): void => { lastPt = null; if (!pressed && mode === 'shape') setIgnore(true) }
  const rehit = win.setInterval(() => { if (lastPt && mode === 'shape') evaluate(lastPt.x, lastPt.y) }, 100)
  // 拖动:跟着鼠标在屏幕上的位移挪窗(窗口跟着指针走,指针一直在它上面)
  let drag: { sx: number; sy: number; bx: number; by: number; pointer?: number } | null = null
  const onPointerMove = (e: PointerEvent): void => {
    if (!drag || !alive) return
    apply(clampDesktopBounds({ ...bounds, x: drag.bx + (e.screenX - drag.sx), y: drag.by + (e.screenY - drag.sy) }, screens()))
  }
  const onDown = (e: PointerEvent): void => {
    pressed = true
    setIgnore(false)
    if (e.isTrusted) notePluginGesture(pluginId)
  }
  const onUp = (e: PointerEvent): void => {
    pressed = false
    drag = null
    a.released(id) // mac:把这一下点击激活的 Forsion 交还给原来的应用
    evaluate(e.clientX, e.clientY)
  }
  const onKey = (e: KeyboardEvent): void => { if (e.isTrusted) notePluginGesture(pluginId) }
  d.addEventListener('mousemove', onMove, true)
  d.documentElement.addEventListener('mouseleave', onLeave)
  d.addEventListener('pointerdown', onDown, true)
  d.addEventListener('pointermove', onPointerMove, true)
  d.addEventListener('pointerup', onUp, true)
  d.addEventListener('pointercancel', onUp, true)
  d.addEventListener('keydown', onKey, true)
  setIgnore(mode !== 'none')

  const controller: PluginDesktopWindowController = {
    clickThrough: canClickThrough,
    bounds: () => { check(); return { ...bounds } },
    screens: () => { check(); return screens().map((s) => ({ ...s, bounds: { ...s.bounds }, workArea: { ...s.workArea } })) },
    workArea: () => { check(); const s = screenOf(bounds, screens()); return s ? { ...s.workArea } : { ...bounds } },
    moveTo: (x, y) => { check(); apply(clampDesktopBounds({ ...bounds, x, y }, screens())) },
    moveBy: (dx, dy) => { check(); apply(clampDesktopBounds({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, screens())) },
    resize: (width, height) => { check(); apply(clampDesktopBounds({ ...bounds, width, height }, screens())) },
    drag: (e) => {
      check()
      if (!e || typeof (e as MouseEvent).screenX !== 'number') throw new TypeError('drag needs the pointerdown event')
      drag = { sx: (e as MouseEvent).screenX, sy: (e as MouseEvent).screenY, bx: bounds.x, by: bounds.y }
      pressed = true
      setIgnore(false)
      const pe = e as PointerEvent
      try { if (typeof pe.pointerId === 'number' && pe.target && 'setPointerCapture' in (pe.target as Element)) (pe.target as Element).setPointerCapture(pe.pointerId) } catch { /* 合成事件没有指针 */ }
    },
    setClickThrough: (next) => {
      check()
      if (next !== 'shape' && next !== 'none' && next !== 'all') throw new TypeError("setClickThrough takes 'shape', 'none' or 'all'")
      mode = canClickThrough ? next : 'none'
      ignoring = null
      setIgnore(mode === 'all' ? true : mode === 'shape')
    },
    setHitTest: (fn) => {
      check()
      if (fn != null && typeof fn !== 'function') throw new TypeError('setHitTest takes a function or null')
      hitTest = fn ?? null
    },
    requestFrame: (cb) => { check(); const h = win.requestAnimationFrame((t) => { frames.delete(h); if (alive) cb(t) }); frames.add(h); return h },
    cancelFrame: (h) => { frames.delete(h); try { win.cancelAnimationFrame(h) } catch { /* 窗口没了 */ } },
    onBounds: (fn) => { check(); boundsListeners.add(fn); return () => { boundsListeners.delete(fn) } },
    close: () => close(),
  }

  let settle!: () => void
  const closed = new Promise<void>((r) => { settle = r })
  const offViews = subscribeViews(() => { if (alive && !getView(`plugin:${pluginId}:${def.id}`)) close() }) // 插件停用 / 重载 = 视图反注册
  function close(): void {
    if (!alive) return
    alive = false
    offViews()
    screenListeners.delete(reclamp)
    try { win.clearInterval(rehit) } catch { /* 窗口没了 */ }
    for (const h of frames) { try { win.cancelAnimationFrame(h) } catch { /* 窗口没了 */ } }
    frames.clear()
    paramListeners.clear(); layoutListeners.clear(); boundsListeners.clear()
    if (typeof cleanup === 'function') {
      try { cleanup() } catch (e) { console.error(`[plugin-view] desktop cleanup "${def.id}" failed`, e); globalThis.reportError?.(e) }
    }
    unmirror()
    try {
      d.removeEventListener('mousemove', onMove, true)
      d.documentElement.removeEventListener('mouseleave', onLeave)
      for (const [t, fn] of [['pointerdown', onDown], ['pointermove', onPointerMove], ['pointerup', onUp], ['pointercancel', onUp], ['keydown', onKey]] as const) {
        d.removeEventListener(t, fn as EventListener, true)
      }
      root.replaceChildren()
    } catch { /* 窗口已经没了 */ }
    if (recs.get(ident) === rec) recs.delete(ident)
    if (byId.get(id) === rec) byId.delete(id)
    a.close(id)
    settle()
  }
  const rec: Rec = {
    ident, id, pluginId, win, closed, close,
    get params() { return params },
    setParams(next) { params = { ...next }; for (const fn of paramListeners) fn({ ...params }) },
  }
  recs.set(ident, rec)
  byId.set(id, rec)
  win.addEventListener('pagehide', () => close()) // 窗口被系统关了(主进程已经回过 closed 的话这里是空操作)

  try {
    const mounted = def.mount(root, {
      surface: 'desktop',
      desktop: controller,
      getLayout: () => { check(); return layout() },
      onLayout: (fn) => { check(); layoutListeners.add(fn); fn(layout()); return () => { layoutListeners.delete(fn) } },
      getParams: () => { check(); return { ...params } },
      setParams: (patch) => { check(); rec.setParams({ ...params, ...patch }) },
      onParamsChanged: (fn) => { check(); paramListeners.add(fn); return () => { paramListeners.delete(fn) } },
      close: () => { check(); close() },
    })
    if (mounted && typeof (mounted as PromiseLike<unknown>).then === 'function') {
      (mounted as PromiseLike<unknown>).then(
        (fn) => { if (typeof fn !== 'function') return; if (alive) cleanup = fn as () => void; else (fn as () => void)() },
        (e) => { console.error(`[plugin-view] desktop mount "${def.id}" failed`, e); recordDevMountError(pluginId, def.id, e); close() },
      )
    } else if (typeof mounted === 'function') {
      // mount 里同步调过 close() 再交回清理函数:那时 close 已经跑完,这里补跑一次
      if (alive) cleanup = mounted as () => void
      else { try { (mounted as () => void)() } catch (e) { console.error(`[plugin-view] desktop cleanup "${def.id}" failed`, e) } }
    }
  } catch (e) {
    console.error(`[plugin-view] desktop mount "${def.id}" failed`, e)
    recordDevMountError(pluginId, def.id, e)
    close()
    throw e
  }
  return { close, closed }
}

/** 不在主窗(Mini / 独立窗 / Floating Panel):这扇窗不开桌面小窗。主进程那边已经开着 = 报 ok(什么都不做),没开 = unavailable。 */
export async function openPluginDesktopWindowElsewhere(req: { view: OpenTarget; key?: string }): Promise<BareDesktopResult> {
  const a = api()
  const parts = splitType(req.view.type)
  if (!a || !parts) return { ok: false, reason: 'fallback' }
  const plugin = usePluginStore.getState().plugins.find((p) => p.id === parts.pluginId)
  if (!plugin?.capabilities?.includes('desktopWindow')) return { ok: false, reason: 'fallback' }
  const r = await a.prepare({ pluginId: plugin.id, pluginName: plugin.id, key: req.key ?? '', title: '', width: 160, height: 160, pin: true })
  return !r.ok && r.reason === 'elsewhere' ? { ok: true } : { ok: false, reason: 'unavailable' }
}

/** 这扇窗给不给 bare 接缝:桌面主窗才开,别的卫星窗只回报。 */
export function desktopBareOpener(): ((req: Parameters<typeof openPluginDesktopWindow>[0]) => Promise<BareDesktopResult>) | null {
  if (!api()) return null
  return windowKind() === 'main' ? openPluginDesktopWindow : openPluginDesktopWindowElsewhere
}

/** 测试用。 */
export function resetPluginDesktopWindowsForTest(): void {
  for (const r of [...recs.values()]) r.close()
  recs.clear(); byId.clear(); warned.clear(); wired = false; latestScreens = []
}
