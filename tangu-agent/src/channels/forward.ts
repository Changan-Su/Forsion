/**
 * 收件箱 → 通道转发入口(fire-and-forget)。
 * 动态 import hub:静态引用会形成 工具/路由 → hub → service → agentLoop → registry → 工具 的
 * 模块环(registerToolProvider 收到未初始化的 provider 而炸)。本文件零静态依赖,谁都能安全引。
 */
export interface InboxForwardInput {
  userId: string;
  title: string;
  body?: string;
  senderKind: 'agent' | 'system' | 'server';
  senderId?: string;
}

export function forwardInboxToChannels(input: InboxForwardInput): void {
  void import('./hub.js')
    .then((m) => m.channelHub.forwardInbox(input))
    .catch((e: any) => console.warn('[channels] inbox 转发失败:', e?.message || e));
}
