/** Mini 视图往宿主胶囊里登记「标题下拉 + 新建」:视图不再自己画一条栏(10-17 方案 A)。
 *  Mini 窗口里一次只有一个视图,所以就一个槽位。 */
import { useEffect, useSyncExternalStore } from 'react'

export interface MiniChromePicker {
  /** 下拉的无障碍名 + 浮层标题(如「对话」「选择笔记」)。 */
  label: string
  /** 没选中任何项时胶囊里显示的字(如「新会话」「选择笔记」)。 */
  placeholder: string
  value: string
  items: { id: string; label: string }[]
  onSelect: (id: string) => void
  create?: { label: string; disabled?: boolean; onCreate: () => void }
}

let slot: MiniChromePicker | null = null
let sig = ''
let version = 0
const subs = new Set<() => void>()
const signature = (p: MiniChromePicker | null): string => p ? JSON.stringify([p.label, p.placeholder, p.value, p.items, p.create?.label, p.create?.disabled]) : ''

/** 回调每次渲染都换新;只在看得见的内容变了才通知宿主重画(否则宿主重画 → 视图重渲染 → 再登记,死循环)。 */
export function setMiniChrome(p: MiniChromePicker | null): void {
  const next = signature(p)
  slot = p
  if (next === sig) return
  sig = next
  version++
  subs.forEach((f) => f())
}

/** 快照取版本号而不是对象本身:对象每次渲染都会被静默换新(带新回调),拿它当快照会被 React 判成撕裂、反复重画。 */
export function useMiniChromeSlot(): MiniChromePicker | null {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => version)
  return slot
}

/** 点击时取最新回调(渲染时拿到的那份可能已被静默换过)。 */
export const currentMiniChrome = (): MiniChromePicker | null => slot

/** 视图里调用;卸载时自动撤掉。 */
export function useMiniChrome(p: MiniChromePicker | null): void {
  useEffect(() => { setMiniChrome(p) })
  useEffect(() => () => setMiniChrome(null), [])
}
