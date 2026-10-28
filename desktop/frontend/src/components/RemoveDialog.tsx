import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ConfirmDialog } from '@amadeus/components/Dialogs'

/** 移除确认(项目):正文说清会发生什么,`filesLabel` 给了才出「同时删除相关文件」勾选项(缺省不勾)。
 *  外壳复用 Amadeus 的 ConfirmDialog:.dialog-* 样式挂在 .am-app 下 → display:contents 载体,.tangu-lovable = 取色桥;
 *  挂到 body,不被侧栏的堆叠上下文裁掉。 */
export function RemoveDialog({ title, message, confirmLabel, filesLabel, onConfirm, onClose }: {
  title: string
  message: string
  confirmLabel: string
  filesLabel?: string
  onConfirm: (deleteFiles: boolean) => void
  onClose: () => void
}) {
  const [deleteFiles, setDeleteFiles] = useState(false)
  return createPortal(
    <div className="am-app tangu-lovable" style={{ display: 'contents' }} data-remove-dialog>
      <ConfirmDialog title={title} message={message} confirmLabel={confirmLabel} onConfirm={() => onConfirm(!!filesLabel && deleteFiles)} onClose={onClose}>
        {filesLabel && <label className="dialog-check"><input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} /><span>{filesLabel}</span></label>}
      </ConfirmDialog>
    </div>,
    document.body,
  )
}
