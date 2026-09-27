/**
 * host-exec 审批卡片(approval_request 事件 → 内嵌聊天流;run_bash 命令可编辑后批准)。
 * 文件修改类工具批准前渲染 diff 预览(B4:破坏发生前可见)。已兑现(approval_result/410)置灰。
 *
 * 设备页(远端来路,window.tangu.remoteCaller):引擎拒收远端改参数(C9 → 400 REMOTE_ARGS_OVERRIDE_FORBIDDEN)、把「总允许」
 * 降成单次批准,所以这里命令只读、不给「总允许」—— 否则改了命令点批准什么都不发生,点「总允许」实际只批一次(Codex 终审 F#2)。
 */
import React, { useMemo, useState } from 'react'
import { ShieldQuestion, Check, CheckCheck, X } from 'lucide-react'
import type { ApprovalRequest } from '../types'
import { DiffView } from './DiffView'
import { toolDiffText } from './toolDiff'
import { registerMessages, useI18n } from '../i18n'
import { alwaysAllowWorks, approvalReasonText, MODE_KEY } from '../approvalReason'

export { MODE_KEY }

registerMessages({
  'approval.remoteReadOnly': {
    zh: '远程连接下只能原样批准或拒绝，要改命令请在那台设备本机上操作',
    en: 'Over a remote connection you can only approve or reject as is. To change the command, use that device itself',
  },
})

/** 本页驱动的是别的设备的引擎、且以远端身份(x-forsion-remote)调用:审批改参数 / 总允许都不兑现。 */
export const isRemoteApprover = (): boolean => typeof window !== 'undefined' && !!window.tangu?.remoteCaller

export const ApprovalCard: React.FC<{
  req: ApprovalRequest
  onDecide: (action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => void
}> = ({ req, onDecide }) => {
  const { t } = useI18n()
  const remote = isRemoteApprover()
  const isBash = req.name === 'run_bash'
  const initialCmd = (() => {
    if (!isBash || !req.arguments) return ''
    try { return String(JSON.parse(req.arguments).command ?? '') } catch { return '' }
  })()
  const [cmd, setCmd] = useState(initialCmd)
  const resolved = req.status !== 'pending'
  const diff = useMemo(() => (isBash ? null : toolDiffText(req.name, req.arguments)), [isBash, req.name, req.arguments])

  // 「总允许」对 escalate / custom-ask / protected 无效(引擎不落),按钮不给 —— 规则见 approvalReason.ts。
  const alwaysWorks = alwaysAllowWorks(req.reason) && !remote
  const why = approvalReasonText(req.reason, t as (k: string, v?: Record<string, unknown>) => string)

  const decide = (action: 'approve' | 'approve_always' | 'reject') => {
    if (resolved) return
    const argsOverride = isBash && !remote && cmd.trim() && cmd !== initialCmd ? { command: cmd } : undefined
    onDecide(action, action === 'reject' ? undefined : argsOverride)
  }

  return (
    <div className={`approval-card${resolved ? ' resolved' : ''}`}>
      <div className="approval-title">
        <ShieldQuestion size={15} style={{ color: 'var(--accent-ink)' }} />
        {t('approval.requestExec', { name: req.name })}
        {resolved && (
          <span style={{ fontWeight: 400, fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-faint)' }}>
            {req.status === 'approved' ? t('approval.statusApproved') : req.status === 'rejected' ? t('approval.statusRejected') : t('approval.statusExpired')}
          </span>
        )}
      </div>
      {/* B3「为什么问你」:判定分支在引擎里已经算过,不带出来客户端只能猜(尤其猜不到生效档)。
          注意这是**规则判定理由**,不是 Claude Code 那种模型生成的安全性论证 —— 便宜、且糊弄不了。 */}
      {why && <div className="approval-why">{why}</div>}
      {isBash && !resolved && !remote ? (
        <textarea
          className="approval-edit"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          rows={Math.min(6, Math.max(1, cmd.split('\n').length))}
          spellCheck={false}
        />
      ) : (
        <>
          {/* preview 恒显:它是「⚠ 工作区外写入」等升级警示的唯一载体(引擎 approvals.ts 拼进字符串),diff 只能附加不能替换 */}
          <div className="approval-preview">{req.preview}</div>
          {diff && <div className="approval-diff"><DiffView text={diff} side={false} /></div>}
          {remote && !resolved && <div className="approval-why" data-remote-readonly>{t('approval.remoteReadOnly')}</div>}
        </>
      )}
      {!resolved && (
        <div className="approval-actions">
          <button className="btn primary sm" onClick={() => decide('approve')}>
            <Check size={13} /> {t('approval.approve')}
          </button>
          {alwaysWorks && (
            <button className="btn ghost sm" onClick={() => decide('approve_always')}>
              <CheckCheck size={13} /> {t('approval.approveAlways')}
            </button>
          )}
          <button className="btn danger sm" onClick={() => decide('reject')}>
            <X size={13} /> {t('approval.reject')}
          </button>
        </div>
      )}
    </div>
  )
}
