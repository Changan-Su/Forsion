import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { isContinuationRow } from '../../../../../tangu-agent/src/contracts/turnResume'

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
