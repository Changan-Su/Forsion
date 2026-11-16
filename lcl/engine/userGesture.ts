/** "The user did this just now": true while the page is handling the user's own input — a trusted tap / click / key /
 *  drop event, or a choice the user made in a native sheet (nativeSheet.ts) — and until the task that handles it ends.
 *
 *  What it is for: a notification raised *synchronously* by such a handler is the answer to what the user just did
 *  (the "Undo" after a delete or a completed to-do), not something that came looking for them. The phone's banner
 *  throttle (desktop stores/notificationStore.ts) lets those through.
 *
 *  What else can see it: messages, sync results and agent events are raised from network callbacks and timers — tasks
 *  of their own, outside the dispatch of the user's input event. The mark is cleared by a zero-delay timer queued at
 *  the input, so only tasks that run before that timer see it. Usually that is no one, or a few milliseconds' worth;
 *  but when the main thread was busy as the input arrived, every timer that came due during the busy stretch runs
 *  before the clearing timer and sees the mark (measured in Chromium: a 300 ms block, a tap during it, a timer due
 *  meanwhile → it read true). A card with a button raised by such a timer is then treated like an undo receipt: it pops
 *  where it would have been throttled and stays 8 s. The error only ever goes that way — more shown, never fewer.
 *  `navigator.userActivation.isActive` is not used for this: it stays on for seconds after any tap or key press, typing
 *  in a chat included, which would wave through every message arriving meanwhile.
 *  Native bar taps (Dock, back) do not mark: they only navigate. */
const INPUT = ['pointerdown', 'pointerup', 'touchend', 'click', 'dblclick', 'auxclick', 'contextmenu', 'keydown', 'keyup', 'drop', 'submit'] as const

let live = false
let clear: ReturnType<typeof setTimeout> | null = null

/** Mark the current task as the handling of a user's input (cleared by a zero-delay timer). */
export function markUserGesture(): void {
  live = true
  if (clear === null) clear = setTimeout(() => { live = false; clear = null }, 0)
}

export function inUserGesture(): boolean { return live }

/** Watch trusted input events on `target` (capture phase: before any handler of the page sees them). Returns the undo. */
export function installUserGestureTracking(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const on = (e: Event): void => { if (e.isTrusted) markUserGesture() }
  for (const type of INPUT) target.addEventListener(type, on, { capture: true, passive: true })
  return () => { for (const type of INPUT) target.removeEventListener(type, on, { capture: true }) }
}
