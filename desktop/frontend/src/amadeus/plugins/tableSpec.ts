/**
 * 插件表格规格(TableSpec)→ 多维表数据(DbFile)+ 富单元格边料(cellMeta)的**纯**转换与校验。
 *
 * 为什么单独一个文件(而不是塞进 tableSurface.tsx):
 *  ① 校验必须**同步**从 `ctx.table.mount(...)` 抛出去 —— 插件侧(panel-lib 的 `L.table`)拿 try/catch
 *     判「宿主不收 → 退回经典 <table>」。而 tableSurface 是**动态 import** 的(破 pluginStore ↔ 视图的
 *     静态环,与 dashboard.mount 同款),规格错误若等到 import 落地才抛,就抛进了插件永远看不到的
 *     Promise 里:容器空着、没有降级、也没有报错。故 pluginStore 静态引本文件、先校验再挂载。
 *  ② 这样这层逻辑是**真纯的**:不拉 React、不拉 `@amadeus/blocks`、不拉 DatabaseEmbed,单测在 node 环境
 *     里跑,也不会被隔壁正在改的渲染层带红。
 *
 * 三条口径:
 *  · DbFile 的 cell 只放**基元**(排序/筛选/统计要用),一切装饰(两行文案 / 色调 / 状态点 / 头像 /
 *    等宽 / tooltip / 链接 / 行内按钮)走 `cellMeta[rowId][colId]` 这条边料,绝不混进 cell。
 *  · 列 id = spec 的 `column.key`,行 id = `row.id` —— 与插件侧同一套标识,回调不需要任何映射表。
 *  · `__actions` 是保留列 id(操作列),插件不许自己用。
 */
import { DB_VERSION, type DbColumn, type DbFile, type DbRow, type CellValue } from '@amadeus-shared/db/schema'
import type { TableCell, TableColumn, TableSpec } from './types'

/** 操作列的保留列 id(渲染端按它画按钮)。 */
export const TABLE_ACTIONS_COL = '__actions'

/** 一格的富呈现边料;字段集与 DatabaseEmbed 的 `CellMeta` **结构兼容**(那边是消费端真源,
 *  所以这里 `text` 也只收 string —— 不同形就得在挂载处 cast,cast 会把将来的字段漂移吃掉)。 */
export interface TableCellMeta {
  /** 显示文案:给了就优先于 DbFile 里的基元值(`sortValue` 覆盖了排序值的复合格靠它显示)。 */
  text?: string
  sub?: string
  tone?: 'muted' | 'green' | 'red' | 'amber' | 'blue' | 'accent'
  dot?: 'green' | 'red' | 'yellow' | 'gray'
  mono?: boolean
  title?: string
  avatar?: { src?: string | null; letter?: string; attrs?: Record<string, string> }
  href?: string
  /** 日期列的显示档(列级 `format`,落盘串仍是原样)。 */
  format?: 'datetime' | 'day'
  attrs?: Record<string, string>
  /** 仅 `__actions` 列:该行的按钮。 */
  actions?: import('./types').TableAction[]
}

export type TableCellMetaMap = Record<string, Record<string, TableCellMeta>>

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isPrimitive = (v: unknown): boolean =>
  v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/** 规格非法一律抛这个 —— 文案中英同句:插件作者的控制台里两种语言都读得懂(它不是界面文案)。 */
function bad(zh: string, en: string): never {
  throw new Error(`表格规格无效:${zh} / Invalid table spec: ${en}`)
}

/**
 * 同步校验;非法即抛(调用方按抛 = 降级到经典表格)。
 * 只查**会让渲染端静默出错**的那几类:没列 / 没行数组 / 列 key 与行 id 缺失或重复 / 占用保留列 id /
 * 单元格文案不是基元(塞了 DOM 节点、数组、嵌套对象 —— 那是 HTML 字符串走私的入口)。
 */
export function validateTableSpec(spec: TableSpec): void {
  if (!isObj(spec)) bad('spec 必须是对象', 'spec must be an object')
  if (typeof spec.id !== 'string' || !spec.id) bad('缺少 id', 'missing id')
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) bad('columns 不能为空', 'columns must be a non-empty array')
  if (!Array.isArray(spec.rows)) bad('rows 必须是数组(空数组合法)', 'rows must be an array (empty is fine)')
  const keys = new Set<string>()
  for (const c of spec.columns) {
    if (!isObj(c) || typeof c.key !== 'string' || !c.key) bad('每列都要有非空 key', 'every column needs a non-empty key')
    if (c.key === TABLE_ACTIONS_COL) bad(`列 key "${TABLE_ACTIONS_COL}" 是保留字`, `column key "${TABLE_ACTIONS_COL}" is reserved`)
    if (keys.has(c.key)) bad(`列 key 重复:${c.key}`, `duplicate column key: ${c.key}`)
    keys.add(c.key)
    if (typeof c.label !== 'string') bad(`列 ${c.key} 的 label 必须是字符串`, `column ${c.key}: label must be a string`)
  }
  const ids = new Set<string>()
  for (const r of spec.rows) {
    if (!isObj(r) || typeof r.id !== 'string' || !r.id) bad('每行都要有非空 id', 'every row needs a non-empty id')
    if (ids.has(r.id)) bad(`行 id 重复:${r.id}`, `duplicate row id: ${r.id}`)
    ids.add(r.id)
    if (r.cells !== undefined && !isObj(r.cells)) bad(`行 ${r.id} 的 cells 必须是对象`, `row ${r.id}: cells must be an object`)
    for (const [k, cell] of Object.entries(r.cells ?? {})) {
      if (isPrimitive(cell)) continue
      if (!isObj(cell)) bad(`行 ${r.id} 列 ${k} 的单元格必须是基元或对象`, `row ${r.id} column ${k}: cell must be a primitive or an object`)
      if (!isPrimitive((cell as { text?: unknown }).text)) {
        bad(`行 ${r.id} 列 ${k} 的 text 必须是基元`, `row ${r.id} column ${k}: text must be a primitive`)
      }
    }
  }
}

const KIND_TO_TYPE: Record<TableColumn['kind'], string> = {
  text: 'text', number: 'number', date: 'date', select: 'select', check: 'checkbox', url: 'url',
}

/** 选项色 → 边料色调(spec 的色名比 tone 多两个:yellow→amber、gray→muted)。 */
function toneOfColor(color: string | undefined): TableCellMeta['tone'] | undefined {
  switch (color) {
    case 'green': case 'red': case 'blue': case 'accent': case 'amber': return color
    case 'yellow': return 'amber'
    case 'gray': return 'muted'
    default: return undefined
  }
}

/** 规格里允许携带的属性名(与 panel-lib 的 ATTR_OK 同一张表):只放行 data-* / aria-* 与几个惰性属性。
 *  on* / style / src / href / dangerouslySetInnerHTML 一律丢弃 —— 它们会原样摊成 React props:字符串 style 让整棵树在
 *  渲染期抛错(mount 已成功,插件那侧收不到、也不会回落),src 会绕开头像白名单。丢弃而不是抛:一个坏键不该让整张表白屏。 */
const ATTR_OK = /^(data-[\w.:-]+|aria-[\w-]+|title|id|role|tabindex|lang|dir|hidden|class)$/i
export function safeAttrs(attrs: unknown): Record<string, string> | undefined {
  if (!isObj(attrs)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    if (!ATTR_OK.test(k) || v === null || v === undefined || v === false) continue
    out[k] = String(v)
  }
  return Object.keys(out).length ? out : undefined
}

const cellObj = (cell: TableCell): Record<string, unknown> => (isObj(cell) ? cell : {})
/** 一格的「主文案」:对象格取 text,基元格取自己。 */
function textOf(cell: TableCell): string | number | boolean | null | undefined {
  if (isObj(cell)) return (cell as { text?: string | number | null }).text
  return cell
}

function sortValueOf(cell: TableCell): string | number | undefined {
  const v = (cellObj(cell) as { sortValue?: string | number }).sortValue
  return typeof v === 'string' || typeof v === 'number' ? v : undefined
}

/** 落盘基元值:`sortValue ?? 按列类型折算的主值`(排序/筛选/统计都读它)。 */
function cellValue(kind: TableColumn['kind'], cell: TableCell): CellValue {
  const sv = sortValueOf(cell)
  if (sv !== undefined) return sv
  const o = cellObj(cell)
  if (kind === 'check') {
    const checked = (o as { checked?: boolean }).checked
    if (typeof checked === 'boolean') return checked
    return Boolean(textOf(cell))
  }
  if (kind === 'select') {
    const v = (o as { value?: string }).value
    if (typeof v === 'string') return v
    const t = textOf(cell)
    return t === null || t === undefined ? '' : String(t)
  }
  if (kind === 'number') {
    const t = textOf(cell)
    if (typeof t === 'number') return Number.isFinite(t) ? t : null
    const n = typeof t === 'string' && t.trim() ? Number(t) : NaN
    return Number.isFinite(n) ? n : null
  }
  const t = textOf(cell)
  return t === null || t === undefined ? '' : String(t)
}

/**
 * 列类型:一般照 `kind` 折算;但该列若有 `sortValue`,类型跟着 sortValue 的类型走 ——
 * 复合格(如「1.2万 tokens」)的显示归 cellMeta.text,排序归数值,类型不跟就排成字典序。
 */
function colToDb(col: TableColumn, spec: TableSpec): DbColumn {
  let type = KIND_TO_TYPE[col.kind] ?? 'text'
  for (const r of spec.rows) {
    const sv = sortValueOf((r.cells ?? {})[col.key])
    if (sv === undefined) continue
    type = typeof sv === 'number' ? 'number' : 'text'
    break
  }
  const out: DbColumn = { id: col.key, name: col.label, type }
  if (col.kind === 'select' && Array.isArray(col.options)) out.options = col.options.map((o) => o.value)
  if (typeof col.width === 'number' && col.width > 0) out.width = col.width
  // ponytail: align / nowrap 只由降级路径(panel-lib 的经典 <table>)兑现 —— 原生表有自己的列宽/对齐语汇,
  // 为两个装饰属性去改 DbColumn 落盘格式不值当。
  return out
}

/** TableSpec → DbFile(内存源;`views` 留空 = 单张默认表格视图,只读下视图条自然不出现)。 */
export function specToDb(spec: TableSpec): DbFile {
  validateTableSpec(spec)
  const columns: DbColumn[] = spec.columns.map((c) => colToDb(c, spec))
  if (spec.actions) columns.push({ id: TABLE_ACTIONS_COL, name: spec.actionsLabel ?? '', type: 'text' })
  const rows: DbRow[] = spec.rows.map((r) => {
    const cells: Record<string, CellValue> = {}
    for (const c of spec.columns) cells[c.key] = cellValue(c.kind, (r.cells ?? {})[c.key])
    if (spec.actions) cells[TABLE_ACTIONS_COL] = ''
    return { id: r.id, cells }
  })
  return { version: DB_VERSION, name: spec.id, columns, rows }
}

/** TableSpec → cellMeta 边料(rowId → colId → 装饰)。空装饰的格不占位。 */
export function tableCellMeta(spec: TableSpec): TableCellMetaMap {
  validateTableSpec(spec)
  const optionOf = new Map<string, Map<string, { value: string; label?: string; color?: string }>>()
  for (const c of spec.columns) {
    if (c.kind !== 'select' || !Array.isArray(c.options)) continue
    optionOf.set(c.key, new Map(c.options.map((o) => [o.value, o])))
  }
  const out: TableCellMetaMap = {}
  for (const r of spec.rows) {
    const row: Record<string, TableCellMeta> = {}
    for (const c of spec.columns) {
      const cell = (r.cells ?? {})[c.key]
      const o = cellObj(cell)
      const meta: TableCellMeta = {}
      // meta.text 只当「显示覆盖」:复合格(给了 sortValue,基元存的是排序键)与「该列类型消化不了的文案」
      // (number 列的「—」、date 列的「永不」)才需要;普通格的基元值本身就是要显示的 —— 再塞 meta.text 会短路掉
      // 渲染层的 date/number 格式化(日期渲成裸 ISO、数字丢千分位),两条路径就对不上了。
      {
        const t = textOf(cell)
        const s = t === null || t === undefined ? '' : String(t)
        const unparsable = s !== '' && ((c.kind === 'number' && !Number.isFinite(Number(s))) || (c.kind === 'date' && Number.isNaN(Date.parse(s))))
        if (sortValueOf(cell) !== undefined || unparsable) meta.text = s
      }
      const opt = optionOf.get(c.key)?.get(String(cellValue(c.kind, cell)))
      if (opt?.label !== undefined && meta.text === undefined) meta.text = opt.label
      const tone = (o as { tone?: TableCellMeta['tone'] }).tone ?? toneOfColor(opt?.color)
      if (tone) meta.tone = tone
      for (const k of ['sub', 'dot', 'title', 'href'] as const) {
        const v = (o as Record<string, unknown>)[k]
        if (typeof v === 'string' && v) (meta as Record<string, unknown>)[k] = v
      }
      if ((o as { mono?: boolean }).mono || c.mono) meta.mono = true
      if (c.kind === 'date') meta.format = c.format ?? 'datetime' // 契约默认 datetime;不给的话渲染层拿裸 ISO 没法格式化
      if (isObj((o as { avatar?: unknown }).avatar)) {
        const av = (o as { avatar: NonNullable<TableCellMeta['avatar']> }).avatar
        meta.avatar = { ...av, attrs: safeAttrs(av.attrs) }
      }
      const attrs = safeAttrs((o as { attrs?: unknown }).attrs)
      if (attrs) meta.attrs = attrs
      if (Object.keys(meta).length) row[c.key] = meta
    }
    if (spec.actions) {
      const acts = spec.actions(r)
      if (Array.isArray(acts) && acts.length) row[TABLE_ACTIONS_COL] = { actions: acts.map((a) => ({ ...a, attrs: safeAttrs(a.attrs) })) }
    }
    if (Object.keys(row).length) out[r.id] = row
  }
  return out
}
