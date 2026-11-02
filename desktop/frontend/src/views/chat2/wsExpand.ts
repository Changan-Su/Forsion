/**
 * 侧栏项目「查看更多」的分段展开(方案 docs/ToBeImproved/Tangu工作区会话条数方案_2026-11-02,用户选 A + D)。
 * - 每点一次多露出「每次展开数」条,可以一直往下点;每个项目自己设(缺省 10),存 localStorage。
 * - 展开了多少只记在内存里:重启(整页重载)就收回去,这是用户定的,别改成持久化。
 */
export const EXPAND_STEPS = [5, 10, 20, 50] as const
export const DEFAULT_EXPAND_STEP = 10
const STEP_KEY = 'forsion_tangu_ws_expand_step'

/** 读坏了 / 值不合法 = 当没设过,回缺省;只影响一次露几条,不会据此写回。 */
export function parseExpandSteps(raw: string | null): Record<string, number> {
  try {
    const v = JSON.parse(raw || '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter(([, n]) => (EXPAND_STEPS as readonly unknown[]).includes(n))) as Record<string, number>
  } catch { return {} }
}

export function expandStepOf(wsKey: string): number {
  let raw: string | null = null
  try { raw = localStorage.getItem(STEP_KEY) } catch { /* ignore */ }
  return parseExpandSteps(raw)[wsKey] ?? DEFAULT_EXPAND_STEP
}

export function setExpandStep(wsKey: string, n: number): void {
  try {
    const cur = parseExpandSteps(localStorage.getItem(STEP_KEY))
    cur[wsKey] = n
    localStorage.setItem(STEP_KEY, JSON.stringify(cur))
  } catch { /* ignore */ }
}

/** 项目 key → 在条数上限之外多露出的条数。模块级:侧栏重挂(换 Space 再回来)还在,重启就没了。 */
export const expandedExtra = new Map<string, number>()
export const WS_EXPAND_EVENT = 'tangu:wsexpand'

/** 同时挂着几个侧栏时共用这一份:改完广播,各实例重渲(别用组件闭包里的旧值去覆盖)。 */
export function setExpandedExtra(wsKey: string, n: number): void {
  if (n > 0) expandedExtra.set(wsKey, n); else expandedExtra.delete(wsKey)
  try { window.dispatchEvent(new Event(WS_EXPAND_EVENT)) } catch { /* ignore */ }
}
