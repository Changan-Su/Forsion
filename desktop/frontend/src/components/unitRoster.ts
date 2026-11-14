/**
 * 主窗里的名册缓存(账号面板的 Unit 段用):面板打开先画上一次的,同时后台刷新。
 * - 读失败 ≠ 空:unitsList 抛错或非 200/401 时保留旧名册(自己名下的和共享过来的都留);401 = 没登录 → null。
 * - 换账号 / 登出(onAuthChanged)立刻清空,免得画出上一个账号的设备。
 * - LAN 探针结果同样缓存;刷新时不先清空(否则行会在「在线 / 离线」两组之间跳),每台探完逐个覆盖。
 * - 共享过来的 Unit(别人共享给当前账号的):名册带 `{ shared: true }` 要;回包没有 `shared`(旧版云端 / Extend)= 没有这一组,
 *   `shared` 形状不对 = 不知道(沿用旧的)。正看着的那台从共享列表里没了、或不能进了 → 退回这台电脑并说一句(onSharedRevoked)。
 * 设置 › 设备在独立浮窗里(另一份 store),它自己拉,不走这里。
 */
import { create } from 'zustand'
import type { UnitInfo } from '../types'
import { parseSharedUnits, type SharedUnit } from '../../../shared/sharedUnits'

export interface UnitRosterState {
  /** undefined = 还没拉过;null = 没登录(看不到名册);[] = 名下没有别的设备 / 没有名册桥。 */
  units: UnitInfo[] | null | undefined
  /** 别人共享给当前账号的 Unit(已逐行校验);[] = 没有这一组。 */
  shared: SharedUnit[]
  /** 本机在名册里的 id(列表里滤掉它)。 */
  hostUnitId: string | null
  lanOk: Record<string, boolean>
  refresh: () => Promise<void>
  clear: () => void
}

let seq = 0
let authHooked = false
/** 每次读到可信的共享列表都回调一次(UnitSwitcher 挂:判「正看着的那台还能不能进」)。undefined = 这次不知道,不调。 */
let sharedListener: ((shared: SharedUnit[]) => void) | null = null
export function onSharedRoster(cb: ((shared: SharedUnit[]) => void) | null): void { sharedListener = cb }

/** 正看着的那台(共享过来的)此刻还能不能进:名册里还在、还是 enter = frame。 */
export function sharedStillEnterable(shared: readonly SharedUnit[], unitId: string): boolean {
  return shared.some((u) => u.id === unitId && u.shared.enter === 'frame')
}

export const useUnitRoster = create<UnitRosterState>((set, get) => ({
  units: undefined,
  shared: [],
  hostUnitId: null,
  lanOk: {},
  clear: () => { ++seq; set({ units: undefined, shared: [], hostUnitId: null, lanOk: {} }) },
  refresh: async () => {
    const t = window.tangu
    if (!authHooked && t?.onAuthChanged) {
      authHooked = true
      t.onAuthChanged(() => get().clear())
    }
    const my = ++seq
    const [list, host] = await Promise.all([
      t?.unitsList ? t.unitsList({ shared: true }).catch(() => undefined) : Promise.resolve(null),
      t?.unitHostStatus ? t.unitHostStatus().catch(() => null) : Promise.resolve(null),
    ])
    if (my !== seq) return
    let units = get().units
    let shared = get().shared
    let sharedKnown: SharedUnit[] | undefined
    if (list === null) { units = []; shared = [] } // 没有名册桥(没装 Extend):只有本机
    else if (list?.status === 200) {
      units = list.json?.units ?? []
      const json = list.json as { shared?: unknown } | null
      // 没有 shared 键 = 旧版:不画这一组(但不据此判「被撤」—— 那是不知道);有但形状不对 = 不知道,沿用旧的
      if (!json || !('shared' in json)) shared = []
      else {
        sharedKnown = parseSharedUnits(json)
        if (sharedKnown) shared = sharedKnown
      }
    } else if (list?.status === 401) { units = null; shared = [] }
    // 其余(抛错 / 5xx / 网络):保留旧缓存
    set({ units, shared, ...(host ? { hostUnitId: host.unitId ?? host.selfUnitId ?? null } : {}), ...(units === null ? { lanOk: {} } : {}) })
    if (sharedKnown) sharedListener?.(sharedKnown)
    for (const u of units ?? []) {
      if (!u.lanUrl || !t?.unitsProbeLan) continue
      void t.unitsProbeLan(u.lanUrl)
        .then((meta) => !!meta, () => false)
        .then((ok) => { if (my === seq && get().lanOk[u.id] !== ok) set((s) => ({ lanOk: { ...s.lanOk, [u.id]: ok } })) })
    }
  },
}))
