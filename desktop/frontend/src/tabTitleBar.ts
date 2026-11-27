import { UI_ZOOM_EVENT } from '@lcl/engine'
import { windowKind } from './windowKind'

interface ControlsOverlay extends EventTarget {
  visible: boolean
  getTitlebarAreaRect(): DOMRect
}

/** Window pixels and body CSS zoom are different coordinate systems. Only the
 * native caption width is stored in viewport pixels; CSS divides it by --uiz. */
export function installTabTitleBar(): void {
  const bridge = window.tangu
  if (bridge?.platform !== 'win32' || !bridge.setTabTitleBar || !['main', 'detached'].includes(windowKind())) return
  const root = document.documentElement
  const overlay = (navigator as Navigator & { windowControlsOverlay?: ControlsOverlay }).windowControlsOverlay
  root.dataset.tabTitlebar = '1'
  let frame = 0
  let last = ''
  let fullscreen: boolean | undefined
  const update = (): void => {
    frame = 0
    const tabs = [...document.querySelectorAll<HTMLElement>('.dv-tabs-and-actions-container')]
      .find((el) => { const r = el.getBoundingClientRect(); return !el.classList.contains('dv-edge-stacked') && r.width > 0 && r.top < 2 && r.height > 0 })
    // 设备页整窗形态(UnitSwitcher UNIT_SURFACE_WHOLE):标签栏被盖住,原生按钮区对齐宿主画的那条标题条
    const wholeUnit = root.dataset.unitFrame === '1'
    const frameBar = wholeUnit ? document.querySelector<HTMLElement>('.unitrs--whole .unitfr-bar') : null
    const height = Math.max(16, Math.min(128, Math.round((frameBar ?? tabs)?.getBoundingClientRect().bottom ?? 32)))
    const symbolColor = root.dataset.mode === 'dark' ? '#ecebea' : '#383837'
    const key = `${height}:${symbolColor}:${wholeUnit}`
    if (key !== last) {
      last = key
      void bridge.setTabTitleBar!({ height, symbolColor, wholeUnit }).then((result) => {
        if (fullscreen === undefined && result.ok) { fullscreen = result.fullscreen; schedule() }
      }).catch(() => { last = '' })
    }
    const rect = overlay?.getTitlebarAreaRect()
    // Follow the actual native overlay, including maximized/full-screen transitions.
    const width = !fullscreen && rect && overlay?.visible && rect.height > 0 ? Math.max(0, innerWidth - rect.right) : 0
    const value = `${width}px`
    if (root.style.getPropertyValue('--windows-caption-width') !== value) root.style.setProperty('--windows-caption-width', value)
  }
  const schedule = (): void => { if (!frame) frame = requestAnimationFrame(update) }
  const attributes = new MutationObserver(schedule)
  attributes.observe(root, { attributes: true, attributeFilter: ['data-mode', 'data-theme', 'style', 'data-unit-frame'] })
  const resize = new ResizeObserver(schedule)
  // Observe the shell after React has mounted, then stop watching child mutations.
  const mount = new MutationObserver(() => {
    const shell = document.querySelector('.shell')
    if (shell) { resize.observe(shell); mount.disconnect(); schedule() }
  })
  mount.observe(document.getElementById('root')!, { childList: true, subtree: true })
  window.addEventListener('resize', schedule)
  window.addEventListener(UI_ZOOM_EVENT, schedule)
  overlay?.addEventListener('geometrychange', schedule)
  bridge.onTabTitleBarFullscreen?.((value) => { fullscreen = value; schedule() })
  schedule()
}

/** macOS:红绿灯是原生按钮,不跟界面缩放走,而标签行(32px)/ 浮窗顶条(38px)会 —— 只靠建窗时的固定位置,
 * 换个缩放就偏上或偏下(2026-11-27 方案 C)。这里量本窗顶条的实际中线(视口 px)报给主进程摆灯,
 * 再把第三颗灯的右缘写进 --mac-lights-end(视口 px),无 Ribbon 窗口的标签行按它让位(engine.css .dv-under-lights)。 */
export function installMacTrafficLights(): void {
  const bridge = window.tangu
  const kind = windowKind()
  if (bridge?.platform !== 'darwin' || !bridge.setTrafficLights || !['main', 'detached', 'floating'].includes(kind)) return
  const root = document.documentElement
  let frame = 0
  let last = NaN
  /** 本窗顶条的中线(视口 px);量不准(还没挂载 / 工作区滚走了)时给 null,灯留在上一次的位置。 */
  const measure = (): number | null => {
    if (kind === 'floating') {
      const chrome = document.querySelector<HTMLElement>('.floating-native-chrome')?.getBoundingClientRect()
      return chrome && chrome.height > 0 ? chrome.top + chrome.height / 2 : null
    }
    // 设备页整窗形态(连上 / 加载 / 离线都画这条):标签栏被盖住,灯落在宿主画的那条标题条里
    const frameBar = document.querySelector<HTMLElement>('.unitrs--whole:not(.unitrs-hidden) .unitfr-bar')?.getBoundingClientRect()
    if (frameBar && frameBar.height > 0) return frameBar.top + frameBar.height / 2
    // 只认完整贴着窗顶的标签行:工作区内容超高时整块会滚动,滚走一截的行 top < 0,量它灯会往上跳
    const rows = [...document.querySelectorAll<HTMLElement>('.dv-tabs-and-actions-container')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && r.top > -1 && r.top < 2)
    const pick = rows.find(({ el }) => el.classList.contains('dv-under-lights')) ?? rows.sort((a, b) => a.r.left - b.r.left)[0]
    if (!pick) return null
    // 窄窗加行(.dv-edge-stacked 且真的画成两行时)灯对第一行;单行高 = min-height × 界面缩放
    const zoom = parseFloat(getComputedStyle(root).getPropertyValue('--uiz')) || 1
    const single = (parseFloat(getComputedStyle(pick.el).minHeight) || 32) * zoom
    const band = pick.r.height > single * 1.5 ? single : pick.r.height
    return pick.r.top + band / 2
  }
  const update = (): void => {
    frame = 0
    const raw = measure()
    if (raw === null) return
    const centerY = Math.round(raw * 4) / 4
    if (centerY === last) return
    last = centerY
    void bridge.setTrafficLights!({ centerY }).then((result) => {
      if (result.ok && typeof result.end === 'number') root.style.setProperty('--mac-lights-end', `${result.end}px`)
    }).catch(() => { last = NaN })
  }
  const schedule = (): void => { if (!frame) frame = requestAnimationFrame(update) }
  new MutationObserver(schedule).observe(root, { attributes: true, attributeFilter: ['style', 'data-unit-frame'] })
  const resize = new ResizeObserver(schedule)
  // 等顶条真的挂上再停:浮窗的 .floating-native-chrome 要等 floatingReady 拿到目标才画,比外壳晚
  const mount = new MutationObserver(() => {
    if (measure() === null) return
    for (const host of document.querySelectorAll('.shell, .floating-native-root, .unitrs--whole, .floating-native-chrome')) resize.observe(host)
    mount.disconnect()
    schedule()
  })
  mount.observe(document.getElementById('root')!, { childList: true, subtree: true })
  window.addEventListener('resize', schedule)
  window.addEventListener(UI_ZOOM_EVENT, schedule)
  schedule()
}
