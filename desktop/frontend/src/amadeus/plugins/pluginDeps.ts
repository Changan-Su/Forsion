/**
 * 插件之间的前置依赖(manifest `requiresPlugins`,2026-10-02;对标 Cordis 的「空间维」:依赖靠声明,不靠装载顺序)。
 * 纯函数,不碰 store / React:宿主 pluginStore 用它决定「能不能跑」,设置页用它画原因与操作入口。
 *
 * 口径:一个前置算「齐了」⇔ 已安装、没被门禁挡、版本够、**正在运行**。装了但关着不算 —— 依赖方要的是它跑起来之后
 * 注册的视图 / 命令 / 文件类型。前置没齐的插件装着但不激活(用户偏好不动);前置后来齐了自动激活,前置没了自动暂停。
 * 互相依赖成环 = 环上的插件永远不激活(与 Cordis 同口径),原因单独标 'cycle',别让用户以为是没装。
 */
import { cmpVersion, type PluginDependency } from '@amadeus-shared/ipc'

/** missing 没装 · blocked 被门禁挡(apiVersion / 应用版本)· version 版本太低 · cycle 互相依赖 ·
 *  off 用户关着 · waiting 开着但没在跑(它自己的前置没齐,或加载失败)。 */
export type UnmetReason = 'missing' | 'blocked' | 'version' | 'cycle' | 'off' | 'waiting'

export interface UnmetDependency {
  dep: PluginDependency
  reason: UnmetReason
  /** 已装上的那个版本(version / blocked 时给)。 */
  have?: string
}

export interface DepNode {
  id: string
  version: string
  blocked?: unknown
  requiresPlugins?: PluginDependency[]
}

/** 从 from 顺着声明的前置一路走,能不能走回 target(target 自己是否在环上由调用方传 p.id 判)。 */
function reaches(from: string, target: string, byId: Map<string, DepNode>): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const id = stack.pop()!
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const d of byId.get(id)?.requiresPlugins ?? []) stack.push(d.id)
  }
  return false
}

/** p 还差哪些前置(空数组 = 齐了)。isActive / wants 由宿主给:正在运行 / 用户想开(偏好)。 */
export function unmetDependencies(
  p: DepNode,
  all: readonly DepNode[],
  isActive: (id: string) => boolean,
  wants: (id: string) => boolean,
): UnmetDependency[] {
  const deps = p.requiresPlugins ?? []
  if (!deps.length) return []
  const byId = new Map(all.map((x) => [x.id, x]))
  const out: UnmetDependency[] = []
  for (const dep of deps) {
    const d = byId.get(dep.id)
    if (!d) out.push({ dep, reason: 'missing' })
    else if (d.blocked) out.push({ dep, reason: 'blocked', have: d.version })
    else if (dep.minVersion && cmpVersion(d.version, dep.minVersion) < 0) out.push({ dep, reason: 'version', have: d.version })
    else if (reaches(d.id, p.id, byId)) out.push({ dep, reason: 'cycle' })
    else if (!isActive(d.id)) out.push({ dep, reason: wants(d.id) ? 'waiting' : 'off' })
  }
  return out
}

/** 前置在前、依赖方在后的顺序;除此之外**保持传入顺序**(来源顺序决定注册顺序 → 功能区 / 命令的排列,不许因为
 *  引入依赖就整体洗牌)。环上的按原顺序排到最后。启动按它,停按它倒过来。 */
export function topoOrder<T extends DepNode>(all: readonly T[]): T[] {
  const byId = new Map(all.map((x) => [x.id, x]))
  const out: T[] = []
  // 'stuck' = 在环上或走得到环:这次排不进,以后也排不进 —— 记死,别从每条路径重新展开(否则成环的分层图是指数级,Codex 10-02)。
  const state = new Map<string, 'visiting' | 'done' | 'stuck'>()
  const visit = (n: T): boolean => {
    const st = state.get(n.id)
    if (st === 'done') return true
    if (st === 'visiting' || st === 'stuck') return false // 环:交给末尾兜底
    state.set(n.id, 'visiting')
    let ok = true
    for (const d of n.requiresPlugins ?? []) {
      const dn = byId.get(d.id)
      if (dn && !visit(dn)) ok = false
    }
    if (!ok) { state.set(n.id, 'stuck'); return false }
    state.set(n.id, 'done')
    out.push(n)
    return true
  }
  for (const n of all) visit(n)
  for (const n of all) if (state.get(n.id) !== 'done') out.push(n)
  return out
}

/** 直接或间接声明了要 id 的那些插件(不含 id 自己)。 */
export function dependentsOf<T extends DepNode>(id: string, all: readonly T[]): T[] {
  const byId = new Map(all.map((x) => [x.id, x]))
  return all.filter((x) => x.id !== id && (x.requiresPlugins ?? []).some((d) => reaches(d.id, id, byId)))
}
