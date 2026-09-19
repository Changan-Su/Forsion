import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'

/** Web fallback for Floating Panel. Deliberately fixed/non-draggable; desktop uses an OS window. */
export function FloatingPanelFrame({ title, onClose, children, compact = false }: {
  title: string
  onClose: () => void
  children: ReactNode
  compact?: boolean
}) {
  return <motion.div className="floating-panel-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    transition={{ duration: 0.18 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <motion.section className={`floating-panel-window${compact ? ' compact' : ''}`} role="dialog" aria-modal="true" aria-label={title}
      initial={{ opacity: 0, scale: .975, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: 8 }}
      transition={{ duration: .2, ease: [0.2, 0.8, 0.2, 1] }}>
      <header className="floating-panel-chrome"><span>{title}</span><button className="icon-btn" onClick={onClose} aria-label={title}><X size={16} /></button></header>
      <div className="floating-panel-content">{children}</div>
    </motion.section>
  </motion.div>
}
