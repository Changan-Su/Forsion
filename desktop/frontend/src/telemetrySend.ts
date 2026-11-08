/**
 * 帮助改进 Forsion(匿名遥测)渲染层的发送叶子:只往主进程报(preload telemetryReport),主进程按白名单整形后转给 Extend,
 * 发不发由 Extend 定(契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §3 / §9)。
 * 故意没有任何运行期 import:pluginStore、成就、主题这些被很多地方 import 的模块要从这里报,反过来 import 就成环。
 * 一律即发即忘:没有 telemetryReport 键(web / 手机 / 没有带遥测的 Extend)就什么都不做;报失败吞掉,绝不影响用户路径。
 */
import type { AppCountKey, CommandSource, RendererReportKind } from '../../shared/telemetryKeys'
import type { SpecialAgentsConfig } from './types'

export function sendTelemetry(kind: RendererReportKind, props: Record<string, unknown>): void {
  try { window.tangu?.telemetryReport?.(kind, props) } catch { /* 上报失败不影响任何事 */ }
}
/** 本机有没有人接遥测(有就值得花点工夫整理要报的东西)。 */
export const telemetryOn = (): boolean => {
  try { return typeof window !== 'undefined' && typeof window.tangu?.telemetryReport === 'function' } catch { return false }
}
/** app_counts 的一次计数(主进程按小时攒成一条)。 */
export const countTelemetry = (key: AppCountKey, n = 1): void => sendTelemetry('count', n === 1 ? { key } : { key, n })

/** 引擎事件派生的计数(某个工具被调了):同一条运行会在每个订阅它的窗口里、重连 / 重载时整段回放。
 *  带上事件自己的 id,主进程(一个进程,各窗口共用)按它去重;id 只用来去重,不转发。 */
export const countTelemetryOnce = (key: AppCountKey, uniq: string): void => sendTelemetry('count', { key, once: uniq })
/** 一次设置改动:值给原始值,主进程按契约表归档(布尔 → on / off、分钟数 → 分档 …);表外的键直接丢。 */
export const settingTelemetry = (key: string, value: unknown): void => sendTelemetry('setting', { key, value })
/** 一次命令使用(主进程按小时按 (id, 来源) 攒成 command_use)。 */
export const commandTelemetry = (id: string, source: CommandSource): void => sendTelemetry('command', { id, source })
/** 匿名遥测 setting_change(契约 §9):用户真改了的 Muse 设置各报一条(值由主进程归档:开关 → on/off、心跳分钟 / 每天私信数 → 分档)。
 *  调用方只传**变了的**字段(保存成功之后):整份配置原样回写的地方(自动化列表的开关)只传它翻的那一项。 */
export function museSettingTelemetry(changed: Partial<Pick<SpecialAgentsConfig['muse'], 'enabled' | 'mode' | 'notify' | 'heartbeatMinutes' | 'maxDmPerDay'>> | undefined): void {
  if (!changed) return
  const keys: Record<string, string> = { enabled: 'muse.enabled', mode: 'muse.mode', notify: 'muse.notify', heartbeatMinutes: 'muse.heartbeat', maxDmPerDay: 'muse.maxDmPerDay' }
  for (const [field, key] of Object.entries(keys)) if (Object.hasOwn(changed, field)) settingTelemetry(key, (changed as Record<string, unknown>)[field])
}
