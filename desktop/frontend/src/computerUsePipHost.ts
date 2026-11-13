/**
 * Computer Use 悬浮小画面的应答方:装在除 pip 以外的每扇桌面窗口里。
 * pip 窗里的 ctx.tangu.stop / agentStatus 经主进程转到这里,用**本窗**的 store 回答(谁起的这一轮,谁的
 * runningBySession 里才有它)。主进程按「主窗优先、按 run 的找第一个在跑的」合并(electron/computerUsePip.ts)。
 * 没有转发桥(web / 手机 / 旧主进程)= no-op。
 */
import type { TanguAgentStatus, TanguSessionTarget } from './amadeus/plugins/tanguSeam'
import { readAgentStatus, stopAgentRun, subscribeAgentStatus } from './tanguProbe'
import { windowKind } from './windowKind'

export interface PipAgentHostBridge {
  ready(): void
  onRequest(cb: (req: { id?: number; op: string; key?: string; target?: unknown }) => void): () => void
  reply(id: number, value: unknown): void
  status(key: string, status: unknown): void
}

export interface PipAgentHostDeps {
  read(target: TanguSessionTarget): TanguAgentStatus
  subscribe(cb: (s: TanguAgentStatus) => void, target: TanguSessionTarget): () => void
  stop(target: TanguSessionTarget): Promise<boolean>
}

/** 纯接线(测试喂假 bridge / 假 store)。返回卸载函数。 */
export function servePipAgent(bridge: PipAgentHostBridge, deps: PipAgentHostDeps): () => void {
  const subs = new Map<string, () => void>()
  const off = bridge.onRequest((req) => {
    if (!req || typeof req !== 'object') return
    const target = req.target as TanguSessionTarget
    if (req.op === 'stop' && typeof req.id === 'number') {
      const id = req.id
      void deps.stop(target).then((ok) => bridge.reply(id, ok === true), () => bridge.reply(id, false))
      return
    }
    if (typeof req.key !== 'string') return
    const key = req.key
    if (req.op === 'watch') {
      subs.get(key)?.()
      subs.set(key, deps.subscribe((st) => bridge.status(key, st), target))
      bridge.status(key, deps.read(target)) // 订阅不立刻回调:先推一份当前的
      return
    }
    if (req.op === 'unwatch') { subs.get(key)?.(); subs.delete(key) }
  })
  bridge.ready()
  return () => { off(); for (const unsub of subs.values()) unsub(); subs.clear() }
}

let installed = false
export function installComputerUsePipHost(): void {
  if (installed || windowKind() === 'pip') return
  const bridge = typeof window !== 'undefined' ? window.tangu?.pipAgentHost : undefined
  if (!bridge) return
  installed = true
  servePipAgent(bridge, { read: readAgentStatus, subscribe: subscribeAgentStatus, stop: stopAgentRun })
}
