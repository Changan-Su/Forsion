/** 多维表「属性类型注册表」—— 面向插件开发者的扩展接缝(仿 blocks/registry.ts、engine 各 registerX)。
 *  硬编码的 primitive 列类型(schema.ColumnType)之外,插件可注册自定义属性类型:提供渲染/编辑组件
 *  + 一个已有 primitive 作 baseType(决定落盘/校验/frontmatter 编解形状)。渲染层是唯一消费者——
 *  主进程只按 z.string() 放行 type、按 cellValueSchema 校验值,永不需要认识自定义类型。
 *
 *  内置 todo / calendarDate 经此注册(propertyTypes.builtins);第三方经插件 ctx.registerPropertyType。 */
import { useSyncExternalStore, type ComponentType } from 'react'
import { COLUMN_TYPES, type CellValue, type ColumnType } from '@amadeus-shared/db/schema'

/** 传给自定义属性 Cell 的最小上下文:value 已按 baseType 经 coerceForDisplay 折算。 */
export interface PropCellProps {
  value: CellValue
  onChange(v: CellValue | undefined): void
}

export interface PropertyTypeDef {
  /** 类型 id(存进 DbColumn.type,如 'todo'/'calendarDate')。 */
  type: string
  /** 列菜单/表头显示名。 */
  label: string
  /** 单字形图标(与 primitive TYPE_META 同风格)。 */
  icon: string
  /** 落盘/校验/frontmatter 编解所借的 primitive(如 checkbox / text / date)。 */
  baseType: ColumnType
  /** 渲染 + 编辑组件。 */
  Cell: ComponentType<PropCellProps>
  /** 可选:自定义排序键(默认按 baseType 折算值排序)。 */
  sortValue?(v: CellValue): number | string
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

/** 订阅注册表变更(三方插件运行时启停时,让列菜单/单元格分发即时刷新)。 */
export function usePropertyTypesVersion(): number {
  const size = (): number => registry.size
  return useSyncExternalStore(subscribePropertyTypes, size, size)
}
