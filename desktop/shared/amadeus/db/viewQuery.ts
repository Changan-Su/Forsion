/** 视图查询纯逻辑:每视图筛选求值 + 页脚统计。渲染层唯一消费者。
 *  本文件不认识属性注册表:自定义类型由调用方折算 kind(baseType;calendarDate 列传 'date',
 *  其区间串由 parseCalDate 兼容解析)。未知 op / 未知统计一律温和降级,绝不静默丢行。 */
import { coerceForDisplay, type CellValue, type ColumnType, type DbRow, type DbViewFilter } from './schema'
import { parseCalDate, splitSide } from './calDate'

/** 每 kind 可用的 op(即 UI 菜单顺序);一元 op 见 UNARY_OPS。 */
export const FILTER_OPS: Record<ColumnType, string[]> = {
  text: ['contains', 'notcontains', 'eq', 'ne', 'empty', 'notempty'],
  url: ['contains', 'notcontains', 'eq', 'ne', 'empty', 'notempty'],
  page: ['contains', 'notcontains', 'eq', 'ne'],
  number: ['eq', 'ne', 'gt', 'lt', 'empty', 'notempty'],
  checkbox: ['checked', 'unchecked'],
  date: ['on', 'before', 'after', 'empty', 'notempty'],
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

function isEmptyVal(raw: CellValue | undefined, kind: ColumnType): boolean {
  if (raw == null) return true
  if (kind === 'multiselect') return (coerceForDisplay(raw, 'multiselect') as string[]).length === 0
  if (kind === 'checkbox') return raw !== true
  if (kind === 'number') return coerceForDisplay(raw, 'number') === null
  return str(coerceForDisplay(raw, 'text')).trim() === ''
}

/** 单条件求值。kind = 列的求值语义;未知 op 恒真(旧版本写的新 op 不丢行)。 */
export function matchFilter(raw: CellValue | undefined, f: DbViewFilter, kind: ColumnType): boolean {
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
    const want = Number(fv)
    if (!Number.isFinite(want) || n === null) return false
    if (f.op === 'eq') return n === want
    if (f.op === 'ne') return n !== want
    if (f.op === 'gt') return n > want
    if (f.op === 'lt') return n < want
    return true
  }
  if (kind === 'date') {
    const d = dateOf(raw)
    if (!d || !fv) return false
    if (f.op === 'on') return d === fv
    if (f.op === 'before') return d < fv
    if (f.op === 'after') return d > fv
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
): DbRow[] {
  const live = (filters ?? []).filter((f) => {
    const kind = kindOf(f.colId)
    return kind !== null && FILTER_OPS[kind].includes(f.op)
  })
  if (!live.length) return rows
  const hit = (r: DbRow, f: DbViewFilter): boolean => matchFilter(r.cells[f.colId], f, kindOf(f.colId)!)
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
