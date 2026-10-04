import { create } from 'zustand'

/** `ctx.tangu.mountChat` 的预填通道:按会话排队,由那条对话自己的 Composer 一次取走
 *  (叶子模块,Composer2 与探针两头都引得到)。排队而不是单槽:想法和一键任务挨着投时,后一条不能把前一条顶掉。 */
export const usePluginChat = create<{
  pending: Array<{ sessionId: string; text: string }>
  queue(sessionId: string, text: string): void
  /** 取走这条会话名下排着的全部预填(先进先出);别的会话的留着。 */
  take(sessionId: string): string[]
}>((set, get) => ({
  pending: [],
  queue: (sessionId, text) => set((s) => ({ pending: [...s.pending, { sessionId, text }] })),
  take: (sessionId) => {
    const mine = get().pending.filter((p) => p.sessionId === sessionId)
    if (mine.length) set((s) => ({ pending: s.pending.filter((p) => p.sessionId !== sessionId) }))
    return mine.map((p) => p.text)
  },
}))
