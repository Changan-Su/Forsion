/** 任务卡落点(```forsion-task,对标 Claude Code 的 spawn_task)—— 聊天与收件箱共用:
 *   here = 任务书当用户消息发进当前会话;new = 开新会话再发(隐式建会话,沿用当前默认);
 *   muse = 写一条 Muse 日程(repeat 1d, auto)= Track,到期回灌 Muse 周期,Calendar 可见;ignore = 只留反馈。
 * 四档都往 Muse 的 LOG 写一条 [feedback] 行(与 TODO 处理同通道)—— 没点 ≠ 不喜欢,反馈只用于调校提议频率。
 * ⚠️ 调用方在别的 Space(收件箱)里点「新会话执行」要**先切到 Tangu Space**(发 Tangu 必须先切 Space),这里不替它切。 */
import { openNewChat } from '../../sessionNav'
import { postMuseFeedback, saveAgentScheduleEntry } from '../../services/backendService'
import { useApp } from '../../stores/appStore'
import type { TaskCard } from './suggest'
import type { TaskLanding } from './TaskCards'

function localStamp(d: Date): string {
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 交给 Muse 的日程 prompt 上限(与引擎 agentSchedule.validateEntryInput 的 4000 对齐;超了不静默截断,告诉用户拆小)。 */
const TRACK_PROMPT_MAX = 4000
export const TRACK_PREFIX = 'Track this task; report to the user only when something changed, and remove this entry when it is done. '

/** 返回 true = 做成(卡片定格);false = 没做成(卡片保留按钮,toast 说明)。反馈行只在做成后发,免得 LOG 里记着没发生的事。 */
export async function runTaskCard(card: TaskCard, landing: TaskLanding, sessionId: string | null): Promise<boolean> {
  const app = useApp.getState()
  const feedback = (line: string): void => { void postMuseFeedback(app.cfg, line).catch(() => {}) }
  const label = `task-card "${card.title.slice(0, 80)}"`
  if (landing === 'here') {
    const ok = await app.send(card.prompt, [], undefined, undefined, undefined, sessionId)
    if (ok) feedback(`${label} accepted: run here`)
    return !!ok
  }
  if (landing === 'new') {
    openNewChat()
    const ok = await useApp.getState().send(card.prompt, [], undefined, undefined, undefined, null)
    if (ok) feedback(`${label} accepted: run in a new session`)
    return !!ok
  }
  if (landing === 'muse') {
    const prompt = TRACK_PREFIX + card.prompt
    if (prompt.length > TRACK_PROMPT_MAX) { app.toast(app.tr('chat.task.tooLong'), true); return false }
    try {
      await saveAgentScheduleEntry(app.cfg, 'muse', {
        name: card.title.slice(0, 120),
        date: localStamp(new Date(Date.now() + 3600_000)), // 一小时后首查,之后每天
        repeat: '1d',
        auto: true,
        prompt,
        description: `${card.tldr ? `${card.tldr} · ` : ''}source session ${sessionId || '-'}`.slice(0, 500),
        todo: true,
      })
      app.toast(app.tr('chat.task.tracked'))
      feedback(`${label} handed to Muse for tracking`)
      return true
    } catch (e: any) {
      app.toast(app.tr('chat.task.trackFail', { e: e?.message || String(e) }), true)
      return false
    }
  }
  feedback(`${label} ignored`)
  return true
}
