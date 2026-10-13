/** What stands at the bottom edge of the page — the message box, an editor's toolbar — travels with the keyboard instead
 *  of jumping to where the keyboard will be (the user, 2026-10-13: "应该有过渡动画,而不是突然闪现上去").
 *
 *  An element opts in with `data-kb-rise`. `data-kb-rise="end"` is for a whole column that ends in such a bar (a chat):
 *  it travels as one piece — the conversation with its input, as a native chat does — but only while the scroller inside
 *  it marked `data-kb-end` is at its end; scrolled up, the column stays and the bar inside it (marked on its own)
 *  travels alone, so what is being read does not move.
 *
 *  Every Android version (the baseline): the page's height changes with the keyboard, in one step, and the page answers
 *  it — the elements start where they stood and slide to where layout now puts them.
 *   - going away, the page grows at the keyboard's first frame: they slide down the height it just gained;
 *   - coming up where the system resizes the window (before Android 15), the page shrinks at the keyboard's first
 *     frame: the bar slides up into its new place from under the page's new bottom edge. Only the bar — a whole
 *     column started that far down would bare a band of the page at its top.
 *  Android 15+ (the shell owns the margins) does better on the way up: the shell holds the page's height until the
 *  keyboard has arrived and says how far and how fast (`ime` event, NativeChromePlugin.reportIme). The elements ride
 *  up by that much, in step with the keyboard, and the ride is dropped in the very frame the page is made shorter:
 *  from then on they stand there by layout. A keyboard sent away before it had arrived never made the page shorter:
 *  the shell says so (the same event, `rise` 0) and what was riding comes back down from where it is.
 *
 *  A motion cut short by the next one (the keyboard reversed mid-way) starts the next from where the element is drawn.
 *  With animations turned off in the system (`prefers-reduced-motion`) nothing travels.
 *
 *  Motion is `translate` through the Web Animations API: it runs on the compositor, composes with whatever `transform`
 *  the element has, and leaves no inline style behind. */
export interface ImeRise { rise?: unknown; ms?: unknown; at?: unknown; ease?: unknown }

/** Android's curve for a keyboard an app follows; used until the shell has reported the device's own. */
const EASE = 'cubic-bezier(0.2, 0, 0, 1)'
const FRAME = 16
/** A height change smaller than this is the gesture bar or the dock coming and going, not a keyboard (CSS px = dp). */
const KEYBOARD_MIN = 120
let last = { ms: 285, ease: EASE }
let riding: { els: HTMLElement[]; anims: Animation[]; rise: number; timer: number } | null = null

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const still = (): boolean => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }
/** How far above its layout place the element is drawn right now (its own px): a motion of ours still under way. */
const lifted = (el: Element): number => -(parseFloat((getComputedStyle(el).translate || '').split(' ')[1]) || 0)

/** The elements that travel right now: marked, on screen, outermost first (a column that travels takes its bar along).
 *  `columns: false` leaves every `end` column where it is — the bars inside them travel alone. */
export function risers(doc: Document = document, columns = true): HTMLElement[] {
  const out: HTMLElement[] = []
  const view = doc.defaultView
  for (const el of doc.querySelectorAll<HTMLElement>('[data-kb-rise]')) { // document order: an ancestor comes before what is inside it
    if (out.some((o) => o.contains(el))) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || (view && (r.top >= view.innerHeight || r.left >= view.innerWidth))) continue // a parked list, a hidden tab
    if (el.dataset.kbRise === 'end') {
      if (!columns) continue
      const sc = el.querySelector<HTMLElement>('[data-kb-end]')
      if (!sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight > 40) continue
    }
    out.push(el)
  }
  return out
}

/** The page's px inside an element are scaled by every `zoom` above it; the keyboard's travel is in screen dp. */
function zoomOf(el: Element): number {
  const z = (el as Element & { currentCSSZoom?: number }).currentCSSZoom
  if (typeof z === 'number' && z > 0) return z
  let n = 1
  for (let e: Element | null = el; e; e = e.parentElement) n *= parseFloat(getComputedStyle(e).zoom) || 1
  return n
}

/** Moves `els` from `from` to `to` dp above where layout puts them — `from` on top of wherever an earlier motion has
 *  them right now. `lag` = how far into the keyboard's own motion we already are (a negative delay starts the animation
 *  that much in). `hold` keeps the end position until cancelled. */
function ride(els: HTMLElement[], from: number, to: number, lag: number, hold: boolean): Animation[] {
  const out: Animation[] = []
  for (const el of els) {
    const z = zoomOf(el)
    const frames = [{ translate: `0 ${(-from / z - lifted(el)).toFixed(2)}px` }, { translate: `0 ${(-to / z).toFixed(2)}px` }]
    const timing = { duration: last.ms, delay: -Math.min(lag, last.ms * 0.5), fill: hold ? 'forwards' as const : 'none' as const }
    try { out.push(el.animate(frames, { ...timing, easing: last.ease })) } catch {
      // a WebView that does not know `linear()` refuses the easing: the stock curve is close enough
      try { out.push(el.animate(frames, { ...timing, easing: EASE })) } catch { /* no Web Animations: the element simply does not travel */ }
    }
  }
  return out
}

function settle(): void {
  if (!riding) return
  window.clearTimeout(riding.timer)
  for (const a of riding.anims) a.cancel()
  riding = null
}

/** The shell's `ime` event: the keyboard starts coming up and the page keeps its height until it has arrived
 *  (`rise` > 0), or it starts going away (`rise` 0). */
export function keyboardRise(e: ImeRise): void {
  const rise = num(e.rise)
  const ms = num(e.ms)
  last = {
    ms: ms >= 80 && ms <= 800 ? ms : last.ms,
    ease: typeof e.ease === 'string' && /^linear\([0-9., ]{3,400}\)$/.test(e.ease) ? e.ease : last.ease,
  }
  const was = riding
  const moving = ms >= 80 && !still() // otherwise the keyboard is simply there (or gone)
  const sent = num(e.at)
  const lag = (sent ? Math.max(0, Math.min(100, Date.now() - sent)) : 0) + FRAME
  const els = rise >= 24 && moving ? risers() : []
  // the new motion first (it starts from where the old one has the element), then the old one is dropped
  const anims = els.length ? ride(els, 0, rise, lag, true) : was && moving ? ride(was.els, 0, 0, lag, false) : []
  settle()
  // The shell resizes the page when the keyboard has arrived, and that is what ends the ride (onResize). The timer is
  // for a resize that never comes: an element left riding would stand above a keyboard that is not there.
  if (els.length) riding = { els, anims, rise, timer: window.setTimeout(settle, last.ms + 700) }
}

let installed = false
/** Hooks the page's own half (see the top comment). Safe to call twice. */
export function installKeyboardRise(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  let h = window.innerHeight
  let w = window.innerWidth
  let typedAt = 0
  const typing = (el: Element | null): boolean => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable)
  // a keyboard dismissed by a tap elsewhere has already taken the focus away by the time the page grows
  document.addEventListener('focusout', (e) => { if (typing(e.target as Element | null)) typedAt = Date.now() }, true)
  window.addEventListener('resize', () => {
    const dh = window.innerHeight - h
    const turned = window.innerWidth !== w
    h = window.innerHeight; w = window.innerWidth
    if (riding) {
      // made shorter by (about) what the elements rode: from this frame on layout puts them there
      if (turned || (dh < 0 && -dh >= riding.rise * 0.5)) settle()
      return // anything else while riding (the dock's room going) is not the keyboard's step
    }
    if (turned || Math.abs(dh) < KEYBOARD_MIN || last.ms < 80 || still()) return
    if (!typing(document.activeElement) && Date.now() - typedAt > 1000) return // another reason (a page without the top bar, a split screen)
    // `dh` above where layout now puts them is where they stood a frame ago (below it, when the page shrank)
    ride(risers(document, dh > 0), dh, 0, 2 * FRAME, false)
  })
}
