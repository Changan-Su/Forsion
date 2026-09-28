/**
 * 跨设备会话聚合(P1-K7a;方案 §4.7 b1 / D6,规格 K7 §3.3–§3.4;INTEGRATION R-15 / R-16 / R-17 / R-20)。
 *
 * 手机侧栏 = 本端(云端)会话 ∪ 每台在线电脑一段「那台上的会话」。那一段**现拉现用、只在内存**(D6):
 *   - 名册:window.tangu.unitsList(),只留电脑(kind 缺席的老名册按电脑算),去掉本机;
 *   - 逐台:经 K6 engineFetch 打 `GET /agent/sessions?archived=false&limit=50`(8s 超时),结果记成探针(services/deviceMarks),
 *     状态按 services/deviceStatus(R-22,K8 产出)算 —— 离线 / 引擎没起 / 拒绝各是各的;离线的电脑整段会话立即不可见;
 *   - 合并规则:设备自报的会话 id 撞上本端会话、或已绑到别处(bindingConflict,只问不绑)→ 丢掉那一行(console.warn,不提示)。
 *     设备可能故意撞 id(S2),本端胜;列表**不绑定**任何东西,绑定只在真正打开那一条时发生。
 * 远端会话**只在打开时**注入 appStore.sessions(inject-on-open,R-17):adoptRemoteSession = bindSession(先到先得,conflict 即拒)
 * → 经 withLocation 打标插进列表 → openSession。不把整台电脑的会话并进 appStore.sessions(workspaces() 等 22 个读者会把 Mac 的
 * 路径当成本机项目)。
 * 远端行只给「重命名 / 归档」(PATCH;DELETE 是 deny-remote,本模块永不发)。
 * 名册的 caps / name 与会话标题都是设备自报:只作纯文本显示,永不作授权依据 —— 真正的拒绝恒是 HTTP 码。
 */
import { create } from 'zustand'
import type { SessionRecord, UnitInfo } from '../types'
import { useApp } from './appStore'
import { openSession } from '../sessionNav'
import { setActiveSpace, useSpaceStore } from '@lcl/engine'
import { bindSession, bindingConflict, engineFetch, isUnitIdShape, locationOf, noteUnitName, sameRef, targetForRef, withLocation } from '../services/engine/targets'
import { describeDevice, type DeviceStatus, type RefusalDetail } from '../services/deviceStatus'
import { noteDeviceProbe, probeOfError, resetDeviceMarks, useDeviceMarks } from '../services/deviceMarks'
import { rosterAvailable, runLocationsAvailable } from '../features/runtime'
import { getSessionDetail, updateSession } from '../services/backendService'
import { AGENT_APP_ID } from '../services/agentRunService'

/** 逐台会话列表的新鲜度:比这更新就不重拉(手动刷新 / force 除外)。 */
export const DEVICE_LIST_FRESH_MS = 10_000
/** 逐台拉会话列表的超时(4G 上经 hub 隧道;K7 §3.3)。 */
export const DEVICE_LIST_TIMEOUT_MS = 8_000
/** 每台最多列多少条(引擎按 updated_at 倒序;更早的留在那台的设备页里)。 */
export const DEVICE_LIST_LIMIT = 50

export type UnitRef = { kind: 'unit'; unitId: string }

export interface DeviceEntry {
  /** 这台列出来的会话(撞 id / 已绑到别处的已丢掉),新的在前。离线 / 引擎没起 / 拉失败 = []。 */
  sessions: SessionRecord[]
  fetchedAt: number | null
  loading: boolean
}

interface DeviceSessionsState {
  /** 账号代:换号 / 登出递增,在飞的回包代不对一律作废。 */
  gen: number
  /** 名册里的电脑(已去掉手机与本机),名册序。null = 还没拉过 / 这一端没有名册。 */
  units: UnitInfo[] | null
  byUnit: Record<string, DeviceEntry>
  /** 最近一次整轮刷新完成的时刻(runLocationStore 订阅它做「默认位置」的对账)。 */
  refreshedAt: number
  refreshRoster(): Promise<UnitInfo[] | null>
  refresh(opts?: { force?: boolean }): Promise<void>
  reset(): void
}

const EMPTY_ENTRY: DeviceEntry = { sessions: [], fetchedAt: null, loading: false }

/** 本机的设备 id(手机 = 原生身份;桌面 = unitHost 配对)。拿不到 = null(名册里就不排除任何一台)。 */
async function selfUnitId(): Promise<string | null> {
  try {
    const s = await window.tangu?.unitSelf?.()
    if (s?.unitId) return s.unitId.toLowerCase()
  } catch { /* 没有原生身份 */ }
  try {
    const h = await window.tangu?.unitHostStatus?.()
    if (h?.unitId) return h.unitId.toLowerCase()
  } catch { /* 不是桌面 */ }
  return null
}

/** 名册行 → 只留能跑会话的电脑(kind 缺席 = 老名册 = 电脑;手机没有引擎)、不是本机、id 形状对。 */
export function runnableDesktops(units: readonly UnitInfo[], selfId: string | null): UnitInfo[] {
  return units.filter((u) => !!u && typeof u.id === 'string' && isUnitIdShape(u.id) && (u.kind ?? 'desktop') === 'desktop' && u.id.toLowerCase() !== selfId)
}

/** 设备自报的会话行 → 只收形状对的(id 是短串);它自带的 location 一律扔掉(位置只从绑定表派生,R-15)。 */
function sanitizeRows(raw: unknown): SessionRecord[] {
  const rows = (raw as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(rows)) return []
  const out: SessionRecord[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const x = r as SessionRecord & { location?: unknown }
    if (typeof x.id !== 'string' || !x.id || x.id.length > 200 || x.archived) continue
    const { location: _drop, ...rest } = x
    void _drop
    out.push({ ...rest, title: typeof rest.title === 'string' ? rest.title : '' } as SessionRecord)
  }
  return out
}

function unitRef(unitId: string): UnitRef {
  return { kind: 'unit', unitId: unitId.toLowerCase() }
}

export const useDeviceSessions = create<DeviceSessionsState>((set, get) => ({
  gen: 0,
  units: null,
  byUnit: {},
  refreshedAt: 0,

  refreshRoster: async () => {
    if (!rosterAvailable() || !window.tangu?.unitsList) return null
    const gen = get().gen
    let listed: UnitInfo[] | null = null
    try {
      const r = await window.tangu.unitsList()
      if (r?.status === 200 && Array.isArray(r.json?.units)) listed = r.json!.units
    } catch { /* 名册拉不到:保留上一份 */ }
    if (gen !== get().gen) return null
    if (!listed) return get().units
    const units = runnableDesktops(listed, await selfUnitId())
    if (gen !== get().gen) return null
    for (const u of units) noteUnitName(unitRef(u.id), u.name)
    set({ units })
    return units
  },

  refresh: async (opts = {}) => {
    if (!runLocationsAvailable()) return
    const gen = get().gen
    const units = await get().refreshRoster()
    if (!units || gen !== get().gen) return
    await Promise.all(units.map((u) => fetchDevice(u, gen, !!opts.force)))
    if (gen !== get().gen) return
    // 名册里没了的电脑:整段丢掉
    const keep = new Set(units.map((u) => u.id.toLowerCase()))
    const byUnit = Object.fromEntries(Object.entries(get().byUnit).filter(([k]) => keep.has(k)))
    set({ byUnit, refreshedAt: Date.now() })
    syncInjected()
  },

  reset: () => {
    set((s) => ({ gen: s.gen + 1, units: null, byUnit: {}, refreshedAt: 0 }))
    resetDeviceMarks()
  },
}))

function patchEntry(unitId: string, patch: Partial<DeviceEntry>): void {
  const k = unitId.toLowerCase()
  useDeviceSessions.setState((s) => ({ byUnit: { ...s.byUnit, [k]: { ...(s.byUnit[k] ?? EMPTY_ENTRY), ...patch } } }))
}

/** 拉一台的会话列表。离线 / 设备自报引擎没在跑(capsLive)→ 不拉、整段清空(D6:离线电脑的会话不可见)。 */
async function fetchDevice(u: UnitInfo, gen: number, force: boolean): Promise<void> {
  const id = u.id.toLowerCase()
  const cur = useDeviceSessions.getState().byUnit[id]
  if (!u.online) { patchEntry(id, { sessions: [], loading: false }); return }
  if (u.capsLive && u.caps?.engine && u.caps.engine !== 'ready') { patchEntry(id, { sessions: [], loading: false }); return }
  if (!force && cur?.fetchedAt && Date.now() - cur.fetchedAt < DEVICE_LIST_FRESH_MS) return
  const t = targetForRef(unitRef(id))
  if (!t) return
  patchEntry(id, { loading: true })
  try {
    const r = await engineFetch(t, `/agent/sessions?archived=false&limit=${DEVICE_LIST_LIMIT}&app_id=${encodeURIComponent(AGENT_APP_ID)}`, {}, { timeoutMs: DEVICE_LIST_TIMEOUT_MS })
    let body: unknown = null
    try { body = await r.json() } catch { /* 非 JSON */ }
    if (gen !== useDeviceSessions.getState().gen) return
    if (!r.ok) {
      const j = (body ?? {}) as { code?: unknown; state?: unknown; reason?: unknown }
      noteDeviceProbe(id, probeOfError({ status: r.status, code: j.code, state: j.state, reason: j.reason }))
      patchEntry(id, { sessions: [], fetchedAt: Date.now(), loading: false })
      return
    }
    const loc = unitRef(id)
    const rows = sanitizeRows(body).filter((row) => {
      if (!bindingConflict(row.id, loc)) return true
      console.warn(`[device-sessions] dropped session ${row.id} listed by ${id}: that id already belongs to another location`)
      return false
    })
    noteDeviceProbe(id, { ok: true })
    patchEntry(id, { sessions: rows, fetchedAt: Date.now(), loading: false })
  } catch (e) {
    if (gen !== useDeviceSessions.getState().gen) return
    noteDeviceProbe(id, probeOfError(e))
    patchEntry(id, { sessions: [], fetchedAt: Date.now(), loading: false })
  }
}

/** 已注入 appStore 的远端会话:用最新列表回填标题 / 更新时间 / 摘要(那台上改了名、跑了新一轮)。 */
function syncInjected(): void {
  const byUnit = useDeviceSessions.getState().byUnit
  const fresh = new Map<string, SessionRecord>()
  for (const [unitId, e] of Object.entries(byUnit)) {
    for (const row of e.sessions) if (sameRef(locationOf(row.id), unitRef(unitId))) fresh.set(row.id, row)
  }
  if (!fresh.size) return
  const st = useApp.getState()
  let changed = false
  const sessions = st.sessions.map((x) => {
    const f = x.location?.kind === 'unit' ? fresh.get(x.id) : undefined
    if (!f || (f.title === x.title && f.updated_at === x.updated_at && f.summary === x.summary)) return x
    changed = true
    return { ...x, title: f.title, updated_at: f.updated_at, summary: f.summary }
  })
  if (changed) useApp.setState({ sessions })
}

/** 一台电脑此刻的状态(名册 × 最近探针 × 粘滞拒绝,services/deviceStatus 的口径)。 */
export function statusOfUnit(u: UnitInfo, now = Date.now()): { status: DeviceStatus; refusal?: RefusalDetail } {
  const m = useDeviceMarks.getState()
  const id = u.id.toLowerCase()
  return describeDevice(u, m.probes[id] ?? null, m.sticky[id] ?? null, now)
}

/** 按 id 找名册里的电脑(没拉过 / 不在名册 → null)。 */
export function unitById(unitId: string): UnitInfo | null {
  const id = unitId.toLowerCase()
  return useDeviceSessions.getState().units?.find((u) => u.id.toLowerCase() === id) ?? null
}

/**
 * 打开那台电脑上的一条会话(inject-on-open,R-17):先绑定(先到先得;conflict = 这个 id 已属于本端 / 别的电脑 → 拒绝,不改绑,R-16),
 * 再经 withLocation 打标插进 appStore.sessions(必须在 openSession 之前:setActiveId → loadSessionHistory 按绑定路由),最后打开。
 */
export function adoptRemoteSession(rec: SessionRecord, loc: UnitRef): boolean {
  if (!rec?.id || !isUnitIdShape(loc.unitId)) return false
  const ref = unitRef(loc.unitId)
  if (bindSession(rec.id, ref) === 'conflict') {
    console.warn(`[device-sessions] refused to open ${rec.id} on ${ref.unitId}: that id already belongs to another location`)
    return false
  }
  const { location: _drop, ...clean } = rec as SessionRecord & { location?: unknown }
  void _drop
  const tagged = withLocation(clean as SessionRecord)
  useApp.setState((s) => ({
    sessions: [tagged, ...s.sessions.filter((x) => x.id !== rec.id)],
    // 列表行自带 agent_config:历史拉回来之前先按它渲染(同 refreshSessions 的预填)
    configBySession: s.configBySession[rec.id] || !rec.agent_config ? s.configBySession : { ...s.configBySession, [rec.id]: rec.agent_config },
  }))
  if (useSpaceStore.getState().activeSpaceId === 'home' || useSpaceStore.getState().activeSpaceId === 'inbox') setActiveSpace('tangu')
  openSession(rec.id)
  return true
}

/**
 * 按 (设备, 会话 id) 打开(K3 收件箱审批提醒信的「打开会话」,R-20)。已注入 / 已绑在那台 → 直接开;设备分组里列着 → 注入;
 * 否则经那台拉一次 `GET /agent/sessions/:id/detail` 再注入。那个 id 属于本端 / 别的电脑、这一端不能连别的电脑、拉不到 → false。
 */
export async function openRemoteSession(unitId: string, sessionId: string): Promise<boolean> {
  if (!runLocationsAvailable() || !isUnitIdShape(unitId) || !sessionId) return false
  const ref = unitRef(unitId)
  if (bindingConflict(sessionId, ref)) return false
  const st = useApp.getState()
  const injected = st.sessions.find((x) => x.id === sessionId) ?? st.archivedSessions.find((x) => x.id === sessionId)
  if (injected && sameRef(locationOf(sessionId), ref)) {
    if (useSpaceStore.getState().activeSpaceId === 'home' || useSpaceStore.getState().activeSpaceId === 'inbox') setActiveSpace('tangu')
    openSession(sessionId)
    return true
  }
  const listed = useDeviceSessions.getState().byUnit[ref.unitId]?.sessions.find((x) => x.id === sessionId)
  if (listed) return adoptRemoteSession(listed, ref)
  const t = targetForRef(ref)
  if (!t) return false
  try {
    const rec = await getSessionDetail(t, sessionId)
    if (!rec || rec.id !== sessionId) return false
    return adoptRemoteSession(rec, ref)
  } catch {
    return false
  }
}

/** 远端行的重命名(PATCH title)。已注入的记录一并改(乐观)。 */
export async function renameRemote(unitId: string, sessionId: string, title: string): Promise<void> {
  const ref = unitRef(unitId)
  const t = targetForRef(ref)
  if (!t || bindingConflict(sessionId, ref)) return
  const apply = (x: SessionRecord): SessionRecord => (x.id === sessionId ? { ...x, title } : x)
  const e = useDeviceSessions.getState().byUnit[ref.unitId]
  if (e) patchEntry(ref.unitId, { sessions: e.sessions.map(apply) })
  useApp.setState((s) => ({ sessions: s.sessions.map((x) => (x.location?.kind === 'unit' ? apply(x) : x)) }))
  try { await updateSession(t, sessionId, { title }) } catch (err: any) {
    useApp.getState().toast(useApp.getState().tr('app.renameFail', { e: err?.message || err }), true)
  }
}

/** 远端行的归档(PATCH archived:true;永不 DELETE —— 远端硬删是 deny-remote)。 */
export async function archiveRemote(unitId: string, sessionId: string): Promise<void> {
  const ref = unitRef(unitId)
  const t = targetForRef(ref)
  if (!t || bindingConflict(sessionId, ref)) return
  try {
    await updateSession(t, sessionId, { archived: true })
  } catch (err: any) {
    useApp.getState().toast(err?.message || String(err), true)
    return
  }
  const e = useDeviceSessions.getState().byUnit[ref.unitId]
  if (e) patchEntry(ref.unitId, { sessions: e.sessions.filter((x) => x.id !== sessionId) })
  useApp.setState((s) => ({ sessions: s.sessions.filter((x) => !(x.id === sessionId && x.location?.kind === 'unit')) }))
  if (useApp.getState().activeId === sessionId) useApp.getState().setActiveId(null)
}

// 换号 / 登出:整份作废(在飞的回包按代丢弃)。手机换号是整页重载,这里兜住同页的 token 变化。
let lastToken = useApp.getState().cfg?.token ?? ''
useApp.subscribe((s) => {
  const tok = s.cfg?.token ?? ''
  if (tok === lastToken) return
  lastToken = tok
  useDeviceSessions.getState().reset()
})
