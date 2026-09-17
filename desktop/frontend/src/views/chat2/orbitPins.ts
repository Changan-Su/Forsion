/** Orbits 一级条目的 Pin 状态。
 *
 * key 直接使用 SidebarPane 的一级 entry key(`ws:*` / `row:*`);value 是该 Pin 条目最近一次被
 * 用户激活的时间。它与会话 `updated_at` 完全分开:Pin 区可以按点击切换顺序重排,不会把一次浏览
 * 伪装成新消息活动。 */
export type OrbitPinTimes = Record<string, number>

export const ORBIT_PINS_KEY = 'forsion_orbits_pinned_entries_v1'

const owns = (pins: Readonly<OrbitPinTimes>, key: string): boolean => Object.prototype.hasOwnProperty.call(pins, key)

export function isOrbitPinned(pins: Readonly<OrbitPinTimes>, key: string): boolean {
  return owns(pins, key)
}

function nextStamp(pins: Readonly<OrbitPinTimes>, now: number): number {
  let latest = 0
  for (const value of Object.values(pins)) if (Number.isFinite(value)) latest = Math.max(latest, value)
  return Math.max(now, latest + 1)
}

export function toggleOrbitPin(pins: Readonly<OrbitPinTimes>, key: string, now = Date.now()): OrbitPinTimes {
  if (owns(pins, key)) {
    const next = { ...pins }
    delete next[key]
    return next
  }
  return { ...pins, [key]: nextStamp(pins, now) }
}

/** 只有已 Pin 的一级条目才记录激活;未 Pin 条目的普通 activity 排序继续只认消息时间。 */
export function touchOrbitPin(pins: Readonly<OrbitPinTimes>, key: string, now = Date.now()): OrbitPinTimes {
  if (!owns(pins, key)) return pins as OrbitPinTimes
  return { ...pins, [key]: nextStamp(pins, now) }
}

export function readOrbitPins(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): OrbitPinTimes {
  if (!storage) return {}
  try {
    const raw = JSON.parse(storage.getItem(ORBIT_PINS_KEY) || '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: OrbitPinTimes = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key && Number.isFinite(value) && Number(value) > 0) out[key] = Number(value)
    }
    return out
  } catch {
    return {}
  }
}

export function writeOrbitPins(pins: Readonly<OrbitPinTimes>, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.setItem(ORBIT_PINS_KEY, JSON.stringify(pins)) } catch { /* private mode / quota:当前会话内仍然可用 */ }
}

/** Pin 条目先组成连续区域并按最近激活降序;其余条目保持原来的消息 activity 降序。 */
export function orderOrbitEntries<T extends { key: string; at: number }>(entries: readonly T[], pins: Readonly<OrbitPinTimes>): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const ap = owns(pins, a.entry.key)
      const bp = owns(pins, b.entry.key)
      if (ap !== bp) return ap ? -1 : 1
      if (ap && bp) return pins[b.entry.key] - pins[a.entry.key] || a.index - b.index
      return b.entry.at - a.entry.at || a.index - b.index
    })
    .map(({ entry }) => entry)
}
