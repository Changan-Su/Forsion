/**
 * 电脑历史(Computer History)共享契约:主进程 electron/computerHistory.ts 实现,渲染层设置页消费同一份形状。
 * 采集在 CU helper(recordSubscribe,协议 13),落盘/保留/清除/暂停全在主进程;引擎 read_computer_history
 * 只读 <forsionHome>/computer-history/(state.json + events/*.jsonl),格式改动三处同步:helper / 主进程 / 引擎。
 * 单独一个文件是为了不让渲染层 import 到 electron/(那边带 node:net / fs)。
 * 平台:macOS(helper.app,unix socket)与 Windows(windows-bridge.exe 常驻服务,命名管道;见 electron/computerHistoryWin.ts),
 * 线协议逐字节相同;其余平台 status 恒 unsupported。
 */

/** helper 推来的一条事件,主进程原样落盘(一行一条 JSON)。 */
export interface ComputerHistoryEvent {
  /** epoch ms(helper 时钟)。 */
  t: number
  kind: 'app' | 'window' | 'text' | 'click' | 'key' | 'system'
  /** bundleId:macOS = bundle id(com.google.Chrome);Windows = 小写 exe 文件名(chrome.exe),name = exe 的 FileDescription。 */
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
  /** 断点:helper 在「刚才的情境没被记录」(无痕窗口 / 排除 App·站点)之后的第一条可记录情境事件上打的标。
   *  不带时间与内容;折叠器见到它必须切段,不许跨过它合并(否则无痕时段会被算进前后的普通页面)。 */
  resumed?: true
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
  /** App 标识(macOS bundle id / Windows 小写 exe 文件名),不分大小写,`.*` 结尾 = 前缀通配 */
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
  /** 「关闭 / 暂停 / 收紧排除表」没能写进配置(主进程在后台重试,成功即消失):本次运行已生效,但写成之前重启可能
   *  按盘上旧值恢复记录、或重新记下刚排除的 App / 站点。值是落盘错误的原文。只在主进程 ↔ 设置页之间流转
   *  (引擎读的是 state.json,不看这里)。 */
  persistError?: string
  /** state.json 没能写成(写失败;要关门的那份连删也失败时附上删除的错误):主进程按退避重写,盘上跟上最新一份即消失。
   *  这期间引擎读到的记录状态可能是旧的 —— 关闭时靠第二道闸(桌面配置,见 COMPUTER_HISTORY_DESKTOP_CONFIG_*)兜底。 */
  stateError?: string
}

/**
 * 引擎的第二道闸 = 桌面壳配置里的开关(电脑历史开关的真源:主进程先落这里,再写 state.json)。
 * state.json 写不进、也删不掉(历史目录只读,桌面配置仍可写)时,「关」已经落在这份文件里:引擎除了 state.json 的
 * enabled,还要求这份文件里 `computerHistoryEnabled === true`,缺键 / 读不到 / 坏 JSON 一律按关。
 * 文件在 Electron userData 下:`<userData>/tangu-desktop-config.json`(打包版 userData = appData/Forsion,
 * dev = appData/forsion-desktop-dev,随产品名 / dev 变,**不在** forsionHome 下),所以桌面拉起引擎时经环境变量
 * `FORSION_DESKTOP_CONFIG` 传绝对路径(同 FORSION_AMADEUS_CONFIG)。三个名字改动 = 桌面 main / backendManager / 引擎同步。
 */
export const COMPUTER_HISTORY_DESKTOP_CONFIG_FILE = 'tangu-desktop-config.json'
export const COMPUTER_HISTORY_DESKTOP_CONFIG_KEY = 'computerHistoryEnabled'
export const COMPUTER_HISTORY_DESKTOP_CONFIG_ENV = 'FORSION_DESKTOP_CONFIG'

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
  /** end(缺省 = 现在)之前 hours 小时的折叠会话(新的在前),设置页时间线用。 */
  recent(hours: number, end?: number): Promise<ComputerHistorySession[]>
  /** 最近见过的 App(给「排除 App」选择器),按最近出现排序。 */
  recentApps(): Promise<Array<{ name: string; bundleId: string }>>
  /** 有记录的日子(本地日期 YYYY-MM-DD,新的在前),时间线的日期下拉只列这些。 */
  days(): Promise<string[]>
  /** bundle id → App 图标 dataURL(找不到为 null),时间线的图标行用。 */
  appIcons(bundleIds: string[]): Promise<Record<string, string | null>>
  reveal(): Promise<void>
  /** 状态变化推送(录制 ↔ 断开 ↔ 暂停…);返回取消订阅。 */
  onChanged(cb: (view: ComputerHistoryView) => void): () => void
}
