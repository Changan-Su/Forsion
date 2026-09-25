/**
 * host-exec 审批卡片(approval_request 事件 → 内嵌聊天流;run_bash 命令可编辑后批准)。
 * 文件修改类工具批准前渲染 diff 预览(B4:破坏发生前可见)。已兑现(approval_result/410)置灰。
 */
import React, { useMemo, useState } from 'react'
import { ShieldQuestion, Check, CheckCheck, X } from 'lucide-react'
import type { ApprovalRequest } from '../types'
import { DiffView } from './DiffView'
import { toolDiffText } from './toolDiff'
import { useI18n } from '../i18n'

/** 档位 id 是连字符(引擎口径),i18n 键是驼峰(既有) —— 映射写一处,别两边各拼各的。
 *  名字直接用输入框审批药丸的那套键(询问我批准 / 替我批准 / 完全放行):同一屏上药丸与审批卡的「为什么问你」
 *  曾各叫一套(只读 / 自动编辑 / 全自动),一个档两个名字。引擎侧同名表 = commandCatalog 的 APPROVAL_MODE_META。 */
export const MODE_KEY: Record<string, string> = {
  readonly: 'input.approval.readonly',
  'auto-edit': 'input.approval.autoEdit',
  'full-auto': 'input.approval.fullAuto',
}

export const ApprovalCard: React.FC<{
  req: ApprovalRequest
  onDecide: (action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => void
}> = ({ req, onDecide }) => {
  const { t } = useI18n()
  const isBash = req.name === 'run_bash'
  const initialCmd = (() => {
    if (!isBash || !req.arguments) return ''
    try { return String(JSON.parse(req.arguments).command ?? '') } catch { return '' }
  })()
  const [cmd, setCmd] = useState(initialCmd)
  const resolved = req.status !== 'pending'
  const diff = useMemo(() => (isBash ? null : toolDiffText(req.name, req.arguments)), [isBash, req.name, req.arguments])

  // 引擎在这三种情形下**不会**把工具记进「总允许」(approvals.ts 明写:越界写每次都确认,
  // custom 的 ask 是用户写死的「永远问我」,控制面(建无人值守工作)点了「总允许」也只算批准一次)。
  // 按钮却照常显示 = 又一处「界面说一套引擎做一套」。
  const kind = req.reason?.kind
  const alwaysWorks = kind !== 'escalate' && kind !== 'custom-ask' && kind !== 'control'
  const why = (() => {
    const r = req.reason
    if (!r) return ''
    const m = r.mode && MODE_KEY[r.mode] ? t(MODE_KEY[r.mode] as any) : ''
    if (r.kind === 'custom-ask') return t('approval.why.customAsk', { rule: r.rule || '' })
    if (r.kind === 'escalate') return t('approval.why.escalate')
    // 控制面不拼档位:沙箱会话的控制面调用带的是 full-auto(缺省档),写出来就成了「完全放行下仍要你批」
    if (r.kind === 'control') return t('approval.why.control')
    return m ? t('approval.why.mode', { mode: m }) : ''
  })()

  const decide = (action: 'approve' | 'approve_always' | 'reject') => {
    if (resolved) return
    const argsOverride = isBash && cmd.trim() && cmd !== initialCmd ? { command: cmd } : undefined
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
      {isBash && !resolved ? (
        <textarea
          className="approval-edit"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          rows={Math.min(6, Math.max(1, cmd.split('\n').length))}
          spellCheck={false}
        />
      ) : (
        <>
          {/* preview 恒显:引擎把越界警示(英文「⚠ Write outside the workspace · 」)与控制面要害(建什么、到点无人值守跑什么)
              拼进这个字符串;本地化的原因走上面的 why 行。旧事件没有 reason 时它仍是唯一的警示载体,diff 只能附加不能替换 */}
          <div className="approval-preview">{req.preview}</div>
          {diff && <div className="approval-diff"><DiffView text={diff} side={false} /></div>}
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
