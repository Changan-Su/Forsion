import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Retain the child through both directions of a disclosure. Layout moves with it, not after it. */
export function StudioReveal({ open, children, className = '' }: { open: boolean; children: ReactNode; className?: string }) {
  const latest = useRef(children)
  const body = useRef<HTMLDivElement>(null)
  if (open) latest.current = children
  useLayoutEffect(() => {
    if (!open || !body.current) return
    body.current.querySelector<HTMLInputElement>('input:not([disabled])')?.focus({ preventScroll: true })
  }, [open])
  return <div className={`csu-reveal ${className}`} data-open={open} aria-hidden={!open} inert={!open}>
    <div ref={body} className="csu-reveal-body">{latest.current}</div>
  </div>
}
