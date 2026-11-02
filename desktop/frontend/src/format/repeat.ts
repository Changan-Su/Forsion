import { registerMessages } from '../i18n'

registerMessages({
  'repeat.daily': { zh: '每天', en: 'Daily' },
  'repeat.days': { zh: '每 {n} 天', en: 'Every {n} days' },
  'repeat.hourly': { zh: '每小时', en: 'Hourly' },
  'repeat.hours': { zh: '每 {n} 小时', en: 'Every {n} hours' },
  'repeat.weekly': { zh: '每周', en: 'Weekly' },
  'repeat.weeks': { zh: '每 {n} 周', en: 'Every {n} weeks' },
  'repeat.minute': { zh: '每分钟', en: 'Every minute' },
  'repeat.minutes': { zh: '每 {n} 分钟', en: 'Every {n} minutes' },
})

type T = (key: string, vars?: Record<string, string>) => string

/** 存的重复周期(`1d` / `2h` / `1w` / `90m`,日程与 Muse / 自动化的 every 条件同一种写法)→ 人话。
 *  整小时的分钟进位成小时;认不出的写法原样塞进旧的「每 {ivl}」,不吞掉。 */
export function formatRepeat(t: T, ivl: string): string {
  const m = /^(\d+)([mhdw])$/.exec(ivl.trim())
  let n = m ? Number(m[1]) : 0
  if (!m || n < 1) return t('automation.schedule.every', { ivl })
  let unit = m[2]
  if (unit === 'm' && n % 60 === 0) { n /= 60; unit = 'h' }
  if (unit === 'd') return n === 1 ? t('repeat.daily') : t('repeat.days', { n: String(n) })
  if (unit === 'h') return n === 1 ? t('repeat.hourly') : t('repeat.hours', { n: String(n) })
  if (unit === 'w') return n === 1 ? t('repeat.weekly') : t('repeat.weeks', { n: String(n) })
  return n === 1 ? t('repeat.minute') : t('repeat.minutes', { n: String(n) })
}
