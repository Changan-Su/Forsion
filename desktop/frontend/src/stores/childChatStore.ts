import { create } from 'zustand'
import type { SessionRecord } from '../types'

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
  open: (parentId, child) => set((s) => ({ selected: { ...s.selected, [parentId]: child } })),
  close: (parentId) => set((s) => ({ selected: { ...s.selected, [parentId]: undefined } })),
}))
