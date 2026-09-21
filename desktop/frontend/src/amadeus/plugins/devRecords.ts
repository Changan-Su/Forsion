/**
 * Forsion Sandbox 的「开发态记账」(2026-09-21):开发副本(dev 来源)跑起来之后,**它自己说的话**去哪了。
 *
 * 为什么要单开一层:`new Function` 求值出来的代码,栈帧一律是 `<anonymous>` —— window.onerror / 控制台里
 * 看得见报错,却归不到是哪个插件说的;开发者只能在一整片宿主日志里大海捞针。所以开发副本求值时多带一个
 * `console` 形参(见 pluginStore.toPlugin),转发给真 console **一个字不改**,顺手按插件 id 落进环形缓冲。
 *
 * 本模块刻意**零依赖**(只要 zustand):pluginStore 写、pluginViews 写、devSandbox 读 —— 三方都指向这里,
 * 谁也不 import 谁,免得绕出一圈 import 环(pluginStore ↔ devSandbox)。
 *
 * 纪律:
 *  · 只存**格式化后的字符串**,绝不留住插件传进来的对象(留了就等于宿主替插件的临时对象续命,还可能把
 *    已销毁的 DOM/React 树钉在内存里);
 *  · 格式化**绝不抛**:循环引用、getter 抛错、Object.create(null)、BigInt —— 记日志把应用弄崩是最蠢的死法;
 *  · 环形缓冲有顶(日志 200 条、每条 2000 字符、挂载错误 20 条):一个 setInterval 里刷日志的插件不该吃光内存。
 */
import { create } from 'zustand'
// 两条记录的**对外契约**住 devSandbox.ts(Studio 面板只认那一个文件)。这里只 import type:
// 编译期擦除,运行期没有环(devSandbox → devRecords 是单向的)。
import type { DevPluginLog, DevPluginMountError } from './devSandbox'

/** 记账的 console 级别(其余方法如 table/dir/group 照常转发,不记账)。 */
export type DevLogLevel = DevPluginLog['level']

const MAX_LOGS = 200
const MAX_TEXT = 2000
const MAX_MOUNT_ERRORS = 20
/** 栈头:最多两帧。`new Function` 的帧名是 <anonymous>,给多了也只是噪音。 */
const STACK_HEAD_LINES = 2

export interface DevPluginRecord {
  logs: DevPluginLog[]
  mountErrors: DevPluginMountError[]
}

/** 读侧(useDevPluginState / getDevPluginState)共用的空记录:引用恒定,免得每次渲染换一个新数组。 */
export const EMPTY_DEV_RECORD: DevPluginRecord = Object.freeze({
  logs: Object.freeze([]) as unknown as DevPluginLog[],
  mountErrors: Object.freeze([]) as unknown as DevPluginMountError[],
})

interface DevRecordsState {
  byId: Record<string, DevPluginRecord>
}

export const useDevRecords = create<DevRecordsState>(() => ({ byId: {} }))

/** 一个值 → 一行可读文本。任何一步抛错都要有兜底(见文件头第二条纪律)。 */
function formatArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const kind = typeof value
  if (kind === 'number' || kind === 'boolean' || kind === 'bigint') return String(value)
  if (kind === 'symbol') return (value as symbol).toString()
  if (kind === 'function') return `[Function ${(value as { name?: string }).name || 'anonymous'}]`
  // 跨 realm 的 Error(插件代码在另一个 Function 作用域里 new 的)instanceof 判不出来,按形状认。
  const maybeError = value as { name?: unknown; message?: unknown; stack?: unknown }
  if (typeof maybeError?.message === 'string' && typeof maybeError?.stack === 'string') {
    return `${typeof maybeError.name === 'string' ? maybeError.name : 'Error'}: ${maybeError.message}`
  }
  try {
    // 类型参数写裸 `new WeakSet()`:显式写成 `WeakSet<对象类型>` 会被 webhost.test.ts 的 `<object[\s/>]`
    // 正则当成网页宿体标签报红(它扫的是文本,不是 AST)。
    const seen = new WeakSet()
    const json = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'bigint') return String(v)
      if (typeof v === 'function') return `[Function ${(v as { name?: string }).name || 'anonymous'}]`
      if (v && typeof v === 'object') {
        if (seen.has(v as object)) return '[Circular]' // 自引用对象是插件里最常见的日志入参(store / DOM 节点)
        seen.add(v as object)
      }
      return v
    })
    if (typeof json === 'string') return json
  } catch { /* toJSON / getter 抛错 → 落到下面的 String() */ }
  try { return String(value) } catch { return '[unprintable]' }
}

/** 多个入参 → 一条日志文本(空格分隔,整条封顶)。 */
export function formatDevLogArgs(args: readonly unknown[]): string {
  const parts: string[] = []
  let size = 0
  for (const arg of args) {
    const text = formatArg(arg)
    parts.push(text)
    size += text.length + 1
    if (size > MAX_TEXT) break // 已经超顶,后面的参数不必再格式化(可能还很贵)
  }
  const joined = parts.join(' ')
  return joined.length > MAX_TEXT ? `${joined.slice(0, MAX_TEXT)}…` : joined
}

const push = <T>(list: readonly T[], item: T, cap: number): T[] => {
  const next = list.length >= cap ? list.slice(list.length - cap + 1) : list.slice()
  next.push(item)
  return next
}

const recordOf = (state: DevRecordsState, pluginId: string): DevPluginRecord => state.byId[pluginId] ?? EMPTY_DEV_RECORD

export function recordDevLog(pluginId: string, level: DevLogLevel, args: readonly unknown[]): void {
  const entry: DevPluginLog = { level, text: formatDevLogArgs(args), at: Date.now() }
  useDevRecords.setState((s) => {
    const cur = recordOf(s, pluginId)
    return { byId: { ...s.byId, [pluginId]: { logs: push(cur.logs, entry, MAX_LOGS), mountErrors: cur.mountErrors } } }
  })
}

export function recordDevMountError(pluginId: string, viewId: string, error: unknown): void {
  const stack = typeof (error as { stack?: unknown })?.stack === 'string' ? (error as { stack: string }).stack : ''
  const head = stack.split('\n').slice(1, 1 + STACK_HEAD_LINES).map((l) => l.trim()).filter(Boolean).join(' | ')
  const message = `${formatArg(error)}${head ? ` — ${head}` : ''}`.slice(0, MAX_TEXT)
  const entry: DevPluginMountError = { viewId, message, at: Date.now() }
  useDevRecords.setState((s) => {
    const cur = recordOf(s, pluginId)
    return { byId: { ...s.byId, [pluginId]: { logs: cur.logs, mountErrors: push(cur.mountErrors, entry, MAX_MOUNT_ERRORS) } } }
  })
}

/** 重载插件时清账:留下条目(引用换新 → 订阅方重渲),内容归零。 */
export function clearDevRecords(pluginId: string): void {
  useDevRecords.setState((s) => (s.byId[pluginId] ? { byId: { ...s.byId, [pluginId]: { logs: [], mountErrors: [] } } } : s))
}

/** 只清日志(Studio 的「清空控制台」);挂载错误是故障史,不跟着清。 */
export function clearDevLogs(pluginId: string): void {
  useDevRecords.setState((s) => {
    const cur = s.byId[pluginId]
    if (!cur || !cur.logs.length) return s
    return { byId: { ...s.byId, [pluginId]: { logs: [], mountErrors: cur.mountErrors } } }
  })
}

/** 来源整个没了(项目被删 / 撤下开发副本且没有安装版顶上)→ 连条目一起丢。 */
export function dropDevRecords(pluginId: string): void {
  useDevRecords.setState((s) => {
    if (!(pluginId in s.byId)) return s
    const byId = { ...s.byId }
    delete byId[pluginId]
    return { byId }
  })
}

export const getDevRecord = (pluginId: string): DevPluginRecord => useDevRecords.getState().byId[pluginId] ?? EMPTY_DEV_RECORD

const RECORDED_LEVELS: readonly DevLogLevel[] = ['log', 'info', 'warn', 'error', 'debug']

/**
 * 给开发副本的 console 替身:原型链挂真 console(table / dir / group / time… 照常可用且 this 指得对),
 * 五个常用级别改写成「先记账、再原样转发」。
 * `__devProxy` 是给测试与 Studio 认的标记:已安装插件拿到的是**全局真 console**,那里没有这个属性 ——
 * 「开发副本才有 console 代理」这条是可断言的,不是靠读代码相信。
 */
export function devConsoleFor(pluginId: string): Console {
  const real = console
  const proxy = Object.create(real) as Console & { __devProxy?: true }
  Object.defineProperty(proxy, '__devProxy', { value: true, enumerable: false, configurable: true })
  for (const level of RECORDED_LEVELS) {
    Object.defineProperty(proxy, level, {
      value: (...args: unknown[]): void => {
        try { recordDevLog(pluginId, level, args) } catch { /* 记账坏了也绝不吞掉这次输出 */ }
        const fn = real[level] as ((...a: unknown[]) => void) | undefined
        if (typeof fn === 'function') fn.apply(real, args)
      },
      writable: true,
      configurable: true,
      enumerable: true,
    })
  }
  return proxy
}
