/**
 * 审批托盘:待批的审批攒在输入框上方(借 Claude Code / Codex),不再插在聊天流里打断阅读。
 * 状态不搬家 —— 审批仍挂在各自的消息上(持久化回放 / decideApproval / turn_boundary 的 keep 都钉在那),
 * 托盘只是「本会话所有 pending」的另一个视图:选中的一张(缺省最早那张)展开可批,其余缩成一行,点哪行展开哪行。
 * 排队行在上、展开的卡在下(贴着输入框):卡带长 diff 时排队的几张仍一眼可见,不被挤进滚动区。
 */
import { useEffect, useState } from 'react'
import { ChevronDown, ShieldQuestion } from 'lucide-react'
import { ApprovalCard } from '../../components/ApprovalCard'
import { registerMessages, useI18n } from '../../i18n'
import type { PendingApproval } from './approvalQueue'

registerMessages({
  'approval.tray.title': { zh: '等你批准 · {n}', en: 'Waiting for your approval · {n}' },
  'approval.tray.label': { zh: '待批准的操作', en: 'Actions waiting for approval' },
})

const ARM_MS = 350

export function ApprovalTray({ items, onDecide }: {
  items: PendingApproval[]
  onDecide: (messageId: string, approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => void
}) {
  const { t } = useI18n()
  const [openId, setOpenId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const cur = items.find((i) => i.req.approvalId === openId) ?? items[0]
  // 换卡冷却:批完一张,下一张原地顶上来 —— 连点两下「批准」不能把没看过的下一张也批了。
  // 展开的卡一换(含新出现),按钮先不接收点击,ARM_MS 后才生效。
  const curId = cur?.req.approvalId
  const [armedId, setArmedId] = useState<string | undefined>(undefined)
  useEffect(() => {
    const timer = setTimeout(() => setArmedId(curId), ARM_MS)
    return () => clearTimeout(timer)
  }, [curId])
  if (!cur) return null
  return (
    <div className="t2c-apv" role="region" aria-label={t('approval.tray.label')} data-approval-tray={items.length}>
      <button type="button" className="t2c-apv-head" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>
        <ShieldQuestion size={13} className="t2c-apv-ic" />
        <span className="t2c-apv-title">{t('approval.tray.title', { n: items.length })}</span>
        <ChevronDown size={13} className={`t2c-apv-chev${collapsed ? ' is-collapsed' : ''}`} />
      </button>
      {!collapsed && items.length > 1 && (
        <div className="t2c-apv-rest">
          {items.filter((i) => i !== cur).map((i) => (
            <button type="button" key={i.req.approvalId} className="t2c-apv-row" title={i.req.preview} onClick={() => setOpenId(i.req.approvalId)}>
              {i.agentName && <span className="t2c-apv-row-from">{i.agentName}</span>}
              <span className="t2c-apv-row-name">{i.req.name}</span>
              <span className="t2c-apv-row-preview">{i.req.preview}</span>
            </button>
          ))}
        </div>
      )}
      {!collapsed && (
        <div className={`t2c-apv-body${armedId === curId ? '' : ' is-arming'}`}>
          {cur.agentName && <div className="t2c-apv-from">{cur.agentName}</div>}
          <ApprovalCard
            key={cur.req.approvalId}
            req={cur.req}
            onDecide={(action, args) => onDecide(cur.messageId, cur.req.approvalId, action, args)}
          />
        </div>
      )}
    </div>
  )
}
