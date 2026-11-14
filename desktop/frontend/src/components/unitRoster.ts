/**
 * 主窗里的名册缓存(账号面板的 Unit 段用):面板打开先画上一次的,同时后台刷新。
 * - 读失败 ≠ 空:unitsList 抛错或非 200/401 时保留旧名册;401 = 没登录 → null。
 * - 换账号 / 登出(onAuthChanged)立刻清空,免得画出上一个账号的设备。
 * - LAN 探针结果同样缓存;刷新时不先清空(否则行会在「在线 / 离线」两组之间跳),每台探完逐个覆盖。
 * 设置 › 设备在独立浮窗里(另一份 store),它自己拉,不走这里。
 */
import { create } from 'zustand'
import type { UnitInfo } from '../types'

export interface UnitRosterState {
  /** undefined = 还没拉过;null = 没登录(看不到名册);[] = 名下没有别的设备 / 没有名册桥。 */
  units: UnitInfo[] | null | undefined
  /** 本机在名册里的 id(列表里滤掉它)。 */
  hostUnitId: string | null
  lanOk: Record<string, boolean>
  refresh: () => Promise<void>
  clear: () => void
}

let seq = 0
let authHooked = false

export const useUnitRoster = create<UnitRosterState>((set, get) => ({
  units: undefined,
  hostUnitId: null,
  lanOk: {},
  clear: () => { ++seq; set({ units: undefined, hostUnitId: null, lanOk: {} }) },
  refresh: async () => {
    const t = window.tangu
    if (!authHooked && t?.onAuthChanged) {
      authHooked = true
      t.onAuthChanged(() => get().clear())
    }
    const my = ++seq
    const [list, host] = await Promise.all([
      t?.unitsList ? t.unitsList().catch(() => undefined) : Promise.resolve(null),
      t?.unitHostStatus ? t.unitHostStatus().catch(() => null) : Promise.resolve(null),
    ])
    if (my !== seq) return
    let units = get().units
    if (list === null) units = [] // 没有名册桥(没装 Extend):只有本机
    else if (list?.status === 200) units = list.json?.units ?? []
    else if (list?.status === 401) units = null
    // 其余(抛错 / 5xx / 网络):保留旧缓存
    set({ units, ...(host ? { hostUnitId: host.unitId ?? host.selfUnitId ?? null } : {}), ...(units === null ? { lanOk: {} } : {}) })
    for (const u of units ?? []) {
      if (!u.lanUrl || !t?.unitsProbeLan) continue
      void t.unitsProbeLan(u.lanUrl)
        .then((meta) => !!meta, () => false)
        .then((ok) => { if (my === seq && get().lanOk[u.id] !== ok) set((s) => ({ lanOk: { ...s.lanOk, [u.id]: ok } })) })
    }
  },
}))
