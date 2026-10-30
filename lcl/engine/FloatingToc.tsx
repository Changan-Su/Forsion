/**
 * LCL floating table of contents.
 *
 * The component deliberately knows nothing about chat, notes, or plugins. It scans a caller-owned
 * content root, tracks the section nearest the top of a caller-owned scroll container, and renders
 * the shared collapsed-rail / expanded-list UI. Feature surfaces adapt their DOM through
 * `itemFromElement`; external plugins receive the same component through `ctx.ui.mountFloatingToc`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { curve, emergeDroplet, ms, type Droplet } from './droplet'
import { useExitGhost, zoomOf } from './menuAnchor'
import { reducedMotion } from './spring'
import './floatingToc.css'

export interface FloatingTocItemDescriptor {
  text: string
  /** 0 is reserved for a prominent parent/turn; headings normally use 1-6. */
  level: number
  /** Prominent entries use the stronger rail/list treatment (for example a chat turn). */
  primary?: boolean
  /** Optional navigation override. Omit it to scroll the source element into view. */
  onSelect?: () => void
}

export type FloatingTocItemReader = (
  element: HTMLElement,
  index: number,
) => FloatingTocItemDescriptor | null

export type FloatingTocElementSource =
  | HTMLElement
  | null
  | RefObject<HTMLElement | null>
  | (() => HTMLElement | null)

export interface FloatingTocOptions {
  /** Defaults to h1-h3 plus elements carrying `data-lcl-toc-title`. */
  selector?: string
  /** Defaults to heading text/level or `data-lcl-toc-*` attributes. */
  itemFromElement?: FloatingTocItemReader
  label?: string
  /** Hide until this many usable entries exist. Defaults to 2. */
  minItems?: number
  /** Hide when the scroll surface is narrower than this many CSS pixels. Defaults to 520. */
  hideBelow?: number
  /** Space left above a target after navigation and the active-section probe line. */
  topOffset?: number
  side?: 'left' | 'right'
}

export interface FloatingTocProps extends FloatingTocOptions {
  scrollContainer: FloatingTocElementSource
  /** Defaults to the scroll container. */
  contentRoot?: FloatingTocElementSource
  /** Optional explicit invalidation; MutationObserver already covers ordinary DOM/text changes
   *  (the first change after a quiet spell rescans on the next frame, later ones at most every 500 ms;
   *  changes inside `[data-lcl-toc-ignore]` subtrees, e.g. lazily mounted code or embeds, never do). */
  scanTrigger?: unknown
  /** Height of sticky chrome covering the top of the scroll container (read at use time), added to
   *  `topOffset` for both the jump target and the active-section line. Pass a stable function. */
  topInset?: (scrollContainer: HTMLElement) => number
  /** Height of floating chrome over the bottom of the scroll container (a composer, say). The open
   *  list stays above it. Read when the list opens. */
  bottomInset?: (scrollContainer: HTMLElement) => number
  /** `overlay` anchors to a non-scrolling positioned parent; `sticky` lives in the scroll surface. */
  placement?: 'overlay' | 'sticky'
}

interface ResolvedItem extends FloatingTocItemDescriptor {
  key: string
  target: HTMLElement
}

const DEFAULT_SELECTOR = 'h1, h2, h3, [data-lcl-toc-title]'

const ROW = 28 // Row height and list padding; keep in step with floatingToc.css.
const PAD = 6
const TICK_LENGTHS = [16, 13, 10, 7]
const ACTIVE_BUMP = 4
const TICK_WIDTH = 20 // Ticks are this wide in CSS and scaled down, so length changes stay on the compositor.
const POOL_CELL = 3 // Below this spacing ticks merge: each cell draws its highest-level heading.
const OPEN_DELAY = 120
const CLOSE_DELAY = 150
const IDLE_AFTER = 1200

const tickLength = (level: number): number => TICK_LENGTHS[Math.min(level, TICK_LENGTHS.length - 1)]

function resolveElement(source: FloatingTocElementSource | undefined): HTMLElement | null {
  if (!source) return null
  if (typeof source === 'function') return source()
  if ('current' in source) return source.current
  return source
}

/** Attribute convention for DOM-only consumers that do not need a custom reader. */
export const defaultFloatingTocItem: FloatingTocItemReader = (element) => {
  const tagLevel = /^H([1-6])$/.exec(element.tagName)?.[1]
  const rawLevel = element.dataset.lclTocLevel ?? tagLevel ?? '1'
  const n = Number(rawLevel)
  const text = (element.dataset.lclTocTitle ?? element.textContent ?? '').trim()
  if (!text) return null
  return {
    text,
    level: Number.isFinite(n) ? Math.max(0, Math.min(6, Math.round(n))) : 1,
    primary: element.hasAttribute('data-lcl-toc-primary') || element.dataset.lclTocKind === 'primary',
  }
}

function sameItems(a: ResolvedItem[], b: ResolvedItem[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const next = b[index]
    return item.target === next.target && item.text === next.text && item.level === next.level
      && item.primary === next.primary && item.onSelect === next.onSelect
  })
}

/** Rescans while content keeps changing (streaming, typing) are spaced this far apart. */
const SCAN_SPACING_MS = 500

const ignoredMutation = (record: MutationRecord): boolean => {
  const node = record.target
  const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  return !!el?.closest('[data-lcl-toc-ignore]')
}

/** The element to measure for `target`. Reading the box of something inside a subtree that
 *  `content-visibility: auto` is skipping forces the browser to lay that whole subtree out, which undoes
 *  the skipping on every scroll frame. Such a subtree is far from the viewport, so measuring its nearest
 *  unskipped ancestor is precise enough to tell above from below the probe line. */
function measurable(target: HTMLElement): HTMLElement {
  if (target.checkVisibility?.({ contentVisibilityAuto: true }) !== false) return target
  let el = target.parentElement
  while (el && !el.checkVisibility({ contentVisibilityAuto: true })) el = el.parentElement
  return el ?? target
}

/** The pending scrollToElement correction per scroll root: one at a time, the newer jump wins. */
const settling = new WeakMap<Element, () => void>()

/** Stops a pending scrollToElement correction on `root`. */
export function cancelScrollToElement(root: Element): void {
  settling.get(root)?.()
}

/** Smoothly scrolls `root` so `target` sits `offset` px below its top, then re-measures once scrolling settles and
 *  corrects (up to 3 times). Blocks skipped by `content-visibility: auto` only get their real height in the frame they
 *  come near the viewport, which pushes the target away, and scroll anchoring has no anchor to compensate with then
 *  (a long chat landed 850 px off). Stops as soon as the user scrolls, clicks or types, or another jump on the same
 *  root starts; call `cancelScrollToElement(root)` before scrolling `root` somewhere else yourself.
 *  `onLanded` runs once the target has settled in place (not when the user or a newer jump cut it short). */
export function scrollToElement(root: Element, target: Element, offset = 0, onLanded?: () => void): void {
  cancelScrollToElement(root)
  const delta = (): number => target.getBoundingClientRect().top - root.getBoundingClientRect().top - offset
  root.scrollTo({ top: Math.max(0, root.scrollTop + delta()), behavior: 'smooth' })
  let user = false, tries = 0, frames = 0, still = 0, last = -1
  const stop = (): void => { user = true }
  const events = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const
  for (const e of events) root.addEventListener(e, stop, { passive: true })
  settling.set(root, stop)
  const done = (): void => {
    for (const e of events) root.removeEventListener(e, stop)
    if (settling.get(root) === stop) settling.delete(root)
  }
  const tick = (): void => {
    if (user || !target.isConnected || ++frames > 240) return done()
    if (root.scrollTop !== last) { last = root.scrollTop; still = 0 } // smooth scroll still moving
    else if (++still >= 2) {
      const d = delta()
      if (Math.abs(d) <= 2 || tries++ >= 3) { done(); onLanded?.(); return }
      root.scrollBy({ top: d })
      still = 0
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function FloatingToc({
  scrollContainer,
  contentRoot,
  selector = DEFAULT_SELECTOR,
  itemFromElement = defaultFloatingTocItem,
  label = 'Table of contents',
  minItems = 2,
  hideBelow = 520,
  topOffset = 24,
  topInset,
  bottomInset,
  side = 'left',
  scanTrigger,
  placement = 'overlay',
}: FloatingTocProps) {
  const [items, setItems] = useState<ResolvedItem[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed')
  const [tooNarrow, setTooNarrow] = useState(false)
  const [railMax, setRailMax] = useState(0)
  const hoverTimer = useRef<number | null>(null)
  const hovered = useRef(false)
  const keepClosedOnFocus = useRef(false)
  const idleTimer = useRef(0)
  const lastActive = useRef(-1)
  const droplet = useRef<Droplet | null>(null)
  const navRef = useRef<HTMLElement | null>(null)
  const hitRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const sourceRef = useRef<HTMLElement | null>(null)
  const beadRef = useRef<HTMLElement | null>(null)
  const keys = useRef(new WeakMap<HTMLElement, string>())
  const nextKey = useRef(0)

  /** The current items, or null when there is no root / the selector is invalid. */
  const collect = useCallback((): ResolvedItem[] | null => {
    const scroller = resolveElement(scrollContainer)
    const root = resolveElement(contentRoot) ?? scroller
    if (!root) return null
    let nodes: NodeListOf<HTMLElement>
    try {
      nodes = root.querySelectorAll<HTMLElement>(selector)
    } catch (error) {
      console.error(`[lcl] FloatingToc ignored invalid selector "${selector}"`, error)
      return null
    }
    const list: ResolvedItem[] = []
    nodes.forEach((node, index) => {
      let descriptor: FloatingTocItemDescriptor | null = null
      try {
        descriptor = itemFromElement(node, index)
      } catch (error) {
        console.error('[lcl] FloatingToc item reader failed', error)
      }
      const text = String(descriptor?.text ?? '').trim()
      if (!descriptor || !text) return
      let key = keys.current.get(node)
      if (!key) {
        key = `lcl-ftoc-${++nextKey.current}`
        keys.current.set(node, key)
      }
      const level = Number(descriptor.level)
      list.push({
        ...descriptor,
        key,
        target: node,
        text,
        level: Number.isFinite(level) ? Math.max(0, Math.min(6, Math.round(level))) : 1,
      })
    })
    return list
  }, [contentRoot, itemFromElement, scrollContainer, selector])

  const scan = useCallback(() => {
    const list = collect()
    setItems((prev) => (list ? (sameItems(prev, list) ? prev : list) : (prev.length ? [] : prev)))
  }, [collect])

  useEffect(() => {
    scan()
    const scroller = resolveElement(scrollContainer)
    const root = resolveElement(contentRoot) ?? scroller
    if (!root || typeof MutationObserver === 'undefined') return
    // Rescanning walks every heading of the document, so doing it on every streamed token or keystroke grows
    // with the document. A change after a quiet spell still rescans on the next frame (switching sessions,
    // a new message); further changes are folded into one rescan per SCAN_SPACING_MS.
    let frame = 0
    let timer = 0
    let lastScan = 0
    const run = (): void => { frame = 0; lastScan = performance.now(); scan() }
    const observer = new MutationObserver((records) => {
      if (frame || timer || records.every(ignoredMutation)) return
      const wait = lastScan + SCAN_SPACING_MS - performance.now()
      if (wait <= 0) frame = requestAnimationFrame(run)
      else timer = window.setTimeout(() => { timer = 0; frame = requestAnimationFrame(run) }, wait)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [contentRoot, scan, scanTrigger, scrollContainer])

  // `data-lcl-ftoc` tells the surface's CSS the gutter is needed. It tracks the width only, not whether there are
  // headings yet: the text must not shift when a second heading appears.
  // A microtask, because the scroll container is often an ancestor whose ref attaches after this layout effect runs;
  // it still lands before the first paint, so the text does not jump sideways on mount.
  useLayoutEffect(() => {
    let stop = (): void => {}
    let live = true
    queueMicrotask(() => {
      const root = resolveElement(scrollContainer)
      if (!live || !root) return
      const measure = (): void => {
        const narrow = hideBelow > 0 && root.getBoundingClientRect().width <= hideBelow
        setTooNarrow(narrow)
        if (narrow) root.removeAttribute('data-lcl-ftoc')
        else root.setAttribute('data-lcl-ftoc', side)
        setRailMax(Math.min(window.innerHeight / zoomOf(root) * 0.44, root.clientHeight - 32))
      }
      measure()
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
      observer?.observe(root)
      stop = () => {
        observer?.disconnect()
        root.removeAttribute('data-lcl-ftoc')
      }
    })
    return () => {
      live = false
      stop()
    }
  }, [hideBelow, scrollContainer, side])

  // A scroll listener is more reliable than an IntersectionObserver here: headings between probe
  // bands still retain the preceding section, and it works for nested positioned editor blocks.
  useEffect(() => {
    const root = resolveElement(scrollContainer)
    if (!root || !items.length) {
      setActiveKey(null)
      return
    }
    let frame = 0
    const sync = (): void => {
      frame = 0
      const line = root.getBoundingClientRect().top + topOffset + (topInset?.(root) ?? 0) + 1
      let active = items[0]
      for (const item of items) {
        if (!item.target.isConnected || !root.contains(item.target)) continue
        if (measurable(item.target).getBoundingClientRect().top <= line) active = item
        else break
      }
      setActiveKey(active?.key ?? null)
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(sync)
    }
    const wake = (): void => {
      navRef.current?.classList.add('awake')
      window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => navRef.current?.classList.remove('awake'), IDLE_AFTER)
    }
    sync()
    root.addEventListener('scroll', wake, { passive: true })
    root.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(idleTimer.current)
      root.removeEventListener('scroll', wake)
      root.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [items, scrollContainer, topOffset, topInset])

  useEffect(() => () => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
    droplet.current?.cancel()
  }, [])

  const jumpTo = useCallback((item: ResolvedItem) => {
    const root = resolveElement(scrollContainer)
    if (!root) return
    if (item.onSelect) {
      try { item.onSelect() } catch (error) { console.error('[lcl] FloatingToc navigation failed', error) }
    } else {
      // Rescans are spaced (SCAN_SPACING_MS), so an editor may have redrawn this heading since: take the
      // current node at the same position (or with the same text and level) instead of the detached one.
      let target: HTMLElement | undefined = item.target
      if (!target.isConnected) {
        const fresh = collect() ?? []
        const at = fresh[items.indexOf(item)]
        target = (at?.text === item.text ? at : fresh.find((x) => x.text === item.text && x.level === item.level))?.target
        scan()
      }
      if (target && root.contains(target)) scrollToElement(root, target, topOffset + (topInset?.(root) ?? 0))
    }
    setActiveKey(item.key)
  }, [collect, items, scan, scrollContainer, topOffset, topInset])

  const clearHoverTimer = (): void => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  const open = useCallback((): void => {
    clearHoverTimer()
    setPhase((p) => (p === 'open' ? p : 'open'))
  }, [])
  const close = useCallback((): void => {
    clearHoverTimer()
    const d = droplet.current
    setPhase((p) => (p === 'closed' ? p : d ? 'closing' : 'closed'))
    if (!d) return
    void d.retract().then(() => {
      if (droplet.current !== d) return // Reopened meanwhile.
      droplet.current = null
      setPhase((p) => (p === 'closing' ? 'closed' : p))
    })
  }, [])

  const visible = items.length >= Math.max(1, minItems) && !tooNarrow
  useExitGhost(navRef, visible)

  useEffect(() => {
    if (visible) return
    droplet.current?.cancel()
    droplet.current = null
    setPhase('closed')
  }, [visible])

  // Lines the active row up with its tick, then pours the list out of the tick.
  useLayoutEffect(() => {
    if (phase !== 'open') return
    const nav = navRef.current, panel = panelRef.current, source = sourceRef.current
    const scroller = resolveElement(scrollContainer)
    if (!nav || !panel || !source || !scroller) return
    droplet.current?.cancel()
    const z = zoomOf(nav)
    const box = scroller.getBoundingClientRect()
    const paneH = box.height / z
    const low = (topInset?.(scroller) ?? 0) + 8
    const high = (bottomInset?.(scroller) ?? 0) + 8
    const full = items.length * ROW + 2 * PAD + 2
    const height = Math.max(ROW + 2 * PAD, Math.min(window.innerHeight / z * 0.56, paneH - low - high, full))
    const index = Math.max(0, items.findIndex((item) => item.key === activeKey))
    const navTop = (nav.getBoundingClientRect().top - box.top) / z
    const rowMiddle = PAD + index * ROW + ROW / 2
    const tick = (source.getBoundingClientRect().top + source.getBoundingClientRect().height / 2 - box.top) / z
    const maxScroll = Math.max(0, full - height), maxTop = Math.max(low, paneH - high - height)
    const clampTop = (y: number): number => Math.min(maxTop, Math.max(low, y))
    const firstTop = clampTop(tick - height / 2)
    const scroll = Math.min(maxScroll, Math.max(0, rowMiddle - (tick - firstTop)))
    panel.style.top = `${clampTop(tick - (rowMiddle - scroll)) - navTop}px`
    panel.style.height = `${height}px`
    panel.scrollTop = scroll
    droplet.current = emergeDroplet(source, panel)
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps -- placed once per opening

  // A click anywhere else closes it (touch has no leave), and so does leaving the window.
  useEffect(() => {
    if (phase !== 'open') return
    const outside = (event: PointerEvent): void => {
      if (!navRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('blur', close)
    }
  }, [close, phase])

  const activeIndex = items.findIndex((item) => item.key === activeKey)

  useEffect(() => {
    const was = lastActive.current
    lastActive.current = activeIndex
    if (was < 0 || activeIndex < 0 || was === activeIndex) return
    const reduced = reducedMotion()
    if (!reduced) {
      beadRef.current?.animate(
        [{ transform: 'scaleY(1)' }, { transform: 'scaleY(2.4)', offset: 0.4 }, { transform: 'scaleY(1)' }],
        { duration: ms('--duration-slow', 250), easing: curve('--ease-calm', 'ease') },
      )
    }
    const panel = panelRef.current
    if (!panel || phase !== 'open') return
    const y = PAD + activeIndex * ROW, top = panel.scrollTop, h = panel.clientHeight
    if (y < top + h * 0.2 || y + ROW > top + h * 0.8) {
      panel.scrollTo({ top: y - h / 2 + ROW / 2, behavior: reduced ? 'auto' : 'smooth' })
    }
  }, [activeIndex, phase])

  const rail = useMemo(() => {
    const height = Math.max(0, Math.min(railMax, items.length * 6))
    const gap = height / Math.max(1, items.length)
    const best = new Map<number, number>()
    items.forEach((item, index) => {
      const cell = Math.floor(((index + 0.5) * gap) / POOL_CELL)
      const held = best.get(cell)
      if (held == null || item.level < items[held].level) best.set(cell, index)
    })
    const ticks = items.map((item, index) => {
      if (best.get(Math.floor(((index + 0.5) * gap) / POOL_CELL)) !== index) return null
      const style = {
        '--y': `${(index + 0.5) * gap}px`,
        '--l': (tickLength(item.level) / TICK_WIDTH).toFixed(3),
        '--o': item.primary ? 0.62 : item.level <= 1 ? 0.5 : 0.36,
      } as CSSProperties
      return <i key={item.key} className="lcl-ftoc-tick" style={style} />
    })
    return { height, gap, ticks }
  }, [items, railMax])

  // Pointer enter / leave only: touch has no hover, so a tap opens through the button's click.
  const onEnter = (event: ReactPointerEvent): void => {
    if (event.pointerType === 'touch') return
    hovered.current = true
    clearHoverTimer()
    if (event.buttons || phase === 'open') return // Dragging a text selection across the gutter opens nothing.
    hoverTimer.current = window.setTimeout(open, OPEN_DELAY)
  }
  const onLeave = (event: ReactPointerEvent): void => {
    if (event.pointerType === 'touch') return
    hovered.current = false
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(close, CLOSE_DELAY)
  }

  if (!visible) return null
  const levelBase = Math.min(...items.map((item) => item.level))
  const active = activeIndex >= 0 ? items[activeIndex] : null

  return (
    <div className={`lcl-ftoc-frame is-${placement}`} data-side={side}>
      <nav
        ref={navRef}
        className={`lcl-ftoc${phase === 'open' ? ' open' : ''}${phase === 'closed' ? '' : ' hot'}`}
        style={{ '--rail-h': `${rail.height}px`, '--th': rail.gap >= 4 ? '2px' : '1px' } as CSSProperties}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onFocusCapture={(event) => {
          if (keepClosedOnFocus.current) keepClosedOnFocus.current = false
          else if ((event.target as HTMLElement).matches(':focus-visible')) open()
        }}
        onBlurCapture={(event) => {
          if (!hovered.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) close()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          close()
          keepClosedOnFocus.current = true
          hitRef.current?.focus()
        }}
        aria-label={label}
      >
        {rail.ticks}
        {active && (
          <span
            className="lcl-ftoc-mark"
            style={{
              '--my': `${(activeIndex + 0.5) * rail.gap}px`,
              '--ml': ((tickLength(active.level) + ACTIVE_BUMP) / TICK_WIDTH).toFixed(3),
            } as CSSProperties}
          >
            <i className="lcl-ftoc-pin" />
            <i ref={beadRef} className="lcl-ftoc-bead" />
            <i ref={sourceRef} className="lcl-ftoc-source" />
          </span>
        )}
        <button
          ref={hitRef}
          type="button"
          className="lcl-ftoc-hit"
          aria-label={label}
          aria-expanded={phase === 'open'}
          onClick={open}
        />
        {phase !== 'closed' && (
          <div ref={panelRef} className="lcl-ftoc-panel">
            <div className="lcl-ftoc-list">
              <i className="lcl-ftoc-hl" style={{ '--hy': `${Math.max(0, activeIndex) * ROW}px` } as CSSProperties} />
              {items.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  className={`lcl-ftoc-item${index === activeIndex ? ' active' : ''}${item.primary ? ' primary' : ''}`}
                  onClick={() => jumpTo(item)}
                  title={item.text}
                  aria-current={index === activeIndex ? 'location' : undefined}
                  style={{ paddingInlineStart: 8 + (item.level - levelBase) * 12 }}
                >
                  <span className="lcl-ftoc-text">{item.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>
    </div>
  )
}
