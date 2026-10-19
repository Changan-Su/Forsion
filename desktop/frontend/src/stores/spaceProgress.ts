/** 插件 Space 在 Ribbon 上的进度环(2026-10-18,蓬洲云网盘:传文件时挂在它的图标上)。
 *  插件经 `ctx.app.setSpaceProgress(spaceId, 0–1 | null)` 写,只认这个插件自己带的 Space;插件拆掉时一并收掉。
 *  归属表放在这里而不是 userSpaces:userSpaces 已经 import pluginStore,pluginStore 再引 userSpaces 就成环了。 */
import { create } from 'zustand'

/** 插件捆绑包内嵌的 Space:spec id → 所属插件 id(userSpaces 装 / 卸插件 Space 时写)。 */
export const pluginSpaceOwner = new Map<string, string>()

export const useSpaceProgress = create<{ progress: Record<string, number> }>(() => ({ progress: {} }))

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

export function clearSpaceProgressOf(pluginId: string): void {
  const cur = useSpaceProgress.getState().progress
  const keep = Object.fromEntries(Object.entries(cur).filter(([id]) => pluginSpaceOwner.get(id) !== pluginId))
  if (Object.keys(keep).length !== Object.keys(cur).length) useSpaceProgress.setState({ progress: keep })
}
