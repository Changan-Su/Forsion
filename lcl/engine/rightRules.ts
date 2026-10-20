/**
 * 右栏的「主视图规则」(2026-10-20 用户定,方案页 docs/ToBeImproved/右栏主视图规则方案_2026-10-20 的 B)。
 * 纯函数,无 DOM / 无 store —— 桌面 Dockview store 与单列 store 共用。
 *
 * 右栏 = 本 Space 的 pinned ∪ 规则组 ∪ 用户自带:
 *  · 规则组 = 主区前台视图声明的 `rightCompanions`;没声明 → 本 Space 的右栏缺省(sidebarDefaults.right)。
 *  · 规则管的面板 = 规则开出来的(参数带 `__by: 'rule'`)+ 类型在本 Space 右栏缺省里的(缺省是 Space 规则放的,
 *    老布局里它们没有标记,按类型认 —— 不认的话用过这个 Space 的人永远看不到变化)。其余都是用户自带,规则永远不关。
 *  · 组变了才重算(对话 → 笔记);同组换文件不动。组变了 → 新组第一项顶到前台;没变 → 只在前台那个被关掉时补一个。
 *  · 过渡页(启动器 / 空白占位)不算:右栏停在上一组。
 * 左栏、底部面板不受这套规则管(左栏是 Space 驱动)。Extend View 跟随它的主人,也不在这里。
 */
import type { PersistedPanel } from './layoutPersist'

/** 规则开出来的面板在参数里带的来源标记(随布局存档,重启后也认得)。视图拿到的 params 里没有它。 */
export const RULE_PARAM = '__by'
export const RULE_TAG = 'rule'

/** 组的上限:右栏标签只有图标,4 个在 1512 宽下就已溢出。超出截断(开发时在控制台说一声)。 */
export const MAX_COMPANIONS = 4

/** 不触发重算的主视图:引擎自己的占位(新建标签页 / 空白主区 / 空侧栏)。 */
const TRANSIENT_MAIN = new Set(['launcher', 'home', 'sidebar-empty'])

/** 右栏现有的一项(活面板或收起时暂存着的)。 */
export interface RightRef {
  id: string
  type: string
  /** 参数里带 RULE_PARAM = RULE_TAG。 */
  tagged: boolean
  active: boolean
}

/** 主区前台视图 `mainType` 该带哪一组。返回 null = 过渡页 / 主区没东西,右栏不动。
 *  `declared` 是该视图注册时声明的 rightCompanions;没声明、声明了空组、声明的都用不了,都落 Space 缺省。
 *  ponytail: 不支持「这个视图右栏什么都不要」—— 收着时暂存空 = 展开按缺省填,空组记不住(Codex 10-20)。真要再给暂存加「对过账」标记。
 *  `usable(type)`:视图已注册、且不是主区实体(编辑器、PDF、主区对话不进右栏)。 */
export function rightGroupFor(
  mainType: string | null | undefined,
  declared: readonly PersistedPanel[] | undefined,
  spaceDefaults: readonly PersistedPanel[],
  usable: (type: string) => boolean,
): { key: string; group: PersistedPanel[] } | null {
  if (!mainType || TRANSIENT_MAIN.has(mainType)) return null
  const pick = (src: readonly PersistedPanel[]): PersistedPanel[] => {
    const seen = new Set<string>()
    return src.filter((p) => {
      if (seen.has(p.type) || !usable(p.type)) return false
      seen.add(p.type)
      return true
    })
  }
  const own = pick(declared ?? []).slice(0, MAX_COMPANIONS)
  const group = own.length ? own : pick(spaceDefaults) // Space 缺省是宿主 / 配方自己定的,不截
  return { key: group.map((p) => p.type).join('|'), group }
}

export interface RightPlan {
  /** 要开的,按目标顺序;`after` = 排在哪一项后面(null = 排最前)。 */
  open: Array<PersistedPanel & { after: string | null }>
  /** 要关的 id。 */
  close: string[]
  /** 该顶到前台的类型(null = 不动)。 */
  activate: string | null
  /** 对账后的完整顺序(类型),收起时直接拿它重写暂存。 */
  order: string[]
}

/** 对账:给定规则组、pinned、右栏现状,算出要开、要关、前台。`changed` = 组真的变了(不是还原布局后的第一次对账)。
 *  `elsewhere` = 已经开在别的区(主区 / 左栏 / 底部)的**单例**类型:用户把它挪过去了,不在右栏再开一份。
 *  非单例(工作区:左栏会话、右栏文件是同一个类型)不该进这个集合,由调用方滤。 */
export function planRight(args: {
  group: readonly PersistedPanel[]
  pinned: readonly PersistedPanel[]
  spaceDefaults: readonly PersistedPanel[]
  current: readonly RightRef[]
  changed: boolean
  elsewhere?: ReadonlySet<string>
}): RightPlan {
  const { group, current, changed } = args
  const want = new Set(group.map((p) => p.type))
  const pinned = new Set(args.pinned.map((p) => p.type))
  const fromSpace = new Set(args.spaceDefaults.map((p) => p.type))
  const ruled = (r: RightRef): boolean => r.tagged || fromSpace.has(r.type)
  const close = current.filter((r) => ruled(r) && !want.has(r.type) && !pinned.has(r.type))
  const closing = new Set(close.map((r) => r.id))
  const kept = current.filter((r) => !closing.has(r.id))
  const has = new Set(kept.map((r) => r.type))
  const open: RightPlan['open'] = []
  // 目标顺序:规则组在前(按组的顺序),留下来的其余项(pinned、用户自带)按原来的相对顺序跟在后面。
  const order: string[] = []
  let prev: string | null = null
  for (const p of group) {
    if (!has.has(p.type)) {
      if (args.elsewhere?.has(p.type)) continue
      open.push({ ...p, after: prev })
    }
    order.push(p.type)
    prev = p.type
  }
  for (const r of kept) if (!want.has(r.type)) order.push(r.type)
  const front = current.find((r) => r.active)
  let activate: string | null = null
  if (changed && order.length && group.length && order.includes(group[0].type)) activate = group[0].type
  else if (front && closing.has(front.id)) activate = order[0] ?? null
  if (activate && front && front.type === activate && !closing.has(front.id)) activate = null // 已在前台
  return { open, close: close.map((r) => r.id), activate, order }
}

/** 按对账结果排出新的一列(两个 store 共用):组里的(留下的那份,或 `opened` 新开的)在前,其余留下的按原顺序跟在后面。
 *  按项排、不按类型排:同类型的两份(两个用户自带的工作区)都留。 */
export function arrangeRight<T extends { type: string }>(group: readonly PersistedPanel[], kept: readonly T[], opened: (type: string) => T | undefined): T[] {
  const head = group.map((p) => kept.find((r) => r.type === p.type) ?? opened(p.type)).filter((r): r is T => !!r)
  return [...head, ...kept.filter((r) => !head.includes(r))]
}
