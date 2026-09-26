import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ExtendViewController, ExtendViewHandle } from '@lcl/engine'

/** Keep React context and drafts with the owner; the workbench owns the panel and its close lifecycle. */
export function AutomationExtension({ controller, open, title, onClose, children }: {
  controller?: ExtendViewController; open: boolean; title: string; onClose: () => void; children: ReactNode
}) {
  const [slot] = useState(() => document.createElement('div'))
  slot.className = 'auto-extension'
  const handle = useRef<ExtendViewHandle | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const titleRef = useRef(title)
  titleRef.current = title
  useEffect(() => {
    if (!controller || !open) return
    try {
      handle.current = controller.open({
        id: 'automation-context', title: () => titleRef.current,
        mount: (el) => { el.appendChild(slot); return () => slot.remove() },
        onClose: () => closeRef.current(),
      })
    } catch { closeRef.current() }
    return () => { handle.current?.close(); handle.current = null }
  }, [controller, open, slot])
  if (!open) return null
  return controller ? createPortal(children, slot) : <div className="auto-extension auto-extension-inline">{children}</div>
}
