/**
 * 插件列表源的层级(纯函数 → 可测)。
 *
 * 插件交出来的仍是一张平铺的行表,层级只靠 `ListItem.parent` 指向上一级的 key;这里把它搭成树、
 * 算出搜索时的平铺结果、行的各级上级,以及拖动时指针落在一行的哪一段。画法在 WorkspaceView 的 PluginListBody。
 */
import type { ListItem } from './types'

/** 宿主的列表能做什么,经 `ctx.listCapabilities` 给插件做 feature-detect(老宿主没有这个字段)。
 *  'tree' = 认 `parent` / `kind: 'folder'`;'items' = 行可以拖到别的行上;'rename' = 行内改名。 */
export const LIST_CAPABILITIES = ['tree', 'items', 'rename'] as const
export type ListCapability = (typeof LIST_CAPABILITIES)[number]

/** 行在列表内被拖动时的载荷类型。只在同一个列表源里有效,跨源、跨窗口都不认。 */
export const LIST_ROW_MIME = 'application/x-forsion-list-row'

export interface ListNode { item: ListItem; children: ListNode[] }

export const isFolder = (item: ListItem): boolean => item.kind === 'folder'

/** 从 from 往上数,会不会走到 key(用来挡自己挂自己、互相挂成环)。 */
function climbsTo(byKey: Map<string, ListItem>, from: ListItem, key: string): boolean {
  let at: ListItem | undefined = from
  for (let hops = 0; at && hops <= byKey.size; hops++) {
    if (at.key === key) return true
    at = at.parent ? byKey.get(at.parent) : undefined
  }
  return false
}

/** 平铺的行 → 树。输入顺序就是显示顺序;`parent` 指不到、指向自己或成环的行落回根;重复的 key 只认第一条。 */
export function buildListTree(items: ListItem[]): ListNode[] {
  const byKey = new Map<string, ListItem>()
  for (const item of items) if (!byKey.has(item.key)) byKey.set(item.key, item)
  const nodes = new Map<string, ListNode>()
  for (const item of byKey.values()) nodes.set(item.key, { item, children: [] })
  const roots: ListNode[] = []
  for (const item of byKey.values()) {
    const up = item.parent ? byKey.get(item.parent) : undefined
    if (up && !climbsTo(byKey, up, item.key)) nodes.get(up.key)!.children.push(nodes.get(item.key)!)
    else roots.push(nodes.get(item.key)!)
  }
  return roots
}

/** 这几个节点下面(含更深的层)有多少条不是文件夹的行。 */
export function leafCount(nodes: ListNode[]): number {
  let n = 0
  for (const node of nodes) n += isFolder(node.item) ? leafCount(node.children) : 1 + leafCount(node.children)
  return n
}

/** 搜索时用:去掉文件夹,压平成行。行没写 `group` 的沿用它最上面那一级的。 */
export function flattenLeaves(nodes: ListNode[], group?: string): ListItem[] {
  const out: ListItem[] = []
  for (const node of nodes) {
    const g = group ?? node.item.group
    if (!isFolder(node.item)) out.push(node.item.group === undefined && g !== undefined ? { ...node.item, group: g } : node.item)
    out.push(...flattenLeaves(node.children, g))
  }
  return out
}

/** 一行上面的各级(由近到远)。 */
export function ancestorsOf(items: ListItem[], key: string): string[] {
  const byKey = new Map<string, ListItem>()
  for (const item of items) if (!byKey.has(item.key)) byKey.set(item.key, item)
  const out: string[] = []
  let at = byKey.get(key)
  while (at?.parent && at.parent !== at.key && !out.includes(at.parent) && byKey.has(at.parent)) {
    out.push(at.parent)
    at = byKey.get(at.parent)
  }
  return out
}

export type ListDropPosition = 'before' | 'after' | 'into'

/**
 * 指针落在一行的哪一段 → 可以试的落点,按优先顺序排(头一个被插件拒了再试后面的)。
 * ratio = 指针在行内的纵向位置(0 顶、1 底)。
 * 普通行只分上下两半;文件夹的上下四分之一是「排在它前 / 后」,中间是「放进去」。
 */
export function dropCandidates(ratio: number, folder: boolean): ListDropPosition[] {
  const side: ListDropPosition = ratio < 0.5 ? 'before' : 'after'
  if (!folder) return [side]
  if (ratio < 0.25) return ['before', 'into']
  if (ratio > 0.75) return ['after', 'into']
  return ['into', side]
}
