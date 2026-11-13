/**
 * Computer Use 悬浮小画面(?window=pip)里的 ctx.tangu.stop / agentStatus / subscribeAgentStatus。
 *
 * runningBySession 每个渲染进程一份:这一轮是主窗(或某扇 Mini / 独立窗)起的,pip 窗从没挂上它,
 * 直接读本窗 store 永远是 idle、stop 永远 false。所以 pip 里这三样经主进程转给其余窗口
 * (electron/computerUsePip.ts 的 createPipAgentRelay;应答方见 computerUsePipHost.ts):
 *   - stop:invoke 转发,回的是对方窗口 stopAgentRun 的结果;
 *   - 状态:向对方订一份,快照推回来缓存在这里;agentStatus 同步读缓存(还没推到 = idle),
 *     subscribeAgentStatus 只在 statusKey 变了时回调(同本窗口版的语义)。
 * 本文件只许 import 类型和 tanguSeam / agentStatus 的叶子工具 —— tanguProbe 引它。
 */
import { idleAgentStatus, type TanguAgentStatus, type TanguSessionTarget } from './amadeus/plugins/tanguSeam'
import { statusKey } from './stores/agentStatus'

export interface PipAgentBridge {
  stop(target: unknown): Promise<boolean>
  watch(key: string, target: unknown): void
  unwatch(key: string): void
  onStatus(cb: (key: string, status: unknown) => void): () => void
}

/** 目标的稳定键(对象键序无关);形状同 TanguSessionTarget,别的字段不进键。 */
export function pipTargetKey(target: TanguSessionTarget): string {
  if (target === undefined) return 'active'
  if (target === null) return 'draft'
  if (typeof target === 'string') return `s:${target}`
  const parts: string[] = []
  if ('runId' in target) parts.push(`r:${typeof target.runId === 'string' ? target.runId : ''}`)
  if ('sessionId' in target) parts.push(`s:${typeof target.sessionId === 'string' ? target.sessionId : target.sessionId === null ? '<null>' : ''}`)
  return parts.length ? `o:${parts.join('|')}` : 'active'
}

/** 只认像状态的对象(phase 是字符串);别的当没收到。 */
function asStatus(raw: unknown): TanguAgentStatus | null {
  return raw && typeof raw === 'object' && typeof (raw as { phase?: unknown }).phase === 'string' ? raw as TanguAgentStatus : null
}

export interface PipAgentClient {
  read(target?: TanguSessionTarget): TanguAgentStatus
  subscribe(cb: (s: TanguAgentStatus) => void, target?: TanguSessionTarget): () => void
  stop(target?: TanguSessionTarget): Promise<boolean>
}

/** 纯构造(测试直接喂假 bridge)。 */
export function createPipAgentClient(bridge: PipAgentBridge): PipAgentClient {
  const cache = new Map<string, TanguAgentStatus>()
  const listeners = new Map<string, Set<(s: TanguAgentStatus) => void>>()
  /** 被 read() 拉起的订阅:pip 窗活多久它就留多久(只看一两个目标,封顶 16)。 */
  const passive = new Set<string>()
  const watched = new Set<string>()
  const ensure = (key: string, target: TanguSessionTarget): void => {
    if (watched.has(key)) return
    watched.add(key)
    bridge.watch(key, target)
  }
  bridge.onStatus((key, raw) => {
    const next = asStatus(raw)
    if (!next || !watched.has(key)) return
    const prev = cache.get(key)
    cache.set(key, next)
    if (prev && statusKey(prev) === statusKey(next)) return
    for (const cb of [...(listeners.get(key) ?? [])]) {
      try { cb(next) } catch (e) { console.error('[tangu] agentStatus subscriber threw', e) }
    }
  })
  const fallback = (target: TanguSessionTarget): TanguAgentStatus =>
    idleAgentStatus(typeof target === 'string' ? target : target && typeof target === 'object' && typeof target.sessionId === 'string' && !('runId' in target) ? target.sessionId : null)
  return {
    read(target) {
      const key = pipTargetKey(target)
      const hit = cache.get(key)
      if (hit) return hit
      if (!watched.has(key) && passive.size < 16) { passive.add(key); ensure(key, target) }
      return cache.get(key) ?? fallback(target)
    },
    subscribe(cb, target) {
      const key = pipTargetKey(target)
      let set = listeners.get(key)
      if (!set) listeners.set(key, set = new Set())
      set.add(cb)
      ensure(key, target)
      let off = false
      return () => {
        if (off) return
        off = true
        set!.delete(cb)
        if (set!.size || passive.has(key)) return
        listeners.delete(key)
        watched.delete(key)
        cache.delete(key)
        bridge.unwatch(key)
      }
    },
    stop: (target) => bridge.stop(target).then((v) => v === true, () => false),
  }
}

let client: PipAgentClient | null | undefined
/** 只在 pip 窗里、且主进程给了转发桥时有;别的窗口回 null(照旧读本窗 store)。 */
export function pipAgentClient(): PipAgentClient | null {
  if (client !== undefined) return client
  let isPip = false
  try { isPip = new URLSearchParams(location.search).get('window') === 'pip' } catch { /* no location */ }
  const bridge = isPip && typeof window !== 'undefined' ? window.tangu?.pipAgent : undefined
  client = bridge ? createPipAgentClient(bridge) : null
  return client
}
