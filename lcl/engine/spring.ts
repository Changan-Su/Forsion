/** Spring-shaped easing for what a finger lets go of (2026-10-14, the user: the swipes feel linear, "I want the
 *  liveliness of native Android / iOS"). A fixed-length curve from wherever the finger stopped ignores how fast it was
 *  going: a flick slows down at release, a slow drag gets a long tail. A spring released with the finger's velocity
 *  carries it on and settles in as long as that takes.
 *
 *  The motion itself stays CSS (a transition or animation with a sampled `linear()` easing), so it runs on the
 *  compositor like any other transition. `linear()` needs Chrome 113 (WebView updates on its own on every Android
 *  version we ship to, but an old one is possible): there `springEasing` returns null and the caller keeps its curve. */

export interface Spring {
  /** Seconds the undamped spring takes for one swing (UIKit `response`); smaller = stiffer. */
  response: number
  /** 1 = no bounce; below 1 swings past the end and comes back. */
  damping: number
}

/** Pages and drawers: no bounce (against the screen edge it would show a gap). */
export const SPRING_PAGE: Spring = { response: 0.42, damping: 1 }
/** A list row's actions: a little give at the end, like a row in a native list. */
export const SPRING_ROW: Spring = { response: 0.36, damping: 0.78 }

/** Where a spring released at 0 with velocity `v0` (fractions of the way per second, + = toward 1) is at `t` seconds. */
export function springAt(t: number, v0: number, { response, damping }: Spring): number {
  const w = (2 * Math.PI) / response
  if (damping >= 1) return 1 + Math.exp(-w * t) * ((v0 - w) * t - 1)
  const wd = w * Math.sqrt(1 - damping * damping)
  return 1 + Math.exp(-damping * w * t) * (((v0 - damping * w) / wd) * Math.sin(wd * t) - Math.cos(wd * t))
}

/** The system's "remove animations" (Android: accessibility → remove animations). */
export function reducedMotion(): boolean {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

let supported: boolean | undefined
/** Can this WebView take a spring at all (`linear()` easing), and does the user want motion? */
export function springMotion(): boolean {
  if (reducedMotion()) return false
  if (supported === undefined) {
    try { supported = CSS.supports('transition-timing-function', 'linear(0, 1)') } catch { supported = false }
  }
  return supported
}

const FRAME = 1 / 60
const MAX_S = 1.2

/** A `linear()` easing and its length for that spring, sampled per frame until it has settled. `clamp` stops at the
 *  end the first time it gets there (a page meeting the screen edge stops; it does not swing past) and never goes
 *  back behind the start. `give` bounds the swing past the end (a fraction of the travel): a fast flick carries on
 *  into a soft wall instead of flying past. Null when
 *  `springMotion()` says no — the caller keeps whatever it did before. */
export function springEasing(v0: number, spring: Spring, opts: { clamp?: boolean; give?: number } = {}): { easing: string; ms: number } | null {
  if (!springMotion() || !Number.isFinite(v0)) return null
  // two input samples a hair apart make an absurd speed; nothing a finger does is faster than 60 travels a second
  v0 = Math.max(-60, Math.min(60, v0))
  // clamped (a page between two edges): a release moving away from the end would first swing back past where it was
  // let go — out of its bounds when that was near an edge. Such a release starts from rest instead.
  if (opts.clamp) v0 = Math.max(0, v0)
  const pts = [0]
  let t = 0
  let past = false
  while (t < MAX_S) {
    t += FRAME
    let x = springAt(t, v0, spring)
    if (opts.clamp && x >= 1) break
    if (Math.abs(1 - x) < 0.002 && Math.abs(springAt(t + FRAME, v0, spring) - x) < 0.001) break
    // past the end once, the swing is a soft wall: never more than `give` (of the travel) either side of it
    if (x >= 1) past = true
    if (past && opts.give) x = 1 + opts.give * Math.tanh((x - 1) / opts.give)
    pts.push(x)
  }
  pts.push(1)
  return { easing: `linear(${pts.map((x) => +x.toFixed(4)).join(', ')})`, ms: Math.max(16, Math.round(t * 1000)) }
}
