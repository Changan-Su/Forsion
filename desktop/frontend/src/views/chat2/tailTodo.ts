/** 对话末尾那一行任务清单选哪份(方案「对话末尾与任务清单」11-23 B1):末尾只放这一轮的清单。
 *  - 在跑:只认正在跑的那条回答自己的清单(插话切段时清单挪到新段,见 tanguSlice turn_boundary)。这一轮没写清单 → 不放,
 *    不往回找上一轮的 —— 原来 `running ||` 会把任何一份旧清单(做完的、停下的)搬到末尾,跑完再跳回原处。
 *  - 没在跑:最后一条回答的清单还有没做完的 → 放末尾;做完的留在原回答里(10-23 定稿)。
 *  判「写没写过」不判长度:`todo_write([])` 清空清单 = 这一轮没有清单,不能当没发生、接着往回找旧的。 */
import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'

export function tailTodoOf(messages: readonly UiMessage[], running: boolean, hidden: (m: UiMessage) => boolean = () => false): UiMessage | null {
  if (running) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'assistant' && m.status === 'streaming' && m.todos !== undefined) return m.todos.length ? m : null
    }
    return null
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || hidden(m)) continue
    return m.todos?.some((x) => x.status !== 'completed') ? m : null
  }
  return null
}

/** 「↓ N 条新消息」数的东西:画出来、已经说完的回答。在跑的空气泡、团队成员占位、团队总结都不算。 */
export function finishedReplyCount(messages: readonly UiMessage[], hidden: (m: UiMessage) => boolean): number {
  let n = 0
  for (const m of messages) if (m.role === 'assistant' && m.status !== 'streaming' && !hidden(m)) n++
  return n
}
