import { create } from 'zustand'

/** `ctx.tangu.mountChat` 的预填通道:按会话投给那条对话的输入框,由它自己的 Composer 消费一次
 *  (与 Image Studio 的 pending / consume 同一套;叶子模块,Composer2 与探针两头都引得到)。 */
let sequence = 0
export const usePluginChat = create<{
  pending: { sessionId: string; text: string; seq: number } | null
  queue(sessionId: string, text: string): void
  consume(seq: number): boolean
}>((set, get) => ({
  pending: null,
  queue: (sessionId, text) => set({ pending: { sessionId, text, seq: ++sequence } }),
  consume: (seq) => {
    if (get().pending?.seq !== seq) return false
    set({ pending: null })
    return true
  },
}))
