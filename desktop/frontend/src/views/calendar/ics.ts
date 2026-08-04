/**
 * 极小 iCalendar(RFC 5545)读取器 —— 够读 Google / Outlook / Apple 的订阅链接和导出文件。
 * 产出直接就是日历的存储格式(`YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`,本地时区,`start/end` 拼接),
 * 所以订阅源和本地多维表在渲染层完全同形,不需要第二套事件模型。
 *
 * ponytail 的天花板(有意为之,写在这儿免得下次重新推演):
 *  · **TZID 一律按本地墙钟读**(不解析 VTIMEZONE)。带 `Z` 的 UTC 会正确换算,且**循环也在 UTC 上展开**
 *    (见 expandRrule 的 cal 参数);只有「日历时区 ≠ 本机时区」且事件写成 TZID 形式时会整体差一个时区。
 *  · RRULE 只做 FREQ=DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL / COUNT / UNTIL / BYDAY(周)。
 *    BYSETPOS、BYMONTHDAY 组合、RDATE 不做 —— 真遇到再说。
 *  · 循环只在 horizon 窗口内展开且封顶实例数:订阅是只读叠加,不值当为「三年后的周会」算全量。
 */
import { fmtStamp } from './dateUtils'

export interface IcsEvent {
  uid: string
  summary: string
  /** 'YYYY-MM-DD'(全天)或 'YYYY-MM-DDTHH:mm' */
  start: string
  /** 结束(含):全天事件已把 ICS 的「排他 DTEND」按**日历日**减回一天 */
  end?: string
  allDay: boolean
  location?: string
}

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const MAX_INSTANCES_PER_RULE = 400
const MAX_ITER = 20_000

/** RFC 3.1 折行还原:以空格/制表符开头的行是上一行的续行。 */
function unfold(text: string): string[] {
  const out: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (out.length && (raw.startsWith(' ') || raw.startsWith('\t'))) out[out.length - 1] += raw.slice(1)
    else out.push(raw)
  }
  return out
}

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

/** `NAME;TZID=Asia/Shanghai:VALUE` → 拆解。冒号要找**引号外**的第一个(参数值里可能带 `:`)。 */
function parseProp(line: string): Prop | null {
  let cut = -1
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (c === ':' && !quoted) { cut = i; break }
  }
  if (cut < 0) return null
  const [name, ...rest] = line.slice(0, cut).split(';')
  const params: Record<string, string> = {}
  for (const p of rest) {
    const j = p.indexOf('=')
    if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, '')
  }
  return { name: name.toUpperCase(), params, value: line.slice(cut + 1) }
}

/** TEXT 值转义还原(`\n` `\,` `\;` `\\`)。 */
function untext(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

export interface IcsDate {
  d: Date
  allDay: boolean
  /** 值带 `Z`:锚在 UTC,循环也必须在 UTC 上推(否则跨夏令时整条序列的墙钟会错一小时)。 */
  utc: boolean
}

/**
 * ICS 日期/时间值 → Date。**非法值一律回 null,绝不让 JS 的自动归一悄悄改成另一天**
 * (`20260229`(非闰年)会变成 3/1、`T250000` 会滚到次日 —— 那是静默错数据,不是容错)。
 */
function icsDate(value: string, params: Record<string, string> = {}): IcsDate | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const [, ys, mos, das, hhs, mis, sss, z] = m
  const [y, mo, da] = [+ys, +mos, +das]
  const [hh, mi, ss] = [+(hhs || 0), +(mis || 0), +(sss || 0)]
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || hh > 23 || mi > 59 || ss > 60) return null
  const allDay = params.VALUE === 'DATE' || !hhs
  const utc = !!z && !allDay
  const d = allDay
    ? new Date(y, mo - 1, da)
    : utc
      ? new Date(Date.UTC(y, mo - 1, da, hh, mi, ss))
      : new Date(y, mo - 1, da, hh, mi, ss)
  // 归一检测:构造回来的年月日必须与输入一致(2 月 30 日之类会被 JS 静默顺延)。
  const [gy, gm, gd] = utc ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] : [d.getFullYear(), d.getMonth() + 1, d.getDate()]
  if (gy !== y || gm !== mo || gd !== da) return null
  return { d, allDay, utc }
}

/** ISO 8601 时长 `P1DT2H30M` → 毫秒;不认识回 null。 */
function durationMs(s: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim())
  if (!m) return null
  const [, sign, w, d, h, mi, sec] = m
  const ms = ((+(w || 0) * 7 + +(d || 0)) * 86400 + +(h || 0) * 3600 + +(mi || 0) * 60 + +(sec || 0)) * 1000
  return sign === '-' ? -ms : ms
}

/** 日历运算的坐标系:同一套展开逻辑,既能跑本地墙钟也能跑 UTC(带 `Z` 的 DTSTART 用后者)。 */
interface Cal {
  parts(d: Date): [number, number, number, number, number, number]
  make(y: number, mo: number, da: number, h: number, mi: number, s: number): Date
  dow(d: Date): number
}
const LOCAL: Cal = {
  parts: (d) => [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()],
  make: (y, mo, da, h, mi, s) => new Date(y, mo, da, h, mi, s),
  dow: (d) => d.getDay(),
}
const UTC: Cal = {
  parts: (d) => [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()],
  make: (y, mo, da, h, mi, s) => new Date(Date.UTC(y, mo, da, h, mi, s)),
  dow: (d) => d.getUTCDay(),
}

/** 两个 Date 相差多少个自然日(按 UTC 毫秒粗算,只用于「快进到窗口附近」的下界估计)。 */
const daysBetween = (a: Date, b: Date): number => Math.floor((+b - +a) / 86400_000)

/**
 * 展开 RRULE:回落在 [from, to] 里的起始时刻。
 * 第 n 次出现一律**从原始 DTSTART 重算**(不是在上一次结果上累加),否则夏令时切换会让整条序列漂移;
 * MONTHLY/YEARLY 撞上不存在的日子(1/31 + 1 月、2/29)按 RFC **跳过且不计入 COUNT**,不顺延到次月 1 号。
 */
function expandRrule(start: Date, rule: string, from: Date, to: Date, cal: Cal): Date[] {
  const p: Record<string, string> = {}
  for (const kv of rule.split(';')) {
    const i = kv.indexOf('=')
    if (i > 0) p[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1)
  }
  const freq = (p.FREQ || '').toUpperCase()
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return [start]
  const interval = Math.max(1, Number(p.INTERVAL) || 1)
  const count = p.COUNT ? Number(p.COUNT) : Infinity
  const until = p.UNTIL ? (icsDate(p.UNTIL)?.d ?? null) : null
  const byday = (p.BYDAY || '')
    .split(',')
    .map((s) => s.trim().toUpperCase().replace(/^[+-]?\d+/, '')) // 去掉 `2MO` 这种序数前缀(序数语义不做)
    .filter((s) => WD.includes(s))

  const [y, mo, da, h, mi, sec] = cal.parts(start)
  /** 第 n 个周期里的候选时刻(按时间升序);不存在的日子回空。 */
  const slotsAt = (n: number): Date[] => {
    if (freq === 'WEEKLY' && byday.length) {
      const monday = da - ((cal.dow(start) + 6) % 7) + n * interval * 7 // 周一为周首(RFC 默认 WKST=MO)
      return byday
        .map((w) => cal.make(y, mo, monday + ((WD.indexOf(w) + 6) % 7), h, mi, sec))
        .sort((a, b) => +a - +b)
    }
    if (freq === 'DAILY') return [cal.make(y, mo, da + n * interval, h, mi, sec)]
    if (freq === 'WEEKLY') return [cal.make(y, mo, da + n * interval * 7, h, mi, sec)]
    if (freq === 'MONTHLY') {
      const d = cal.make(y, mo + n * interval, da, h, mi, sec)
      return cal.parts(d)[2] === da ? [d] : []
    }
    const d = cal.make(y + n * interval, mo, da, h, mi, sec)
    const q = cal.parts(d)
    return q[1] === mo && q[2] === da ? [d] : []
  }

  // 快进:2010 年起的无限 DAILY 规则,从 n=0 逐次空转会在走到今年之前就撞上 MAX_ITER 而返回空。
  // **只在没有 COUNT 时快进** —— 有 COUNT 时 emitted 必须从第一次出现开始数,不能跳。
  let n = 0
  if (count === Infinity && start < from) {
    const days = daysBetween(start, from)
    if (freq === 'DAILY') n = Math.floor(days / interval)
    else if (freq === 'WEEKLY') n = Math.floor(days / 7 / interval)
    else if (freq === 'MONTHLY') n = Math.floor(days / 31 / interval)
    else n = Math.floor(days / 366 / interval)
    n = Math.max(0, n - 1) // 退一格,宁可多算一个周期也不能跳掉边界上那次
  }

  const out: Date[] = []
  let emitted = 0
  for (let i = 0; i < MAX_ITER && emitted < count && out.length < MAX_INSTANCES_PER_RULE; i++, n++) {
    const slots = slotsAt(n)
    if (slots.length && slots[0] > to) break // 整个周期都越过窗口右界 → 后面只会更晚
    for (const s of slots) {
      if (s < start) continue // 首个周期里早于 DTSTART 的那几天不算
      if (until && s > until) return out
      if (emitted >= count) return out
      emitted++
      if (s >= from && s <= to) out.push(s)
      if (out.length >= MAX_INSTANCES_PER_RULE) return out
    }
  }
  return out
}

/** `X-WR-CALNAME`(订阅显示名);没有回 undefined。 */
export function icsCalendarName(text: string): string | undefined {
  for (const line of unfold(text)) {
    const p = parseProp(line)
    if (p?.name === 'X-WR-CALNAME') return untext(p.value).trim() || undefined
  }
  return undefined
}

/** 看起来是不是一份 iCalendar(用来挡「订阅地址过期后返回 200 登录页」这类假成功)。 */
export function looksLikeIcs(text: string): boolean {
  return /^BEGIN:VCALENDAR/im.test(text)
}

export interface ParseIcsOptions {
  /** 展开循环事件的窗口(默认 now-180d ~ now+540d)。按**整天**取:from 归到当日 0 点、
   *  to 归到当日 23:59:59 —— 否则传 `new Date(y,m,d)` 当右界会把那天 0 点之后的事件全漏掉。 */
  from?: Date
  to?: Date
}

/** 加减「日历日」:跨夏令时那周,一天不是 86400 秒,固定毫秒运算会算少/算多一天。 */
function addCalendarDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds())
}

/** 解析整份 .ics → 事件列表(循环已在窗口内展开)。 */
export function parseIcs(text: string, opts: ParseIcsOptions = {}): IcsEvent[] {
  const now = new Date()
  const f = opts.from ?? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 180)
  const t = opts.to ?? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 540)
  const from = new Date(f.getFullYear(), f.getMonth(), f.getDate())
  const to = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59, 999)

  interface Raw {
    uid: string
    summary: string
    location?: string
    start?: IcsDate
    end?: IcsDate
    duration?: number
    rrule?: string
    exdates: Set<number>
    recurrenceId?: Date
  }
  const raws: Raw[] = []
  let cur: Raw | null = null
  let nested = 0 // VALARM 等**嵌套组件**的深度:里头也有 SUMMARY / DURATION,漏判会顶掉事件自己的值
  for (const line of unfold(text)) {
    if (line.startsWith('BEGIN:VEVENT')) { cur = { uid: '', summary: '', exdates: new Set() }; nested = 0; continue }
    if (line.startsWith('END:VEVENT')) { if (cur) raws.push(cur); cur = null; nested = 0; continue }
    if (!cur) continue
    if (line.startsWith('BEGIN:')) { nested++; continue }
    if (line.startsWith('END:')) { nested = Math.max(0, nested - 1); continue }
    if (nested > 0) continue // 还在 VALARM 里,这些属性不属于事件
    const p = parseProp(line)
    if (!p) continue
    switch (p.name) {
      case 'UID': cur.uid = p.value.trim(); break
      case 'SUMMARY': cur.summary = untext(p.value).trim(); break
      case 'LOCATION': cur.location = untext(p.value).trim() || undefined; break
      case 'DTSTART': cur.start = icsDate(p.value, p.params) ?? undefined; break
      case 'DTEND': cur.end = icsDate(p.value, p.params) ?? undefined; break
      case 'DURATION': cur.duration = durationMs(p.value) ?? undefined; break
      case 'RRULE': cur.rrule = p.value.trim(); break
      case 'RECURRENCE-ID': cur.recurrenceId = icsDate(p.value, p.params)?.d; break
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const d = icsDate(v, p.params)?.d
          if (d) cur.exdates.add(+d)
        }
        break
    }
  }

  // RECURRENCE-ID = 对某一次的单独改期/改名:那一次要从母序列里剔掉,再把改后的当独立事件加进来。
  const overridden = new Map<string, Set<number>>()
  for (const r of raws) {
    if (!r.recurrenceId) continue
    const set = overridden.get(r.uid) ?? new Set<number>()
    set.add(+r.recurrenceId)
    overridden.set(r.uid, set)
  }

  const out: IcsEvent[] = []
  for (const r of raws) {
    if (!r.start) continue
    const { allDay } = r.start
    // 全天事件的 DTEND 是**排他**的,减回一天才是「含」的结束日 —— 必须按**日历日**减,
    // 不能减固定 86400000ms:跨春季夏令时那两天只差 47 小时,固定毫秒会把两天的假期算成一天。
    let spanMs: number | null = null
    let allDayEnd: Date | null = null
    if (allDay) {
      const exclusiveEnd = r.end ? r.end.d : r.duration != null ? new Date(+r.start.d + r.duration) : null
      if (exclusiveEnd) {
        const inclusive = addCalendarDays(exclusiveEnd, -1)
        allDayEnd = inclusive > r.start.d ? inclusive : null
      }
    } else if (r.end) spanMs = +r.end.d - +r.start.d
    else if (r.duration != null) spanMs = r.duration

    const skip = r.recurrenceId ? null : overridden.get(r.uid)
    const cal = r.start.utc ? UTC : LOCAL
    const starts = r.rrule && !r.recurrenceId ? expandRrule(r.start.d, r.rrule, from, to, cal) : [r.start.d]
    const allDaySpanDays = allDayEnd ? Math.round((+allDayEnd - +r.start.d) / 86400_000) : 0
    for (const s of starts) {
      if (r.exdates.has(+s) || skip?.has(+s)) continue
      const endDate = allDayEnd
        ? addCalendarDays(s, allDaySpanDays)
        : spanMs != null && spanMs > 0
          ? new Date(+s + spanMs)
          : null
      out.push({
        uid: starts.length > 1 ? `${r.uid}@${+s}` : r.uid || `${+s}`,
        summary: r.summary,
        location: r.location,
        allDay,
        start: fmtStamp(s, allDay),
        end: endDate ? fmtStamp(endDate, allDay) : undefined,
      })
    }
  }
  return out
}
