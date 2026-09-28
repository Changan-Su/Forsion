/**
 * 「允许远程会话」开关 + 调用方信任 + 远程会话最高审批档的主进程控制器(设备能力 MCP 方案 P1 · K4;INTEGRATION R-01 / R-07 / R-11 / R-24 / R-25 / R-26 / U1)。
 *
 * 存储:
 *   - 开关 + 信任列表 → userData/remote-sessions.json(不进 TanguStoredConfig:通用 config:set 不校验发送方、effectiveConfig 全量回显给渲染层;
 *     userData 在引擎 credentialPaths() 里 —— 结构化读硬拒、远程污点 run 写硬拒、本机 run 写要批)。只经本模块的 isTrustedSender IPC 写。
 *   - 最高审批档 → ~/.forsion(-dev)/config.json 的 remote.maxApprovalMode(引擎 C3 每次工具调用现读),只写这一个键、只写三值。
 *
 * 信任(U1 缺省):按主体记 ——
 *   unit    设备行 {principal:'unit', accountId, unitId, name, kind, platform, registeredAt, confirmedAt}:本机确认那一刻的快照(R-25),之后只用它;
 *   account 账号行 {principal:'account', accountId, confirmedAt, preconfirmed?}:「本账号的浏览器与网页版」—— 不带调用方断言的客户端;
 *           每个账号至多一条,p2p 也按它判(R-09),撤销它 = D8 严格档。
 * 只认 accountId 等于当前登录账号的行(换号后旧行惰性保留、不生效、不显示)。
 *
 * 迁移(一次性):文件不存在才看 unitHostEnabled —— 老用户已开互联 → 开关开 + 账号行预置(preconfirmed);新用户关。文件一旦存在绝不再看。
 * 首次本机确认:执行设备主进程原生弹框(挂父窗,由 main.ts 注入 confirm),不经引擎审批、不写收件箱、不经隧道回推(§6.1 执行设备专属类)。
 * 闸(gateEngine)是同步的,绝不等弹框:当场回 403 同时排一次确认(每主体去重、全局 1 框 + 队列 ≤ 3、拒绝后冷却 10 分钟、弹框 2 分钟 TTL)。
 * 刻意零 electron 运行期依赖(只有类型):vitest 直测。
 */
import { readFile } from 'node:fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import { createSerialQueue, writePrivateJson } from './configWrite'
import { defineMainMessages, mt } from './mainI18n'
import { decideRemoteEngine, remoteEngineTier } from './remoteSessionGate'
import type { ProxyCaller, UnitCaller, UnitKind } from './unitCaller'
import {
  normalizeCap, SECRET_STORE_INSECURE, type CapMode, type GateResult, type PendingView, type RemoteAccessStatus,
  type RemoteSessionsView, type TrustedView, type TrustState,
} from '../shared/remoteSessions'

export const REMOTE_SESSIONS_FILE = 'remote-sessions.json'

const MAX_UNIT_ROWS = 64
const DENY_COOLDOWN_MS = 10 * 60_000
const PROMPT_TTL_MS = 2 * 60_000
/** 排队上限(不含正在弹的那一个):超出直接回 unconfirmed,不排队(防局域网 / 隧道刷框)。 */
const MAX_QUEUED = 3

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 名册名字是登记者自选的不可信串:剥控制符、零宽与双向覆写(与 unitCaller 同一张表),截 60。 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
const clean = (v: unknown, max = 60): string => (typeof v === 'string' ? v.replace(UNSAFE_CHARS, '').trim().slice(0, max) : '')

// ── 主进程文案(R-23:mt() / defineMainMessages,键 main.remoteSessions.*;调用时求值)─────────────────────────
export const REMOTE_SESSIONS_MESSAGES = defineMainMessages({
  'main.remoteSessions.title': { zh: '远程会话请求', en: 'Remote session request' },
  'main.remoteSessions.unitMessage': { zh: '「{name}」请求在这台电脑上运行会话', en: '"{name}" wants to run sessions on this computer' },
  'main.remoteSessions.unitDetail': {
    zh: '设备：{kind} · {platform}\n首次登记：{registeredAt}\n设备 ID：…{idTail}\n\n允许后，这台设备可以在本机启动和继续 Agent 会话、回答审批，并使用这台电脑上的文件、工具和模型登录；审批档最高为「{cap}」。可随时在「设置 › 远程会话」中撤销。只允许你认得的设备。',
    en: "Device: {kind} · {platform}\nFirst registered: {registeredAt}\nDevice ID: …{idTail}\n\nIf you allow it, this device can start and continue Agent sessions here, answer approvals, and use this computer's files, tools and model sign-ins. Approval mode is capped at \"{cap}\". You can revoke this anytime in Settings › Remote sessions. Only allow devices you recognize.",
  },
  'main.remoteSessions.accountMessage': { zh: '你账号下的浏览器与网页版请求在这台电脑上运行会话', en: 'Browsers and the web app signed in to your account want to run sessions on this computer' },
  'main.remoteSessions.accountDetail': {
    zh: '在浏览器里打开的设备页、Forsion 网页版和旧版 App 无法识别具体是哪台设备。允许后，登录了你的 Forsion 账号的这类客户端都可以在本机启动和继续 Agent 会话，并使用这台电脑上的文件、工具和模型登录；审批档最高为「{cap}」。可随时在「设置 › 远程会话」中撤销。如果你刚才没有在别处打开这台电脑的设备页，请选「不允许」。',
    en: "Device pages opened in a browser, the Forsion web app and older app versions can't be identified as a specific device. If you allow this, any such client signed in to your Forsion account can start and continue Agent sessions here and use this computer's files, tools and model sign-ins. Approval mode is capped at \"{cap}\". You can revoke this anytime in Settings › Remote sessions. If you didn't just open this computer's device page somewhere else, choose Don't allow.",
  },
  'main.remoteSessions.allow': { zh: '允许', en: 'Allow' },
  'main.remoteSessions.deny': { zh: '不允许', en: "Don't allow" },
  'main.remoteSessions.kind.phone': { zh: '手机', en: 'Phone' },
  'main.remoteSessions.kind.desktop': { zh: '电脑', en: 'Computer' },
  'main.remoteSessions.unknown': { zh: '未知', en: 'Unknown' },
  'main.remoteSessions.cap.readonly': { zh: '只读', en: 'Readonly' },
  'main.remoteSessions.cap.autoEdit': { zh: '自动编辑', en: 'Auto edit' },
  'main.remoteSessions.cap.fullAuto': { zh: '全自动', en: 'Full auto' },
  'main.remoteSessions.accountLabel': { zh: '本账号的浏览器与网页版', en: "This account's browsers and web app" },
})

const CAP_KEY: Record<CapMode, string> = { readonly: 'main.remoteSessions.cap.readonly', 'auto-edit': 'main.remoteSessions.cap.autoEdit', 'full-auto': 'main.remoteSessions.cap.fullAuto' }

/** 确认框要展示的东西(unit:名字取名册 registeredName ?? name,R-25)。 */
export type ConfirmInfo =
  | { principal: 'unit'; unitId: string; name: string; kind: UnitKind; platform: string | null; registeredAt: string | null; cap: CapMode }
  | { principal: 'account'; cap: CapMode }

/** showMessageBox 的选项(不含 signal;main.ts 注入的 confirm 挂父窗弹)。按钮 0 = 允许;缺省与取消都是「不允许」。 */
export interface ConfirmDialogOptions {
  type: 'question'
  title: string
  message: string
  detail: string
  buttons: [string, string]
  defaultId: 1
  cancelId: 1
  noLink: true
}

const isoDay = (v: string | null): string | null => {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}

/** 纯函数:按当前主进程语言出确认框文案(调用时求值;单测钉 zh / en)。 */
export function confirmDialogOptions(info: ConfirmInfo): ConfirmDialogOptions {
  const cap = mt(CAP_KEY[info.cap])
  const unknown = mt('main.remoteSessions.unknown')
  const base = {
    type: 'question' as const,
    title: mt('main.remoteSessions.title'),
    buttons: [mt('main.remoteSessions.allow'), mt('main.remoteSessions.deny')] as [string, string],
    defaultId: 1 as const,
    cancelId: 1 as const,
    noLink: true as const,
  }
  if (info.principal === 'account') {
    return { ...base, message: mt('main.remoteSessions.accountMessage'), detail: mt('main.remoteSessions.accountDetail', { cap }) }
  }
  const idTail = info.unitId.replace(/-/g, '').slice(-6)
  return {
    ...base,
    message: mt('main.remoteSessions.unitMessage', { name: clean(info.name) || `…${idTail}` }),
    detail: mt('main.remoteSessions.unitDetail', {
      kind: mt(info.kind === 'phone' ? 'main.remoteSessions.kind.phone' : 'main.remoteSessions.kind.desktop'),
      platform: clean(info.platform, 40) || unknown,
      registeredAt: isoDay(info.registeredAt) ?? unknown,
      idTail,
      cap,
    }),
  }
}

// ── 审批档上限的写法(main.ts 在 config.json 的跨进程写锁内调;引擎 remoteApprovalCap() 每次现读同一个键)──────────────
/** 只改 remote.maxApprovalMode 一个键:其他段、remote 段的其他键原样保留;remote 不是对象(坏值)就换成只含这一键的新段。 */
export function withRemoteCap(home: Record<string, any>, m: CapMode): Record<string, any> {
  const remote = home.remote && typeof home.remote === 'object' && !Array.isArray(home.remote) ? home.remote : {}
  return { ...home, remote: { ...remote, maxApprovalMode: m } }
}

// ── 名册查询(GET {cloud}/api/units,主进程凭 auth.json 的 token;main.ts 注入 base / token)──────────────────────────
export interface RosterUnit { name: string; registeredName: string | null; kind: string | null; platform: string | null; createdAt: string | null }

/** unitId 在不在本账号名册里:在 → 名册字段;不在 → null(直接 denied,不弹框);查不了(未登录 / 网络 / 非 2xx)→ 'unreachable'(不弹框、不拿断言自报的名字弹)。 */
export async function lookupRosterUnit(
  o: { base: string; token: string; fetch?: typeof fetch; timeoutMs?: number },
  unitId: string,
): Promise<RosterUnit | null | 'unreachable'> {
  if (!o.base || !o.token) return 'unreachable'
  try {
    const r = await (o.fetch ?? fetch)(`${o.base.replace(/\/+$/, '')}/api/units`, {
      headers: { Authorization: `Bearer ${o.token}` },
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    })
    if (!r.ok) return 'unreachable'
    const j = (await r.json()) as { units?: unknown }
    if (!Array.isArray(j?.units)) return 'unreachable'
    const want = unitId.toLowerCase()
    const u = (j.units as Array<Record<string, unknown>>).find((x) => typeof x?.id === 'string' && x.id.toLowerCase() === want)
    if (!u) return null
    const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
    return { name: s(u.name) ?? '', registeredName: s(u.registeredName), kind: s(u.kind), platform: s(u.platform), createdAt: s(u.createdAt) }
  } catch {
    return 'unreachable'
  }
}

// ── 文件形状 ────────────────────────────────────────────────────────────────────────────────
interface UnitRow { principal: 'unit'; accountId: string; unitId: string; name: string; kind: UnitKind; platform: string | null; registeredAt: string | null; confirmedAt: number }
interface AccountRow { principal: 'account'; accountId: string; confirmedAt: number; preconfirmed?: true }
type Row = UnitRow | AccountRow
interface FileState { v: 1; enabled: boolean; migratedFromUnitHost: boolean; trusted: Row[] }

const EMPTY: FileState = { v: 1, enabled: false, migratedFromUnitHost: false, trusted: [] }

function parseRow(x: unknown): Row | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const r = x as Record<string, unknown>
  if (typeof r.accountId !== 'string' || !r.accountId) return null
  const confirmedAt = typeof r.confirmedAt === 'number' && Number.isFinite(r.confirmedAt) ? r.confirmedAt : 0
  if (r.principal === 'account') return { principal: 'account', accountId: r.accountId, confirmedAt, ...(r.preconfirmed === true ? { preconfirmed: true as const } : {}) }
  if (r.principal !== 'unit' || typeof r.unitId !== 'string' || !UUID_RE.test(r.unitId)) return null
  if (r.kind !== 'phone' && r.kind !== 'desktop') return null
  return {
    principal: 'unit', accountId: r.accountId, unitId: r.unitId.toLowerCase(), name: clean(r.name), kind: r.kind,
    platform: clean(r.platform, 40) || null, registeredAt: clean(r.registeredAt, 40) || null, confirmedAt,
  }
}

/** 坏 JSON / 形状不对 → null(调用方 fail closed,不回写)。 */
export function parseRemoteSessionsFile(raw: string): FileState | null {
  let j: unknown
  try { j = JSON.parse(raw) } catch { return null }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  const trusted = (Array.isArray(o.trusted) ? o.trusted : []).map(parseRow).filter((r): r is Row => !!r)
  return { v: 1, enabled: o.enabled === true, migratedFromUnitHost: o.migratedFromUnitHost === true, trusted }
}

/** 主体键:unit:<id> | account。p2p 按 account 判(R-09);局域网配对不进信任表(null)。 */
type PrincipalKey = 'account' | `unit:${string}`
function keyOf(c: UnitCaller): PrincipalKey | null {
  if (c.kind === 'unit') return `unit:${c.caller.unit.toLowerCase()}`
  if (c.kind === 'account' || c.kind === 'p2p') return 'account'
  return null
}
const rowKey = (r: Row): PrincipalKey => (r.principal === 'unit' ? `unit:${r.unitId}` : 'account')

/** 同一账号的设备行超过上限:按 confirmedAt 淘汰最旧;账号行不计数、永不被淘汰。 */
function capRows(rows: Row[]): Row[] {
  const byAccount = new Map<string, UnitRow[]>()
  for (const r of rows) if (r.principal === 'unit') byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r])
  const drop = new Set<Row>()
  for (const list of byAccount.values()) {
    if (list.length <= MAX_UNIT_ROWS) continue
    for (const r of [...list].sort((a, b) => a.confirmedAt - b.confirmedAt).slice(0, list.length - MAX_UNIT_ROWS)) drop.add(r)
  }
  return rows.filter((r) => !drop.has(r))
}

// ── 控制器 ──────────────────────────────────────────────────────────────────────────────────
export interface RemoteSessionsDeps {
  /** join(app.getPath('userData'), REMOTE_SESSIONS_FILE)(惰性取:dev 的 userData 在 main 顶部才改名)。 */
  file: () => string
  /** 迁移与视图用:shell 配置里的 unitHostEnabled。 */
  unitHostEnabled: () => Promise<boolean>
  /** config.json remote.maxApprovalMode(缺省 / 非法 → auto-edit)。 */
  readCap: () => Promise<CapMode>
  /** 只写 remote.maxApprovalMode 这一个键(main.ts:configQueue + updateHomeConfig)。 */
  writeCap: (m: CapMode) => Promise<void>
  /** 当前登录账号(forsionAccountId);未登录 = null(不弹框、不记信任)。 */
  accountId: () => string | null
  lookupUnit: (unitId: string) => Promise<RosterUnit | null | 'unreachable'>
  /** 挂父窗的原生确认框。true = 允许;false = 不允许;null = 没答(关窗 / 被 signal 关掉 / 弹不出来)。 */
  confirm: (opts: ConfirmDialogOptions, signal: AbortSignal) => Promise<boolean | null>
  /** K5 门控(deviceSecrets.remoteSessionsPermitted):设备凭据未绑系统加密时远程会话 fail closed(R-24)。 */
  permitted: () => boolean
  /** K2 远程锁定(R-26):锁定时不弹确认。K2 合入前恒 false。 */
  isLocked: () => boolean
  /** 广播 remoteSessions:changed(+ 供 K2 刷托盘)。 */
  onChanged: (v: RemoteSessionsView) => void
  log: (m: string) => void
  now?: () => number
  /** 测试注入:读文件(ENOENT → null)/ 原子写。 */
  readFile?: (f: string) => Promise<string | null>
  writeFile?: (f: string, data: unknown) => Promise<void>
}

export interface TrustedCallerView {
  principal: 'unit' | 'account'
  unitId?: string
  name: string
  kind?: UnitKind
  platform?: string | null
  registeredAt?: string | null
  confirmedAt: number
}

export interface RemoteSessionsGate {
  gateEngine: (q: { method: string; path: string; via: string | null; caller: UnitCaller }) => GateResult
  status: (caller: UnitCaller) => RemoteAccessStatus
  request: (caller: UnitCaller) => Promise<RemoteAccessStatus>
}

export interface RemoteSessions {
  /** 迁移 / 读盘做完(init 之前 await 会一直等;闸在此之前 fail closed)。 */
  ready: Promise<void>
  /** 在 deviceSecrets.init 之后调(迁移读 shell 配置、K5 门控要有状态)。幂等。 */
  init(): Promise<void>
  view(): Promise<RemoteSessionsView>
  setEnabled(on: boolean): Promise<RemoteSessionsView>
  setMaxApprovalMode(m: unknown): Promise<RemoteSessionsView>
  /** unit id 或 'account'。 */
  revoke(principal: unknown): Promise<RemoteSessionsView>
  /** 同步、内存态:存档开 && K5 允许(R-24)。 */
  isEnabled(): boolean
  /** 同步;K2 托盘「远程会话运行中 · {name}」用本机记下的名字(R-11)。'account' → 「本账号的浏览器与网页版」。 */
  trustedCaller(unitId: string): TrustedCallerView | null
  /** 账号 / 父开关 / K5 状态可能变了:收掉不再属于当前账号的弹框,并广播一次视图。 */
  notifyChanged(): void
  gate: RemoteSessionsGate
}

interface Pending {
  id: string // `${accountId}|${key}`
  accountId: string
  key: PrincipalKey
  caller: UnitCaller
  since: number
  ac: AbortController
  active: boolean
}

export function createRemoteSessions(deps: RemoteSessionsDeps): RemoteSessions {
  const now = deps.now ?? (() => Date.now())
  const read = deps.readFile ?? (async (f: string): Promise<string | null> => {
    try { return await readFile(f, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  })
  const write = deps.writeFile ?? writePrivateJson
  const writeQ = createSerialQueue()

  let state: FileState = EMPTY
  let loaded = false
  let capCache: CapMode = 'auto-edit'
  /** 拒绝后的冷却(内存,重启清零):`${accountId}|${key}` → 到期时刻。 */
  const cooldown = new Map<string, number>()
  const pending = new Map<string, Pending>()
  let pumping = false

  let resolveReady!: () => void
  const ready = new Promise<void>((r) => { resolveReady = r })
  let initP: Promise<void> | null = null

  const isEnabled = (): boolean => loaded && state.enabled && safePermitted()
  function safePermitted(): boolean {
    try { return deps.permitted() } catch { return false }
  }
  function safeAccount(): string | null {
    try { return deps.accountId() } catch { return null }
  }
  function safeLocked(): boolean {
    try { return deps.isLocked() } catch { return true } // 读不出锁状态 = 按锁定处理(不弹框)
  }

  /** 落盘成功才生效(开、授信):写的是当下内存 + fn,成功后把 fn 再套到**那一刻**的内存上(期间别的「先生效」改动不丢)。 */
  const commit = (fn: (s: FileState) => FileState): Promise<void> =>
    writeQ(async () => {
      await write(deps.file(), fn(state))
      state = fn(state)
    })
  /** 先生效再落盘(关、撤销:失败偏严)。落盘失败抛给调用方,内存保持已收紧。 */
  const commitNow = (fn: (s: FileState) => FileState): Promise<void> => {
    state = fn(state)
    return writeQ(async () => { await write(deps.file(), state) })
  }

  async function load(): Promise<void> {
    let raw: string | null
    try {
      raw = await read(deps.file())
    } catch (e) {
      deps.log(`[remote-sessions] 读 ${REMOTE_SESSIONS_FILE} 失败,按关闭处理:${(e as Error)?.message || e}`)
      state = EMPTY
      return
    }
    if (raw !== null) {
      const parsed = parseRemoteSessionsFile(raw)
      if (!parsed) deps.log(`[remote-sessions] ${REMOTE_SESSIONS_FILE} 不是合法 JSON,按关闭处理(不回写,下次操作时覆盖)`)
      state = parsed ?? EMPTY // 文件在 = 用它,绝不再看 unitHostEnabled
      return
    }
    // 一次性迁移:老用户已开「允许其他设备连接本机」→ 开关开 + 账号行预置;新用户关。
    let hostOn = false
    try { hostOn = await deps.unitHostEnabled() } catch { /* 读不出 = 按新用户 */ }
    const acc = safeAccount()
    const next: FileState = {
      v: 1,
      enabled: hostOn,
      migratedFromUnitHost: hostOn,
      trusted: hostOn && acc ? [{ principal: 'account', accountId: acc, confirmedAt: now(), preconfirmed: true }] : [],
    }
    state = next // 写失败:本次会话与老版本行为一致,下次启动重试
    try { await writeQ(() => write(deps.file(), next)) } catch (e) {
      deps.log(`[remote-sessions] 迁移落盘失败(下次启动重试):${(e as Error)?.message || e}`)
    }
  }

  function trustState(acc: string | null, key: PrincipalKey | null): TrustState {
    if (!acc || !key) return 'unconfirmed'
    if (state.trusted.some((r) => r.accountId === acc && rowKey(r) === key)) return 'trusted'
    if (pending.has(`${acc}|${key}`)) return 'pending'
    const until = cooldown.get(`${acc}|${key}`)
    if (until !== undefined) {
      if (until > now()) return 'denied'
      cooldown.delete(`${acc}|${key}`)
    }
    return 'unconfirmed'
  }

  /** 这次确认还作数吗:开关仍开、账号没换、没锁定、没被撤销 / 收掉。 */
  const stillValid = (p: Pending): boolean =>
    !p.ac.signal.aborted && pending.get(p.id) === p && isEnabled() && safeAccount() === p.accountId && !safeLocked()

  function abortWhere(pred: (p: Pending) => boolean): boolean {
    let hit = false
    for (const p of [...pending.values()]) {
      if (!pred(p)) continue
      p.ac.abort() // 真关框(showMessageBox 的 signal),不只改状态
      pending.delete(p.id)
      hit = true
    }
    return hit
  }

  /** 同步排一次本机确认,回排完之后的状态(闸与 request 共用)。只有 unit / account 会弹;p2p 只读 account 条目(R-09 / U1)。 */
  function beginTrust(caller: UnitCaller): TrustState {
    if (caller.kind !== 'unit' && caller.kind !== 'account') return trustState(safeAccount(), keyOf(caller))
    const acc = safeAccount()
    const key = keyOf(caller)!
    const st = trustState(acc, key)
    if (st !== 'unconfirmed' || !acc) return st
    if (!isEnabled() || safeLocked()) return 'unconfirmed' // 开关关 / 锁定:不弹(R-26)
    if (pending.size >= 1 + MAX_QUEUED) return 'unconfirmed'
    const p: Pending = { id: `${acc}|${key}`, accountId: acc, key, caller, since: now(), ac: new AbortController(), active: false }
    pending.set(p.id, p)
    emit()
    void pump()
    return 'pending'
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        const p = [...pending.values()].find((x) => !x.active)
        if (!p) break
        p.active = true
        try { await handle(p) } catch (e) { deps.log(`[remote-sessions] 确认流程出错:${(e as Error)?.message || e}`) }
        if (pending.get(p.id) === p) pending.delete(p.id)
        emit()
      }
    } finally {
      pumping = false
    }
  }

  const deny = (p: Pending): void => { cooldown.set(p.id, now() + DENY_COOLDOWN_MS) }

  async function handle(p: Pending): Promise<void> {
    if (!stillValid(p)) return
    let info: ConfirmInfo
    let snapshot: Omit<UnitRow, 'principal' | 'accountId' | 'confirmedAt'> | null = null
    if (p.caller.kind === 'unit') {
      const pc: ProxyCaller = p.caller.caller
      const r = await deps.lookupUnit(pc.unit).catch(() => 'unreachable' as const)
      if (!stillValid(p)) return
      if (r === 'unreachable') { deps.log('[remote-sessions] 名册不可达:这次不弹确认'); return } // → unconfirmed
      if (r === null) { deps.log('[remote-sessions] 调用方设备不在本账号名册里:拒绝,不弹框'); deny(p); return }
      if (r.kind && r.kind !== pc.kind) { deps.log('[remote-sessions] 名册 kind 与调用方断言不一致:拒绝,不弹框'); deny(p); return }
      const name = clean(r.registeredName) || clean(r.name) || clean(pc.name)
      snapshot = { unitId: pc.unit.toLowerCase(), name, kind: pc.kind, platform: pc.platform ?? r.platform, registeredAt: pc.registeredAt ?? r.createdAt }
      info = { principal: 'unit', unitId: snapshot.unitId, name, kind: pc.kind, platform: snapshot.platform, registeredAt: snapshot.registeredAt, cap: capCache }
    } else {
      info = { principal: 'account', cap: capCache }
    }
    const ttl = setTimeout(() => p.ac.abort(), PROMPT_TTL_MS)
    let answer: boolean | null = null
    try {
      answer = await deps.confirm(confirmDialogOptions(info), p.ac.signal)
    } catch (e) {
      deps.log(`[remote-sessions] 确认框出错:${(e as Error)?.message || e}`)
    } finally {
      clearTimeout(ttl)
    }
    if (!stillValid(p)) return // 关框后的结果一律丢弃:不得在开关已关 / 换号 / 撤销后落信任
    if (answer === false) { deny(p); return }
    if (answer !== true) return // 没答 → unconfirmed,可再请求
    const row: Row = snapshot
      ? { principal: 'unit', accountId: p.accountId, ...snapshot, confirmedAt: now() }
      : { principal: 'account', accountId: p.accountId, confirmedAt: now() }
    const apply = (s: FileState): FileState => ({ ...s, trusted: capRows([...s.trusted.filter((r) => !(r.accountId === p.accountId && rowKey(r) === p.key)), row]) })
    try {
      await writeQ(async () => {
        await write(deps.file(), apply(state))
        if (!stillValid(p)) { await write(deps.file(), state); return } // 落盘途中被收掉:盘上撤回,内存不动
        state = apply(state) // 落盘成功才信任
        cooldown.delete(p.id)
      })
    } catch (e) {
      deps.log(`[remote-sessions] 信任落盘失败,不信任:${(e as Error)?.message || e}`)
    }
  }

  async function view(): Promise<RemoteSessionsView> {
    await ready
    const [hostEnabled, cap] = await Promise.all([
      deps.unitHostEnabled().catch(() => false),
      deps.readCap().then(normalizeCap).catch(() => capCache),
    ])
    capCache = cap
    const acc = safeAccount()
    const rows = acc ? state.trusted.filter((r) => r.accountId === acc) : []
    const trusted: TrustedView[] = [
      ...rows.filter((r): r is AccountRow => r.principal === 'account').map((r) => ({ principal: 'account' as const, confirmedAt: r.confirmedAt, preconfirmed: r.preconfirmed === true })),
      ...rows.filter((r): r is UnitRow => r.principal === 'unit').sort((a, b) => b.confirmedAt - a.confirmedAt)
        .map((r) => ({ principal: 'unit' as const, unitId: r.unitId, name: r.name, kind: r.kind, platform: r.platform, registeredAt: r.registeredAt, confirmedAt: r.confirmedAt })),
    ]
    const pend: PendingView[] = [...pending.values()].filter((p) => p.accountId === acc).map((p) => (
      p.caller.kind === 'unit'
        ? { principal: 'unit' as const, unitId: p.caller.caller.unit, name: clean(p.caller.caller.name), kind: p.caller.caller.kind, since: p.since }
        : { principal: 'account' as const, since: p.since }
    ))
    return { hostEnabled, enabled: state.enabled, permitted: safePermitted(), maxApprovalMode: cap, trusted, pending: pend }
  }

  function emit(): void {
    void view().then((v) => deps.onChanged(v)).catch((e) => deps.log(`[remote-sessions] 广播失败:${(e as Error)?.message || e}`))
  }

  function statusOf(caller: UnitCaller): RemoteAccessStatus {
    const principal = caller.kind === 'paired' ? 'lan' : caller.kind
    return {
      remoteSessions: isEnabled(),
      principal,
      caller: caller.kind === 'paired' ? 'paired' : trustState(safeAccount(), keyOf(caller)),
      maxApprovalMode: capCache,
    }
  }

  const gate: RemoteSessionsGate = {
    gateEngine(q) {
      const tier = remoteEngineTier(q.method, q.path)
      if (tier === 'base') return { ok: true }
      const enabled = isEnabled()
      if (!enabled || q.caller.kind === 'paired') return decideRemoteEngine(tier, enabled, q.caller, null)
      let trust = trustState(safeAccount(), keyOf(q.caller))
      if (trust === 'unconfirmed') trust = beginTrust(q.caller) // fire-and-forget:闸绝不等弹框
      return decideRemoteEngine(tier, enabled, q.caller, trust)
    },
    status: statusOf,
    async request(caller) {
      beginTrust(caller)
      return statusOf(caller)
    },
  }

  const api: RemoteSessions = {
    ready,
    init() {
      initP ??= (async () => {
        try { capCache = normalizeCap(await deps.readCap()) } catch { /* 读不出 = auto-edit */ }
        await load()
        loaded = true
        resolveReady()
        emit()
      })()
      return initP
    },
    view,
    async setEnabled(on) {
      await ready
      if (typeof on !== 'boolean') throw new Error('bad-arg')
      if (on) {
        if (!safePermitted()) throw new Error(SECRET_STORE_INSECURE) // R-24:设备凭据未绑系统加密 → 打不开
        if (!state.enabled) await commit((s) => ({ ...s, enabled: true })) // 落盘成功才开
        emit()
      } else {
        abortWhere(() => true) // 开着的弹框真关掉,排队项清空
        try {
          await commitNow((s) => ({ ...s, enabled: false })) // 先关(失败偏严)
        } finally {
          emit()
        }
      }
      return view()
    },
    async setMaxApprovalMode(m) {
      await ready
      if (m !== 'readonly' && m !== 'auto-edit' && m !== 'full-auto') throw new Error('bad-approval-mode') // 永不写 custom(C3)
      await deps.writeCap(m)
      capCache = m
      emit()
      return view()
    },
    async revoke(principal) {
      await ready
      const key: PrincipalKey | null = principal === 'account' ? 'account'
        : typeof principal === 'string' && UUID_RE.test(principal) ? `unit:${principal.toLowerCase()}` : null
      if (!key) throw new Error('bad-principal')
      const acc = safeAccount()
      if (acc) {
        abortWhere((p) => p.accountId === acc && p.key === key)
        try {
          if (state.trusted.some((r) => r.accountId === acc && rowKey(r) === key)) {
            await commitNow((s) => ({ ...s, trusted: s.trusted.filter((r) => !(r.accountId === acc && rowKey(r) === key)) }))
          }
        } finally {
          emit()
        }
      }
      return view()
    },
    isEnabled,
    trustedCaller(unitId) {
      const acc = safeAccount()
      if (!acc || typeof unitId !== 'string') return null
      if (unitId === 'account') {
        const r = state.trusted.find((x): x is AccountRow => x.principal === 'account' && x.accountId === acc)
        return r ? { principal: 'account', name: mt('main.remoteSessions.accountLabel'), confirmedAt: r.confirmedAt } : null
      }
      const id = unitId.toLowerCase()
      const r = state.trusted.find((x): x is UnitRow => x.principal === 'unit' && x.accountId === acc && x.unitId === id)
      return r ? { principal: 'unit', unitId: r.unitId, name: r.name, kind: r.kind, platform: r.platform, registeredAt: r.registeredAt, confirmedAt: r.confirmedAt } : null
    },
    notifyChanged() {
      const acc = safeAccount()
      abortWhere((p) => p.accountId !== acc || !isEnabled())
      if (loaded) emit()
    },
    gate,
  }
  return api
}

// ── IPC(全部只收本机可信发送方;unitWeb 不转发 IPC)───────────────────────────────────────────────
export function registerRemoteSessionsIpc(
  ipc: { handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void },
  rs: RemoteSessions,
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean,
): void {
  const guard = (e: IpcMainInvokeEvent): void => { if (!isTrustedSender(e)) throw new Error('forbidden') }
  ipc.handle('remoteSessions:get', async (e) => { guard(e); return rs.view() })
  ipc.handle('remoteSessions:setEnabled', async (e, on: unknown) => { guard(e); return rs.setEnabled(on as boolean) })
  ipc.handle('remoteSessions:setMaxApprovalMode', async (e, m: unknown) => { guard(e); return rs.setMaxApprovalMode(m) })
  ipc.handle('remoteSessions:revoke', async (e, principal: unknown) => { guard(e); return rs.revoke(principal) })
}
