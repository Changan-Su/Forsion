/** 关联表(rowlink)列的纯逻辑:芯片文案 / cell 归一 / 删行与改列时的引用清理。无 React,DatabaseEmbed 与
 *  日历 EventCard、dbAggregateStore 共用同一份(别各处再抄一遍 `columns[0]`)。
 *  ⚠️ 这里是渲染层(要 resolveBaseType 认插件注册类型);引擎侧 lookup.ts 的 join 文案走 lookupCol 显式列,不经这里。 */
import { coerceForDisplay, type CellValue, type DbColumn, type DbFile, type DbRow } from '@amadeus-shared/db/schema'
import { resolveBaseType } from './propertyTypes'
import { registerMessages, translate } from '../../../i18n'

registerMessages({
  'dbrowlink.untitled': { zh: '未命名', en: 'Untitled' },
})

/** 计算列(公式/引用):磁盘无值,不能当芯片显示列。与 DatabaseEmbed.isComputed 同判据。 */
export const isComputedCol = (type: string): boolean => type === 'formula' || type === 'lookup'

/** 关联表 cell → 目标行 id 列表:单选存 string、多选存 string[];其它形态(旧脏值)当空。 */
export const rowLinkIds = (v: CellValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : typeof v === 'string' && v ? [v] : []

/** 路径口径归一(refDb 是 vault 相对路径,store 的 path / 嵌入的 ref 可能带 `./` 或反斜杠)。 */
export const normDbPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

/** 本表的各种路径口径(store path / 嵌入 ref)归一成一个集合,给下面两个判据用。 */
export const selfPathSet = (selfPaths: string[]): Set<string> => new Set(selfPaths.map(normDbPath))

/** **自指关联列**:type='rowlink' 且 refDb 指回本表 —— 「父任务」这类列的唯一判据。
 *  层级树(DbView.treeCol)、删行时的引用清理(dropSelfRefs)共用这一条,别在渲染里散着判。 */
export const isSelfRefCol = (c: DbColumn, self: Set<string>): boolean =>
  c.type === 'rowlink' && !!c.refDb && self.has(normDbPath(c.refDb))

/** 可当层级树父列的候选(视图菜单只列这些);顺序 = 全局列序。 */
export const treeColsOf = (columns: DbColumn[], selfPaths: string[]): DbColumn[] => {
  const self = selfPathSet(selfPaths)
  return columns.filter((c) => isSelfRefCol(c, self))
}

/** 视图记的 treeCol 解析:列还在**且**仍是自指关联列才生效,否则 null(改了列类型 / 换了 refDb / 删了列 → 静默回平铺)。
 *  ⚠️ 按 db.columns 解析而**不是**可见列:把父列隐藏起来只看缩进,是最常见的用法。 */
export const resolveTreeCol = (columns: DbColumn[], treeCol: string | undefined, selfPaths: string[]): DbColumn | null => {
  if (!treeCol) return null
  const self = selfPathSet(selfPaths)
  return columns.find((c) => c.id === treeCol && isSelfRefCol(c, self)) ?? null
}

/** 芯片显示列解析:titleCol 找得到且非计算列才用,否则回落目标表 columns[0](缺省 / 列已删 / 误配计算列)。
 *  ⚠️ 回落只是**显示层兜底**(界面永不空白),悬空的 titleCol 由 scripts/rowlink.check.mjs 报 cfg-bad —— 扫描器红了别来改这里。 */
export const titleColOf = (target: DbFile, titleCol?: string): DbColumn | undefined => {
  const c = titleCol ? target.columns.find((x) => x.id === titleCol) : undefined
  return c && !isComputedCol(c.type) ? c : target.columns[0]
}

/** 一行在关联侧的文案(芯片 / 选择器 / 排序键 / 筛选值下拉):按 titleCol 指定列显示,空值「未命名」。 */
export const linkLabel = (target: DbFile, row: DbRow, titleCol?: string): string => {
  const c = titleColOf(target, titleCol)
  if (!c) return translate('dbrowlink.untitled')
  const raw = row.cells[c.id]
  // ponytail: 属性注册表没有「值 → 文本」钩子,自动编号的前缀(ORD-1)在这里特判;它是唯一带显示前缀的内置类型。
  if (c.type === 'autonumber' && typeof raw === 'number') return `${c.prefix ?? ''}${raw}`
  const v = coerceForDisplay(raw, resolveBaseType(c.type))
  const s = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)
  return s.trim() || translate('dbrowlink.untitled')
}

/** dropSelfRefs 摘掉的一条自引用(撤销删行时按它条件回填):rowId/colId 那一格,before = 摘除前的值,after = 摘除后的值(undefined = 键被删)。 */
export interface DroppedRef {
  rowId: string
  colId: string
  before: CellValue | undefined
  after: CellValue | undefined
}

/** 删行清理(**只限同一文件内**):本表其它 rowlink 列若 refDb 指向本表自己,把被删行 id 从它们的 cell 里摘掉。
 *  跨文件的悬空引用刻意**不级联**——删一条库存不该静默改动出库/订单表(那是数据事故不是清理),
 *  跨文件悬空由 scripts/rowlink.check.mjs 报告。selfPaths = 本表的各种路径口径(store path / 嵌入 ref)。
 *  removed(可选出参):每摘一格 push 一条 DroppedRef,给撤销(restoreAggRow)条件回填用 —— after 在这里算、在这里记,单源。 */
export function dropSelfRefs(d: DbFile, rowId: string, selfPaths: string[], removed?: DroppedRef[]): DbFile {
  const self = selfPathSet(selfPaths)
  const selfCols = d.columns.filter((c) => isSelfRefCol(c, self))
  if (!selfCols.length) return d
  let touched = false
  const rows = d.rows.map((r) => {
    let cells: Record<string, CellValue> | null = null
    for (const c of selfCols) {
      const ids = rowLinkIds(r.cells[c.id])
      if (!ids.includes(rowId)) continue
      const rest = ids.filter((x) => x !== rowId)
      cells ??= { ...r.cells }
      if (!rest.length) delete cells[c.id]
      else cells[c.id] = c.multiple || Array.isArray(r.cells[c.id]) ? rest : rest[0]
      removed?.push({ rowId: r.id, colId: c.id, before: r.cells[c.id], after: cells[c.id] })
    }
    if (!cells) return r
    touched = true
    return { ...r, cells }
  })
  return touched ? { ...d, rows } : d
}

/** 关联列失效(**只有**换 refDb / 删列两种)→ 沿它取值的正向 lookup 配置作废:lookupRel 与 lookupCol 一起清
 *  (lookupCol 是旧目标表的列 id,留着也是悬空),列本身保留,ColMenu 显示「待重新配置」。
 *  ⚠️ 关联列改成别的类型**不调这里**:那是可逆的休眠(lookup.ts 只沿 rowlink 列取值,期间为空;改回即恢复),
 *  清了就不可逆 —— 调用点见 DatabaseEmbed.patchCol / delCol。 */
export function detachLookups(columns: DbColumn[], relColId: string): DbColumn[] {
  if (!columns.some((c) => c.type === 'lookup' && c.lookupRel === relColId)) return columns
  return columns.map((c) => (c.type === 'lookup' && c.lookupRel === relColId ? { ...c, lookupRel: undefined, lookupCol: undefined } : c))
}
