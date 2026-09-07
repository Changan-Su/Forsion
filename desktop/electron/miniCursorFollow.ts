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

export function cursorPanelTarget(cursor: Point, size: Bounds, work: Bounds): Point {
  const gap = 24
  const right = cursor.x + gap
  const below = cursor.y + gap
  const x = right + size.width <= work.x + work.width ? right : cursor.x - size.width - gap
  const y = below + size.height <= work.y + work.height ? below : cursor.y - size.height - gap
  return { x: Math.round(Math.max(work.x, Math.min(x, work.x + Math.max(0, work.width - size.width)))),
    y: Math.round(Math.max(work.y, Math.min(y, work.y + Math.max(0, work.height - size.height)))) }
}

/** Constant speed along the straight line; no easing, spring, or native animated setBounds. */
export function linearCursorStep(from: Point, to: Point, elapsedMs: number, speed = 2400): Point {
  const dx = to.x - from.x, dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  const travel = speed * Math.max(0, Math.min(64, elapsedMs)) / 1000
  const ratio = distance ? Math.min(1, travel / distance) : 0
  return { x: from.x + dx * ratio, y: from.y + dy * ratio }
}

interface MiniWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  getBounds(): Bounds
  setPosition(x: number, y: number, animate?: boolean): void
  setIgnoreMouseEvents(ignore: boolean): void
}
interface FollowDeps {
  readActive(): Promise<boolean>
  cursor(): Point
  workArea(cursor: Point): Bounds
  onFollowing(following: boolean): void
}
export function startMiniCursorFollow(win: MiniWindow, deps: FollowDeps): () => void {
  let stopped = false, checking = false, active = false, following = false
  let position: Point | null = null, target: Point | null = null
  let last = performance.now()
  const setFollowing = (value: boolean): void => {
    if (following === value) return
    following = value
    if (!win.isDestroyed()) win.setIgnoreMouseEvents(value)
    deps.onFollowing(value)
  }
  const sample = async (): Promise<void> => {
    if (checking || stopped) return
    checking = true
    try { const next = await deps.readActive(); if (!stopped) active = next }
    catch { active = false }
    finally { checking = false }
  }
  const poll = setInterval(() => void sample(), 60)
  const motion = setInterval(() => {
    if (stopped || win.isDestroyed()) return
    const now = performance.now(), dt = now - last
    last = now
    if (!win.isVisible()) { active = false; position = target = null; setFollowing(false); return }
    if (active) {
      if (!following) { position = win.getBounds(); setFollowing(true) }
      const cursor = deps.cursor()
      target = cursorPanelTarget(cursor, win.getBounds(), deps.workArea(cursor))
    }
    if (!following || !position || !target) return
    position = linearCursorStep(position, target, dt)
    win.setPosition(Math.round(position.x), Math.round(position.y), false)
    if (!active && Math.hypot(position.x - target.x, position.y - target.y) < 1) {
      setFollowing(false); position = target = null
    }
  }, 16)
  void sample()
  return () => { stopped = true; clearInterval(poll); clearInterval(motion); setFollowing(false) }
}
