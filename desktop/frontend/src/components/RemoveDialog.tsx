import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ConfirmDialog } from '@amadeus/components/Dialogs'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import type { NormalAgentDef } from '../types'

registerMessages({
  'agentRemove.title': { zh: '删除 Agent「{name}」？', en: 'Delete agent "{name}"?' },
  'agentRemove.msg': { zh: '会从 Agent 名册和侧栏移除，历史私聊保留（只读）。它的记忆与 Library 默认保留在 Tangu 数据目录的 agents/.removed/ 里。', en: 'It is removed from the agent roster and the sidebar; past direct chats are kept (read-only). By default its memory and Library are kept in agents/.removed/ in the Tangu data folder.' },
  'agentRemove.msgCloud': { zh: '会从 Agent 名册移除，历史会话保留（只读）。', en: 'It is removed from the agent roster; past sessions are kept (read-only).' },
  'agentRemove.files': { zh: '同时删除相关文件：它的记忆、Library 等，移到废纸篓', en: 'Also delete related files: its memory, Library and the rest, moved to the Trash' },
  'agentRemove.confirm': { zh: '删除', en: 'Delete' },
  'agentRemove.done': { zh: '已删除 Agent「{name}」', en: 'Agent "{name}" deleted' },
})

/** 移除确认(项目 / Agent 共用):正文说清会发生什么,`filesLabel` 给了才出「同时删除相关文件」勾选项(缺省不勾)。
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

/** 删除 Agent 的确认(侧栏 Agent 行与 Agents 名册共用)。本机 Agent 才有「同时删除相关文件」:云端 Agent 没有本机文件,给了勾选框等于骗人。 */
export function AgentRemoveDialog({ agent, onDone, onClose }: { agent: NormalAgentDef; onDone?: () => void; onClose: () => void }) {
  const { t } = useI18n()
  const local = !!agent.libraryDir
  const name = agent.name || agent.slug
  return <RemoveDialog
    title={t('agentRemove.title', { name })}
    message={t(local ? 'agentRemove.msg' : 'agentRemove.msgCloud')}
    confirmLabel={t('agentRemove.confirm')}
    filesLabel={local && window.tangu?.trashHostPath ? t('agentRemove.files') : undefined}
    onConfirm={(deleteFiles) => {
      const app = useApp.getState()
      void app.removeAgent(agent, deleteFiles)
        .then(() => { app.toast(t('agentRemove.done', { name })); onDone?.() })
        .catch((e: any) => app.toast(String(e?.message || e), true))
    }}
    onClose={onClose}
  />
}
