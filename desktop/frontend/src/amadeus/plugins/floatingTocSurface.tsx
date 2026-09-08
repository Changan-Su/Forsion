/** Host-native FloatingToc mount for DOM-only Forsion plugins. */
import { FloatingToc } from '@lcl/engine'
import { mountHostReact } from './blockSurface'
import type { PluginFloatingTocHandle, PluginFloatingTocOptions } from './types'

/**
 * Appends an overlay layer without taking ownership of the plugin's content DOM. The caller's shell
 * becomes positioned only when necessary, and its original inline position is restored on dispose.
 */
export function mountPluginFloatingToc(
  shell: HTMLElement,
  opts: PluginFloatingTocOptions,
): PluginFloatingTocHandle {
  const layer = document.createElement('div')
  layer.className = 'lcl-ftoc-mount-layer'
  const originalPosition = shell.style.position
  const madeRelative = getComputedStyle(shell).position === 'static'
  if (madeRelative) shell.style.position = 'relative'
  shell.appendChild(layer)

  let trigger = 0
  let disposed = false
  let disposeRoot = (): void => {}
  const render = (): void => {
    disposeRoot = mountHostReact(layer, (
      <FloatingToc
        scrollContainer={opts.scrollContainer}
        contentRoot={opts.contentRoot ?? opts.scrollContainer}
        selector={opts.selector}
        itemFromElement={opts.itemFromElement}
        label={opts.label}
        minItems={opts.minItems}
        hideBelow={opts.hideBelow}
        topOffset={opts.topOffset}
        side={opts.side}
        scanTrigger={trigger}
      />
    ))
  }
  render()

  return {
    refresh: () => {
      if (disposed) return
      trigger++
      render()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      disposeRoot()
      layer.remove()
      if (madeRelative && shell.style.position === 'relative') shell.style.position = originalPosition
    },
  }
}
