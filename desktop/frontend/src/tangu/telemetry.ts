/**
 * Tangu 界面自己的匿名遥测发送口(契约 §9 app_counts / setting_change)。故意不 import 宿主的 telemetrySend:
 * Tangu 界面会被热更新到旧宿主上,宿主模块表只许减(check:tanguboundary / build-tangu-ui),新加一个宿主依赖 = 旧宿主装不上新界面。
 * 这里直接走 preload 桥 window.tangu.telemetryReport(没有就什么都不做);键 / 值由主进程按白名单整形,表外的丢。
 */
type Bridge = { telemetryReport?: (kind: string, props: Record<string, unknown>) => void }
const send = (kind: 'count' | 'setting', props: Record<string, unknown>): void => {
  try { (globalThis as { tangu?: Bridge; window?: { tangu?: Bridge } }).window?.tangu?.telemetryReport?.(kind, props) } catch { /* 遥测不影响任何事 */ }
}
/** app_counts 的一次计数(键见 shared/telemetryKeys APP_COUNT_KEYS;主进程按小时攒)。 */
export const tanguCount = (key: string): void => send('count', { key })
/** 一次设置改动(键见 shared/telemetryKeys SETTING_KEYS;值由主进程归档)。 */
export const tanguSetting = (key: string, value: unknown): void => send('setting', { key, value })
