/**
 * 插件列表源的层级(纯函数 → 可测)。
 *
 * 插件交出来的仍是一张平铺的行表,层级只靠 `ListItem.parent` 指向上一级的 key;这里把它搭成树、
 * 算出搜索时的平铺结果、行的各级上级,以及拖动时指针落在一行的哪一段。画法在 WorkspaceView 的 PluginListBody。
 */
import type { ListItem } from './types'

/** 宿主的列表能做什么,经 `ctx.listCapabilities` 给插件做 feature-detect(老宿主没有这个字段)。
 *  'tree' = 认 `parent` / `kind: 'folder'`;'items' = 行可以拖到别的行上;'rename' = 行内改名;
 *  'group' = 认 `folderStyle: 'group'` / `defaultOpen`(组头,2026-10-14)。 */
export const LIST_CAPABILITIES = ['tree', 'items', 'rename', 'group', 'folderOpen'] as const
export type ListCapability = (typeof LIST_CAPABILITIES)[number]

/** 行在列表内被拖动时的载荷类型。只在同一个列表源里有效,跨源、跨窗口都不认。 */
export const LIST_ROW_MIME = 'application/x-forsion-list-row'

export interface ListNode { item: ListItem; children: ListNode[] }

export const isFolder = (item: ListItem): boolean => item.kind === 'folder'
/** 组头:最上面一级、画成工作区一级行那样的文件夹(`folderStyle: 'group'`)。 */
export const isGroupHead = (item: ListItem): boolean => isFolder(item) && item.folderStyle === 'group' && !item.parent

/** 筛选藏掉了几行(2026-10-24,借鉴 Comma §2.9):清掉筛选会多出来的行 —— 没筛的那份里有、这一份里没有的(文件夹不算)。
 *  用集合差,不用两个行数相减:分组不一定是「全部」的子集(收件箱的「已归档」是另一份数据),相减会算错、甚至出负数。
 *  重复的 key 只算一行,和 buildListTree 画出来的一样(Codex 10-24)。 */
export function hiddenByFilter(all: ListItem[], shown: ListItem[]): number {
  const here = new Set(shown.map((item) => item.key))
  return new Set(all.filter((item) => !isFolder(item) && !here.has(item.key)).map((item) => item.key)).size
}

/** 手机的整屏列表画得下的形状:平铺的行,外加最多一层组头(组头下面直接是行)。更深的树、普通文件夹仍画成树。 */
export function fitsPhoneList(items: ListItem[]): boolean {
  const heads = new Set(items.filter(isGroupHead).map((item) => item.key))
  return items.every((item) => (isFolder(item) ? heads.has(item.key) : !item.parent || heads.has(item.parent)))
}

/** 组头的开合:只记这一次运行,不落盘 —— 每次启动都回到「插件说该开的开着、其余收着」。
 *  `defaultOpen` 由假变真(例:来了新的未读)时重新打开,哪怕用户之前收起过;它一直为真的期间,用户收起就让它收着;
 *  它变回假时不自己合上(组里最后一封未读被标成已读,组不能在光标底下收起来)。
 *  渲染时调用:同样的输入重复调用结果不变。 */
export interface GroupFold { open: boolean; armed: boolean }
export function groupFold(memo: Map<string, GroupFold>, id: string, item: ListItem): GroupFold {
  const fold = memo.get(id) ?? { open: false, armed: false }
  if (item.defaultOpen && !fold.armed) fold.open = true
  fold.armed = !!item.defaultOpen
  memo.set(id, fold)
  return fold
}

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
