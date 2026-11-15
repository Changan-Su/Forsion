/**
 * 账号面板「Unit」段的纯逻辑:走哪条路(pickUnitRoute + 记住的通路)、分组与折叠(unitPanelModel)。
 * 面板里一台设备只占一行,行的状态(在线 / 离线、灰字写的通路)**只**从 pickUnitRoute 的返回推导 ——
 * 别另看 `u.online`,否则通路规则一改,灰字和点下去走的路就对不上。
 * 设置 › 设备照旧按通路拆行,不走这里。
 */
import type { UnitInfo } from '../types'
import { sharedLabel, type SharedUnit } from '../../../shared/sharedUnits'
import { pluginDependencyIndex } from '../../../../tangu-agent/src/contracts/pluginAliases'

export type UnitVia = 'lan' | 'p2p' | 'tunnel'

/** 选路要看的本端条件。 */
export interface UnitRouteEnv {
  /** 这台设备的直连地址此刻探得通(LAN 探针;只说明端口通,分不出配没配对)。 */
  lanOk: boolean
  /** 本端有 P2P 打洞的桥。 */
  p2p: boolean
  /** 用户上一次在 设置 › 设备 里给这台明确选过、并且加载成功的通路(readRememberedVia);没选过 / 读坏 = null。 */
  remembered?: UnitVia | null
}

/** 选路结果;downgraded = 记住的是直连,这次探针不通,改走中转(调用方出声说一句)。 */
export interface UnitRoutePick { via: UnitVia; downgraded?: true }

/**
 * 点这一行会走哪条路;null = 现在一条都走不通(离线)。
 * 1. 记住的通路优先:直连要这次探得通,否则在线就改走中转(downgraded);P2P 要云端在线且本端有桥(打洞失败由 runUnitRoute 出声回落中转)。
 * 2. 没选过 → 云端在线就走中转;不因为探通就自动改走直连(没配对过会落到对方的配对页,中转也不许被顶掉)。
 * 3. 例外:云端不在线、但直连探得通 → 走直连(中转这条路走不了),不算离线。两条都不通才离线。
 */
export function pickUnitRoute(u: Pick<UnitInfo, 'online' | 'lanUrl'>, env: UnitRouteEnv): UnitRoutePick | null {
  const lan = !!u.lanUrl && env.lanOk
  if (env.remembered === 'lan') {
    if (lan) return { via: 'lan' }
    return u.online ? { via: 'tunnel', downgraded: true } : null
  }
  if (env.remembered === 'p2p' && u.online && env.p2p) return { via: 'p2p' }
  if (u.online) return { via: 'tunnel' }
  if (lan) return { via: 'lan' }
  return null
}

const VIAS: readonly UnitVia[] = ['lan', 'p2p', 'tunnel']
const viaKey = (unitId: string): string => `forsion_unit_via:${unitId}`
type KV = Pick<Storage, 'getItem' | 'setItem'>
const local = (): KV | null => { try { return window.localStorage } catch { return null } }

/** 读记住的通路。读失败、值不认识 = 没选过(null);**不据此写回**。 */
export function readRememberedVia(unitId: string, store: KV | null = local()): UnitVia | null {
  try {
    const v = store?.getItem(viaKey(unitId))
    return v && (VIAS as readonly string[]).includes(v) ? (v as UnitVia) : null
  } catch { return null }
}

/** 记下用户明确选过、并且加载成功的通路(只在 设置 › 设备 的通路行点进去、远程面加载完成时调)。 */
export function rememberVia(unitId: string, via: UnitVia, store: KV | null = local()): void {
  if (!unitId || !VIAS.includes(via)) return
  try { store?.setItem(viaKey(unitId), via) } catch { /* 存不下:下次照「没选过」走 */ }
}

export type UnitPanelRow =
  | { kind: 'unit'; key: string; unit: UnitInfo; via: UnitVia | null; downgraded?: boolean; current: boolean }
  /** 手输地址连着的那个目标(没有名册条目;只在正看着它时出现)。 */
  | { kind: 'addr'; key: string; name: string; current: true }

/** 别人共享给当前账号的 Unit 那一行。clickable = 点得动:能进(frame),或能打开它指的那个插件的主 Space。 */
export interface SharedPanelRow {
  kind: 'shared'
  key: string
  unit: SharedUnit
  /** 行尾灰字(按界面语言取好的)。 */
  role: string
  /** frame = 点了整窗切到这台;space = 点了打开那个插件的主 Space(spaceId);null = 点不动。 */
  action: { kind: 'frame' } | { kind: 'space'; spaceId: string } | null
  sleeping: boolean
  current: boolean
}

/** 一组共享过来的 Unit(按 shared.group.id 分,组标题按界面语言)。 */
export interface SharedPanelGroup { id: string; title: string; rows: SharedPanelRow[] }

export interface UnitPanelModel {
  /** 「这台电脑」打勾:没在看别的设备。 */
  localCurrent: boolean
  /** 「我的设备」外面那几行:能走通的 + 正在看的那台(掉线了也不折),名册顺序。 */
  rows: UnitPanelRow[]
  /** 折进「离线 N 台」的。 */
  offline: UnitPanelRow[]
  /** 「我的设备」之后:共享过来的 Unit,按组排(组按名册里第一次出现的顺序);不折进「离线」。 */
  shared: SharedPanelGroup[]
}

/** 共享过来的 Unit 的远程面目标 key。 */
export const sharedTargetKey = (unitId: string): string => `${unitId}:shared`
export const isSharedTargetKey = (key: string | null | undefined): boolean => !!key && key.endsWith(':shared') && !key.startsWith('addr:')

/**
 * 按插件的 manifest id 找它的主 Space:先认运行身份等于它的插件,再认改名身份(商店装的 `market-<UUID>`,
 * manifest id 记在 packageId;同一个 manifest id 只对上一个时才认)。找到后取它注册的第一个 Space(Space 列表的顺序)。
 * 插件没装 / 停用了(停用的插件的 Space 不注册)/ 没注册 Space → null。
 */
export function resolvePluginSpace(
  manifestId: string,
  plugins: ReadonlyArray<{ id: string; packageId?: string }>,
  spaceIds: readonly string[],
  ownerOf: (spaceId: string) => string | undefined,
): string | null {
  const p = pluginDependencyIndex(plugins).get(manifestId)
  if (!p) return null
  return spaceIds.find((sid) => ownerOf(sid) === p.id) ?? null
}

/** 远程面目标 key = `<设备 id>:<lan|p2p|tunnel|shared>` 或 `addr:<url>`;取出设备 id(addr 回 null)。 */
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
  /** 记住的通路(缺省 = 都没选过)。 */
  remembered?: (unitId: string) => UnitVia | null
  /** 共享过来的 Unit(缺省 = 没有)。 */
  shared?: readonly SharedUnit[]
  lang?: 'zh' | 'en'
  /** enter = none 的行:按插件 manifest id 找它的主 Space(resolvePluginSpace);找不到 = null(行点不动)。 */
  pluginSpace?: (manifestId: string) => string | null
}): UnitPanelModel {
  const { units, hostUnitId, lanOk, p2p, remote, remembered } = input
  const viewingKey = remote.active ? remote.key : null
  const viewingShared = isSharedTargetKey(viewingKey)
  const viewingId = remoteUnitId(viewingKey)
  const rows: UnitPanelRow[] = []
  const offline: UnitPanelRow[] = []
  // 本机、手机不列(手机上没有引擎可进)
  for (const u of units ?? []) {
    if (u.id === hostUnitId || u.kind === 'phone') continue
    const pick = pickUnitRoute(u, { lanOk: !!lanOk[u.id], p2p, remembered: remembered?.(u.id) ?? null })
    const via = pick?.via ?? null
    const row: UnitPanelRow = { kind: 'unit', key: u.id, unit: u, via, ...(pick?.downgraded ? { downgraded: true } : {}), current: !viewingShared && u.id === viewingId }
    if (via || row.current) rows.push(row)
    else offline.push(row)
  }
  if (viewingKey?.startsWith('addr:')) rows.push({ kind: 'addr', key: viewingKey, name: remote.name || viewingKey.slice(5), current: true })
  // 共享过来的:自己名下已有的 id / 本机 / 手机不列;按组排,组内名册顺序
  const lang = input.lang ?? 'zh'
  const own = new Set((units ?? []).map((u) => u.id))
  const groups = new Map<string, SharedPanelGroup>()
  for (const u of input.shared ?? []) {
    if (own.has(u.id) || u.id === hostUnitId || u.kind === 'phone') continue
    const s = u.shared
    const spaceId = s.enter === 'none' && s.open ? input.pluginSpace?.(s.open.plugin) ?? null : null
    const row: SharedPanelRow = {
      kind: 'shared', key: sharedTargetKey(u.id), unit: u, role: sharedLabel(s.roleLabel, lang),
      action: s.enter === 'frame' ? { kind: 'frame' } : spaceId ? { kind: 'space', spaceId } : null,
      sleeping: !!u.sleeping, current: viewingShared && u.id === viewingId,
    }
    let g = groups.get(s.group.id)
    if (!g) groups.set(s.group.id, (g = { id: s.group.id, title: sharedLabel(s.group.title, lang), rows: [] }))
    g.rows.push(row)
  }
  return { localCurrent: !viewingKey, rows, offline, shared: [...groups.values()] }
}

/** Unit 窗:名册回包 → 这扇窗的状态。list: undefined = 没有名册桥;抛错由调用方折成 'unknown'。 */
export function unitWindowRosterState(list: { status: number; json: { units?: UnitInfo[] } | null } | undefined, id: string): { state: 'signedOut' | 'missing' | 'unknown' | 'noBridge' } | { state: 'found'; unit: UnitInfo; units: UnitInfo[] } {
  if (list === undefined) return { state: 'noBridge' }
  if (list.status === 401) return { state: 'signedOut' }
  const units = list.status === 200 ? list.json?.units : undefined
  if (!Array.isArray(units)) return { state: 'unknown' }
  const unit = units.find((u) => u?.id === id)
  return unit ? { state: 'found', unit, units } : { state: 'missing' }
}
