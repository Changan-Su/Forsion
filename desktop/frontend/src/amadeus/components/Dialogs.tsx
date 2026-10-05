// Small modal dialogs for file-management flows: confirm (delete), prompt (folder name),
// and folder picker (move a page). They share the .dialog-* styles.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { nativeSheetPresenter, presentNativeConfirm } from '@lcl/engine'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'amdlg.delete': { zh: '删除', en: 'Delete' },
  'amdlg.cancel': { zh: '取消', en: 'Cancel' },
  'amdlg.confirm': { zh: '确定', en: 'OK' },
  'amdlg.rootFolder': { zh: '（根目录）', en: '(Root folder)' },
  'amdlg.noOtherFolders': { zh: '没有其它可移动到的文件夹', en: 'No other folders to move to' },
})

export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = true,
  onConfirm,
  onClose,
  children,
}: {
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
  /** 正文与按钮之间的附加内容(如移除确认里的「同时删除相关文件」勾选项)。 */
  children?: ReactNode
}) {
  useEscape(onClose)
  const { t } = useI18n()
  const titleId = useId()
  // Android 原生半屏确认(lcl nativeSheet 的可选宿主)。带附加内容(勾选项等)的确认原生层画不了,保持 Web;
  // 宿主缺席或呈现失败同样回落 Web 对话框。
  const plain = children === undefined || children === null || children === false || children === ''
  const [web, setWeb] = useState(() => !(plain && nativeSheetPresenter()))
  const latest = useRef({ onConfirm, onClose })
  latest.current = { onConfirm, onClose }
  const confirmText = confirmLabel ?? t('amdlg.delete')
  const cancelText = t('amdlg.cancel')
  useEffect(() => {
    if (web) return
    const ctl = new AbortController()
    void presentNativeConfirm({ title, message, confirm: confirmText, cancel: cancelText, danger }, ctl.signal).then((out) => {
      if (ctl.signal.aborted) return
      if (!out.handled) { setWeb(true); return }
      if (out.value) latest.current.onConfirm()
      latest.current.onClose()
    })
    return () => ctl.abort()
  }, [web, title, message, confirmText, cancelText, danger])
  if (!web) return null
  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title" id={titleId}>{title}</div>
        {message && <div className="dialog-msg">{message}</div>}
        {children}
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={onClose}>
            {t('amdlg.cancel')}
          </button>
          <button
            className="dialog-btn"
            data-danger={danger || undefined}
            data-primary={!danger || undefined}
            autoFocus
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmLabel ?? t('amdlg.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function PromptDialog({
  title,
  label,
  initial = '',
  confirmLabel,
  altLabel,
  onAlt,
  onConfirm,
  onClose,
}: {
  title: string
  label?: string
  initial?: string
  confirmLabel?: string
  /** 次要出口(如「移除链接」):靠左单列,不经输入框的值。缺省不出。 */
  altLabel?: string
  onAlt?: () => void
  onConfirm: (value: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [value, setValue] = useState(initial)
  const submit = (): void => {
    const v = value.trim()
    // 先 confirm 后 close:命令式包装(askString)在 close 里兜「取消」,顺序反了会把确定误判成取消
    if (v) onConfirm(v)
    onClose()
  }
  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        {label && <div className="dialog-msg">{label}</div>}
        <input
          className="dialog-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
        />
        <div className="dialog-actions">
          {altLabel && onAlt && (
            <button className="dialog-btn" data-alt onClick={() => { onAlt(); onClose() }}>
              {altLabel}
            </button>
          )}
          <button className="dialog-btn" onClick={onClose}>
            {t('amdlg.cancel')}
          </button>
          <button className="dialog-btn" data-primary onClick={submit}>
            {confirmLabel ?? t('amdlg.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function FolderPickerDialog({
  title,
  folders,
  currentFolder,
  onPick,
  onClose,
}: {
  title: string
  folders: string[]
  currentFolder: string
  onPick: (folder: string) => void
  onClose: () => void
}) {
  useEscape(onClose)
  const { t } = useI18n()
  const options = ['', ...folders].filter((f) => f !== currentFolder)
  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-list">
          {options.map((f) => (
            <button
              key={f || '/'}
              className="dialog-listitem"
              onClick={() => {
                onClose()
                onPick(f)
              }}
            >
              {f === '' ? t('amdlg.rootFolder') : f}
            </button>
          ))}
          {options.length === 0 && <div className="dialog-msg">{t('amdlg.noOtherFolders')}</div>}
        </div>
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={onClose}>
            {t('amdlg.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
