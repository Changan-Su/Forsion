import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { OverlayAt } from '@lcl/engine'
import { Copy, Scissors, CopyPlus, ClipboardPaste, Trash2, Undo2, Redo2, FileText, ArrowLeft } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { canRedoCalendarEdit, canUndoCalendarEdit } from './eventActions'

registerMessages({
  'calevmenu.copy': { zh: '复制', en: 'Copy' },
  'calevmenu.cut': { zh: '剪切', en: 'Cut' },
  'calevmenu.clone': { zh: '克隆', en: 'Clone' },
  'calevmenu.paste': { zh: '粘贴', en: 'Paste' },
  'calevmenu.delete': { zh: '删除', en: 'Delete' },
  'calevmenu.undo': { zh: '撤销', en: 'Undo' },
  'calevmenu.redo': { zh: '重做', en: 'Redo' },
  'calevmenu.summary': { zh: '复制摘要', en: 'Copy summary' },
  'calevmenu.back': { zh: '返回详情', en: 'Back to details' },
  'calevmenu.readonly': { zh: '此来源只支持查看和复制摘要。', en: 'This source supports viewing and copying a summary.' },
  'calevmenu.fixedTime': { zh: '系统时间属性不可移动。', en: 'System time properties cannot be moved.' },
  'calevmenu.note': { zh: '此事件关联笔记文件，删除时需确认。', en: 'This event is a note file. Deletion requires confirmation.' },
})
export type EventCommand = 'copy' | 'cut' | 'clone' | 'paste' | 'delete' | 'undo' | 'redo' | 'summary'
const icons = { copy: Copy, cut: Scissors, clone: CopyPlus, paste: ClipboardPaste, delete: Trash2, undo: Undo2, redo: Redo2, summary: FileText }
const keys: Partial<Record<EventCommand, string>> = { copy: 'C', cut: 'X', clone: 'D', paste: 'V', undo: 'Z', redo: '⇧Z', delete: 'Del' }
export function EventMenu({ at, mobile, writable, note, hasClip, onRun, onClose, hasEvent = true, canCut = true }: {
  at: { x: number; y: number }; mobile: boolean; writable: boolean; note: boolean; hasClip: boolean;
  onRun: (action: EventCommand) => void; onClose: () => void;
  hasEvent?: boolean;
  canCut?: boolean;
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    const dismiss = (e: Event): void => { if (!ref.current?.contains(e.target as Node)) onClose() }
    if (!mobile) window.addEventListener('pointerdown', dismiss)
    return () => window.removeEventListener('pointerdown', dismiss)
  }, [])
  const actions: EventCommand[] = !hasEvent ? ['paste', 'undo', 'redo'] : writable ? ['copy', 'cut', 'clone', 'paste', 'summary', 'delete', 'undo', 'redo'] : ['summary']
  const body = <div ref={ref} className={`amx-cal-eventmenu${mobile ? ' phone' : ''}`} role="menu" onKeyDown={(e) => {
    if (e.key === 'Escape' || (mobile && e.key === 'ArrowLeft')) { e.preventDefault(); e.stopPropagation(); onClose(); return }
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  }}>
    {mobile && <button role="menuitem" onClick={onClose}><ArrowLeft size={16} />{t('calevmenu.back')}</button>}
    {hasEvent && (!writable || note) && <p>{t(note ? 'calevmenu.note' : 'calevmenu.readonly')}</p>}
    {actions.map((action) => { const Icon = icons[action]; return <button key={action} role="menuitem" aria-label={t(`calevmenu.${action}`)} className={action === 'delete' ? 'danger' : ''}
      title={action === 'cut' && !canCut ? t('calevmenu.fixedTime') : undefined}
      disabled={(action === 'cut' && !canCut) || (action === 'paste' && !hasClip) || (action === 'undo' && !canUndoCalendarEdit()) || (action === 'redo' && !canRedoCalendarEdit())} onClick={() => onRun(action)}>
      <Icon size={16} /><span>{t(`calevmenu.${action}`)}</span>{!mobile && keys[action] && <kbd aria-hidden="true">{action === 'delete' ? 'Del' : `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}${keys[action]}`}</kbd>}
    </button> })}
  </div>
  return mobile ? body : createPortal(<OverlayAt x={at.x} y={at.y} className="ctx-menu amx-cal-menu-position">{body}</OverlayAt>, document.body)
}
