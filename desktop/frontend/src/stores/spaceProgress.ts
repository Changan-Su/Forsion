/** 插件 Space 在 Ribbon 上的进度环(2026-10-18,蓬洲云网盘:传文件时挂在它的图标上)与提示红点(2026-10-19,服务器管理:有没看过的反馈)。
 *  插件经 `ctx.app.setSpaceProgress(spaceId, 0–1 | null)` / `ctx.app.setSpaceDot(spaceId, on)` 写,只认这个插件自己带的 Space;插件拆掉时一并收掉。
 *  归属表放在这里而不是 userSpaces:userSpaces 已经 import pluginStore,pluginStore 再引 userSpaces 就成环了。 */
import { create } from 'zustand'

/** 插件捆绑包内嵌的 Space:spec id → 所属插件 id(userSpaces 装 / 卸插件 Space 时写)。 */
export const pluginSpaceOwner = new Map<string, string>()

export const useSpaceProgress = create<{ progress: Record<string, number>; dot: Record<string, true> }>(() => ({ progress: {}, dot: {} }))

export function setSpaceProgress(pluginId: string, spaceId: string, value: unknown): boolean {
  if (pluginSpaceOwner.get(spaceId) !== pluginId) return false
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null
  const cur = useSpaceProgress.getState().progress
  // 插件每 0.5 秒报一次:进度环只按整百分比画,没变就不发 set(免得 Ribbon 跟着重渲)
  if (n == null ? !(spaceId in cur) : Math.round((cur[spaceId] ?? -1) * 100) === Math.round(n * 100)) return true
  const next = { ...cur }
  if (n == null) delete next[spaceId]
  else next[spaceId] = n
  useSpaceProgress.setState({ progress: next })
  return true
}

export function setSpaceDot(pluginId: string, spaceId: string, on: unknown): boolean {
  if (pluginSpaceOwner.get(spaceId) !== pluginId) return false
  const cur = useSpaceProgress.getState().dot
  if (!!on === (cur[spaceId] === true)) return true
  const next = { ...cur }
  if (on) next[spaceId] = true
  else delete next[spaceId]
  useSpaceProgress.setState({ dot: next })
  return true
}

/** 插件停用 / 换代:它挂的进度环和红点一并收掉,别人的留着。 */
export function clearSpaceProgressOf(pluginId: string): void {
  const { progress, dot } = useSpaceProgress.getState()
  const theirs = ([id]: [string, unknown]) => pluginSpaceOwner.get(id) !== pluginId
  const keep = Object.fromEntries(Object.entries(progress).filter(theirs))
  const keepDot = Object.fromEntries(Object.entries(dot).filter(theirs)) as Record<string, true>
  if (Object.keys(keep).length !== Object.keys(progress).length || Object.keys(keepDot).length !== Object.keys(dot).length)
    useSpaceProgress.setState({ progress: keep, dot: keepDot })
}
