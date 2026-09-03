/** 视图查询纯逻辑:每视图筛选求值 + 页脚统计。渲染层唯一消费者。
 *  本文件不认识属性注册表:自定义类型由调用方折算 kind(baseType;calendarDate 列传 'date',
 *  其区间串由 parseCalDate 兼容解析)。未知 op / 未知统计一律温和降级,绝不静默丢行。
 *
 *  区间与相对日期(2026-09-02+):
 *  - `between`(number / date)闭区间;value 为 `[lo, hi]`(string[])或 `'lo..hi'` 单串(仅有单个文本框的
 *    UI 也能填);缺一端 / 不是数 / **非法日期** / lo>hi → 不命中(不交换,不抛);
 *  - date 类 op 的 value 都可以写相对日期:`today` / `yesterday` / `tomorrow` / `±Nd` / `±Nw`(相对当前本地日),
 *    落盘的是记号本身,每次求值时按 `now` 折算 —— 「最近 7 天」= `between ['-7d','today']` 永远不过期。
 *  - **日期边界 fail-closed**(2026-09-02,Codex 评审):date 类 op 的边界一律先经 `resolveDateBound` 折算成
 *    真实的本地日,折不出来(`zzzz` / `0000` / `2026-02-30`)= 该条件不匹配任何行。此前是原样字符串比大小,
 *    `before zzzz` / `between 0000..zzzz` 会命中全表 —— OR 视图或绑定指标卡里一条坏条件就暴露全部行。 */
import { coerceForDisplay, type CellValue, type ColumnType, type DbRow, type DbViewFilter } from './schema'
import { isRealDate, parseCalDate, splitSide } from './calDate'

/** 每 kind 可用的 op(即 UI 菜单顺序);一元 op 见 UNARY_OPS。 */
export const FILTER_OPS: Record<ColumnType, string[]> = {
  text: ['contains', 'notcontains', 'eq', 'ne', 'empty', 'notempty'],
  url: ['contains', 'notcontains', 'eq', 'ne', 'empty', 'notempty'],
  page: ['contains', 'notcontains', 'eq', 'ne'],
  number: ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'between', 'empty', 'notempty'],
  checkbox: ['checked', 'unchecked'],
  date: ['on', 'before', 'after', 'gte', 'lte', 'between', 'empty', 'notempty'],
  select: ['eq', 'ne', 'empty', 'notempty'],
  multiselect: ['has', 'nothas', 'empty', 'notempty'],
}

export const OP_LABEL: Record<string, string> = {
  contains: '包含',
  notcontains: '不包含',
  eq: '是',
  ne: '不是',
  gt: '大于',
  lt: '小于',
  gte: '大于等于',
  lte: '小于等于',
  between: '介于',
  on: '是当天',
  before: '早于',
  after: '晚于',
  has: '含',
  nothas: '不含',
  empty: '为空',
  notempty: '不为空',
  checked: '已勾选',
  unchecked: '未勾选',
}

/** 不需要 value 的一元 op。 */
export const UNARY_OPS = new Set(['empty', 'notempty', 'checked', 'unchecked'])

const str = (v: CellValue | undefined): string => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v))

/** 单日与区间统一取「开始日」:'YYYY-MM-DD' 本身是合法单日 calDate。 */
const dateOf = (v: CellValue | undefined): string => {
  const c = typeof v === 'string' ? parseCalDate(v) : null
  return c ? splitSide(c.start).date : ''
}

/** 本地日键 `'YYYY-MM-DD'`。既是相对日期折算的基准,也给渲染层当**天粒度缓存键**用
 *  (含相对日期的筛选跨过本地午夜就该重算 —— 见 views/dashDataCards 的 useDayKey)。 */
export function localDayKey(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 筛选值里的日期:相对记号(`today` / `yesterday` / `tomorrow` / `±Nd` / `±Nw`,大小写不敏感)按 now 折算成
 *  本地 'YYYY-MM-DD';其余原样返回 trim 后的串(绝对日期 / 空串)。 */
export function resolveDateValue(v: CellValue | undefined, now: Date = new Date()): string {
  const s = str(v).trim()
  const low = s.toLowerCase()
  const shift = (days: number): string => localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days))
  if (low === 'today') return shift(0)
  if (low === 'yesterday') return shift(-1)
  if (low === 'tomorrow') return shift(1)
  const m = /^([+-])(\d+)([dw])$/.exec(low)
  if (m) return shift(Number(m[1] + m[2]) * (m[3] === 'w' ? 7 : 1))
  return s
}

/** date 类筛选的**边界**:折算成可比较的本地日 `'YYYY-MM-DD'`;折不出真实日期一律 `''`,
 *  调用方按 fail-closed 处理(该条件不匹配任何行),与本仓「解析不到就失败即关」的既有纪律一致。
 *  认这些:相对记号(先经 resolveDateValue)、`'YYYY-MM-DD'`、日历列的落盘形态 `'YYYY-MM-DDTHH:mm'`
 *  与区间串 `'start/end'`(都取开始日)。形状对但那天不存在(`2026-02-30`)也算非法。
 *  ⚠️ 刻意不收紧 `resolveDateValue` 本身:它的契约是「只折算记号,其余原样透传」,别处也这么用。
 *  ⚠️ 带时刻的边界被归一到「天」:`before 2026-09-10T14:00` 现在按 `< 2026-09-10` 比 —— 单元格那侧
 *     本来就只取开始日(dateOf),两侧同粒度才不会出现「同一天既不早于也不晚于」的空洞。 */
export function resolveDateBound(v: CellValue | undefined, now: Date = new Date()): string {
  const day = dateOf(resolveDateValue(v, now))
  return day && isRealDate(day) ? day : ''
}

/** between 的两端:`[lo, hi]` 或 `'lo..hi'`;形态不对 → null(调用方按不命中处理)。 */
const boundsOf = (v: CellValue | undefined): [string, string] | null => {
  if (Array.isArray(v)) return v.length === 2 ? [str(v[0]).trim(), str(v[1]).trim()] : null
  const s = str(v)
  const i = s.indexOf('..')
  return i >= 0 ? [s.slice(0, i).trim(), s.slice(i + 2).trim()] : null
}

function isEmptyVal(raw: CellValue | undefined, kind: ColumnType): boolean {
  if (raw == null) return true
  if (kind === 'multiselect') return (coerceForDisplay(raw, 'multiselect') as string[]).length === 0
  if (kind === 'checkbox') return raw !== true
  if (kind === 'number') return coerceForDisplay(raw, 'number') === null
  return str(coerceForDisplay(raw, 'text')).trim() === ''
}

/** 单条件求值。kind = 列的求值语义;未知 op 恒真(旧版本写的新 op 不丢行)。now 只给相对日期折算用(测试注入)。 */
export function matchFilter(raw: CellValue | undefined, f: DbViewFilter, kind: ColumnType, now: Date = new Date()): boolean {
  switch (f.op) {
    case 'empty':
      return isEmptyVal(raw, kind)
    case 'notempty':
      return !isEmptyVal(raw, kind)
    case 'checked':
      return raw === true
    case 'unchecked':
      return raw !== true
  }
  const fv = str(f.value).trim()
  if (kind === 'number') {
    const n = coerceForDisplay(raw, 'number') as number | null
    if (n === null) return false
    if (f.op === 'between') {
      const b = boundsOf(f.value)
      if (!b || b[0] === '' || b[1] === '') return false
      const [lo, hi] = [Number(b[0]), Number(b[1])]
      return Number.isFinite(lo) && Number.isFinite(hi) && n >= lo && n <= hi
    }
    const want = Number(fv)
    if (!Number.isFinite(want)) return false
    if (f.op === 'eq') return n === want
    if (f.op === 'ne') return n !== want
    if (f.op === 'gt') return n > want
    if (f.op === 'lt') return n < want
    if (f.op === 'gte') return n >= want
    if (f.op === 'lte') return n <= want
    return true
  }
  if (kind === 'date') {
    const d = dateOf(raw)
    if (!d) return false
    if (f.op === 'between') {
      const b = boundsOf(f.value)
      if (!b) return false
      const [lo, hi] = [resolveDateBound(b[0], now), resolveDateBound(b[1], now)]
      return lo !== '' && hi !== '' && d >= lo && d <= hi // lo>hi 自然落空(不交换)
    }
    const want = resolveDateBound(f.value, now)
    if (!want) return false
    if (f.op === 'on') return d === want
    if (f.op === 'before') return d < want
    if (f.op === 'after') return d > want
    if (f.op === 'gte') return d >= want
    if (f.op === 'lte') return d <= want
    return true
  }
  if (kind === 'multiselect') {
    const arr = coerceForDisplay(raw, 'multiselect') as string[]
    if (f.op === 'has') return arr.includes(fv)
    if (f.op === 'nothas') return !arr.includes(fv)
    return true
  }
  const v = str(coerceForDisplay(raw, kind === 'select' ? 'select' : 'text')).toLowerCase()
  const want = fv.toLowerCase()
  if (f.op === 'eq') return v === want
  if (f.op === 'ne') return v !== want
  if (f.op === 'contains') return want === '' || v.includes(want)
  if (f.op === 'notcontains') return want === '' || !v.includes(want)
  return true
}

/** 条件组合;kindOf 由调用方按列折算。mode 缺省 'and'(全部满足),'or' = 任一满足。
 *  找不到列、或该 kind 不认识的 op(如改列类型留下的陈旧条件)的条件都先剔除:
 *  AND 下等价于旧的「未知恒真」;OR 下不剔会让一条废条件放行全部行。 */
export function applyFilters(
  rows: DbRow[],
  filters: DbViewFilter[] | undefined,
  kindOf: (colId: string) => ColumnType | null,
  mode?: string,
  now: Date = new Date(),
): DbRow[] {
  const live = (filters ?? []).filter((f) => {
    const kind = kindOf(f.colId)
    return kind !== null && FILTER_OPS[kind].includes(f.op)
  })
  if (!live.length) return rows
  const hit = (r: DbRow, f: DbViewFilter): boolean => matchFilter(r.cells[f.colId], f, kindOf(f.colId)!, now)
  return mode === 'or'
    ? rows.filter((r) => live.some((f) => hit(r, f)))
    : rows.filter((r) => live.every((f) => hit(r, f)))
}

/** 多列排序(稳定;逐层比较):keyOf 把一行折算成该列的排序键(数字对数字比大小,否则中文字典序)。 */
export function applySorts(
  rows: DbRow[],
  sorts: Array<{ colId: string; dir: 'asc' | 'desc' }>,
  keyOf: (row: DbRow, colId: string) => string | number,
): DbRow[] {
  if (!sorts.length) return rows
  return [...rows].sort((a, b) => {
    for (const s of sorts) {
      const ka = keyOf(a, s.colId)
      const kb = keyOf(b, s.colId)
      const cmp = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), 'zh')
      if (cmp !== 0) return s.dir === 'asc' ? cmp : -cmp
    }
    return 0
  })
}

// ── 页脚统计 ────────────────────────────────────────────────────────────────

export const STAT_LABEL: Record<string, string> = {
  count: '已填',
  empty: '空',
  sum: '求和',
  avg: '平均',
  min: '最小',
  max: '最大',
  checked: '已勾选',
  unchecked: '未勾选',
}

/** 每 kind 可选统计(UI 菜单顺序)。 */
export function statOptionsFor(kind: ColumnType): string[] {
  if (kind === 'number') return ['count', 'empty', 'sum', 'avg', 'min', 'max']
  if (kind === 'checkbox') return ['checked', 'unchecked', 'count', 'empty']
  return ['count', 'empty']
}

const trimNum = (n: number): string => {
  const s = n.toFixed(2)
  return s.replace(/\.?0+$/, '')
}

/** 统计值文本;未知统计返回 ''(渲染端显示为未设置)。 */
export function computeStat(rows: DbRow[], colId: string, kind: ColumnType, stat: string): string {
  if (stat === 'count') return String(rows.filter((r) => !isEmptyVal(r.cells[colId], kind)).length)
  if (stat === 'empty') return String(rows.filter((r) => isEmptyVal(r.cells[colId], kind)).length)
  if (stat === 'checked') return String(rows.filter((r) => r.cells[colId] === true).length)
  if (stat === 'unchecked') return String(rows.filter((r) => r.cells[colId] !== true).length)
  const nums = rows
    .map((r) => coerceForDisplay(r.cells[colId], 'number') as number | null)
    .filter((n): n is number => n !== null)
  if (stat === 'sum') return trimNum(nums.reduce((a, b) => a + b, 0))
  if (nums.length === 0) return '–'
  if (stat === 'avg') return trimNum(nums.reduce((a, b) => a + b, 0) / nums.length)
  if (stat === 'min') return trimNum(Math.min(...nums))
  if (stat === 'max') return trimNum(Math.max(...nums))
  return ''
}
