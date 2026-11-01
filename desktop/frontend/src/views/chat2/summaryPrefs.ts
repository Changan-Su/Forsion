/** 摘要栏(右侧车道多卡片,2026-10-25 用户选方案 A)的全局偏好:卡片顺序。
 *  存 localStorage,读不到 / 写不进就当没有偏好(隐私窗口、配额满)。
 *  ⚠️ 折叠状态**不再**记在这里:10-29 用户选第三轮方案 A,开合跟着内容走、手动的只管到这一轮结束(summaryOpen.ts)。
 *  旧版存下的 `open` 字段读的时候直接丢掉,下次写入时就没了 —— 这是用户要的行为,别加回「按卡片种类全局记住」。 */
import { create } from 'zustand'

const KEY = 'forsion.summaryCards'

interface Prefs {
  /** 用户拖过才有;没有 = 默认顺序。只记 id,不在场的卡片也留在序列里,换会话回来位置不丢。 */
  order?: string[]
}

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    return { order: Array.isArray(raw.order) ? raw.order.filter((k: unknown) => typeof k === 'string') : undefined }
  } catch { return {} }
}

export const useSummaryPrefs = create<Prefs>(load)

const save = (next: Prefs): void => {
  useSummaryPrefs.setState(next, true)
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* 存不进就只在本次有效 */ }
}

/** undefined = 恢复默认顺序。 */
export const setCardOrder = (order: string[] | undefined): void => save({ ...useSummaryPrefs.getState(), order })

/** 完整序列:保存过的在前(去重),缺的按默认顺序插到「默认里排它前面、已在序列里」的最后一个之后,
 *  一个都没有就放最前 —— 新出现的插件卡落在它的默认位置(Desk 前面),不会被追加到 Desk 后头。 */
export function fullOrder(defaults: string[], saved: string[] = []): string[] {
  const seq = saved.filter((k, i) => saved.indexOf(k) === i)
  for (let d = 0; d < defaults.length; d++) {
    const k = defaults[d]
    if (seq.includes(k)) continue
    let at = 0
    for (let p = d - 1; p >= 0; p--) {
      const i = seq.indexOf(defaults[p])
      if (i >= 0) { at = i + 1; break }
    }
    seq.splice(at, 0, k)
  }
  return seq
}

/** 在场的卡片按序排好。defaults 要包含全部在场的 id(插件卡由调用方按注册顺序拼进去)。 */
export const orderCards = (present: string[], defaults: string[], saved?: string[]): string[] =>
  fullOrder(defaults, saved).filter((k) => present.includes(k))

/** 把 id 挪到 before 前面(before = null → 最后),返回新的完整序列。 */
export function moveCard(seq: string[], id: string, before: string | null): string[] {
  const rest = seq.filter((k) => k !== id)
  const at = before === null ? rest.length : rest.indexOf(before)
  rest.splice(at < 0 ? rest.length : at, 0, id)
  return rest
}

/** 摘要卡的立体感(开发者选项,2026-10-28 用户定):浮 = 原来那枚和输入卡同档的投影 + 大圆角;
 *  半浮(缺省)= 影子收近收淡、圆角小一档,让输入卡做唯一的主浮;平 = 不投影。
 *  写的一方是宿主设置页(不 import 本文件,Tangu 边界;同一个 key 在 SettingsModal 里另写一份):它写完 localStorage
 *  再派一次 storage 事件,这里只听事件、不导出写函数。 */
export type SummaryElevation = 'float' | 'half' | 'flat'
const SUMMARY_ELEVATION_KEY = 'forsion.summaryElevation'
const ELEVATIONS: SummaryElevation[] = ['float', 'half', 'flat']

function loadElevation(): SummaryElevation {
  try {
    const v = localStorage.getItem(SUMMARY_ELEVATION_KEY) as SummaryElevation | null
    return v && ELEVATIONS.includes(v) ? v : 'half'
  } catch { return 'half' }
}

export const useSummaryElevation = create<{ elevation: SummaryElevation }>(() => ({ elevation: loadElevation() }))

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SUMMARY_ELEVATION_KEY) useSummaryElevation.setState({ elevation: loadElevation() })
  })
}
