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
  useRef,
  useState,
  type RefObject,
} from 'react'
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
  /** Optional explicit invalidation; MutationObserver already covers ordinary DOM/text changes. */
  scanTrigger?: unknown
  /** `overlay` anchors to a non-scrolling positioned parent; `sticky` lives in the scroll surface. */
  placement?: 'overlay' | 'sticky'
}

interface ResolvedItem extends FloatingTocItemDescriptor {
  key: string
  target: HTMLElement
}

const DEFAULT_SELECTOR = 'h1, h2, h3, [data-lcl-toc-title]'

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

export function FloatingToc({
  scrollContainer,
  contentRoot,
  selector = DEFAULT_SELECTOR,
  itemFromElement = defaultFloatingTocItem,
  label = 'Table of contents',
  minItems = 2,
  hideBelow = 520,
  topOffset = 24,
  side = 'left',
  scanTrigger,
  placement = 'overlay',
}: FloatingTocProps) {
  const [items, setItems] = useState<ResolvedItem[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [tooNarrow, setTooNarrow] = useState(false)
  const hoverTimer = useRef<number | null>(null)
  const keys = useRef(new WeakMap<HTMLElement, string>())
  const nextKey = useRef(0)

  const scan = useCallback(() => {
    const scroller = resolveElement(scrollContainer)
    const root = resolveElement(contentRoot) ?? scroller
    if (!root) {
      setItems((prev) => (prev.length ? [] : prev))
      return
    }
    let nodes: NodeListOf<HTMLElement>
    try {
      nodes = root.querySelectorAll<HTMLElement>(selector)
    } catch (error) {
      console.error(`[lcl] FloatingToc ignored invalid selector "${selector}"`, error)
      setItems((prev) => (prev.length ? [] : prev))
      return
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
    setItems((prev) => (sameItems(prev, list) ? prev : list))
  }, [contentRoot, itemFromElement, scrollContainer, selector])

  useEffect(() => {
    scan()
    const scroller = resolveElement(scrollContainer)
    const root = resolveElement(contentRoot) ?? scroller
    if (!root || typeof MutationObserver === 'undefined') return
    let frame = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(scan)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [contentRoot, scan, scanTrigger, scrollContainer])

  useEffect(() => {
    const root = resolveElement(scrollContainer)
    if (!root) return
    const measure = (): void => setTooNarrow(hideBelow > 0 && root.getBoundingClientRect().width <= hideBelow)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [hideBelow, scrollContainer])

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
      const line = root.getBoundingClientRect().top + topOffset + 1
      let active = items[0]
      for (const item of items) {
        if (!item.target.isConnected || !root.contains(item.target)) continue
        if (item.target.getBoundingClientRect().top <= line) active = item
        else break
      }
      setActiveKey(active?.key ?? null)
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(sync)
    }
    sync()
    root.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [items, scrollContainer, topOffset])

  useEffect(() => () => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
  }, [])

  const jumpTo = useCallback((item: ResolvedItem) => {
    const root = resolveElement(scrollContainer)
    if (!root) return
    if (item.onSelect) {
      try { item.onSelect() } catch (error) { console.error('[lcl] FloatingToc navigation failed', error) }
    } else if (root.contains(item.target)) {
      const top = item.target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
      root.scrollTo({ top: Math.max(0, top - topOffset), behavior: 'smooth' })
    }
    setActiveKey(item.key)
  }, [scrollContainer, topOffset])

  const enter = (): void => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setHovered(true)
  }
  const leave = (): void => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHovered(false), 150)
  }

  if (items.length < Math.max(1, minItems) || tooNarrow) return null
  const expanded = hovered || focused

  return (
    <div className={`lcl-ftoc-frame is-${placement}`} data-side={side}>
      <nav
        className={`lcl-ftoc${expanded ? ' open' : ''}`}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setHovered(false)
            setFocused(false)
            ;(event.target as HTMLElement | null)?.blur?.()
          }
        }}
        aria-label={label}
      >
        {items.map((item) => {
          const active = activeKey === item.key
          const barLength = (item.level === 0 ? 18 : item.level === 1 ? 14 : item.level === 2 ? 11 : 8) + (active ? 6 : 0)
          return (
            <button
              key={item.key}
              type="button"
              className={`lcl-ftoc-item${active ? ' active' : ''}${item.primary ? ' primary' : ''}`}
              onClick={() => jumpTo(item)}
              title={item.text}
              aria-current={active ? 'location' : undefined}
              style={{ paddingInlineStart: expanded ? 8 + item.level * 10 : 0 }}
            >
              <span
                className="lcl-ftoc-bar"
                style={{ transform: expanded ? 'translateX(0) scaleX(1)' : `translateX(${item.level * 3}px) scaleX(${barLength / 4})` }}
              />
              <span className="lcl-ftoc-text">{item.text}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
