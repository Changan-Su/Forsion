import { zoomOf } from '@lcl/engine'

export interface ChatReadingPosition { follow: boolean; messageId?: string; offset: number; top: number }
const positions = new Map<string, ChatReadingPosition>()
const LIMIT = 300
export const chatReadingKey = (space: string, view: string, session: string, engine = ''): string => JSON.stringify([space, view, session, engine])
export const readChatPosition = (key: string): ChatReadingPosition | undefined => positions.get(key)
export function rememberChatPosition(key: string, position: ChatReadingPosition): void {
  positions.delete(key); positions.set(key, position)
  while (positions.size > LIMIT) positions.delete(positions.keys().next().value!)
}

/** Keep an element id plus an offset inside that message, rather than a document pixel position. */
export function captureChatPosition(root: HTMLElement, follow: boolean): ChatReadingPosition {
  const top = root.scrollTop
  if (follow) return { follow, top, offset: 0 }
  const bounds = root.getBoundingClientRect(), zoom = zoomOf(root)
  for (const message of root.querySelectorAll<HTMLElement>('[id^="tocmsg-"]')) {
    const rect = message.getBoundingClientRect()
    if (rect.bottom > bounds.top + 1 && rect.top < bounds.bottom) {
      return { follow, top, messageId: message.id, offset: (rect.top - bounds.top) / zoom }
    }
  }
  return { follow, top, offset: 0 }
}
export function restoreChatPosition(root: HTMLElement, position: ChatReadingPosition): boolean {
  if (position.follow) { root.scrollTop = root.scrollHeight; return true }
  // Element ids repeat when the same conversation is split; never query the whole document.
  const target = position.messageId
    ? [...root.querySelectorAll<HTMLElement>('[id^="tocmsg-"]')].find(el => el.id === position.messageId) : undefined
  if (position.messageId && !target) return false
  root.scrollTop = target
    ? root.scrollTop + (target.getBoundingClientRect().top - root.getBoundingClientRect().top) / zoomOf(root) - position.offset
    : position.top
  return true
}

export interface ChatReadingController {
  restore(loading: boolean): void
  cancel(): void
  save(): void
  dispose(): void
  readonly restoring: boolean
}
/** Owns a single mounted conversation. User/search intent always cancels pending layout correction. */
export function trackChatReading(
  key: string, root: HTMLElement, follows: { current: boolean }, explicitJump = false,
): ChatReadingController {
  const saved = readChatPosition(key)
  follows.current = explicitJump ? false : saved?.follow ?? true
  let pending = !explicitJump && !!saved && !saved.follow
  let disposed = false, raf = 0, captureRaf = 0, frames = 0, stable = 0, lastTop = -1
  let loading = true
  const previousAnchor = root.style.overflowAnchor
  const restoreAnchor = (): void => { root.style.overflowAnchor = previousAnchor }
  if (pending) root.style.overflowAnchor = 'none'
  const save = (): void => {
    if (disposed || pending || !root.isConnected || root.clientHeight <= 0) return
    rememberChatPosition(key, captureChatPosition(root, follows.current))
  }
  const cancel = (): void => {
    pending = false; cancelAnimationFrame(raf); restoreAnchor()
  }
  const tick = (): void => {
    if (!pending || disposed || !root.isConnected || root.clientHeight <= 0) return
    const found = restoreChatPosition(root, saved!)
    if (!found) {
      if (loading) return // load completion calls restore again
      root.scrollTop = saved!.top // deleted/trimmed message: preserve the closest available position
    }
    stable = Math.abs(root.scrollTop - lastTop) < 1 ? stable + 1 : 0
    lastTop = root.scrollTop
    if (++frames >= 60 || (!loading && stable >= 3)) { cancel(); save(); return }
    raf = requestAnimationFrame(tick)
  }
  const onScroll = (): void => { cancelAnimationFrame(captureRaf); captureRaf = requestAnimationFrame(save) }
  const onIntent = (): void => { cancel() }
  // Dockview constructs background tabs while detached. A later attachment need
  // not change messages, so visibility must independently resume the saved anchor.
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
    if (!pending) return
    cancelAnimationFrame(raf); tick()
  })
  observer?.observe(root)
  root.addEventListener('scroll', onScroll, { passive: true })
  const intents = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'lcl:scroll-to-element'] as const
  for (const event of intents) root.addEventListener(event, onIntent, { passive: true })
  return {
    get restoring() { return pending },
    restore(isLoading) {
      loading = isLoading
      if (!pending) return
      cancelAnimationFrame(raf); frames = 0; stable = 0
      tick()
    },
    cancel,
    save,
    dispose() {
      save(); disposed = true; cancel(); cancelAnimationFrame(captureRaf)
      observer?.disconnect()
      root.removeEventListener('scroll', onScroll)
      for (const event of intents) root.removeEventListener(event, onIntent)
    },
  }
}
