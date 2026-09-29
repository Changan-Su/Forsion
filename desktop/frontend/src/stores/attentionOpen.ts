/**
 * 「打开那条等你处理的会话」(设备能力 MCP 方案 P1 · K3):系统通知点击(桌面 approval:open)与收件箱审批提醒信的「打开会话」共用。
 * 未知 id 先刷一次会话列表(通知可能比列表新);主页 / 收件箱 Space 没有聊天主区 —— 先切回 Tangu Space,否则会把那里的 leaf
 * 原地导航成聊天(同 sessionNav.openSolo 的 leaveHomeSpace、InboxReaderView 的「与发件 agent 聊天」)。
 * 刷完仍找不到 → false(调用方提示),不开一个「加载失败」的空会话。
 */
import { setActiveSpace, useSpaceStore } from '@lcl/engine'
import { useApp } from './appStore'
import { openSession } from '../sessionNav'

const known = (sid: string): boolean => {
  const st = useApp.getState()
  return st.sessions.some((s) => s.id === sid) || st.archivedSessions.some((s) => s.id === sid)
}

export async function openSessionFromApproval(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  if (!known(sessionId)) {
    try { await useApp.getState().refreshSessions(useApp.getState().cfg) } catch { /* 离线:按找不到处理 */ }
    if (!known(sessionId)) return false
  }
  const space = useSpaceStore.getState().activeSpaceId
  if (space === 'home' || space === 'inbox') setActiveSpace('tangu')
  openSession(sessionId)
  return true
}
