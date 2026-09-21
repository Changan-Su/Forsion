/** 规则行折叠(DbView.fold)的纯逻辑:同一折叠键的多行收成一条**汇总行**,可展开回成员行。
 *  只改呈现,绝不动 rows(与 groupRows 同一条纪律)。
 *
 *  折叠键 = by 各列的值(全等)+ 可选时间窗(timeCol 落在同一个 `minutes` 分钟的**本地时钟**窗口里)。
 *  例:API 用量表 `{ by: ['username'], timeCol: 'created_at', minutes: 30 }` = 每个用户每 30 分钟一条。
 *
 *  ⚠️ `server/admin/panel-lib.js` 的 `foldUnits` 是 foldKey / foldTimeMs 的**同语义 JS 移植**(面板按折叠单元分页 +
 *     经典 <table> 回落)。改键的归一、窗口对齐、缺时间的处置,必须两边一起改 —— 否则「面板切的页」与
 *     「原生表折出来的组」对不上,而且不会红任何一边的断言。 */
import type { CellValue, DbColumn, DbRow, DbViewFold } from './schema'

export const FOLD_DEFAULT_MINUTES = 30
/** 一年;再大的窗口没有意义,也防 `minutes * 60000` 之后的除法退化。 */
const FOLD_MAX_MINUTES = 525600

/** 一个折叠单元:rows ≥ 1(只有 1 行的单元照常渲染成普通行,不出汇总行)。 */
export interface FoldUnit { key: string; rows: DbRow[] }
/** 汇总行 + 各列的「混合值」清单(该列成员值不止一种时才有;按首次出现序,日期列按时间升序)。
 *  rowId = 该值的一个样本成员行 —— 渲染端借它取宿主给的装饰(芯片色调 / 日期显示档)。 */
export interface FoldMixedValue { value: CellValue; count: number; rowId: string }
export interface FoldSummary { row: DbRow; mixed: Record<string, FoldMixedValue[]> }

/** 汇总行的合成行 id(永不落盘;React key / 展开态 / 排序回查都用它)。 */
export const foldRowId = (key: string): string => `fold:${key}`

/** 读端归一:非正数 / 非有限数一律回落 30,上限夹到一年。 */
export const foldMinutesOf = (fold: DbViewFold | undefined): number => {
  const m = fold?.minutes
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? Math.min(m, FOLD_MAX_MINUTES) : FOLD_DEFAULT_MINUTES
}

/** 规则按现有列解析:指向已删列的键丢掉;by 与 timeCol 都落空 = null(不折叠)。 */
export function resolveFold(fold: DbViewFold | undefined, columns: DbColumn[]): DbViewFold | null {
  if (!fold) return null
  const ids = new Set(columns.map((c) => c.id))
  const by = [...new Set((fold.by ?? []).filter((id) => ids.has(id)))]
  const timeCol = fold.timeCol && ids.has(fold.timeCol) ? fold.timeCol : undefined
  if (!by.length && !timeCol) return null
  return { by, timeCol, minutes: foldMinutesOf(fold) }
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/
/** 单元格 → 时刻(ms)。三种形状:本地日历串 `YYYY-MM-DD[THH:mm]`(date / calendarDate / created;区间 `a/b` 取起始侧)
 *  **按本地时间**构造 —— 丢给 Date.parse 会把纯日期当 UTC 午夜(calDate.ts 同一条纪律);带时区的 ISO 串(插件表)
 *  走 Date.parse;数字当 epoch ms。取不到 = null。 */
export function foldTimeMs(v: CellValue | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || !v) return null
  const side = v.split('/')[0]
  const m = LOCAL_RE.exec(side)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime()
  const t = Date.parse(side)
  return Number.isNaN(t) ? null : t
}

/** 时间窗序号:按**本地时钟**对齐(30 分钟 = :00 / :30;1440 = 本地自然日),不是 epoch 整除 ——
 *  后者在非整点时区(印度 +5:30)与「按天」窗口上都会切歪。 */
export const foldBucket = (ms: number, minutes: number): number =>
  Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / (minutes * 60000))

/** 键里的一个值:空(null / '' / 缺)归一为 null;数组按 JSON 拼;其余一律转串(1 与 '1' 同键,两条路径的基元类型不必逐字对齐)。 */
const keyPart = (v: CellValue | undefined): string | null =>
  v === null || v === undefined || v === '' ? null : Array.isArray(v) ? JSON.stringify(v) : String(v)

/** 一行的折叠键;`null` = 不可折(配了时间列但这一行没有时刻)—— 它自成一个单元,绝不和别的「没时刻」的行凑一组。 */
export function foldKey(row: DbRow, fold: DbViewFold): string | null {
  const parts: Array<string | number | null> = (fold.by ?? []).map((id) => keyPart(row.cells[id]))
  if (fold.timeCol) {
    const ms = foldTimeMs(row.cells[fold.timeCol])
    if (ms === null) return null
    parts.push(foldBucket(ms, foldMinutesOf(fold)))
  }
  return JSON.stringify(parts)
}

/** 折叠:单元序 = 首次出现序,单元内保持来序(喂的是筛选/排序之后的行)。同键的行**不要求相邻**。 */
export function foldRows(rows: DbRow[], fold: DbViewFold): FoldUnit[] {
  const by = new Map<string, FoldUnit>()
  const out: FoldUnit[] = []
  for (const r of rows) {
    const k = foldKey(r, fold)
    const hit = k === null ? undefined : by.get(k)
    if (hit) { hit.rows.push(r); continue }
    const unit: FoldUnit = { key: k ?? `row:${r.id}`, rows: [r] }
    if (k !== null) by.set(k, unit)
    out.push(unit)
  }
  return out
}

const distinctKey = (v: CellValue | undefined): string => JSON.stringify(v === undefined || v === '' ? null : v)

/** 汇总一个单元。`kindOf` 由渲染边界解析(日期系 = 'date',其余 = 属性注册表折算的基类)。
 *  · number:求和(一个有限数都没有 = null);
 *  · multiselect:并集;
 *  · date:值 = 最晚的那个(按它排序 = 按最近活动排),成员不止一个时刻 → mixed(时间升序,渲染端画「最早 – 最晚」);
 *  · checkbox:全勾才算勾,勾与不勾并存 → mixed;
 *  · 其余:成员值只有一种 = 原值;不止一种 → mixed(首次出现序),汇总值 = 各值按 `, ` 拼接的串(只为排序有个稳定键)。 */
export function foldSummary(unit: FoldUnit, columns: DbColumn[], kindOf: (col: DbColumn) => string): FoldSummary {
  const cells: Record<string, CellValue> = {}
  const mixed: Record<string, FoldMixedValue[]> = {}
  for (const col of columns) {
    const kind = kindOf(col)
    // checkbox 的「缺 / null / false」都是没勾:先归一成布尔,别把它们数成三种值
    const values: Array<CellValue | undefined> = unit.rows.map((r) => (kind === 'checkbox' ? r.cells[col.id] === true : r.cells[col.id]))
    if (kind === 'number') {
      const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      cells[col.id] = nums.length ? nums.reduce((a, b) => a + b, 0) : null
      continue
    }
    if (kind === 'multiselect') {
      cells[col.id] = [...new Set(values.flatMap((v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [])))]
      continue
    }
    const seen = new Map<string, FoldMixedValue>()
    unit.rows.forEach((r, i) => {
      const k = distinctKey(values[i])
      const hit = seen.get(k)
      if (hit) hit.count++
      else seen.set(k, { value: values[i] ?? null, count: 1, rowId: r.id })
    })
    const list = [...seen.values()]
    if (kind === 'date') {
      const at = (x: FoldMixedValue): number => foldTimeMs(x.value) ?? Number.NEGATIVE_INFINITY
      list.sort((a, b) => at(a) - at(b))
      cells[col.id] = list[list.length - 1].value
    } else if (kind === 'checkbox') {
      cells[col.id] = values.every((v) => v === true)
    } else {
      cells[col.id] = list.length === 1 ? list[0].value : list.map((x) => keyPart(x.value) ?? '').filter(Boolean).join(', ')
    }
    if (list.length > 1) mixed[col.id] = list
  }
  return { row: { id: foldRowId(unit.key), cells }, mixed }
}
