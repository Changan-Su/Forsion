/**
 * 待办分桶 —— **桶序与归桶判据的唯一真源**。
 *
 * 桶序是**硬编码数组**,不是按标题字符串排(Obsidian Tasks 就栽在这:它的分组标题按大小写敏感
 * 字母序排,结果「11月排在2月前面」)。新增桶必须显式插进 ORDER。
 *
 * 取代原来的「按所属多维表分组」:实测各 vault 合格来源库数 0/1/1,分组维度恒为常量,
 * 一整层可折叠 section 换一个不变的表名。旧路径整条删掉,**不留可选项**。
 *
 * 「未排期」= 无日期的一切(多维表里日期列空的行 + 笔记正文任务,后者天然全部无日期)。
 * 这是 Sunsama Backlog / NotePlan Priority 段的语义:显式收成一个命名的桶,
 * 而不是让它们无条件散在各处置顶(旧行为)。
 */
import { diffDays, sameDay, startOfDay, toLocalDate } from './dateUtils'
import { parseCalDate } from '@amadeus-shared/db/calDate'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'todogroups.overdue': { zh: '逾期', en: 'Overdue' },
  'todogroups.today': { zh: '今天', en: 'Today' },
  'todogroups.tomorrow': { zh: '明天', en: 'Tomorrow' },
  'todogroups.week': { zh: '本周', en: 'This week' },
  'todogroups.later': { zh: '以后', en: 'Later' },
  'todogroups.undated': { zh: '未排期', en: 'Unscheduled' },
})

export type TodoBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'undated'

/** 渲染顺序。⚠️ 硬编码,勿改成按标题排序;新桶必须插进这里。 */
export const ORDER: TodoBucket[] = ['overdue', 'today', 'tomorrow', 'week', 'later', 'undated']

/**
 * 桶标题。⚠️ 惰性 getter —— 读一次算一次,语言切换后立即跟上。
 * 勿改回字面量常量表(那会在模块加载时把文案冻在启动语言上),也勿对它做
 * spread / JSON 快照后缓存 —— 那等于把 getter 展平成一次性快照,同样冻死。
 */
export const BUCKET_LABEL: Record<TodoBucket, string> = {
  get overdue() { return translate('todogroups.overdue') },
  get today() { return translate('todogroups.today') },
  get tomorrow() { return translate('todogroups.tomorrow') },
  get week() { return translate('todogroups.week') },
  get later() { return translate('todogroups.later') },
  get undated() { return translate('todogroups.undated') },
}

/** 默认折叠的桶:长尾两个。逾期/今天恒展开 —— 它们是这个面板存在的理由。 */
export const COLLAPSED_BY_DEFAULT: TodoBucket[] = ['later']

/** 日期原文 → 桶。空 / 解析不出 = 未排期。 */
export function bucketOf(raw: string, today: Date): TodoBucket {
  const cd = raw ? parseCalDate(raw) : null
  if (!cd) return 'undated'
  const start = startOfDay(toLocalDate(cd.start))
  const base = startOfDay(today)
  const d = diffDays(start, base)
  if (d < 0) return 'overdue'
  if (sameDay(start, base)) return 'today'
  if (d === 1) return 'tomorrow'
  if (d <= 7) return 'week'
  return 'later'
}

/** 排序键:有日期的按时间升序,未排期恒沉底(桶内也稳定)。 */
export function sortTimeOf(raw: string): number {
  const cd = raw ? parseCalDate(raw) : null
  if (!cd) return Number.POSITIVE_INFINITY
  return toLocalDate(cd.start).getTime()
}
