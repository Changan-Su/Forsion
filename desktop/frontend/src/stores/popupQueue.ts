/**
 * 自己弹出来的弹窗排队(2026-10-19):协议更新、首登同步卡、What's new、插件的公告…… 同一时间只露一个。
 * 原来各弹各的:Extend 公告(z 1600、自带焦点陷阱)会叠在 What's new / 升级引导上抢焦点,第一下 Esc 只关最上面那张。
 *
 * 规则:轮到谁谁才渲染;关掉(release)后按优先级(数字小先出)、同级按先来后到放下一个。
 * 不抢占:已经在显示的那张不会被后来的高优先级挤掉,等它关了才轮到。
 * 全屏引导(onboarding)开着时谁都不出(setPopupsBlocked),引导结束再按顺序出。
 * 用户自己点开的弹窗也走这里:前面没人就立刻出,不影响手感。
 */
import { useEffect } from 'react'
import { create } from 'zustand'

/** 数字小的先出。插件统一排在宿主自己的后面。 */
export const POPUP_PRIORITY = { terms: 0, syncSetup: 10, whatsNew: 20, plugin: 30 } as const

interface Entry { id: string; priority: number; seq: number }
interface QueueState { waiting: Entry[]; active: string | null; blocked: boolean }

export const usePopupQueue = create<QueueState>(() => ({ waiting: [], active: null, blocked: false }))
let seq = 0

function pump(): void {
  const s = usePopupQueue.getState()
  if (s.active || s.blocked || !s.waiting.length) return
  const next = s.waiting.reduce((a, b) => (b.priority < a.priority || (b.priority === a.priority && b.seq < a.seq) ? b : a))
  usePopupQueue.setState({ active: next.id, waiting: s.waiting.filter((e) => e !== next) })
}

/** 排队(同一个 id 重复排是无操作)。 */
export function requestPopup(id: string, priority: number): void {
  const s = usePopupQueue.getState()
  if (s.active === id || s.waiting.some((e) => e.id === id)) return
  usePopupQueue.setState({ waiting: [...s.waiting, { id, priority, seq: ++seq }] })
  pump()
}

/** 让出:正在显示的关掉,或还在排的撤销。 */
export function releasePopup(id: string): void {
  const s = usePopupQueue.getState()
  if (s.active === id) usePopupQueue.setState({ active: null })
  else if (s.waiting.some((e) => e.id === id)) usePopupQueue.setState({ waiting: s.waiting.filter((e) => e.id !== id) })
  else return
  pump()
}

/** 全屏引导开 / 关。开着时不放新的出来(已经在显示的不收)。 */
export function setPopupsBlocked(blocked: boolean): void {
  if (usePopupQueue.getState().blocked === blocked) return
  usePopupQueue.setState({ blocked })
  pump()
}

/** React:`want` 为真就排队,轮到了返回 true;`want` 变假或卸载就让出。 */
export function usePopupTurn(id: string, want: boolean, priority: number): boolean {
  useEffect(() => {
    if (!want) return
    requestPopup(id, priority)
    return () => releasePopup(id)
  }, [id, want, priority])
  return usePopupQueue((s) => want && s.active === id)
}

/** 非 React(插件、DOM 直挂的弹窗):`ready` 在轮到时 resolve;`done()` 让出,没轮到时调 = 撤销(`ready` 就永远不 resolve)。 */
export function queuePopup(id: string, priority: number): { ready: Promise<void>; done(): void } {
  let unsub: () => void = () => {}
  let finished = false
  const ready = new Promise<void>((resolve) => {
    const check = (s: QueueState): void => { if (!finished && s.active === id) { unsub(); resolve() } }
    unsub = usePopupQueue.subscribe(check)
    requestPopup(id, priority)
    check(usePopupQueue.getState())
  })
  return {
    ready,
    done: () => {
      if (finished) return
      finished = true
      unsub()
      releasePopup(id)
    },
  }
}

/** 插件停用 / 换代:它排的号一并收掉,别让一张永远不会关的「隐形弹窗」堵住队列。 */
export function releasePopupsOf(prefix: string): void {
  const s = usePopupQueue.getState()
  const mine = (id: string): boolean => id.startsWith(prefix)
  if (!(s.active && mine(s.active)) && !s.waiting.some((e) => mine(e.id))) return
  usePopupQueue.setState({ active: s.active && mine(s.active) ? null : s.active, waiting: s.waiting.filter((e) => !mine(e.id)) })
  pump()
}
