import { parseCalDate } from '@amadeus-shared/db/calDate'
import { diffDays, sameDay, startOfDay, toLocalDate } from './dateUtils'
import { registerMessages, translate } from '../../i18n'
import { formatMonthDay, formatTime } from '../../format/time'
import './todoGroups' // 「逾期 / 今天 / 明天」复用分桶标题的词条(todogroups.*),保证已注册

registerMessages({
  'todometa.noDate': { zh: '未设日期', en: 'No date' },
})

export interface TodoDueMeta {
  label: string
  tone: 'muted' | 'today' | 'overdue' | 'future'
  sortTime: number
}

/** 待办侧栏的紧凑日期副文案；不改变原始筛选语义，只补回用户判断轻重缓急所需的信息。
 *  文案跟界面语言(此前英文界面仍显示「今天 / 明天 09:00」);月日、时刻走 format/time 单源。 */
export function todoDueMeta(raw: string, today = new Date()): TodoDueMeta {
  const cd = parseCalDate(raw)
  if (!cd) return { label: translate('todometa.noDate'), tone: 'muted', sortTime: Number.POSITIVE_INFINITY }
  const start = toLocalDate(cd.start)
  const dayDelta = diffDays(startOfDay(start), startOfDay(today))
  const time = cd.allDay ? '' : ` ${formatTime(start)}`
  if (dayDelta < 0) return { label: `${translate('todogroups.overdue')} ${formatMonthDay(start)}${time}`, tone: 'overdue', sortTime: start.getTime() }
  if (sameDay(start, today)) return { label: `${translate('todogroups.today')}${time}`, tone: 'today', sortTime: start.getTime() }
  if (dayDelta === 1) return { label: `${translate('todogroups.tomorrow')}${time}`, tone: 'future', sortTime: start.getTime() }
  return { label: `${formatMonthDay(start)}${time}`, tone: 'future', sortTime: start.getTime() }
}
