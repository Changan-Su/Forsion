/** 任务卡落点(```forsion-task,对标 Claude Code 的 spawn_task)—— 聊天与收件箱共用:
 *   here = 任务书当用户消息发进当前会话;new = 开新会话再发(隐式建会话,沿用当前默认);
 *   muse = 写一条 Muse 日程(repeat 1d, auto)= Track,到期回灌 Muse 周期,Calendar 可见;ignore = 只留反馈。
 * 四档都往 Muse 的 LOG 写一条 [feedback] 行(与 TODO 处理同通道)—— 没点 ≠ 不喜欢,反馈只用于调校提议频率。
 * Muse TODO 卡(`todo:` 头 —— 只在收件箱里 Muse 自己的信上生效,见 InboxBody):状态迁移交给引擎 ——
 *   muse = POST /agent/special/muse/todos/:id/approve(按 id 读库里的规范任务书、建一次性此刻到期的 Muse 日程、CAS
 *   pending→injected,反馈行引擎写);ignore = PATCH dismissed(from=pending 的 CAS;这是唯一的动作,没改上就留着按钮;
 *   反馈行也是引擎写);here / new = **先** CAS pending→injected 再发(别处刚处理过就不再发第二遍),没发出去(含抛错)
 *   等退回 pending 落地再返回,调用方随后按真状态重拉。
 * ⚠️ 调用方在别的 Space(收件箱)里点「新会话执行」要**先切到 Tangu Space**(发 Tangu 必须先切 Space),这里不替它切。 */
import { openNewChat } from '../../sessionNav'
import { approveMuseTodo, patchMuseTodo, postMuseFeedback, saveAgentScheduleEntry } from '../../services/backendService'
import { useApp } from '../../stores/appStore'
import type { TaskCard } from './suggest'
import type { TaskLanding } from './TaskCards'

function localStamp(d: Date): string {
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 交给 Muse 追踪的日程 prompt 上限。引擎已放到 8000(批准 TODO 要装下整份 detail),这里仍按 4000 卡:
 *  新桌面配老引擎时,超长任务书不能被老引擎静默截断。超了告诉用户拆小。 */
const TRACK_PROMPT_MAX = 4000
export const TRACK_PREFIX = 'Track this task; report to the user only when something changed, and remove this entry when it is done. '

/** Muse TODO 的状态迁移(CAS from=pending):别处已处理 → 提示「已经处理过了」;失败 toast;两种都返回 false(卡片不定格)。 */
async function syncTodo(id: string, status: 'injected' | 'dismissed'): Promise<boolean> {
  const app = useApp.getState()
  try {
    await patchMuseTodo(app.cfg, id, status, 'pending')
    return true
  } catch (e: any) {
    app.toast(e?.code === 'todo_not_pending' ? app.tr('chat.task.doneTodo') : app.tr('chat.task.todoSyncFail', { e: e?.message || String(e) }), true)
    return false
  }
}

/** 发送没成:把刚占下的 injected 退回 pending(from=injected 的 CAS,别处已改走就不动);退不回就提示。 */
async function revertTodo(id: string): Promise<void> {
  const app = useApp.getState()
  await patchMuseTodo(app.cfg, id, 'pending', 'injected').catch((e: any) => {
    app.toast(app.tr('chat.task.todoSyncFail', { e: e?.message || String(e) }), true)
  })
}

/** 返回 true = 做成(卡片定格);false = 没做成(卡片保留按钮,toast 说明)。反馈行只在做成后发,免得 LOG 里记着没发生的事。 */
export async function runTaskCard(card: TaskCard, landing: TaskLanding, sessionId: string | null): Promise<boolean> {
  const app = useApp.getState()
  const feedback = (line: string): void => { void postMuseFeedback(app.cfg, line).catch(() => {}) }
  const label = `task-card "${card.title.slice(0, 80)}"`
  if (landing === 'here' || landing === 'new') {
    if (card.todo && !(await syncTodo(card.todo, 'injected'))) return false
    let ok = false
    try {
      if (landing === 'new') openNewChat()
      ok = !!(await useApp.getState().send(card.prompt, [], undefined, undefined, undefined, landing === 'here' ? sessionId : null))
    } finally {
      if (!ok && card.todo) await revertTodo(card.todo)
    }
    if (ok) feedback(`${label} accepted: ${landing === 'here' ? 'run here' : 'run in a new session'}`)
    return ok
  }
  if (landing === 'muse' && card.todo) {
    try {
      await approveMuseTodo(app.cfg, card.todo)
      app.toast(app.tr('chat.task.handedDo'))
      return true
    } catch (e: any) {
      app.toast(e?.code === 'muse_disabled' ? app.tr('chat.task.museOff') : e?.code === 'todo_not_pending' ? app.tr('chat.task.doneTodo') : app.tr('chat.task.trackFail', { e: e?.message || String(e) }), true)
      return false
    }
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
  if (card.todo) return syncTodo(card.todo, 'dismissed') // 忽略 TODO 卡:唯一的动作,没改上就留着按钮;[feedback] 行引擎 PATCH 路由写
  feedback(`${label} ignored`)
  return true
}
