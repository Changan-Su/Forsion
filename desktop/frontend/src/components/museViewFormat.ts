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
