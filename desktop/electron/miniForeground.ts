import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { helperSocketPath } from './computerUse'

export interface Point { x: number; y: number }
export interface Bounds extends Point { width: number; height: number }
export function foregroundSignalActive(raw: unknown, now: number): boolean {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  return r.v === 1 && typeof r.active === 'boolean' && Number.isInteger(r.helperPid) && Number(r.helperPid) > 0
    && typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) && r.updatedAt <= now + 100
    && now - r.updatedAt <= 2500 && typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt)
    && r.expiresAt > now && r.expiresAt - r.updatedAt <= (r.active ? 2500 : 350)
}

/** Reads only the helper's short-lived input signal; never launches it or requests a screenshot. */
export async function readComputerUseForeground(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    const raw = JSON.parse(await readFile(path.join(path.dirname(helperSocketPath()), 'foreground.json'), 'utf8'))
    if (!foregroundSignalActive(raw, Date.now())) return false
    try { process.kill(raw.helperPid, 0) } catch { return false }
    return true
  } catch { return false }
}

/** Where Mini sits until the user drags it: the work area's top-right corner. */
export function topRightPosition(size: { width: number; height: number }, work: Bounds, inset = 24): Point {
  return { x: work.x + work.width - size.width - inset, y: work.y + inset }
}

interface PassThroughWindow {
  isDestroyed(): boolean
  getBounds(): Bounds
  setIgnoreMouseEvents(ignore: boolean): void
}
const inside = (p: Point, b: Bounds): boolean => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height

/** While Computer Use drives the foreground, Mini lets clicks through to the app underneath —
 * except under the pointer, so the user can still grab and drag it out of the way.
 * ponytail: a CU hover (moveMouse) that rests on the card makes the card hittable for a click at
 * that same spot; upgrade to per-call pass-through from tool events if agents hit it. */
export function startMiniPassThrough(win: PassThroughWindow, deps: { active(): boolean; cursor(): Point }): () => void {
  let ignoring: boolean | null = null
  const apply = (next: boolean): void => {
    if (next === ignoring || win.isDestroyed()) return
    ignoring = next
    win.setIgnoreMouseEvents(next)
  }
  const tick = (): void => {
    if (!win.isDestroyed()) apply(deps.active() && !inside(deps.cursor(), win.getBounds()))
  }
  // 50ms: a pointer that just entered the card must be able to press within a human reaction time.
  const timer = setInterval(tick, 50)
  tick()
  return () => { clearInterval(timer); apply(false) }
}
