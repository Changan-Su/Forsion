import { parseCalDate } from '@amadeus-shared/db/calDate'
import { diffDays, sameDay, startOfDay, toLocalDate } from './dateUtils'

export interface TodoDueMeta {
  label: string
  tone: 'muted' | 'today' | 'overdue' | 'future'
  sortTime: number
}

const hm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** 待办侧栏的紧凑日期副文案；不改变原始筛选语义，只补回用户判断轻重缓急所需的信息。 */
export function todoDueMeta(raw: string, today = new Date()): TodoDueMeta {
  const cd = parseCalDate(raw)
  if (!cd) return { label: '未设日期', tone: 'muted', sortTime: Number.POSITIVE_INFINITY }
  const start = toLocalDate(cd.start)
  const dayDelta = diffDays(startOfDay(start), startOfDay(today))
  const time = cd.allDay ? '' : ` ${hm(start)}`
  if (dayDelta < 0) return { label: `逾期 ${start.getMonth() + 1}/${start.getDate()}${time}`, tone: 'overdue', sortTime: start.getTime() }
  if (sameDay(start, today)) return { label: `今天${time}`, tone: 'today', sortTime: start.getTime() }
  if (dayDelta === 1) return { label: `明天${time}`, tone: 'future', sortTime: start.getTime() }
  return { label: `${start.getMonth() + 1}/${start.getDate()}${time}`, tone: 'future', sortTime: start.getTime() }
}
