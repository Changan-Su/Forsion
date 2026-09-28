/**
 * 「设置 › 远程会话」页的扩展槽(P1 · K4 / INTEGRATION R-12):别的包(K2 的急停热键 / 锁定状态与解除)经这里往页尾追加区块,
 * 永不改 SettingsModal.tsx。刻意独立成小模块:注册方 import 它不会把整张设置页拖进来,也不成环。
 * 区块按 order 升序(同 order 按 id)渲染在页面三块之后;同 id 重复注册以后者为准;返回的函数注销。
 */
import type { ReactNode } from 'react'

export interface RemoteSettingsSection {
  id: string
  order: number
  render: () => ReactNode
}

const sections = new Map<string, RemoteSettingsSection>()
const listeners = new Set<() => void>()
let snapshot: RemoteSettingsSection[] = []

function publish(): void {
  snapshot = [...sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  for (const cb of [...listeners]) cb()
}

export function registerRemoteSettingsSection(s: RemoteSettingsSection): () => void {
  sections.set(s.id, s)
  publish()
  return () => {
    if (sections.get(s.id) !== s) return
    sections.delete(s.id)
    publish()
  }
}

/** 当前区块(已排序;同一份数组直到下次变更 —— useSyncExternalStore 要稳定快照)。 */
export function remoteSettingsSections(): RemoteSettingsSection[] {
  return snapshot
}

export function onRemoteSettingsSectionsChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
