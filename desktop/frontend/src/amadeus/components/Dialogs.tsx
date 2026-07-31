// Small modal dialogs for file-management flows: confirm (delete), prompt (folder name),
// and folder picker (move a page). They share the .dialog-* styles.

import { useEffect, useState } from 'react'

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
  confirmLabel = '删除',
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  useEscape(onClose)
  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        {message && <div className="dialog-msg">{message}</div>}
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={onClose}>
            取消
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
            {confirmLabel}
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
  confirmLabel = '确定',
  onConfirm,
  onClose,
}: {
  title: string
  label?: string
  initial?: string
  confirmLabel?: string
  onConfirm: (value: string) => void
  onClose: () => void
}) {
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
          <button className="dialog-btn" onClick={onClose}>
            取消
          </button>
          <button className="dialog-btn" data-primary onClick={submit}>
            {confirmLabel}
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
              {f === '' ? '（根目录）' : f}
            </button>
          ))}
          {options.length === 0 && <div className="dialog-msg">没有其它可移动到的文件夹</div>}
        </div>
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
