import { useId, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DialogOverlay } from '@amadeus/components/DialogOverlay'
import { useEscape } from '@amadeus/components/Dialogs'
import './vaultLandingMessages'
import './vaultLanding.css'

export function VaultLandingDialog({ kind, title, onClose, onSubmit, children }: {
  kind: 'download' | 'new' | 'stop'
  title: string
  onClose: () => void
  onSubmit?: () => void
  children: ReactNode
}) {
  const titleId = useId()
  useEscape(onClose)
  function submit(e: FormEvent) {
    e.preventDefault()
    onSubmit?.()
  }
  return createPortal(
    <div className="am-app tangu-lovable vault-landing-host">
      <DialogOverlay onMouseDown={onClose}>
        <form data-vault-landing={kind} className={`dialog vault-landing ${kind === 'stop' ? 'un-dlg' : ''}`} onSubmit={submit}
          role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
          <div className="dialog-title" id={titleId}>{title}</div>
          {children}
        </form>
      </DialogOverlay>
    </div>, document.body,
  )
}
