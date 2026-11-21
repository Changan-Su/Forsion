/**
 * Tangu 界面自己的匿名遥测发送口(契约 §9 app_counts / setting_change;v3 §19 额度提示 / 按模型计数)。故意不 import 宿主的 telemetrySend:
 * Tangu 界面会被热更新到旧宿主上,宿主模块表只许减(check:tanguboundary / build-tangu-ui),新加一个宿主依赖 = 旧宿主装不上新界面。
 * 这里直接走 preload 桥 window.tangu.telemetryReport(没有就什么都不做);键 / 值由主进程按白名单整形,表外的丢。
 * 旧宿主的主进程不认 v3 的种类(quotaPrompt / modelCount / firstRun)= 照它自己的规矩丢,调用方不受影响。
 */
type Bridge = { telemetryReport?: (kind: string, props: Record<string, unknown>) => void }
const send = (kind: 'count' | 'setting' | 'quotaPrompt' | 'modelCount' | 'firstRun', props: Record<string, unknown>): void => {
  try { (globalThis as { tangu?: Bridge; window?: { tangu?: Bridge } }).window?.tangu?.telemetryReport?.(kind, props) } catch { /* 遥测不影响任何事 */ }
}
/** app_counts 的一次计数(键见 shared/telemetryKeys APP_COUNT_KEYS;主进程按小时攒)。 */
export const tanguCount = (key: string): void => send('count', { key })
/** 一次设置改动(键见 shared/telemetryKeys SETTING_KEYS;值由主进程归档)。 */
export const tanguSetting = (key: string, value: unknown): void => send('setting', { key, value })

// ── v3 · 额度提示(quota_prompt):入口 × 动作,不带文案、不带额度数值 ──
/** = shared/telemetryKeys QUOTA_PROMPT_ENTRIES / QUOTA_PROMPT_ACTIONS(这里不引宿主模块,tangu/telemetryKeys.test.ts 逐字对上)。 */
export type TanguQuotaEntry = 'chat-banner' | 'run-error' | 'run-toast' | 'avatar-menu' | 'muse-settings' | 'quota-page' | 'other'
export type TanguQuotaAction = 'shown' | 'dismiss' | 'card' | 'points' | 'upgrade' | 'topup' | 'bgConvert' | 'bgSettings' | 'more'
/** 提示上的一次动作(点了哪颗钮)。shown 用下面两个,别直接报。 */
export const tanguQuotaPrompt = (entry: TanguQuotaEntry, action: TanguQuotaAction): void => send('quotaPrompt', { entry, action })

/**
 * 「从不显示变成显示」才计一次 shown(契约 §19):同一入口在几个分栏里各挂一份、重渲染、卸了又挂(切会话)都不重复计;
 * 提示等级变了(key 换了)算新的一次。返回释放函数:最后一份挂着的卸掉,这个入口回到「没显示」。
 */
const visible = new Map<TanguQuotaEntry, { key: string; n: number }>()
export function tanguQuotaPromptVisible(entry: TanguQuotaEntry, key: string): () => void {
  const cur = visible.get(entry)
  if (cur && cur.key === key) cur.n++
  else { visible.set(entry, { key, n: 1 }); tanguQuotaPrompt(entry, 'shown') }
  let released = false
  return () => {
    if (released) return
    released = true
    const c = visible.get(entry)
    if (c && c.key === key && --c.n <= 0) visible.delete(entry)
  }
}
/** 按条目只计一次 shown(运行出错那行的芯片:滚动 / 切会话会重挂,按消息 id 去重)。集合有上限,先进先出。 */
const shownOnce = new Set<string>()
const SHOWN_ONCE_CAP = 2000
export function tanguQuotaPromptShownOnce(entry: TanguQuotaEntry, uniq: string): void {
  const k = `${entry}\n${uniq}`
  if (shownOnce.has(k)) return
  shownOnce.add(k)
  if (shownOnce.size > SHOWN_ONCE_CAP) shownOnce.delete(shownOnce.values().next().value!)
  tanguQuotaPrompt(entry, 'shown')
}
/** 测试用:清掉露出状态。 */
export function resetQuotaPromptStateForTest(): void { visible.clear(); shownOnce.clear() }

// ── v3 · 按模型的计数(model_feedback):模型 id 原样交给主进程 → Extend,公开化(publicModelId)在 Extend ──
export type TanguModelCountKey = 'regenerate' | 'stop' | 'editResend'
export const tanguModelCount = (key: TanguModelCountKey, modelId: string | null | undefined): void => {
  if (modelId) send('modelCount', { key, modelId })
}

// ── v3 · 首次运行(first_run):只给新装的,见 tangu/firstRun.ts ──
export const tanguFirstRun = (props: { outcome: 'done' | 'error' | 'aborted'; error?: string; sinceFirstLaunchS: number; durationMs?: number }): void =>
  send('firstRun', { ...props, ...(props.error ? { error: props.error.slice(0, 2000) } : {}) })
