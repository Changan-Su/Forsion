/**
 * 远程会话待批的系统通知被点击 → 主窗打开那条会话(设备能力 MCP 方案 P1 · K3)。
 * 主进程 approvalDelivery 经 webContents.send 发、preload 的 onApprovalOpen 收 —— 两头共用这一个名字,拼错一头就是静默失灵。
 */
export const APPROVAL_OPEN_CHANNEL = 'approval:open'

export interface ApprovalOpenPayload { sessionId: string }
