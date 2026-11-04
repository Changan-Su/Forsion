/** Host tool island for a plugin's own view (ctx.ui.mountToolIsland): the LCL ToolIsland strip plus the layout around
 *  it — top centre (bottom centre when `root` is narrow), the plugin's row under it, the plugin's corner elements. */
import { flushSync } from 'react-dom'
import { ToolIsland, mountHostReact, type ToolIslandItem } from '@lcl/components'
import { resolveIcon } from '../components/icons'
import type { PluginToolIslandHandle, PluginToolIslandOptions } from './types'

/** Below this `root` width the island docks at the bottom (Mini card, phone, portrait pad). */
export const TOOL_ISLAND_NARROW = 520
const CORNERS = [['topLeft', 'top-left'], ['topRight', 'top-right'], ['bottomLeft', 'bottom-left'], ['bottomRight', 'bottom-right']] as const

/** Like FloatingToc, an overlay layer appended to `root` without taking it over. The plugin's own nodes (`row`, the
 *  corner elements) are placed with plain DOM next to the React strip, never handed to React: a re-render must not
 *  reconcile them away. `row` is created by the caller so the handle can return it before this module loads. */
export function mountPluginToolIsland(root: HTMLElement, pluginId: string, row: HTMLElement, initial: PluginToolIslandOptions): PluginToolIslandHandle {
  const opts: PluginToolIslandOptions = { ...initial }
  const layer = document.createElement('div')
  layer.className = 'lcl-isle-layer'
  const main = layer.appendChild(document.createElement('div'))
  main.className = 'lcl-isle-main'
  const strip = main.appendChild(document.createElement('div'))
  strip.style.display = 'contents'
  row.classList.add('lcl-isle-cap', 'lcl-isle-row')
  main.appendChild(row)
  const corners = CORNERS.map(([key, at]) => {
    const wrap = layer.appendChild(document.createElement('div'))
    wrap.className = 'lcl-isle-cap lcl-isle-slot'
    wrap.dataset.at = at
    wrap.hidden = true
    return [key, wrap] as const
  })
  const placeSlots = (): void => {
    for (const [key, wrap] of corners) {
      const el = opts.slots?.[key]
      if (el instanceof HTMLElement) { if (el.parentNode !== wrap) wrap.replaceChildren(el) } else wrap.replaceChildren()
      wrap.hidden = !wrap.firstChild
    }
  }
  placeSlots()
  const originalPosition = root.style.position
  const pos = getComputedStyle(root).position
  const madeRelative = !pos || pos === 'static'
  if (madeRelative) root.style.position = 'relative'
  root.appendChild(layer)

  const dock = (): void => {
    const w = root.clientWidth
    layer.dataset.dock = w > 0 && w < TOOL_ISLAND_NARROW ? 'bottom' : 'top'
  }
  dock()
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(dock) : null
  ro?.observe(root)

  const pick = (id: string): void => {
    try { opts.onPick(id) } catch (e) { console.error(`[amadeus] plugin "${pluginId}" tool island onPick threw`, e) }
  }
  const items = (): ToolIslandItem[] => {
    const seen = new Set<string>()
    return (Array.isArray(opts.tools) ? opts.tools : []).flatMap((t): ToolIslandItem[] => {
      if (t === 'separator') return ['separator']
      if (!t || typeof t.id !== 'string' || !t.id || seen.has(t.id)) return []
      seen.add(t.id)
      const title = String(t.title ?? t.id).slice(0, 200)
      const key = typeof t.key === 'string' && t.key ? t.key.slice(0, 3) : undefined
      return [{ id: t.id, title, key, icon: resolveIcon(typeof t.icon === 'string' ? t.icon : undefined, title.slice(0, 1)) }]
    })
  }
  const tree = (): React.ReactElement => <ToolIsland tools={items()} active={typeof opts.active === 'string' ? opts.active : undefined} onPick={pick} />
  // flushSync:句柄上的调用一返回 DOM 就是新的(焦点归还要在这之后看)
  const mounted = flushSync(() => mountHostReact(strip, tree()))
  let disposed = false
  const render = (): void => {
    if (disposed) return
    const focused = document.activeElement
    const hadFocus = layer.contains(focused)
    const focusedTool = focused instanceof HTMLElement ? focused.dataset.tool : undefined
    flushSync(() => mounted.render(tree()))
    // 按钮按 id 作 key,同一颗按钮 DOM 不换,焦点多半自己留着。但换了顺序 React 会搬动节点(搬动即失焦),那颗被拿掉了
    // 也会落到 body:还给同一颗,没了就给当前工具那颗
    if (hadFocus && !layer.contains(document.activeElement)) {
      const btns = [...strip.querySelectorAll<HTMLElement>('.lcl-isle-btn')]
      ;(btns.find((b) => b.dataset.tool === focusedTool) ?? btns.find((b) => b.hasAttribute('data-on')))?.focus()
    }
  }

  return {
    row,
    showRow(open) { if (!disposed) row.toggleAttribute('data-open', !!open) },
    setActive(id) { if (disposed) return; opts.active = id; render() },
    update(patch) {
      if (disposed || !patch || typeof patch !== 'object') return
      Object.assign(opts, patch)
      placeSlots()
      render()
    },
    dispose() {
      if (disposed) return
      disposed = true
      ro?.disconnect()
      mounted.dispose()
      layer.remove()
      if (madeRelative && root.style.position === 'relative') root.style.position = originalPosition
    },
  }
}
