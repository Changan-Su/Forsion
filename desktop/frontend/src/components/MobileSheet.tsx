import React from 'react'
import { X } from 'lucide-react'
import { useI18n } from '../i18n'
import './mobileSheet.css'

export function MobileSheet({ title, onClose, scrimProps, className, children, footer, focusClose }: {
  title: string
  onClose(): void
  scrimProps?: React.HTMLAttributes<HTMLDivElement> & { [attr: `data-${string}`]: string }
  className?: string
  children: React.ReactNode
  footer?: React.ReactNode
  focusClose?: boolean
}) {
  const { t } = useI18n()
  return (
    <div {...scrimProps} className="mb-sheet-scrim us-scrim" onClick={onClose}>
      <div className={`mb-sheet us-sheet${className ? ` ${className}` : ''}`}
        role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()} onKeyDown={focusClose ? (e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          onClose()
        } : undefined}>
        <div className="mb-sheet-grip" />
        <div className="us-head">
          <span className="us-head-title">{title}</span>
          <button type="button" className="us-icon-btn" aria-label={t('common.close')} autoFocus={focusClose} onClick={onClose}><X size={18} /></button>
        </div>
        <div className="us-body">{children}</div>
        {footer}
      </div>
    </div>
  )
}
