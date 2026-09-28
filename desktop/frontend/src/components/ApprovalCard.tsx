/**
 * host-exec 审批卡片(approval_request 事件 → 内嵌聊天流;run_bash 命令可编辑后批准)。
 * 文件修改类工具批准前渲染 diff 预览(B4:破坏发生前可见)。已兑现(approval_result/410)置灰。
 *
 * 远端来路(设备页 window.tangu.remoteCaller;P1-K6 起还有手机把整端切到「我的电脑」):引擎拒收远端改参数(C9 → 400 REMOTE_ARGS_OVERRIDE_FORBIDDEN)、把「总允许」
 * 降成单次批准,所以这里命令只读、不给「总允许」—— 否则改了命令点批准什么都不发生,点「总允许」实际只批一次(Codex 终审 F#2)。
 *
 * 来源行(P1 · K1):远程会话发起的审批在标题下写「来自远程会话 · 设备名」(调用方经 hub → 本机 unitWeb 验过)或按来路写
 * 「账号下未识别的客户端 / 局域网配对设备 / 点对点直连」。本机 run 不带 remote,不显示。设备名是不可信串,只进文本节点。
 */
import React, { useMemo, useState } from 'react'
import { ShieldQuestion, Check, CheckCheck, X } from 'lucide-react'
import type { ApprovalRequest } from '../types'
import { DiffView } from './DiffView'
import { toolDiffText } from './toolDiff'
import { registerMessages, useI18n } from '../i18n'
import { alwaysAllowWorks, answeredByText, approvalReasonText, approvalRemoteText, MODE_KEY } from '../approvalReason'
import { capsForRef } from '../services/engine/targetCaps'
import { refForSession } from '../services/engine/targets'

export { MODE_KEY }

registerMessages({
  'approval.remoteReadOnly': {
    zh: '远程连接下只能原样批准或拒绝，要改命令请在那台设备本机上操作',
    en: 'Over a remote connection you can only approve or reject as is. To change the command, use that device itself',
  },
  // P1-K1:审批卡来源行
  'approval.remote.caller': { zh: '来自远程会话 · {name}', en: 'From a remote session · {name}' },
  'approval.remote.device': { zh: '来自远程会话 · 已登记设备', en: 'From a remote session · a registered device' },
  'approval.remote.account': { zh: '来自远程会话 · 账号下未识别的客户端', en: 'From a remote session · an unidentified client on your account' },
  'approval.remote.lan': { zh: '来自远程会话 · 局域网配对设备', en: 'From a remote session · a LAN-paired device' },
  'approval.remote.p2p': { zh: '来自远程会话 · 点对点直连', en: 'From a remote session · a peer-to-peer connection' },
  'approval.remote.unknown': { zh: '来自远程会话', en: 'From a remote session' },
  // P1-K3:受保护项只在本机批准 + 收起时「在哪答的」
  'approval.localOnly': {
    zh: '这项操作涉及受保护的配置，只能在执行它的电脑上批准',
    en: 'This touches protected configuration and can only be approved on the computer running it',
  },
  'approval.byHost': { zh: '在执行的电脑上', en: 'on the host computer' },
  'approval.byDevice': { zh: '在 {device} 上', en: 'on {device}' },
  'approval.byRegisteredDevice': { zh: '在已登记设备上', en: 'on a registered device' },
  'approval.byOther': { zh: '在另一台设备上', en: 'on another device' },
  'approval.byChannel': { zh: '经消息通道', en: 'via a messaging channel' },
})

/** P1-K3:本页点过决定的审批 id(托盘与内嵌两处渲染同一张卡,状态放模块级)。收起后「在哪答的」对答复方自己不写。 */
const decidedHere = new Set<string>()

/** 这张审批卡所属会话的引擎是以远端身份被驱动的(设备页 x-forsion-remote / 手机经 hub 打「我的电脑」):
 *  审批改参数 / 总允许都不兑现(C9)。P1-K6(INTEGRATION R-31):按会话所在的目标求值 ——
 *  `targetCaps(targetForSession(sid)).remoteApprover`;设备页里 home 目标的 remoteApprover 仍按 window.tangu.remoteCaller。
 *  不铸目标(refForSession + capsForRef),没装引擎宿主的单测里也能判。 */
export const isRemoteApprover = (sessionId?: string): boolean => capsForRef(refForSession(sessionId)).remoteApprover

export const ApprovalCard: React.FC<{
  req: ApprovalRequest
  onDecide: (action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => void
  /** P1-K6:这张卡属于哪个会话(远端判定按会话所在的目标);缺省 = 焦点(S2 整端切换下两者相同)。 */
  sessionId?: string
}> = ({ req, onDecide, sessionId }) => {
  const { t } = useI18n()
  const remote = isRemoteApprover(sessionId)
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
  const source = approvalRemoteText(req.remote, t as (k: string, v?: Record<string, unknown>) => string)

  // P1-K3:受保护路径的审批只能在执行它的电脑上批准 —— 远端页不给「批准 / 总允许」(引擎也会 403),「拒绝」照留。
  const approveHere = !(req.localOnly && remote)
  const answeredWhere = resolved
    ? answeredByText(req.answeredBy, { remotePage: remote, answeredHere: decidedHere.has(req.approvalId) }, t as (k: string, v?: Record<string, unknown>) => string)
    : ''

  const decide = (action: 'approve' | 'approve_always' | 'reject') => {
    if (resolved) return
    if (action !== 'reject' && !approveHere) return
    decidedHere.add(req.approvalId)
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
            {answeredWhere && <span data-answered-by> · {answeredWhere}</span>}
          </span>
        )}
      </div>
      {/* B3「为什么问你」:判定分支在引擎里已经算过,不带出来客户端只能猜(尤其猜不到生效档)。
          注意这是**规则判定理由**,不是 Claude Code 那种模型生成的安全性论证 —— 便宜、且糊弄不了。 */}
      {source && <div className="approval-why" data-approval-remote>{source}</div>}
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
          {remote && !resolved && approveHere && <div className="approval-why" data-remote-readonly>{t('approval.remoteReadOnly')}</div>}
          {!resolved && !approveHere && <div className="approval-why" data-local-only>{t('approval.localOnly')}</div>}
        </>
      )}
      {!resolved && (
        <div className="approval-actions">
          {approveHere && (
            <button className="btn primary sm" onClick={() => decide('approve')}>
              <Check size={13} /> {t('approval.approve')}
            </button>
          )}
          {alwaysWorks && approveHere && (
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
