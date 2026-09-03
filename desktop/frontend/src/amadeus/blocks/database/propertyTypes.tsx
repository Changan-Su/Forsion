/** 多维表「属性类型注册表」—— 面向插件开发者的扩展接缝(仿 blocks/registry.ts、engine 各 registerX)。
 *  硬编码的 primitive 列类型(schema.ColumnType)之外,插件可注册自定义属性类型:提供渲染/编辑组件
 *  + 一个已有 primitive 作 baseType(决定落盘/校验/frontmatter 编解形状)。渲染层是唯一消费者——
 *  主进程只按 z.string() 放行 type、按 cellValueSchema 校验值,永不需要认识自定义类型。
 *
 *  内置 todo / calendarDate 经此注册(propertyTypes.builtins);第三方经插件 ctx.registerPropertyType。 */
import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { COLUMN_TYPES, type CellValue, type ColumnType, type DbColumn, type DbFile, type DbRow } from '@amadeus-shared/db/schema'

/** 传给自定义属性 Cell 的最小上下文:value 已按 baseType 经 coerceForDisplay 折算。 */
export interface PropCellProps {
  value: CellValue
  onChange(v: CellValue | undefined): void
  /** 所在列(可选:旧三方插件不传也能跑)。autonumber 靠它读 `column.prefix`;两处分发点
   *  (DatabaseEmbed 的 Cell 与 EventCard 的 CardPropField)都传。 */
  column?: DbColumn
}

export interface PropertyTypeDef {
  /** 类型 id(存进 DbColumn.type,如 'todo'/'calendarDate')。 */
  type: string
  /** 列菜单/表头显示名。 */
  label: string
  /** 图标:字符/emoji(插件最常用)或 React 元素(内置用 AFFiNE 图标组件),渲染层一律当 ReactNode。 */
  icon: ReactNode
  /** 落盘/校验/frontmatter 编解所借的 primitive(如 checkbox / text / date)。 */
  baseType: ColumnType
  /** 渲染 + 编辑组件。 */
  Cell: ComponentType<PropCellProps>
  /** 可选:自定义排序键(默认按 baseType 折算值排序)。 */
  sortValue?(v: CellValue): number | string
  /** 可选:新建一行时该列的初值(autonumber 的 max+1、created 的当前时刻)。
   *  `rows` = 建行那一刻表里**已有**的行(CAS 重放时是重读后的最新行,见 newRowCells)。
   *  返回 null = 不盖章。只在「真·新建 / 复制」时调用,恢复(撤销删除)不调。 */
  initialValue?(ctx: { rows: DbRow[]; column: DbColumn }): CellValue
}

const PRIMITIVES = new Set<string>([...COLUMN_TYPES, 'page'])
const registry = new Map<string, PropertyTypeDef>()
const listeners = new Set<() => void>()

export function registerPropertyType(def: PropertyTypeDef): void {
  registry.set(def.type, def)
  listeners.forEach((l) => l())
}
export function unregisterPropertyType(type: string): void {
  if (registry.delete(type)) listeners.forEach((l) => l())
}
export function getPropertyType(type: string): PropertyTypeDef | undefined {
  return registry.get(type)
}
export function allPropertyTypes(): PropertyTypeDef[] {
  return [...registry.values()]
}
export function subscribePropertyTypes(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** type → 落盘 baseType:自定义→其 baseType;primitive→原样;未知→'text'(渲染回退,不丢数据)。 */
export function resolveBaseType(type: string): ColumnType {
  const def = registry.get(type)
  if (def) return def.baseType
  return PRIMITIVES.has(type) ? (type as ColumnType) : 'text'
}

/** 新建一行的「盖章」初值:对表里每个已注册且声明了 initialValue 的类型列各算一次,返回 `{ 列id → 值 }`。
 *  住这里而不是 schema.ts(主进程 import 它,不能拉 React)/ dbStore(零 React 的纯 store)。
 *
 *  ⚠️ 调用方必须在 `mutate` 的回调**里面**调它 —— 与 DatabaseEmbed addRow「id 在回调外定」的铁律
 *  恰好相反:CAS 冲突重放会拿重读后的**最新磁盘行**重跑回调,autonumber 的 max+1 只有此时算才不会
 *  与引擎刚 db_row_add 进来的那行撞号(代价:created 重放时换一个时间戳,秒级差异可接受)。
 *  四个建行点的合并顺序各不同(spec §6.7):新建 = `{...newRowCells(d), ...initial}`(分组值/日期压过盖章);
 *  复制 = `{...src.cells, ...newRowCells(d)}`(盖章压掉复制来的编号);恢复不盖章。 */
export function newRowCells(db: DbFile): Record<string, CellValue> {
  const out: Record<string, CellValue> = {}
  for (const c of db.columns) {
    const def = registry.get(c.type)
    if (!def?.initialValue) continue
    const v = def.initialValue({ rows: db.rows, column: c })
    if (v != null) out[c.id] = v
  }
  return out
}

/** 盖章列(autonumber / created / updated):值由 newRowCells 在建行时写死(updated 之后还由 dbStore.mutate
 *  对真变了的行重盖),用户侧只读 —— setCell 守卫按它拦写入(Cell 组件不给编辑入口只是纪律,这道闸才是护栏)。
 *  ⚠️ 与引擎 tangu-agent automationDbAction.ts 的 db_row_add / db_row_edit 是**同名字符串契约**
 *  (引擎没有注册表,硬编码同三个名字);类型 id 一旦发布永不改。 */
export const STAMPED_TYPES: ReadonlySet<string> = new Set(['autonumber', 'created', 'updated'])
export const isStamped = (type: string): boolean => STAMPED_TYPES.has(type)

/** 订阅注册表变更(三方插件运行时启停时,让列菜单/单元格分发即时刷新)。 */
export function usePropertyTypesVersion(): number {
  const size = (): number => registry.size
  return useSyncExternalStore(subscribePropertyTypes, size, size)
}
