/**
 * Computer Use 悬浮小画面(宿主私有桥 window.tangu.computerUsePip,**不是**公开的插件 API)。
 *
 * 用户在实时画面视图里点「移到悬浮窗」时,插件调 computerUsePip.open();这里起一扇 264 宽的置顶小窗,
 * 只挂插件的实时画面视图(plugin:tangu-computer-use:live,视图上下文 surface: 'pip')。性质(跨仓契约 §2.5):
 *   - 绝不自己出现:只响应 open()。不进 Mini 名册 —— 不随下次启动恢复、不占 6 扇上限、不算「手动 Mini 可见」
 *     (自动 Mini 照旧出没)、应用退出时关掉。
 *   - 置顶、不抢焦点、不进 Dock / 任务栏、无父窗(子窗跨屏会让 Electron 40 在第一下按键 SIGSEGV)、
 *     初始在主屏右上角距边 24、能拖、高度随内容。窗口本身由 desktopFloat.createDesktopFloat 起。
 *   - 插件没装 / 没启用:窗口先藏着加载,渲染层等视图注册;等不到(或报不可用)就销毁,open() 回 false,从头到尾不上屏。
 *
 * 这扇窗里的 ctx.tangu.stop / agentStatus / subscribeAgentStatus 要作用到「真正跑着这一轮」的那扇窗
 * (runningBySession 每个渲染进程一份,pip 自己从没挂上那一轮):经主进程转给其他窗口,见 createPipAgentRelay。
 *
 * 本文件只放纯逻辑(依赖注入,vitest 可测);BrowserWindow / ipcMain 的接线在 main.ts。
 */
import type { Rectangle } from 'electron'
import { desktopFloatBounds } from './desktopFloat'

export const PIP_WIDTH = 264
/** 画面约 173 + 一行说明约 35;渲染层量出实际内容高再报(window:pipResize)。 */
export const PIP_DEFAULT_HEIGHT = 208
export const PIP_MIN_HEIGHT = 96
export const PIP_MAX_HEIGHT = 480
export const PIP_MARGIN = 24
export const PIP_VIEW = 'plugin:tangu-computer-use:live'
/** 渲染层(插件加载 + 视图注册)多久没报就当插件不在。冷启动的插件装载 + 引擎握手要几秒。 */
export const PIP_READY_TIMEOUT_MS = 15_000

/** 高度随内容,但夹在 [PIP_MIN_HEIGHT, PIP_MAX_HEIGHT];非数 / 非正数回缺省。 */
export function clampPipHeight(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : PIP_DEFAULT_HEIGHT
  return Math.max(PIP_MIN_HEIGHT, Math.min(PIP_MAX_HEIGHT, n))
}

/** 初始位置:主屏工作区右上角,距边 24。 */
export function pipInitialBounds(primaryWorkArea: Rectangle, height = PIP_DEFAULT_HEIGHT): Rectangle {
  return desktopFloatBounds(primaryWorkArea, { width: PIP_WIDTH, height: clampPipHeight(height) }, 'top-end', PIP_MARGIN)
}

/** 改高度时右上角不动(用户拖到哪就在哪),只往下长 / 往上收;宽度钉死 264。 */
export function pipResizedBounds(current: Rectangle, height: unknown): Rectangle {
  return { x: current.x, y: current.y, width: PIP_WIDTH, height: clampPipHeight(height) }
}

/** 窗口最少要会的那几样(BrowserWindow 的子集,测试里用假的)。 */
export interface PipWindowLike {
  isDestroyed(): boolean
  showInactive(): void
  moveTop(): void
  getBounds(): Rectangle
  setBounds(bounds: Rectangle): void
  destroy(): void
  close(): void
  readonly webContents: { readonly id: number }
}

export interface PipControllerDeps {
  /** 起一扇**隐藏**的窗(show:false),并开始载入 ?window=pip。closed 时调 onClosed。 */
  create(bounds: Rectangle, onClosed: () => void): PipWindowLike
  primaryWorkArea(): Rectangle
  readyTimeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  /** 窗口关掉(用户点放回去 / 应用退出 / 插件不在):relay 据此撤掉所有转发订阅。 */
  onGone?: () => void
}

export interface PipController {
  /** 已开着 → 叫到原处(不挪位置)回 true;加载中 → 等同一个结果;否则起窗,渲染层报 ready 才上屏。 */
  open(): Promise<boolean>
  close(): void
  isOpen(): boolean
  /** 这条 IPC 是不是 pip 窗口发的(只认当前这扇)。 */
  owns(webContentsId: number): boolean
  /** 渲染层报:视图挂上了(ok:true,带内容高)/ 插件不在(ok:false)。 */
  ready(webContentsId: number, ok: boolean, height?: unknown): void
  resize(webContentsId: number, height: unknown): void
  /** 退出收尾:直接销毁,不走 close 拦截。 */
  dispose(): void
}

export function createComputerUsePip(deps: PipControllerDeps): PipController {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let win: PipWindowLike | null = null
  let shown = false
  let pending: { promise: Promise<boolean>; resolve: (ok: boolean) => void; timer: unknown } | null = null

  const settle = (ok: boolean): void => {
    const p = pending
    if (!p) return
    pending = null
    clearTimer(p.timer)
    p.resolve(ok)
  }
  const drop = (): void => {
    const w = win
    win = null
    shown = false
    settle(false)
    if (w && !w.isDestroyed()) w.destroy()
  }
  const live = (): PipWindowLike | null => (win && !win.isDestroyed() ? win : null)

  return {
    open() {
      const w = live()
      if (w && shown) {
        // 叫到原处:不重摆位置(用户可能拖走了),只保证在最上面且看得见;仍不抢焦点
        w.showInactive()
        w.moveTop()
        return Promise.resolve(true)
      }
      if (pending) return pending.promise
      let resolve!: (ok: boolean) => void
      const promise = new Promise<boolean>((r) => { resolve = r })
      pending = { promise, resolve, timer: null }
      const self = pending
      self.timer = setTimer(() => { if (pending === self) drop() }, deps.readyTimeoutMs ?? PIP_READY_TIMEOUT_MS)
      const created = deps.create(pipInitialBounds(deps.primaryWorkArea()), () => {
        if (win !== created) return
        win = null
        shown = false
        settle(false)
        deps.onGone?.()
      })
      win = created
      return promise
    },
    close() {
      const w = live()
      if (!w) return
      if (!shown) { drop(); deps.onGone?.(); return }
      w.close()
    },
    isOpen: () => !!live() && shown,
    owns: (id) => { const w = live(); return !!w && w.webContents.id === id },
    ready(id, ok, height) {
      const w = live()
      if (!w || w.webContents.id !== id || shown) return
      if (!ok) { drop(); deps.onGone?.(); return }
      w.setBounds(pipResizedBounds(w.getBounds(), height))
      shown = true
      w.showInactive()
      settle(true)
    },
    resize(id, height) {
      const w = live()
      if (!w || w.webContents.id !== id) return
      const next = pipResizedBounds(w.getBounds(), height)
      const cur = w.getBounds()
      if (next.height !== cur.height || next.width !== cur.width) w.setBounds(next)
    },
    dispose() { drop() },
  }
}

// ── 停止 / 状态转发 ──────────────────────────────────────────────────────────

/** 会话参数(同 ctx.tangu 的 TanguSessionTarget;这里只做形状校验,不认识的一律当「主区当前会话」)。 */
export type PipAgentTarget = string | null | undefined | { sessionId?: string | null; runId?: string | null }

/** 只放行插件 API 认的形状,别的字段丢掉(这条缝原样转发 = 让页面往别的窗口塞任意对象)。 */
export function normalizePipTarget(raw: unknown): PipAgentTarget {
  if (raw === null || raw === undefined) return raw as null | undefined
  if (typeof raw === 'string') return raw.slice(0, 256)
  if (typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const out: { sessionId?: string | null; runId?: string | null } = {}
  if ('runId' in o) out.runId = typeof o.runId === 'string' ? o.runId.slice(0, 128) : null
  if ('sessionId' in o) out.sessionId = typeof o.sessionId === 'string' ? o.sessionId.slice(0, 256) : o.sessionId === null ? null : undefined
  return out
}

/** 按 runId 找的目标可以落在任何一扇窗(谁跑着谁回答);其余(会话 id / 主区当前会话)只认主窗。 */
export function targetIsByRun(target: PipAgentTarget): boolean {
  return !!target && typeof target === 'object' && 'runId' in target
}

export interface PipAgentHost {
  /** webContents id */
  id: number
  main: boolean
  send(channel: string, payload: unknown): void
}

/** 主进程 → 宿主窗口的请求 / 订阅;宿主窗口回 pipAgent:reply / pipAgent:status。 */
export const PIP_AGENT_CHANNELS = {
  /** 主进程 → 宿主窗口:{ id, op: 'stop', target } | { op: 'watch', key, target } | { op: 'unwatch', key } */
  request: 'pipAgent:request',
  /** 主进程 → pip:{ key, status } */
  status: 'pipAgent:status',
} as const

type Status = { phase?: unknown; runId?: unknown } & Record<string, unknown>

export interface PipAgentRelayDeps {
  /** 能回答的窗口(主窗排第一);每次现取。 */
  hosts(): PipAgentHost[]
  /** 推给 pip 窗(没开就 no-op)。 */
  toPip(key: string, status: unknown): void
  replyTimeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

/**
 * 转发:pip 窗的 stop 依次问各窗口(主窗先),第一个回 true 的算停了;一个都没有 = false。
 * 订阅:pip 要 watch 一个目标 → 每扇宿主窗口各订一份并把快照推回来,这里按「主窗优先、按 run 的取第一个不是 idle 的」合并,
 * 变了才推给 pip。宿主窗口重载后会报 hostReady,把还在的订阅重发给它。
 */
export function createPipAgentRelay(deps: PipAgentRelayDeps) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const timeoutMs = deps.replyTimeoutMs ?? 4000
  let seq = 0
  const pendingReplies = new Map<number, { hostId: number; resolve: (v: unknown) => void; timer: unknown }>()
  const watches = new Map<string, PipAgentTarget>()
  /** key → hostId → 最近一份快照 */
  const snapshots = new Map<string, Map<number, Status>>()
  const lastPushed = new Map<string, string>()

  const ask = (host: PipAgentHost, payload: Record<string, unknown>): Promise<unknown> => new Promise((resolve) => {
    const id = ++seq
    const timer = setTimer(() => { if (pendingReplies.delete(id)) resolve(undefined) }, timeoutMs)
    pendingReplies.set(id, { hostId: host.id, resolve, timer })
    try { host.send(PIP_AGENT_CHANNELS.request, { ...payload, id }) } catch { pendingReplies.delete(id); clearTimer(timer); resolve(undefined) }
  })

  const merged = (key: string): Status | null => {
    const per = snapshots.get(key)
    if (!per || per.size === 0) return null
    const hosts = deps.hosts()
    const target = watches.get(key)
    if (!targetIsByRun(target)) {
      const main = hosts.find((h) => h.main)
      return main ? per.get(main.id) ?? null : null
    }
    const ordered = hosts.map((h) => per.get(h.id)).filter((s): s is Status => !!s)
    return ordered.find((s) => s.phase !== 'idle') ?? ordered[0] ?? null
  }
  const push = (key: string): void => {
    if (!watches.has(key)) return
    const st = merged(key)
    if (!st) return
    const sig = JSON.stringify(st)
    if (lastPushed.get(key) === sig) return
    lastPushed.set(key, sig)
    deps.toPip(key, st)
  }

  const unwatch = (rawKey: unknown): void => {
    if (typeof rawKey !== 'string' || !watches.delete(rawKey)) return
    snapshots.delete(rawKey); lastPushed.delete(rawKey)
    for (const host of deps.hosts()) try { host.send(PIP_AGENT_CHANNELS.request, { op: 'unwatch', key: rawKey }) } catch { /* window gone */ }
  }

  return {
    async stop(rawTarget: unknown): Promise<boolean> {
      const target = normalizePipTarget(rawTarget)
      const hosts = deps.hosts()
      const candidates = targetIsByRun(target) ? hosts : hosts.filter((h) => h.main)
      for (const host of candidates) {
        if ((await ask(host, { op: 'stop', target })) === true) return true
      }
      return false
    },
    reply(hostId: number, id: unknown, value: unknown): void {
      if (typeof id !== 'number') return
      const p = pendingReplies.get(id)
      if (!p || p.hostId !== hostId) return // 别的窗口不能替人回答
      pendingReplies.delete(id)
      clearTimer(p.timer)
      p.resolve(value)
    },
    watch(rawKey: unknown, rawTarget: unknown): void {
      if (typeof rawKey !== 'string' || !rawKey || rawKey.length > 600) return
      const target = normalizePipTarget(rawTarget)
      if (watches.has(rawKey)) { push(rawKey); return }
      if (watches.size >= 32) return // pip 只看一两个目标;封顶防页面刷爆
      watches.set(rawKey, target)
      for (const host of deps.hosts()) try { host.send(PIP_AGENT_CHANNELS.request, { op: 'watch', key: rawKey, target }) } catch { /* window gone */ }
    },
    unwatch,
    /** 宿主窗口推来一份快照。 */
    status(hostId: number, rawKey: unknown, status: unknown): void {
      if (typeof rawKey !== 'string' || !watches.has(rawKey) || !status || typeof status !== 'object') return
      let per = snapshots.get(rawKey)
      if (!per) snapshots.set(rawKey, per = new Map())
      per.set(hostId, status as Status)
      push(rawKey)
    },
    /** 宿主窗口(重)载好了:它之前的快照作废,还在的订阅重发给它。 */
    hostReady(hostId: number): void {
      for (const per of snapshots.values()) per.delete(hostId)
      const host = deps.hosts().find((h) => h.id === hostId)
      if (host) for (const [key, target] of watches) try { host.send(PIP_AGENT_CHANNELS.request, { op: 'watch', key, target }) } catch { /* window gone */ }
      for (const key of watches.keys()) push(key)
    },
    hostGone(hostId: number): void {
      for (const [id, p] of pendingReplies) if (p.hostId === hostId) { pendingReplies.delete(id); clearTimer(p.timer); p.resolve(undefined) }
      for (const per of snapshots.values()) per.delete(hostId)
      for (const key of watches.keys()) push(key)
    },
    /** pip 关了:撤掉所有订阅。 */
    clear(): void {
      for (const key of [...watches.keys()]) unwatch(key)
    },
    watchCount: () => watches.size,
  }
}
