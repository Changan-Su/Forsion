/** Muse 面板里的时间写法(11-07 右栏改版):今天 / 明天写「今天 20:00」,更远写月日 + 时刻,不是今年才带年份。
 *  从前追踪日程一律带年份(`fmtCalDateYL`),为的是跨年的同月同日分得开;「不是今年才带」同样分得开,第一眼又不被年份占掉。 */
import { parseCalDate, splitSide } from '@amadeus-shared/db/calDate'
import { formatDate, formatDayTime, formatTime } from '../format/time'

/** 单独成列的时间句首大写(英文 `today 20:00` → `Today 20:00`);中文原样。句中引用别用它。 */
export const colTime = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** 一侧(`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`)→ 本地 Date;两侧各自判断带没带时刻(区间可以一侧全天一侧带时刻)。 */
const sideDate = (side: string): { d: Date; timed: boolean } => {
  const { date, time } = splitSide(side)
  const [y, m, day] = date.split('-').map(Number)
  const [hh, mm] = time ? time.split(':').map(Number) : [0, 0]
  return { d: new Date(y, m - 1, day, hh, mm), timed: !!time }
}

/** 追踪日程(SCHEDULE.db 的 date 列,`start[/end]`,每侧 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`)。读不懂就原样给回去,不吞。
 *  同一天的时段写「今天 20:00–21:00」,跨天写「今天 20:00 → 明天 09:00」。 */
export function trackWhen(raw: string, now = Date.now()): string {
  const c = parseCalDate(raw)
  if (!c) return raw
  const one = ({ d, timed }: { d: Date; timed: boolean }): string => (timed ? formatDayTime(d, { now }) : formatDate(d, { now }))
  const a = sideDate(c.start)
  const left = colTime(one(a))
  if (!c.end) return left
  const b = sideDate(c.end)
  if (splitSide(c.start).date === splitSide(c.end).date) return a.timed && b.timed ? `${left}–${formatTime(b.d)}` : left
  return `${left} → ${one(b)}`
}

type Tr = (k: string, v?: Record<string, string | number>) => string

/** 一轮用了多久:不到一分钟写秒,不到一小时写分钟,再长写几小时几分。负数 / 读不出 → ''。 */
export function roundDuration(ms: number, t: Tr): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return t('musePanel.dur.s', { n: Math.max(1, s) })
  const m = Math.round(s / 60)
  if (m < 60) return t('musePanel.dur.m', { n: m })
  return t('musePanel.dur.h', { h: Math.floor(m / 60), m: m % 60 })
}

/** 怎么醒的(引擎 cycleTrigger 的原串 → 一句话)。规则按 id 查当前规则表,删掉了的只写「规则」;日程写第一条的名字;
 *  升级前跑的轮次没记(null)/ 认不出 → ''。 */
export function roundTrigger(trigger: string | null, t: Tr, ruleName: (id: string) => string | undefined): string {
  if (!trigger) return ''
  if (trigger === 'manual') return t('musePanel.by.manual')
  if (trigger === 'heartbeat') return t('musePanel.by.heartbeat')
  if (trigger.startsWith('rule:')) {
    const name = ruleName(trigger.slice(5).split('+')[0])
    return name ? t('musePanel.by.rule', { name }) : t('musePanel.by.ruleAny')
  }
  if (trigger.startsWith('schedule:')) return t('musePanel.by.schedule', { name: trigger.slice(9).split('+')[0] })
  return ''
}

/** 第二行:这一轮做了什么(写了几个文件、提了几条待办,引擎从检查点和待办表数出来,不让模型另写摘要)/ 为什么没做完。 */
export function roundOutcome(r: { status: string; files: number; todos: number; error: string | null }, t: Tr): string {
  if (r.status === 'failed') return t('musePanel.roundFailed', { e: (r.error || '').slice(0, 120) || '—' })
  if (r.status === 'aborted') return t('musePanel.roundAborted')
  const parts = [
    r.files > 0 ? (r.files === 1 ? t('musePanel.files1') : t('musePanel.filesN', { n: r.files })) : '',
    r.todos > 0 ? (r.todos === 1 ? t('musePanel.todos1') : t('musePanel.todosN', { n: r.todos })) : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : t('musePanel.roundQuiet')
}
