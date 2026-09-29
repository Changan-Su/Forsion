import type { ApprovalRequest, InquiryRequest, UiMessage } from '../../types'

/** 输入框上方托盘里的一项 —— 等你拍板的东西:权限审批、Agent 的提问、计划审阅。
 *  都仍挂在各自的消息上(持久化回放 / 兑现 / turn_boundary 的 keep 都钉在那),托盘只是视图。
 *  id = approvalId / inquiryId(前缀 apv_ / inq_ 不同,放一起也不撞)。 */
export type TrayItem = {
  id: string
  /** 挂在哪条消息上(兑现按它找审批 / 询问,410 时按它置灰)。 */
  messageId: string
  /** 团队成员的请求落在成员占位气泡上:托盘据此标出是谁在等你。 */
  agentName?: string
} & (
  | { kind: 'approval'; req: ApprovalRequest }
  | { kind: 'inquiry'; req: InquiryRequest }
  | { kind: 'plan'; req: InquiryRequest; plan: string }
)

/** 计划卡该配对哪个询问:同一条消息里 kind='plan' 的,**待答的优先**,否则取最后一条。
 *  打回→重交会让同一条助手消息累积多个 kind='plan' 询问(第一条已答),而 planProposal 已被换成新一版
 *  —— 取第一条 = 新计划配旧回执(卡上写着「已打回」却摆着新计划),取待答的才对得上。
 *  没配上(重载后的历史、或 plan 事件缺失)就只渲染计划正文,询问按通用问答兜底。 */
export function pickPlanInquiry(msg: Pick<UiMessage, 'planProposal' | 'inquiries'>): InquiryRequest | undefined {
  if (!msg.planProposal) return undefined
  const plans = (msg.inquiries || []).filter((q) => q.kind === 'plan')
  return plans.find((q) => q.status === 'pending') || plans[plans.length - 1]
}

/** 会话里全部等你拍板的东西,按出现顺序(最早的在前)。托盘与灵动岛同源:它们不止挂在最后一条消息上
 *  (run 往后跑会切出新段,团队成员各挂各的占位气泡),只看末条会漏。 */
export function pendingPromptsOf(list: UiMessage[] | undefined): TrayItem[] {
  const out: TrayItem[] = []
  for (const m of list || []) {
    // 只给团队成员(占位气泡带 work)标名字:普通会话每张都写一遍当前 Agent 是噪音
    const who = m.work && m.agentName ? { agentName: m.agentName } : {}
    for (const req of m.approvals || []) {
      if (req.status === 'pending') out.push({ kind: 'approval', id: req.approvalId, messageId: m.id, req, ...who })
    }
    const planInq = pickPlanInquiry(m)
    for (const req of m.inquiries || []) {
      if (req.status !== 'pending') continue
      if (req === planInq && m.planProposal) out.push({ kind: 'plan', id: req.inquiryId, messageId: m.id, req, plan: m.planProposal, ...who })
      else out.push({ kind: 'inquiry', id: req.inquiryId, messageId: m.id, req, ...who })
    }
  }
  return out
}

/** 挂起调用的结局回灌行(引擎 agentLoop.APPROVAL_UPDATE_OPEN 开头的 user 行):给模型看的,对人渲染成一行结局。 */
export const APPROVAL_UPDATE_OPEN = '<approval_update>'

export interface ApprovalOutcome {
  status: 'approved' | 'rejected' | 'failed'
  name: string
  callId: string
  preview: string
}

/** 按引擎写死的行头 `[status] tool (call id) — preview` 取出每一张的结局。回灌里只有引擎自己写的字(工具输出放回了
 *  原工具消息,不进这一行),所以行头伪造不出来。 */
export function parseApprovalUpdate(text: string): ApprovalOutcome[] {
  return [...text.matchAll(/^\[(approved|rejected|failed)\] (\S+) \(call ([^)]*)\) — (.*)$/gm)]
    .map((m) => ({ status: m[1] as ApprovalOutcome['status'], name: m[2], callId: m[3], preview: m[4] }))
}

/** 结局行里的一张(callId = 工具调用 id)对应的审批(approval_request.toolCallId;挂起的审批拍板时 run 往往已切到后面的段,
 *  所以翻全会话)。结局行据它的 answeredBy 写「在哪答的」(M1B)—— 这份信息只在渲染层,不进给模型看的 <approval_update> 正文。
 *  多张同 callId(旧事件没有 toolCallId 的不算)取最后一张。 */
export function approvalForCall(list: UiMessage[] | undefined, callId: string): ApprovalRequest | undefined {
  if (!callId) return undefined
  let hit: ApprovalRequest | undefined
  for (const m of list || []) for (const a of m.approvals || []) if (a.toolCallId === callId) hit = a
  return hit
}
