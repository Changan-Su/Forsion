/** Ribbon 注册表(≈ Obsidian addRibbonIcon)。zustand store,Ribbon 组件订阅。
 *  另承载 ribbon 自身的展开态 + 两区(上=Spaces / 下=命令)用户自定义顺序 + 收纳夹 +
 *  用户钉进命令区的命令(均持久化 localStorage)。 */
import { create } from 'zustand'
import type { RibbonItem } from './types'

const EXPANDED_KEY = 'forsion_tangu_ribbon_expanded'
const ORDER_KEY = 'forsion_tangu_ribbon_order' // 上区(Spaces)顺序,沿用旧键(老用户排序不丢)
const V2_KEY = 'forsion_tangu_ribbon_v2' // 下区顺序 + 收纳夹 + 钉进命令区的命令

export type RibbonZone = 'top' | 'bottom'

/** 收纳夹:同区图标的折叠容器(悬停在右侧浮层展开)。自身占一个槽位并可拖动改序;成员从条上隐藏。 */
export interface RibbonFolder {
  id: string // 'folder:' 前缀,与图标 id 同一命名空间(进同一份顺序数组)
  name: string
  zone: RibbonZone
  items: string[] // 成员 id(ribbon 图标 id 或 'cmd:<commandId>');顺序 = 浮层显示顺序
  icon?: string // 自定义图标名(RIBBON_ICONS 的键);缺省 = 文件夹图标
}

interface V2 {
  bottomOrder: string[]
  folders: RibbonFolder[]
  /** 用户从命令面板钉进命令区的命令 id(ribbon 槽位 id = 'cmd:<id>')。 */
  commandItems: string[]
  /** 用户为命令项覆盖的图标名(键 = 原始命令 id,非 cmd: 前缀);缺省 = 命令自带图标 / Zap 兜底。 */
  commandIcons: Record<string, string>
}

function loadExpanded(): boolean {
  try { return localStorage.getItem(EXPANDED_KEY) === '1' } catch { return false }
}
function loadOrder(): string[] {
  try { const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
/** 过滤成 Record<string,string>(值非字符串的丢弃)。 */
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (v && typeof v === 'object') for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === 'string') out[k] = val
  return out
}
function loadV2(): V2 {
  try {
    const v = JSON.parse(localStorage.getItem(V2_KEY) || '{}') as Partial<V2>
    return {
      bottomOrder: strs(v.bottomOrder),
      commandItems: strs(v.commandItems),
      commandIcons: strMap(v.commandIcons),
      folders: (Array.isArray(v.folders) ? v.folders : [])
        .filter((f): f is RibbonFolder => !!f && typeof f.id === 'string')
        .map((f) => ({ id: f.id, name: typeof f.name === 'string' ? f.name : '', zone: f.zone === 'bottom' ? 'bottom' : 'top', items: strs(f.items), ...(typeof f.icon === 'string' ? { icon: f.icon } : {}) })),
    }
  } catch { return { bottomOrder: [], folders: [], commandItems: [], commandIcons: {} } }
}

interface RibbonState extends V2 {
  items: RibbonItem[]
  /** 展开 = 图标 + 名称(宽条);折叠 = 纯图标(默认)。 */
  expanded: boolean
  /** 上区图标的用户自定义顺序(item id);未列出的新图标按注册序追加在后。 */
  order: string[]
  addRibbonIcon(item: RibbonItem): void
  removeRibbonIcon(id: string): void
  toggleExpanded(): void
  /** 区内顺序整体重写(id 含收纳夹/命令槽位;不含收纳夹成员)。 */
  setZoneOrder(zone: RibbonZone, ids: string[]): void
  addFolder(zone: RibbonZone, name: string): void
  renameFolder(id: string, name: string): void
  /** 更换收纳夹图标(空串 = 回落默认文件夹图标)。 */
  setFolderIcon(id: string, icon: string): void
  /** 覆盖命令项图标(键 = 原始命令 id;空串 = 回落命令自带图标 / Zap)。 */
  setCommandIcon(cmdId: string, icon: string): void
  /** 解散:成员回到收纳夹在顺序数组里的原槽位,收纳夹消失。 */
  removeFolder(id: string): void
  /** 浮层内重排(拖动改成员顺序)。 */
  setFolderItems(id: string, items: string[]): void
  /** 从条上(或另一收纳夹)移入,追加到末尾;调用方保证同区。 */
  moveIntoFolder(folderId: string, itemId: string): void
  /** 仅去 membership;落点位置由随后的 setZoneOrder 决定。 */
  moveOutOfFolder(itemId: string): void
  addCommandItem(cmdId: string): void
  removeCommandItem(cmdId: string): void
}

type Setter = (fn: (s: RibbonState) => Partial<RibbonState>) => void
const persistV2 = (s: Pick<RibbonState, 'bottomOrder' | 'folders' | 'commandItems' | 'commandIcons'>): void => {
  try { localStorage.setItem(V2_KEY, JSON.stringify({ bottomOrder: s.bottomOrder, folders: s.folders, commandItems: s.commandItems, commandIcons: s.commandIcons })) } catch { /* ignore */ }
}
/** set + 持久化 v2 段(所有触碰 bottomOrder/folders/commandItems/commandIcons 的 action 走这里)。 */
const setV2 = (set: Setter) => (fn: (s: RibbonState) => Partial<RibbonState>): void =>
  set((s) => { const patch = fn(s); persistV2({ ...s, ...patch }); return patch })

export const useRibbonStore = create<RibbonState>((set) => {
  const setp = setV2(set)
  return {
    items: [],
    expanded: loadExpanded(),
    order: loadOrder(),
    ...loadV2(),
    addRibbonIcon: (item) =>
      set((s) => ({ items: [...s.items.filter((i) => i.id !== item.id), item] })),
    // 删除图标(如删用户 Space):同时清持久顺序 + 收纳夹成员,否则留幽灵(夹计数虚高、同 id 重建会诈尸回夹)。
    removeRibbonIcon: (id) => setp((s) => {
      const order = s.order.filter((x) => x !== id)
      try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)) } catch { /* ignore */ }
      return {
        items: s.items.filter((i) => i.id !== id),
        order,
        bottomOrder: s.bottomOrder.filter((x) => x !== id),
        folders: s.folders.map((f) => ({ ...f, items: f.items.filter((x) => x !== id) })),
      }
    }),
    toggleExpanded: () => set((s) => {
      const expanded = !s.expanded
      try { localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0') } catch { /* ignore */ }
      return { expanded }
    }),
    setZoneOrder: (zone, ids) => {
      if (zone === 'top') {
        try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
        set({ order: ids })
      } else setp(() => ({ bottomOrder: ids }))
    },
    addFolder: (zone, name) => setp((s) => {
      const id = `folder:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
      const folders = [...s.folders, { id, name, zone, items: [] }]
      // 收纳夹也要进顺序数组(否则永远追加在未列出项之后);上区顺序另存旧键
      const ids = [...(zone === 'top' ? s.order : s.bottomOrder), id]
      if (zone === 'top') { try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)) } catch { /* ignore */ } }
      return zone === 'top' ? { folders, order: ids } : { folders, bottomOrder: ids }
    }),
    renameFolder: (id, name) => setp((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, name } : f)) })),
    setFolderIcon: (id, icon) => setp((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, icon: icon || undefined } : f)) })),
    setCommandIcon: (cmdId, icon) => setp((s) => {
      const commandIcons = { ...s.commandIcons }
      if (icon) commandIcons[cmdId] = icon
      else delete commandIcons[cmdId]
      return { commandIcons }
    }),
    removeFolder: (id) => setp((s) => {
      const f = s.folders.find((x) => x.id === id)
      if (!f) return {}
      const cur = f.zone === 'top' ? s.order : s.bottomOrder
      const at = cur.indexOf(id)
      const ids = at >= 0 ? [...cur.slice(0, at), ...f.items, ...cur.slice(at + 1)] : [...cur, ...f.items]
      if (f.zone === 'top') { try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)) } catch { /* ignore */ } }
      const folders = s.folders.filter((x) => x.id !== id)
      return f.zone === 'top' ? { folders, order: ids } : { folders, bottomOrder: ids }
    }),
    setFolderItems: (id, items) => setp((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, items } : f)) })),
    moveIntoFolder: (folderId, itemId) => setp((s) => ({
      folders: s.folders.map((f) =>
        f.id === folderId ? { ...f, items: [...f.items.filter((x) => x !== itemId), itemId] } : { ...f, items: f.items.filter((x) => x !== itemId) }),
    })),
    moveOutOfFolder: (itemId) => setp((s) => ({ folders: s.folders.map((f) => ({ ...f, items: f.items.filter((x) => x !== itemId) })) })),
    addCommandItem: (cmdId) => setp((s) => (s.commandItems.includes(cmdId) ? {} : {
      commandItems: [...s.commandItems, cmdId],
      bottomOrder: [...s.bottomOrder, `cmd:${cmdId}`],
    })),
    removeCommandItem: (cmdId) => setp((s) => {
      const commandIcons = { ...s.commandIcons }
      delete commandIcons[cmdId] // 移除命令项 → 一并清其图标覆盖(否则留孤儿键)
      return {
        commandItems: s.commandItems.filter((x) => x !== cmdId),
        commandIcons,
        bottomOrder: s.bottomOrder.filter((x) => x !== `cmd:${cmdId}`),
        folders: s.folders.map((f) => ({ ...f, items: f.items.filter((x) => x !== `cmd:${cmdId}`) })),
      }
    }),
  }
})

export const addRibbonIcon = (item: RibbonItem): void => useRibbonStore.getState().addRibbonIcon(item)
export const removeRibbonIcon = (id: string): void => useRibbonStore.getState().removeRibbonIcon(id)

/** 按用户保存的顺序排 id;未列出的按出现序追加在末尾。 */
export function rankIds(ids: string[], order: string[]): string[] {
  const rank = new Map(order.map((id, i) => [id, i] as const))
  return ids
    .map((id, i) => ({ id, k: rank.has(id) ? rank.get(id)! : order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.id)
}

/** 区内重排的基准序:持久顺序 ∪ 可见项(持久优先)。
 *  关键:保留持久序里「当前不可见」的 id —— 用户 Space 异步注册,拖动早发生时不能把它们从存档里抹掉(否则位置丢失)。 */
export function unionOrder(persisted: string[], visible: string[]): string[] {
  const base = [...persisted]
  for (const id of visible) if (!base.includes(id)) base.push(id)
  return base
}
/** unionOrder 再摘掉 movedId(「先摘再插」的调用方用)。 */
export function reorderBase(persisted: string[], visible: string[], movedId: string): string[] {
  return unionOrder(persisted, visible).filter((id) => id !== movedId)
}

/** 竖排等高槽位的落点判定:指针 y → 槽下标。
 *  几何全是视口 px(rect 系,与 clientY 同坐标系;offsetTop 那套是未缩放局部 px,body zoom 下会算歪)。
 *  grabDy = 抓取点到被拖项顶边的距离 → 拿「被拖项自己的虚拟顶边」四舍五入到最近的槽:上下对称、
 *  过半槽才换位,且槽间隙里照样有确定落点(旧的「命中哪个子元素」判法在 4px 间隙里直接丢落点)。 */
export function slotIndexAt(clientY: number, count: number, g: { top: number; pitch: number; grabDy: number }): number {
  if (count < 2 || !g.pitch) return 0
  return Math.max(0, Math.min(count - 1, Math.round((clientY - g.grabDy - g.top) / g.pitch)))
}

/** 拖拽重排:把 movedId 挪到下标 to —— 即「顶掉」原本占着 to 的那个,其余顺次让位(iOS 桌面图标那套)。
 *  to 是 list(含 movedId)里的下标;movedId 不在 list 时退化成「插到 to 之前」。越界自动夹取。
 *  注意别写成「插到目标之前」:下移一格会变成空操作 = 用户报的「落点显示了但松手没动」。 */
export function moveTo(list: string[], movedId: string, to: number): string[] {
  const out = list.filter((x) => x !== movedId)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, movedId)
  return out
}

/** feature 层注入的 ribbon 动作(引擎不 import feature 代码):
 *  - newSpace: 「新建 Space」入口(缺省 = 菜单不显示该项;Tangu Web 无落盘能力不注入)。
 *  - prompt: 文本输入(桌面注入 askString;缺省回落 window.prompt,Electron 下 prompt 是坏的)。 */
export interface RibbonActions {
  newSpace?: () => void
  prompt?: (title: string, initial?: string) => Promise<string | null>
}
export const ribbonActions: RibbonActions = {}
export const setRibbonActions = (a: RibbonActions): void => { Object.assign(ribbonActions, a) }
