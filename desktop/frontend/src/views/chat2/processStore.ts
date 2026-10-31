/** 后台进程(摘要栏「后台」卡、左栏行尾绿点、窄窗那一行)的数据:轮询引擎 GET /agent/processes。
 *  ponytail: 轮询不走 SSE —— 有在跑的 3s 一次、没有 15s 一次、窗口不可见不轮;Agent 起 / 停进程时调用方 refreshProcesses() 立刻刷。
 *  升级路径:引擎 processRegistry.onProcessChange 出一条 SSE。只问本机引擎 + 当前会话所在的那台(别的电脑上的会话切过去才看得到)。 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { listEngineProcesses, type EngineProcess } from '../../services/backendService'
import { homeTarget, targetForSession } from '../../services/engine/targets'
import { useApp } from '../../stores/appStore'

export type { EngineProcess }

export const useProcesses = create<{ bySession: Record<string, EngineProcess[]> }>(() => ({ bySession: {} }))

const FAST_MS = 3000
const SLOW_MS = 15000
const TIMEOUT_MS = 8000
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])
let users = 0
let timer: ReturnType<typeof setTimeout> | null = null
let inflight: Promise<void> | null = null

const anyRunning = (): boolean => Object.values(useProcesses.getState().bySession).some((l) => l.some((p) => p.status === 'running'))

async function poll(): Promise<void> {
  const targets = [homeTarget()]
  const sid = useApp.getState().activeId
  if (sid) {
    const t = targetForSession(sid)
    if (t.key !== targets[0].key) targets.push(t)
  }
  // 每台限时:一台挂住不回(隧道断了半截)不许把整轮卡死 —— 否则 inflight 永不清、再也不排下一轮
  const lists = await Promise.all(targets.map((t) => withTimeout(listEngineProcesses(t), TIMEOUT_MS).catch(() => null)))
  if (lists.every((l) => l === null)) return // 全都没连上:留着上一份,别把绿点闪没
  const bySession: Record<string, EngineProcess[]> = {}
  for (const l of lists) for (const p of l ?? []) (bySession[p.sessionId] ??= []).push(p)
  useProcesses.setState({ bySession })
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!users || document.visibilityState !== 'visible') return
  timer = setTimeout(() => { void refreshProcesses() }, anyRunning() ? FAST_MS : SLOW_MS)
}

/** 立刻拉一次(并发的合成一次),然后按快慢档接着轮。 */
export function refreshProcesses(): Promise<void> {
  if (!inflight) inflight = poll().catch(() => {}).finally(() => { inflight = null; schedule() })
  return inflight
}

const onVisible = (): void => { if (document.visibilityState === 'visible') void refreshProcesses(); else schedule() }

/** 组件挂载时登记、卸载时退订;最后一个退订就停轮询。 */
export function useProcessPolling(): void {
  useEffect(() => {
    if (users++ === 0) {
      document.addEventListener('visibilitychange', onVisible)
      void refreshProcesses()
    }
    return () => {
      if (--users === 0) {
        document.removeEventListener('visibilitychange', onVisible)
        if (timer) clearTimeout(timer)
        timer = null
      }
    }
  }, [])
}

const NONE: EngineProcess[] = []
/** 一条会话的进程:在跑的在前(服务排最前),结束的按结束时间新的在前。 */
export function useSessionProcesses(sessionId: string | null | undefined): EngineProcess[] {
  const list = useProcesses((s) => (sessionId ? s.bySession[sessionId] : undefined)) ?? NONE
  return useMemo(() => (list === NONE ? NONE : sortProcesses(list)), [list])
}

export function sortProcesses(list: EngineProcess[]): EngineProcess[] {
  const rank = (p: EngineProcess): number => (p.status === 'running' ? (p.url ? 0 : 1) : 2)
  return [...list].sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0)))
}

/** 一条会话里在跑的个数(左栏行尾绿点)。 */
export const useRunningCount = (sessionId: string): number =>
  useProcesses((s) => s.bySession[sessionId]?.filter((p) => p.status === 'running').length ?? 0)
