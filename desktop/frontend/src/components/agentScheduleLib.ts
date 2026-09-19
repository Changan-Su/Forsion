/**
 * Agent 详情「日程」标签的纯逻辑:某条日程下一次什么时候到、一条自动化规则归不归这个 Agent。
 * 引擎侧的到期判定在 tangu-agent/src/services/agentSchedule.ts(锚点算术);这里只为**显示**复算「下一次」,
 * 不参与触发 —— 算偏了只是列表排序不准,不会多跑少跑。
 */
import { parseLocalDatetime } from '../views/automation/lib'
import type { AgentScheduleEntry, MuseTriggerInfo } from '../types'

const UNIT_MS = { h: 3_600_000, d: 86_400_000 } as const

/** 下一次发生的时刻;一次性且已过 / 无日期 → null。repeat = `<n>h|d`,从 date 锚点滚动('d' 固定 24h,与引擎同口径)。 */
export function nextOccurrence(entry: Pick<AgentScheduleEntry, 'date' | 'repeat'>, now = Date.now()): Date | null {
  const start = parseLocalDatetime((entry.date || '').split('/')[0])
  if (!start) return null
  if (start.getTime() > now) return start
  const m = /^(\d+)([hd])$/.exec(entry.repeat || '')
  const step = m ? Number(m[1]) * UNIT_MS[m[2] as 'h' | 'd'] : 0
  if (!step) return null
  return new Date(start.getTime() + Math.ceil((now - start.getTime()) / step) * step)
}

/** 规则命中后会不会叫醒这个 Agent:动作链里有它的 agent_run;没有动作链的旧式规则看 agentSlug(缺省 = Muse)。 */
export function triggerWakes(tr: Pick<MuseTriggerInfo, 'actions' | 'agentSlug'>, slug: string): boolean {
  if (tr.actions?.length) return tr.actions.some((a) => a.type === 'agent_run' && a.agentSlug === slug)
  return (tr.agentSlug || 'muse') === slug
}
