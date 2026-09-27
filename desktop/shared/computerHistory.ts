/**
 * 电脑历史(Computer History)共享契约:主进程 electron/computerHistory.ts 实现,渲染层设置页消费同一份形状。
 * 采集在 CU helper(recordSubscribe,协议 13),落盘/保留/清除/暂停全在主进程;引擎 read_computer_history
 * 只读 <forsionHome>/computer-history/(state.json + events/*.jsonl),格式改动三处同步:helper / 主进程 / 引擎。
 * 单独一个文件是为了不让渲染层 import 到 electron/(那边带 node:net / fs)。
 */

/** helper 推来的一条事件,主进程原样落盘(一行一条 JSON)。 */
export interface ComputerHistoryEvent {
  /** epoch ms(helper 时钟)。 */
  t: number
  kind: 'app' | 'window' | 'text' | 'click' | 'key' | 'system'
  app?: { name: string; bundleId?: string; excluded?: true }
  title?: string
  url?: string
  el?: { role: string; label?: string }
  text?: string
  truncated?: true
  deleted?: number
  bigEdit?: true
  keys?: string
  state?: 'locked' | 'unlocked' | 'sleep' | 'wake' | 'dropped'
  count?: number
  origin?: 'agent'
}

export type ComputerHistoryStatus =
  | 'off'
  | 'recording'
  | 'paused'
  | 'no_permission'
  | 'helper_missing'
  | 'helper_outdated'
  | 'disconnected'
  | 'unsupported'

/** <root>/state.json —— 主进程写,引擎只读(工具门控 + 状态行)。 */
export interface ComputerHistoryState {
  v: 1
  enabled: boolean
  pausedUntil: number | null
  status: ComputerHistoryStatus
  /** 进入当前 status 的时刻。 */
  since: number
  updatedAt: number
  platform: string
  /** 数据代次:每次清除、改排除表、关闭都 +1。读者(引擎工具 / Muse 摘要)读完事件后复核,变了就丢弃结果,
   *  堵「清除 / 关闭与在途读取」的竞态。缺省(老文件)按 0。 */
  dataGen: number
}

export interface ComputerHistoryExclude {
  /** bundle id */
  apps: string[]
  /** 域名(含子域) */
  domains: string[]
}

/** 设置页预览用的折叠会话(连续同 App + 同标题合成一段)。 */
export interface ComputerHistorySession {
  start: number
  end: number
  app: string
  bundleId?: string
  title?: string
  url?: string
  /** 这一段里敲过的字(截短,最多几条)。 */
  typed: string[]
}

export interface ComputerHistoryView {
  state: ComputerHistoryState
  exclude: ComputerHistoryExclude
  /** 落盘根目录(给「在访达中显示」和同意说明)。 */
  root: string
  keepDays: number
  /** 单调递增的版本(本进程内):设置页只接受比手上更新的 View,防旧的 get() 回包盖掉新的 onChanged 推送。 */
  rev: number
  /** 「关闭记录」没能写进配置(主进程在后台重试,成功即消失):本次运行已停录,但写成之前重启可能按盘上旧值恢复记录。
   *  值是落盘错误的原文。只在主进程 ↔ 设置页之间流转(引擎读的是 state.json,不看这里)。 */
  persistError?: string
}

/** 原始事件保留天数(无摘要层 → 原始事件即历史;ChatGPT 是 48h 原始 + 永久摘要)。 */
export const COMPUTER_HISTORY_KEEP_DAYS = 7
/** 需要的 helper 协议版本(< 此值 = helper_outdated)。 */
export const COMPUTER_HISTORY_PROTOCOL = 13

/** preload 暴露的 `window.tangu.computerHistory`。每个写操作都回最新的 View(设置页直接替换状态)。 */
export interface ComputerHistoryApi {
  get(): Promise<ComputerHistoryView>
  setEnabled(on: boolean): Promise<ComputerHistoryView>
  /** ms = 暂停时长;'tomorrow' = 暂停到明天本地 00:00。 */
  pause(until: number | 'tomorrow'): Promise<ComputerHistoryView>
  resume(): Promise<ComputerHistoryView>
  /** sinceMs:删 t >= sinceMs 的事件;all:全删。 */
  clear(opts: { sinceMs?: number; all?: boolean }): Promise<ComputerHistoryView>
  setExclude(exclude: ComputerHistoryExclude): Promise<ComputerHistoryView>
  /** 最近 hours 小时的折叠会话(新的在前),设置页预览用。 */
  recent(hours: number): Promise<ComputerHistorySession[]>
  /** 最近见过的 App(给「排除 App」选择器),按最近出现排序。 */
  recentApps(): Promise<Array<{ name: string; bundleId: string }>>
  reveal(): Promise<void>
  /** 状态变化推送(录制 ↔ 断开 ↔ 暂停…);返回取消订阅。 */
  onChanged(cb: (view: ComputerHistoryView) => void): () => void
}
