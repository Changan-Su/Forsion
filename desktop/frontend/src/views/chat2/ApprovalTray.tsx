/**
 * 输入框上方的托盘:等你拍板的东西都攒在这里(借 Claude Code / Codex),不再插在聊天流里打断阅读 ——
 * 权限审批、Agent 的提问(ask_user)、计划审阅的拍板区(计划正文仍在流里的计划卡上)。
 * 状态不搬家 —— 它们仍挂在各自的消息上(持久化回放 / 兑现 / turn_boundary 的 keep 都钉在那),
 * 托盘只是「本会话所有 pending」的另一个视图:选中的一项(缺省最早那项)展开,其余缩成一行,点哪行展开哪行。
 * 排队行在上、展开的在下(贴着输入框):展开项带长 diff 时排队的几项仍一眼可见,不被挤进滚动区。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CircleHelp, ClipboardList, ShieldQuestion } from 'lucide-react'
import { ApprovalCard } from '../../components/ApprovalCard'
import { InquiryCard, PlanDecision } from '../../components/InquiryCard'
import { registerMessages, useI18n } from '../../i18n'
import type { TrayItem } from './approvalQueue'

registerMessages({
  'approval.tray.title': { zh: '等你批准 · {n}', en: 'Waiting for your approval · {n}' },
  'approval.tray.titleAny': { zh: '等你处理 · {n}', en: 'Waiting for you · {n}' },
  'approval.tray.label': { zh: '等你处理的事项', en: 'Items waiting for you' },
  'approval.tray.planRow': { zh: '计划等你拍板', en: 'Plan waiting for your decision' },
})

const ARM_MS = 350

type Sent = void | boolean | Promise<boolean | void>

export function ApprovalTray({ items, onDecide, onAnswer }: {
  items: TrayItem[]
  /** 返回 false = 没送达,托盘解锁这一项让用户重试。 */
  onDecide: (messageId: string, approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => Sent
  /** 询问 / 计划的回答;返回 false = 没送达。 */
  onAnswer: (messageId: string, inquiryId: string, answer: string) => Sent
}) {
  const { t } = useI18n()
  const [openId, setOpenId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const cur = items.find((i) => i.id === openId) ?? items[0]
  const curId = cur?.id
  // 钉住展开项:缺省那项一显示就钉住 —— 之后插到它前面的新条目(并行团队里排在前面的成员晚来的审批 / 提问)
  // 只进排队行,不把正在看的这项顶掉(草稿会丢,冷却过后还会点到顶上来的那张)。它离开列表才回落到最早那项。
  useEffect(() => { if (curId && curId !== openId) setOpenId(curId) }, [curId, openId])
  // 换卡冷却:批完一项,下一项原地顶上来 —— 连点两下不能把没看过的下一项也批了 / 答了。
  // 展开项一换(含新出现),按钮先不接收点击,ARM_MS 后才生效。
  const [armedId, setArmedId] = useState<string | undefined>(undefined)
  useEffect(() => {
    const timer = setTimeout(() => setArmedId(curId), ARM_MS)
    return () => clearTimeout(timer)
  }, [curId])
  // 已送出、还等回执的项:锁在托盘层(卡片切走再切回、收起再展开都不丢),同一项绝不送第二次 ——
  // 第二次必然 410,从前还会把已送达的回答改判成「已过期」。没送达(返回 false / 抛错)才解锁重试。
  const sent = useRef(new Set<string>())
  const [, rerender] = useState(0)
  for (const id of sent.current) if (!items.some((i) => i.id === id)) sent.current.delete(id) // 兑现离开托盘的不再占着
  const submit = (id: string, send: () => Sent): void => {
    if (sent.current.has(id)) return
    sent.current.add(id)
    rerender((n) => n + 1)
    const unlock = (): void => { sent.current.delete(id); rerender((n) => n + 1) }
    void Promise.resolve().then(send).then((ok) => { if (ok === false) unlock() }, unlock)
  }
  if (!cur) return null
  const busy = sent.current.has(cur.id)
  const title = items.every((i) => i.kind === 'approval') ? 'approval.tray.title' : 'approval.tray.titleAny'
  return (
    <div className="t2c-apv" role="region" aria-label={t('approval.tray.label')} data-approval-tray={items.length}>
      <button type="button" className="t2c-apv-head" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>
        <ShieldQuestion size={13} className="t2c-apv-ic" />
        <span className="t2c-apv-title">{t(title, { n: items.length })}</span>
        <ChevronDown size={13} className={`t2c-apv-chev${collapsed ? ' is-collapsed' : ''}`} />
      </button>
      {!collapsed && items.length > 1 && (
        <div className="t2c-apv-rest">
          {items.filter((i) => i !== cur).map((i) => (
            <button type="button" key={i.id} className="t2c-apv-row" data-tray-kind={i.kind} data-tray-msg={i.messageId} title={rowText(i, t)} onClick={() => setOpenId(i.id)}>
              {i.agentName && <span className="t2c-apv-row-from">{i.agentName}</span>}
              {i.kind === 'approval' ? (
                <>
                  <span className="t2c-apv-row-name">{i.req.name}</span>
                  <span className="t2c-apv-row-preview">{i.req.preview}</span>
                </>
              ) : (
                <>
                  {i.kind === 'plan' ? <ClipboardList size={12} className="t2c-apv-row-ic" /> : <CircleHelp size={12} className="t2c-apv-row-ic" />}
                  <span className="t2c-apv-row-text">{rowText(i, t)}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {!collapsed && (
        <div
          className={`t2c-apv-body${armedId === curId ? '' : ' is-arming'}${busy ? ' is-sent' : ''}`}
          data-tray-kind={cur.kind}
          data-tray-msg={cur.messageId}
        >
          {cur.agentName && <div className="t2c-apv-from">{cur.agentName}</div>}
          {cur.kind === 'approval' ? (
            <ApprovalCard key={cur.id} req={cur.req} onDecide={(action, args) => submit(cur.id, () => onDecide(cur.messageId, cur.id, action, args))} />
          ) : cur.kind === 'plan' ? (
            <PlanDecision key={cur.id} plan={cur.plan} req={cur.req} busy={busy} onAnswer={(a) => submit(cur.id, () => onAnswer(cur.messageId, cur.id, a))} />
          ) : (
            <InquiryCard key={cur.id} req={cur.req} onAnswer={(a) => submit(cur.id, () => onAnswer(cur.messageId, cur.id, a))} />
          )}
        </div>
      )}
    </div>
  )
}

function rowText(i: TrayItem, t: (k: string) => string): string {
  if (i.kind === 'approval') return i.req.preview
  if (i.kind === 'plan') return t('approval.tray.planRow')
  return i.req.question
}
