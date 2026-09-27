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

/** 预览只读今天:recent() 要的小时数 = 本地零点到现在(主进程按小时读文件并折叠,多要的只会被丢掉;下限 1 分钟同主进程)。 */
export function hoursSinceLocalMidnight(now: number): number {
  return Math.max(1 / 60, (now - startOfLocalDay(now)) / HOUR)
}

/** 预览只要今天(本地日界)还在进行或结束于今天的段,新的在前。 */
export function todaySessions(sessions: ComputerHistorySession[], now: number): ComputerHistorySession[] {
  const dayStart = startOfLocalDay(now)
  return sessions.filter((s) => s.end >= dayStart).sort((a, b) => b.start - a.start)
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
