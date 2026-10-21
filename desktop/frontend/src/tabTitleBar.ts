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
      .find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top < 2 && r.height > 0 })
    const height = Math.max(16, Math.min(128, Math.round(tabs?.getBoundingClientRect().bottom ?? 32)))
    const symbolColor = root.dataset.mode === 'dark' ? '#ecebea' : '#383837'
    const key = `${height}:${symbolColor}`
    if (key !== last) {
      last = key
      void bridge.setTabTitleBar!({ height, symbolColor }).then((result) => {
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
  attributes.observe(root, { attributes: true, attributeFilter: ['data-mode', 'data-theme', 'style'] })
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
