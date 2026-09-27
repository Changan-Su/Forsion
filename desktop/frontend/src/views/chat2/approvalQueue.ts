import type { ApprovalRequest, UiMessage } from '../../types'

export interface PendingApproval {
  /** 审批挂在哪条消息上(decideApproval 按它找审批、410 时按它置灰)。 */
  messageId: string
  req: ApprovalRequest
  /** 团队成员的审批落在成员占位气泡上:托盘据此标出是谁在要权限。 */
  agentName?: string
}

/** 会话里全部待批审批,按出现顺序(最早的在前)。托盘与灵动岛同源:审批不止挂在最后一条消息上
 *  (run 往后跑了会切出新段,团队成员各挂各的占位气泡),只看末条会漏。 */
export function pendingApprovalsOf(list: UiMessage[] | undefined): PendingApproval[] {
  const out: PendingApproval[] = []
  for (const m of list || []) {
    for (const req of m.approvals || []) {
      // 只给团队成员(占位气泡带 work)标名字:普通会话每张都写一遍当前 Agent 是噪音
      if (req.status === 'pending') out.push({ messageId: m.id, req, ...(m.work && m.agentName ? { agentName: m.agentName } : {}) })
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
