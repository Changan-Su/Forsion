/**
 * 电脑历史设置页的纯逻辑(无 React / 无 IPC),单测钉在 computerHistoryModel.test.ts。
 *
 * ⚠️ 两个 API 的时间口径相反,别写反(见 shared/computerHistory.ts 的注释):
 *   - pause(until):数字 = **时长**(ms),主进程自己加 now;'tomorrow' = 到明天本地 00:00。
 *   - clear({ sinceMs }):**绝对时刻**,删 t >= sinceMs 的事件。
 * 文案 key 一律字面量(i18nCoverage 的 C 断言只扫字面量;模板拼 key 缺词条不会红)。
 */
import type { ComputerHistorySession, ComputerHistoryStatus } from '../../../shared/computerHistory'
import { formatDateTime, formatTime } from '../format/time'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export type PauseChoice = '30m' | '1h' | 'tomorrow'
export const PAUSE_CHOICES: ReadonlyArray<{ id: PauseChoice; labelKey: string }> = [
  { id: '30m', labelKey: 'computerHistory.pause.30m' },
  { id: '1h', labelKey: 'computerHistory.pause.1h' },
  { id: 'tomorrow', labelKey: 'computerHistory.pause.tomorrow' },
]

/** pause() 的参数:时长(ms)或 'tomorrow'。 */
export function pauseArg(choice: PauseChoice): number | 'tomorrow' {
  return choice === '30m' ? 30 * MINUTE : choice === '1h' ? HOUR : 'tomorrow'
}

export type ClearChoice = '10m' | '1h' | '1d' | 'all'
export const CLEAR_CHOICES: ReadonlyArray<{ id: ClearChoice; labelKey: string; confirmKey: string }> = [
  { id: '10m', labelKey: 'computerHistory.clear.10m', confirmKey: 'computerHistory.clear.confirm10m' },
  { id: '1h', labelKey: 'computerHistory.clear.1h', confirmKey: 'computerHistory.clear.confirm1h' },
  { id: '1d', labelKey: 'computerHistory.clear.1d', confirmKey: 'computerHistory.clear.confirm1d' },
  { id: 'all', labelKey: 'computerHistory.clear.all', confirmKey: 'computerHistory.clear.confirmAll' },
]

/** clear() 的参数:最近一段 = 绝对起点 now - 时长;全部 = { all: true }。 */
export function clearArg(choice: ClearChoice, now: number): { sinceMs?: number; all?: boolean } {
  if (choice === 'all') return { all: true }
  const span = choice === '10m' ? 10 * MINUTE : choice === '1h' ? HOUR : 24 * HOUR
  return { sinceMs: now - span }
}

/** 每个状态的标签 + 可操作提示(Record 让 TS 逼出全部 8 个状态)。 */
export const STATUS_KEYS: Readonly<Record<ComputerHistoryStatus, { label: string; hint: string }>> = {
  off: { label: 'computerHistory.status.off', hint: 'computerHistory.status.offHint' },
  recording: { label: 'computerHistory.status.recording', hint: 'computerHistory.status.recordingHint' },
  paused: { label: 'computerHistory.status.paused', hint: 'computerHistory.status.pausedHint' },
  no_permission: { label: 'computerHistory.status.noPermission', hint: 'computerHistory.status.noPermissionHint' },
  helper_missing: { label: 'computerHistory.status.helperMissing', hint: 'computerHistory.status.helperMissingHint' },
  helper_outdated: { label: 'computerHistory.status.helperOutdated', hint: 'computerHistory.status.helperOutdatedHint' },
  disconnected: { label: 'computerHistory.status.disconnected', hint: 'computerHistory.status.disconnectedHint' },
  unsupported: { label: 'computerHistory.status.unsupported', hint: 'computerHistory.status.unsupportedHint' },
}

/** Windows 上说法不同的状态:没有单独安装的助手,组件随 Forsion 内置的 Computer Use 包走(缺 = 重装,旧 = 更新 Forsion)。
 *  no_permission 在 Windows 上不会出现(没有要授的系统权限)。 */
export const WINDOWS_STATUS_KEYS: Readonly<Partial<Record<ComputerHistoryStatus, { label: string; hint: string }>>> = {
  helper_missing: { label: 'computerHistory.win.helperMissing', hint: 'computerHistory.win.helperMissingHint' },
  helper_outdated: { label: 'computerHistory.win.helperOutdated', hint: 'computerHistory.win.helperOutdatedHint' },
}

/** 本平台下这个状态的标签 + 提示。 */
export function statusKeys(status: ComputerHistoryStatus, platform: string | undefined): { label: string; hint: string } {
  return (platform === 'win32' ? WINDOWS_STATUS_KEYS[status] : undefined) ?? STATUS_KEYS[status]
}

/** 有采集端的平台(与主进程 ComputerHistory.supported 同口径)。 */
export function isSupportedPlatform(platform: string | undefined): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/** 状态点的色调:ok 绿、warn 黄(等用户处理 / 自动重连)、idle 灰。 */
export function statusTone(status: ComputerHistoryStatus): 'ok' | 'warn' | 'idle' {
  if (status === 'recording') return 'ok'
  if (status === 'off' || status === 'paused' || status === 'unsupported') return 'idle'
  return 'warn'
}

/** 这几种状态靠授予 / 安装 / 更新 CU helper 解决 → 挂辅助功能权限卡(卡上的按钮会装 / 更新 / 打开系统设置)。 */
export function needsHelperSetup(status: ComputerHistoryStatus): boolean {
  return status === 'no_permission' || status === 'helper_missing' || status === 'helper_outdated'
}

export function startOfLocalDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 「暂停到 / 自…起」的时刻:同一天只写 HH:mm;不在今天(到明天 00:00、昨晚起录)带上日期,免得孤零零的 00:00 看不出是哪天。 */
export function clockLabel(at: number, now: number): string {
  return startOfLocalDay(at) === startOfLocalDay(now) ? formatTime(at) : formatDateTime(at)
}

/** 往回第 offset 天(0 = 今天)的本地零点。按日历减天,夏令时那天也落在 00:00(不能减 24h)。 */
export function dayStartAgo(now: number, offset: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - offset)
  return d.getTime()
}

/** 本地日期键 YYYY-MM-DD(与主进程日文件名同口径)。 */
export function localDayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 日期下拉列哪几天(往回的天数):今天恒在;更早的只列有记录的;正选着的那天也留着(清除后不至于选中项凭空消失)。 */
export function dayOptions(now: number, keepDays: number, days: readonly string[], selected: number): number[] {
  const has = new Set(days)
  return Array.from({ length: keepDays }, (_, i) => i).filter((i) => i === 0 || i === selected || has.has(localDayKey(dayStartAgo(now, i))))
}

/** 时间线看第 offset 天时 recent() 的参数:今天 = 零点到现在;往前的 = 整天,读到次日零点(下限 1 分钟同主进程)。 */
export function dayRange(now: number, offset: number): { hours: number; end: number } {
  const end = offset === 0 ? now : dayStartAgo(now, offset - 1)
  return { hours: Math.max(1 / 60, (end - dayStartAgo(now, offset)) / HOUR), end }
}

export const BLOCK_MS = 20 * MINUTE

/** 时间线上的一段(不调模型的「总结」):窗口按停留时长排,第一条当标题;App 同理排成图标行。 */
export interface HistoryBlock {
  start: number
  items: Array<{ app: string; bundleId?: string; title: string; host: string }>
  apps: Array<{ name: string; bundleId?: string }>
}

/**
 * dayStart 那一天的会话 → 按本地钟点对齐的 20 分钟段(15:00 / 15:20 / 15:40…),新的在前。跨段的会话按重叠时长拆给每一段,
 * 跨午夜的只算落在这一天的那截;零时长的一闪而过也记 1ms,保证它的 App 露个图标。排除的会话没有标题,只进图标行。
 */
export function historyBlocks(sessions: ComputerHistorySession[], dayStart: number, blockMs = BLOCK_MS): HistoryBlock[] {
  const next = new Date(dayStart)
  next.setDate(next.getDate() + 1)
  const dayEnd = next.getTime()
  type Acc = { apps: Map<string, { name: string; bundleId?: string; ms: number }>; items: Map<string, HistoryBlock['items'][number] & { ms: number }> }
  const acc = new Map<number, Acc>()
  for (const s of sessions) {
    if (s.end < dayStart || s.start >= dayEnd) continue
    const from = Math.max(s.start, dayStart), to = Math.min(dayEnd, Math.max(from, s.end))
    const appKey = s.bundleId || s.app
    const first = dayStart + Math.floor((from - dayStart) / blockMs) * blockMs
    // 恰好结束在段界上的不溢进下一段(b < to);零时长的只落在自己那段(b === first)
    for (let b = first; b === first || b < to; b += blockMs) {
      const ms = Math.max(1, Math.min(to, b + blockMs) - Math.max(from, b))
      let a = acc.get(b)
      if (!a) acc.set(b, a = { apps: new Map(), items: new Map() })
      const app = a.apps.get(appKey) ?? { name: s.app, bundleId: s.bundleId, ms: 0 }
      app.ms += ms
      a.apps.set(appKey, app)
      if (!s.title) continue
      const key = `${appKey}\u0000${s.title}`
      const item = a.items.get(key) ?? { app: s.app, bundleId: s.bundleId, title: s.title, host: urlHost(s.url), ms: 0 }
      item.ms += ms
      a.items.set(key, item)
    }
  }
  const byMs = <T extends { ms: number }>(m: Map<string, T>): Array<Omit<T, 'ms'>> =>
    [...m.values()].sort((x, y) => y.ms - x.ms).map(({ ms: _, ...rest }) => rest)
  return [...acc].sort((x, y) => y[0] - x[0]).map(([start, a]) => ({ start, items: byMs(a.items), apps: byMs(a.apps) }))
}

/** 预览行尾只露主机名(网址已在 helper 侧去掉查询串;这里再收成 host,行更短)。 */
export function urlHost(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return '' }
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * 用户输入的网站 → 规范域名;不合法返回 null。
 * 接受 `https://www.example.com/a?b`、`*.example.com`、`Example.COM.` 等写法,统一成 `example.com`。
 * 去掉 `www.`:排除按「域名或其子域」匹配,收宽一档只会少记,不会多记。国际化域名经 URL 转成 punycode。
 */
export function normalizeDomain(input: string): string | null {
  let raw = input.trim().toLowerCase()
  if (!raw || /\s/.test(raw)) return null
  raw = raw.replace(/^\*\./, '')
  let host: string
  try { host = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname } catch { return null }
  host = host.replace(/\.$/, '').replace(/^www\./, '')
  if (host.length > 253) return null
  const labels = host.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null
  // 顶级域不能是纯数字(挡住 IP 与 1.2 这种手滑)。
  if (/^\d+$/.test(labels[labels.length - 1])) return null
  return host
}

/**
 * 手填的 Bundle ID → 规整值;不合法返回 null。比主进程的 BUNDLE_ID_RE 严:至少一个点、不收 `*` 通配(那是内置默认表用的),
 * 大小写原样保留(helper 按原串比对,com.apple.Safari 不能被改成小写)。
 */
export function normalizeBundleId(input: string): string | null {
  const id = input.trim()
  if (id.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(id)) return null
  return id
}
