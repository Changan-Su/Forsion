import { $prose } from '@milkdown/kit/utils'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { zoomOf } from '@lcl/engine'

/** One controller per editor. Switching the view option must preserve the current EditorView and its history. */
export function createCenterLine(exit: () => void, lead: () => HTMLElement | null) {
  let enabled = false
  let view: EditorView | null = null
  let cancel: (() => void) | undefined
  let ownsScroll = () => false
  let changed: (() => void) | undefined

  const connect = (initial: boolean): void => {
    cancel?.()
    cancel = undefined
    changed = undefined
    ownsScroll = () => false
    if (!enabled || !view) return
    const editor = view
    const pane = editor.dom.closest<HTMLElement>('.amx-pane')
    const body = editor.dom.closest<HTMLElement>('.unified-body')
    const spacer = lead()
    if (!pane || !body || !spacer) return

    const toolbar = pane.querySelector<HTMLElement>('.amx-toolbar')
    const viewport = window.visualViewport
    let frame = 0
    let held = false
    let composing = false
    let leadHeight = 0

    const bounds = () => {
      const box = pane.getBoundingClientRect()
      const top = Math.max(box.top, viewport?.offsetTop ?? 0, toolbar?.getBoundingClientRect().bottom ?? box.top)
      // The touch toolbar floats over the remaining page when the software keyboard opens.
      const mobileBar = pane.nextElementSibling?.matches('.amx-mbar') ? pane.nextElementSibling : null
      const bar = mobileBar?.getBoundingClientRect()
      const bottom = Math.min(box.bottom, viewport ? viewport.offsetTop + viewport.height : innerHeight,
        bar && bar.height > 0 && bar.top > top ? bar.top : Infinity)
      return { center: (top + bottom) / 2, height: bottom - top }
    }
    spacer.dataset.centerLine = ''
    const sizeMargins = (): void => {
      const { center, height } = bounds()
      if (height <= 0) return
      const scale = zoomOf(pane)
      // Count the note title, cover and metadata toward the first line's headroom.
      // Put only the missing space above those elements, never between the title and the body.
      const firstTop = editor.dom.getBoundingClientRect().top / scale + pane.scrollTop - leadHeight
      leadHeight = Math.max(0, center / scale - firstTop)
      spacer.style.setProperty('--amx-writing-lead', leadHeight + 'px')
      body.style.setProperty('--amx-writing-tail', height / (2 * scale) + 'px')
    }
    const caret = (): boolean => editor.state.selection instanceof TextSelection && editor.state.selection.empty
    const follow = (allowUnfocused = false): void => {
      if (held || composing) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        if (held || composing || editor.composing || !caret() || (!allowUnfocused && !editor.hasFocus())) return
        const { center, height } = bounds()
        if (height <= 0 || !editor.dom.getClientRects().length) return
        const r = editor.coordsAtPos(editor.state.selection.head)
        const dy = (r.top + r.bottom) / 2 - center
        if (Math.abs(dy) > 1) pane.scrollTop += dy / zoomOf(pane)
      })
    }
    changed = () => { if (editor.hasFocus() && caret()) follow() }
    const hold = (): void => {
      held = true
      cancelAnimationFrame(frame)
      frame = 0
    }
    const resume = (): void => {
      held = false
      follow()
    }
    const key = (event: KeyboardEvent): void => {
      if (!event.isComposing && !event.shiftKey && /^(Arrow(Left|Right|Up|Down)|Home|End|Enter|Backspace|Delete)$/.test(event.key)) resume()
    }
    const startComposition = (): void => { composing = true; hold() }
    const endComposition = (): void => { composing = false; resume() }
    const resize = (): void => { sizeMargins(); if (editor.hasFocus()) follow() }
    const listeners = new AbortController()
    const signal = listeners.signal
    pane.addEventListener('wheel', hold, { passive: true, signal })
    pane.addEventListener('touchmove', hold, { passive: true, signal })
    pane.addEventListener('pointerdown', hold, { capture: true, signal })
    editor.dom.addEventListener('beforeinput', resume, { signal })
    editor.dom.addEventListener('input', resume, { signal })
    editor.dom.addEventListener('keydown', key, { signal })
    editor.dom.addEventListener('compositionstart', startComposition, { signal })
    editor.dom.addEventListener('compositionend', endComposition, { signal })
    viewport?.addEventListener('resize', resize, { signal })
    const observer = new ResizeObserver(resize)
    observer.observe(pane)
    sizeMargins()
    follow(initial)
    ownsScroll = () => frame !== 0 && !held && !composing && !editor.composing && caret() && editor.hasFocus()
    cancel = () => {
      hold()
      listeners.abort()
      observer.disconnect()
      const before = editor.dom.getBoundingClientRect().top
      delete spacer.dataset.centerLine
      spacer.style.removeProperty('--amx-writing-lead')
      body.style.removeProperty('--amx-writing-tail')
      if (editor.dom.isConnected && editor.dom.getClientRects().length) {
        pane.scrollTop += (editor.dom.getBoundingClientRect().top - before) / zoomOf(pane)
      }
    }
  }

  return {
    setEnabled(next: boolean): void {
      if (next === enabled) return
      enabled = next
      connect(next)
    },
    plugin: $prose(() => new Plugin({
      props: {
        handleScrollToSelection: () => ownsScroll(),
        handleKeyDown(editor, event) {
          if (!enabled || event.key !== 'Escape' || event.defaultPrevented || event.isComposing || editor.composing) return false
          exit()
          return true
        },
      },
      view(editor) {
        view = editor
        connect(false)
        return {
          update(current, prev) {
            if (current === view && changed && (prev.doc !== current.state.doc || !prev.selection.eq(current.state.selection))) changed()
          },
          destroy() {
            if (view !== editor) return
            cancel?.()
            cancel = undefined
            changed = undefined
            ownsScroll = () => false
            view = null
          },
        }
      },
    })),
  }
}
