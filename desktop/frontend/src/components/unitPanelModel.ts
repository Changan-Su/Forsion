/**
 * 账号面板「Unit」段的纯逻辑:走哪条路(pickUnitRoute)、分组与折叠(unitPanelModel)。
 * 面板里一台设备只占一行,行的状态(在线 / 离线、灰字写的通路)**只**从 pickUnitRoute 的返回推导 ——
 * 别另看 `u.online`,否则通路规则一改,灰字和点下去走的路就对不上。
 * 设置 › 设备照旧按通路拆行,不走这里。
 */
import type { UnitInfo } from '../types'

export type UnitVia = 'lan' | 'p2p' | 'tunnel'

/** 选路要看的本端条件。 */
export interface UnitRouteEnv {
  /** 这台设备的直连地址此刻探得通(LAN 探针)。 */
  lanOk: boolean
  /** 本端有 P2P 打洞的桥。 */
  p2p: boolean
}

/**
 * 点这一行会走哪条路;null = 现在一条都走不通(离线)。
 * 临时规则:直连 / P2P 都不选,在线就走中转。最终规则另定,调用点只有面板一处。
 */
export function pickUnitRoute(u: Pick<UnitInfo, 'online' | 'lanUrl'>, _env: UnitRouteEnv): UnitVia | null {
  return u.online ? 'tunnel' : null
}

export type UnitPanelRow =
  | { kind: 'unit'; key: string; unit: UnitInfo; via: UnitVia | null; current: boolean }
  /** 手输地址连着的那个目标(没有名册条目;只在正看着它时出现)。 */
  | { kind: 'addr'; key: string; name: string; current: true }

export interface UnitPanelModel {
  /** 「这台电脑」打勾:没在看别的设备。 */
  localCurrent: boolean
  /** 「我的设备」外面那几行:能走通的 + 正在看的那台(掉线了也不折),名册顺序。 */
  rows: UnitPanelRow[]
  /** 折进「离线 N 台」的。 */
  offline: UnitPanelRow[]
}

/** 远程面目标 key = `<设备 id>:<lan|p2p|tunnel>` 或 `addr:<url>`;取出设备 id(addr 回 null)。 */
export function remoteUnitId(key: string | null | undefined): string | null {
  if (!key || key.startsWith('addr:')) return null
  const at = key.lastIndexOf(':')
  return at > 0 ? key.slice(0, at) : null
}

export function unitPanelModel(input: {
  units: UnitInfo[] | null | undefined
  hostUnitId: string | null
  lanOk: Record<string, boolean>
  p2p: boolean
  remote: { active: boolean; key: string | null; name?: string }
}): UnitPanelModel {
  const { units, hostUnitId, lanOk, p2p, remote } = input
  const viewingKey = remote.active ? remote.key : null
  const viewingId = remoteUnitId(viewingKey)
  const rows: UnitPanelRow[] = []
  const offline: UnitPanelRow[] = []
  // 本机、手机不列(手机上没有引擎可进)
  for (const u of units ?? []) {
    if (u.id === hostUnitId || u.kind === 'phone') continue
    const via = pickUnitRoute(u, { lanOk: !!lanOk[u.id], p2p })
    const row: UnitPanelRow = { kind: 'unit', key: u.id, unit: u, via, current: u.id === viewingId }
    if (via || row.current) rows.push(row)
    else offline.push(row)
  }
  if (viewingKey?.startsWith('addr:')) rows.push({ kind: 'addr', key: viewingKey, name: remote.name || viewingKey.slice(5), current: true })
  return { localCurrent: !viewingKey, rows, offline }
}
