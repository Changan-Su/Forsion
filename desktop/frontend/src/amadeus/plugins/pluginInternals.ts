/**
 * `ctx.internals`(2026-11-16+):明说不稳定的内部口子。方案页 docs/ToBeImproved/插件内部接口开放方案_2026-11-16(仓根)。
 *
 * - **第一级 `internals`**:宿主状态库的只读数据副本(read / subscribe)。副本是冻结的普通数据,里面没有函数,改不了宿主;
 *   停用即作废。写不在这里:改名 / 移动 / 建文件夹 / 写文件走正式接口(ctx.app.renamePath 等,带「动别人的文件先问用户」那道闸)。
 * - **第二级 `internals-raw`**(要和第一级一起声明):宿主共享模块表(coreTangu/sharedModules.generated.ts,给可热更新的
 *   Tangu 界面包用的那张)里的真模块对象。读写都行,不保证,停用后收不回 —— 插件页标注、停用后提示重载窗口。
 * - 只在本机桌面注入(Electron 宿主;网页、手机、设备页都不给)。插件沙箱也是 Electron,算本机桌面。
 * - 宿主改内部不需要顾及插件:这里的东西不进 plugin-api 正典,不算破坏性变更。
 *
 * 出错怎么拦(方案第 4 件 b):版本只标注;声明了 internals 的已安装插件,代码末尾打一行 sourceURL,
 * 没接住的错按栈认到当前这一版头上,60 秒内 3 次 → 宿主停用它并通知(trip 由 pluginStore 接)。认不准的只进控制台。
 */
import { useCommandStore, useSpaceStore, useWorkspace } from '@lcl/engine'
import { usePageStore } from '../store/pageStore'
import { useUiStore } from '../store/uiStore'
import { createHostRequire } from '../../coreTangu/hostRequire'
import { coreTanguInfo } from '../../coreTangu/load'
import { windowKind } from '../../windowKind'
import { currentPlatform } from '../../services/platform'
import { isElectronHost } from '../unified/writeSafety'
import { internalStore, internalStoreNames, provideInternalStore, type InternalStore } from './internalsStores'
import type { PluginInternals } from './types'

provideInternalStore('page', usePageStore as unknown as InternalStore)
provideInternalStore('ui', useUiStore as unknown as InternalStore)
provideInternalStore('workspace', useWorkspace as unknown as InternalStore)
provideInternalStore('spaces', useSpaceStore as unknown as InternalStore)
provideInternalStore('commands', useCommandStore as unknown as InternalStore)

/** 这扇窗口给不给内部口子:只有本机桌面。UA 判 Electron(网页 / 手机也装 window.tangu 垫片,不能拿它判),
 *  再排掉设备页(Unit 网页)。 */
export function internalsAvailable(): boolean {
  if (typeof window === 'undefined' || !isElectronHost()) return false
  if (currentPlatform() !== 'desktop') return false
  const w = window as unknown as { tangu?: { unitPage?: unknown }; __FORSION_UNIT_PAGE__?: unknown }
  return !w.tangu?.unitPage && !w.__FORSION_UNIT_PAGE__
}

// ── 只读数据副本 ──────────────────────────────────────────────────────────────

/** 源对象 → 冻结副本。宿主的状态按不可变方式更新(宿主自己的界面也靠这个才刷新),没变的子树原样复用上一份副本,
 *  一次更新只复制变了的那几条路径。冻结的副本谁拿都一样,所以全局共用一张。Map / Set 常被原地改,不进这张表。 */
const copies = new WeakMap<object, unknown>()
const MAX_DEPTH = 64

/** 把宿主状态复制成冻结的普通数据:数字 / 文字 / 布尔 / null 原样;数组、普通对象逐层复制;函数和访问器略去;
 *  Date → 毫秒数;Map → [键, 值] 对的数组;Set → 数组;别的类实例(编辑器、DOM 节点……)略去。超过 64 层略去。 */
export function snapshotOf(value: unknown): unknown {
  return copy(value, 0)
}

function copy(v: unknown, depth: number): unknown {
  if (v === null) return null
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined' || t === 'bigint') return v
  if (t !== 'object') return undefined // 函数、symbol
  const o = v as object
  const hit = copies.get(o)
  if (hit !== undefined) return hit
  if (depth > MAX_DEPTH) return undefined
  if (Array.isArray(o)) {
    const out: unknown[] = []
    copies.set(o, out) // 先占位:环上回到自己时拿到的是同一份(填完再冻)
    for (let i = 0; i < o.length; i++) out.push(copy(o[i], depth + 1))
    return Object.freeze(out)
  }
  if (o instanceof Date) return o.getTime()
  if (o instanceof Map) {
    const out: unknown[] = []
    for (const [k, val] of o) out.push(Object.freeze([copy(k, depth + 1), copy(val, depth + 1)]))
    return Object.freeze(out)
  }
  if (o instanceof Set) {
    const out: unknown[] = []
    for (const val of o) out.push(copy(val, depth + 1))
    return Object.freeze(out)
  }
  const proto = Object.getPrototypeOf(o)
  if (proto !== Object.prototype && proto !== null) return undefined
  const out: Record<string, unknown> = {}
  copies.set(o, out)
  for (const key of Object.keys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key)
    if (!d || !('value' in d) || typeof d.value === 'function') continue
    const c = copy(d.value, depth + 1)
    if (c !== undefined || d.value === undefined) out[key] = c
  }
  return Object.freeze(out)
}

/** 两份副本是否同样的数据。共享的子树按引用直接判等,所以通常只走变了的那几条路径。 */
export function sameData(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true
  if (depth > MAX_DEPTH || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i], depth + 1)) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1)) return false
  }
  return true
}

// ── 第二级:共享模块表 ─────────────────────────────────────────────────────────

let tablePromise: Promise<Record<string, object>> | null = null
let hostRequire: ((id: string) => object) | null = null
const loadTable = (): Promise<Record<string, object>> =>
  (tablePromise ??= import('../../coreTangu/sharedModules.generated').then((m) => m.SHARED_MODULES))

/** 每个插件在这扇窗口里取用过哪些模块(插件页「这次运行取用了」、停用后的重载提示用)。 */
const rawUsage = new Map<string, Set<string>>()
const usageListeners = new Set<() => void>()

export function rawModulesUsedBy(pluginId: string): string[] {
  return [...(rawUsage.get(pluginId) ?? [])].sort()
}

export function subscribeRawUsage(listener: () => void): () => void {
  usageListeners.add(listener)
  return () => { usageListeners.delete(listener) }
}

/** 停用 / 换代时取走这个插件的取用记录(返回取走前的),新一代从零记。 */
export function takeRawUsage(pluginId: string): string[] {
  const used = rawModulesUsedBy(pluginId)
  if (rawUsage.delete(pluginId)) for (const l of usageListeners) l()
  return used
}

function noteRawUse(pluginId: string, id: string): void {
  let set = rawUsage.get(pluginId)
  if (!set) rawUsage.set(pluginId, (set = new Set()))
  if (set.has(id)) return
  set.add(id)
  for (const l of usageListeners) l()
}

// ── 出错归因与熔断 ─────────────────────────────────────────────────────────────

export const FAULT_WINDOW_MS = 60_000
export const FAULT_LIMIT = 3

/** 正在运行的那一版的 sourceURL(只认当前这一版:旧版漏清的定时器抛的错不算到新版头上)。 */
const live = new Map<string, string>()
const loads = new Map<string, number>()
const strikes = new Map<string, number[]>()
const counted = new WeakSet<object>()
let trip: ((pluginId: string) => void) | null = null
let watching = false

/** 下一版代码的 sourceURL。求值成功后再 markInternalsLive。 */
export function nextInternalsSourceUrl(pluginId: string): string {
  const n = (loads.get(pluginId) ?? 0) + 1
  loads.set(pluginId, n)
  return `forsion-plugin/${encodeURIComponent(pluginId)}/${n}/main.js`
}

export function markInternalsLive(pluginId: string, url: string): void {
  live.set(pluginId, url)
  strikes.delete(pluginId)
  watchUncaught()
}

export function dropInternalsLive(pluginId: string): void {
  live.delete(pluginId)
  strikes.delete(pluginId)
}

/** 熔断时宿主怎么办(pluginStore 接:停用 + 通知)。 */
export function setInternalsTrip(fn: ((pluginId: string) => void) | null): void {
  trip = fn
}

/** 栈里有某个插件当前这一版的帧 → 它的 id。 */
export function faultOwner(err: unknown, filename?: string): string | null {
  const stack = String((err as { stack?: unknown } | null)?.stack ?? '')
  for (const [id, url] of live) {
    if (stack.includes(url) || (filename && filename.includes(url))) return id
  }
  return null
}

/** 记一次明确算到这个插件头上的错。同一个错误对象只算一次;60 秒内满 3 次熔断。 */
export function reportInternalsFault(pluginId: string, err: unknown, now = Date.now()): void {
  if (!live.has(pluginId)) return
  if (err && typeof err === 'object') {
    if (counted.has(err)) return
    counted.add(err)
  }
  const recent = (strikes.get(pluginId) ?? []).filter((t) => now - t < FAULT_WINDOW_MS)
  recent.push(now)
  if (recent.length < FAULT_LIMIT) { strikes.set(pluginId, recent); return }
  strikes.delete(pluginId)
  try { trip?.(pluginId) } catch (e) { console.error('[amadeus] internals trip failed', e) }
}

function watchUncaught(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('error', (e) => {
    const id = faultOwner(e.error, e.filename)
    if (id) reportInternalsFault(id, e.error ?? e.message)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const id = faultOwner(e.reason)
    if (id) reportInternalsFault(id, e.reason)
  })
}

// ── ctx.internals ─────────────────────────────────────────────────────────────

export interface InternalsDeps {
  pluginId: string
  /** 声明了 internals-raw(且一并声明了 internals)。 */
  raw: boolean
  alive(): boolean
  /** 记进插件的副作用账,停用时宿主撤。 */
  own(kind: string, undo: () => void, label?: string): () => void
}

const dead = (): Error => new Error('plugin disabled')

export function createInternalsApi(deps: InternalsDeps): PluginInternals {
  const { pluginId, alive } = deps
  const kind = windowKind()
  const select = <T,>(store: InternalStore, selector?: (state: unknown) => T): T | undefined => {
    const snap = snapshotOf(store.getState())
    return selector ? selector(snap) : snap as T
  }
  const api: PluginInternals = {
    host: {
      version: async () => {
        try { return (await window.tangu?.appVersion?.()) ?? null } catch { return null }
      },
      ui: () => coreTanguInfo(),
      window: kind,
      mainWindow: kind === 'main',
    },
    stores: () => internalStoreNames(),
    read: <T,>(name: string, selector?: (state: unknown) => T): T | undefined => {
      if (!alive()) return undefined
      const store = internalStore(name)
      return store ? select(store, selector) : undefined
    },
    subscribe: <T,>(name: string, selector: (state: unknown) => T, listener: (now: T, prev: T) => void): (() => void) => {
      const store = internalStore(name)
      if (!alive() || !store || typeof selector !== 'function' || typeof listener !== 'function') return () => {}
      let prev = select(store, selector) as T
      let queued = false
      // 宿主一次操作常连着 set 好几次(打字时每个字都是一次):并到一个微任务里只算一遍
      const off = store.subscribe(() => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          if (!alive()) return
          let now: T
          try { now = select(store, selector) as T } catch (e) {
            console.error(`[amadeus] 插件 ${pluginId} 的 ctx.internals.subscribe 选择函数抛错`, e)
            reportInternalsFault(pluginId, e)
            return
          }
          if (sameData(now, prev)) return
          const before = prev
          prev = now
          try { listener(now, before) } catch (e) {
            console.error(`[amadeus] 插件 ${pluginId} 的 ctx.internals.subscribe 回调抛错`, e)
            reportInternalsFault(pluginId, e)
          }
        })
      })
      return deps.own('subscription', off, `internals.${name}`)
    },
  }
  if (deps.raw) {
    api.raw = {
      import: async (id: string): Promise<Record<string, unknown>> => {
        if (!alive()) throw dead()
        const table = await loadTable()
        if (!alive()) throw dead()
        if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(table, id)) {
          throw new Error(`"${String(id)}" is not in the host's shared module table; ctx.internals.raw.modules() lists what is`)
        }
        noteRawUse(pluginId, id)
        hostRequire ??= createHostRequire(table)
        return hostRequire(id) as Record<string, unknown>
      },
      modules: async () => Object.keys(await loadTable()).sort(),
    }
  }
  return api
}
