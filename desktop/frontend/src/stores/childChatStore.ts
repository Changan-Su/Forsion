import { create } from 'zustand'
import type { SessionRecord } from '../types'
import { inheritBinding } from '../services/engine/targets'

export interface ChildChatTarget {
  id: string
  title: string
  sessionId?: string
  runId?: string
  slug?: string
  task?: string
}

/** Child selection belongs to its parent. Opening it never changes the main session. */
export const useChildChat = create<{
  selected: Record<string, ChildChatTarget | undefined>
  sessions: Record<string, SessionRecord>
  remember(session: SessionRecord): void
  open(parentId: string, child: ChildChatTarget): void
  close(parentId: string): void
}>((set) => ({
  selected: {},
  sessions: {},
  remember: (session) => set((s) => ({ sessions: { ...s.sessions, [session.id]: session } })),
  open: (parentId, child) => {
    // P1-K6 S4:子会话(@讨论 / 团队成员 / Historian 辅助)在父会话那台引擎上 → 路由跟父会话走(先绑再露给视图,视图立刻按它发请求)
    if (child.sessionId) inheritBinding(child.sessionId, parentId)
    set((s) => ({ selected: { ...s.selected, [parentId]: child } }))
  },
  close: (parentId) => set((s) => ({ selected: { ...s.selected, [parentId]: undefined } })),
}))
