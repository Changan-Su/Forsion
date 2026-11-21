import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { isContinuationRow, type InterruptReason } from '../../../../../tangu-agent/src/contracts/turnResume'

/**
 * 失败的这一轮有没有已经产出的东西(正文或工具调用):从末尾往回走到上一条真正的用户消息,
 * 中间的「继续生成」/ 打断标记照样越过(续写过一次又失败,前面那几段仍算这一轮的)。
 * 有 → 失败行给「继续生成」(主)+「重新生成」;没有 → 只给「重试」,两者此时等价。
 */
export function turnHasOutput(list: readonly UiMessage[] | undefined): boolean {
  if (!list) return false
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.role === 'user') {
      if (isContinuationRow(m.content || '')) continue
      return false
    }
    if (m.role === 'assistant' && ((m.content || '').trim() || m.toolEvents?.length)) return true
  }
  return false
}

/**
 * 这条是不是会话里最新的回答:从末尾往回,越过本地通知行(system)和「继续生成」/ 打断标记这些机器行。
 * 停下 / 截断后的「继续生成」只给最新那条 —— 用户停下时引擎会落一条 <turn_interrupted>,不越过它就永远轮不到。
 */
export function isLatestAnswer(list: readonly UiMessage[] | undefined, id: string): boolean {
  if (!list) return false
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.role === 'system') continue
    if (m.role === 'user' && isContinuationRow(m.content || '')) continue
    return m.id === id
  }
  return false
}

/**
 * 会话里最后一行(越过本地通知行 system)是不是这一行。给机器行自己用:带原因的中断行(<turn_interrupted>[reason])
 * 本身就是续写标记行,isLatestAnswer 会越过它,判不出「它就是最新那条」。
 */
export function isLatestRow(list: readonly UiMessage[] | undefined, id: string): boolean {
  if (!list) return false
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'system') continue
    return list[i].id === id
  }
  return false
}

/**
 * 不是用户按停的中断(中断任务续跑方案 B):引擎记在 run 上的 error 是 `interrupted:<原因>`,在线 error 事件带 interrupted 字段。
 * 气泡收成 stopped、error 记这个标记 —— 不画「⏹ 已停止」与它下面的「继续生成」(那句会告诉模型是用户停的),也不画红色失败行;
 * 引擎重启后会自己补上说明原因的那一行(自动接着做,或给「继续生成」)。
 */
export const INTERRUPTED_RUN_ERROR = 'interrupted'
export function interruptedRunError(reason?: InterruptReason | null): string {
  return reason ? `${INTERRUPTED_RUN_ERROR}:${reason}` : INTERRUPTED_RUN_ERROR
}
export function isInterruptedRunError(error: string | null | undefined): boolean {
  return !!error && (error === INTERRUPTED_RUN_ERROR || error.startsWith(`${INTERRUPTED_RUN_ERROR}:`))
}
