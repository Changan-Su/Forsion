/** Upload progress, one look everywhere: a ring laid over a thumbnail / tile, or a 2px bar along a card's bottom edge.
 *  Presentational only: the host owns the upload, the wording and the shape around it (chat tile, note file card, tree row…).
 *  `value` is 0..1; `null` = the transport can't report bytes (local writes, relays) → the ring spins instead.
 *  Both stay invisible for the first 300ms (CSS), so quick reads and writes never flash. */
import React from 'react'
import './uploadProgress.css'

const R = 9

export function UploadRing({ value, size, className = '' }: { value: number | null; size?: number; className?: string }) {
  const off = value == null ? 70 : 100 - Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <svg
      className={`lcl-upring ${className}`}
      viewBox="0 0 24 24"
      style={size ? { width: size, height: size } : undefined}
      data-indeterminate={value == null ? '' : undefined}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : 100 - off}
    >
      <circle className="lcl-upring-track" cx="12" cy="12" r={R} />
      <circle className="lcl-upring-fill" cx="12" cy="12" r={R} pathLength={100} strokeDasharray={100} strokeDashoffset={off} />
    </svg>
  )
}

export function UploadBar({ value, className = '' }: { value: number | null; className?: string }) {
  const pct = value == null ? 30 : Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <span className={`lcl-upbar ${className}`} data-indeterminate={value == null ? '' : undefined} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value == null ? undefined : pct}>
      <i style={{ width: `${pct}%` }} />
    </span>
  )
}

/** The same ring for DOM-only hosts (ProseMirror widgets, plugin views without React). `set` updates it in place. */
export function createUploadRing(size?: number): { el: SVGSVGElement; set: (value: number | null) => void } {
  const NS = 'http://www.w3.org/2000/svg'
  const el = document.createElementNS(NS, 'svg')
  el.setAttribute('class', 'lcl-upring')
  el.setAttribute('viewBox', '0 0 24 24')
  el.setAttribute('role', 'progressbar')
  if (size) { el.style.width = `${size}px`; el.style.height = `${size}px` }
  const circle = (cls: string): SVGCircleElement => {
    const c = document.createElementNS(NS, 'circle')
    c.setAttribute('class', cls); c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', String(R))
    el.append(c)
    return c
  }
  circle('lcl-upring-track')
  const fill = circle('lcl-upring-fill')
  fill.setAttribute('pathLength', '100'); fill.setAttribute('stroke-dasharray', '100')
  const set = (value: number | null): void => {
    const off = value == null ? 70 : 100 - Math.round(Math.min(1, Math.max(0, value)) * 100)
    fill.setAttribute('stroke-dashoffset', String(off))
    if (value == null) el.setAttribute('data-indeterminate', '')
    else el.removeAttribute('data-indeterminate')
  }
  set(null)
  return { el, set }
}

/** Same bar for DOM-only hosts. */
export function createUploadBar(): { el: HTMLSpanElement; set: (value: number | null) => void } {
  const el = document.createElement('span')
  el.className = 'lcl-upbar'
  el.setAttribute('role', 'progressbar')
  const i = document.createElement('i')
  el.append(i)
  const set = (value: number | null): void => {
    i.style.width = `${value == null ? 30 : Math.round(Math.min(1, Math.max(0, value)) * 100)}%`
    if (value == null) el.setAttribute('data-indeterminate', '')
    else el.removeAttribute('data-indeterminate')
  }
  set(null)
  return { el, set }
}
