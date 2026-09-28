/**
 * 引擎目标解析层(P1-K6):「这条请求发给哪台引擎」只在这里决定。
 * 规格:docs/ToBeImproved/设备能力MCP_P1规格_2026-09-28/K6-session-engine-binding.md §3.4;
 * 裁决以 INTEGRATION.md §1(R-14 / R-15 / R-16 / R-19 / R-20)为准。
 *
 * S0:只有 home 一个目标,且**行为逐字不变**(服务函数一度收 `EngineTarget | 整份 cfg` 的兼容联合,S3 删掉):
 *   - knownTargets() = [home];engineFetch 是给 K3 等消费方的通用出口。homeTarget() 是**活目标**(同一个对象,
 *     base / via / 鉴权头每次访问现读宿主配置),可以跨重连长期持有;connectionTarget(conn) 是按调用的快照。
 *   - 会话绑定表只在内存(S4 起持久化);bindSession 先到先得、永不改绑(R-16),withLocation 是往
 *     appStore.sessions 插记录时唯一的打标入口(R-15)。
 * S1:cloudApiBase()(云端 API 基址,含 /api)与引擎基址分家 —— 凡是打 Forsion 云端 API 的读者(登录态、额度、
 *     名册、Amadeus 云桥、收件箱广播、区域探测)一律读它,不再拿 backendUrl 当云端用。形态见 cloudBase.ts。
 * S2(设计文档「最小切片:整端切到一台电脑」):**焦点目标**。手机 / 网页版可以把整端切到「我的某台电脑」
 *     (unit 目标 = `${cloudApiBase()}/units/<id>/proxy/engine`,经 hub 隧道);只有**目录 + 会话类**请求跟焦点走,
 *     设置 / 管理 / 收件箱恒打 home(K6 待定 2 的缺省)。targetForSession(sid) 在 S2 恒 = 焦点(R-19;S4 起改为
 *     绑定 ?? home)。桌面主窗口与设备页永不提供远端目标(targetForRef(unit) === null,K6 U1 缺省)。
 * S3(签名收口):引擎服务函数(backendService / agentRunService)**只收 EngineTarget**。调用点由
 *     desktop/scripts/engine-target-codemod.cjs 机械改成 homeTarget() / targetForSession(sid) / focusTarget() /
 *     connectionTarget(conn),`api.fn(get().cfg)` 编译失败(brand.typecheck.ts);源码棘轮(engineTargetGuard.test.ts)
 *     钉住 `.backendUrl` 读、自拼 `/agent/` URL、铸造与 connectionTarget 只许出现在白名单里。
 * S4(按会话绑定):**绑定表 sessionTargets 是路由真源**(R-15,只有 bindSession 写):targetForSession(sid) = 绑定 ?? home,
 *     **永不回落焦点**(R-19;焦点在远端时把没绑过的会话静默发到那台电脑是错的)。建会话时绑到当时的焦点(焦点 = 手机上
 *     「新会话建在哪」的缺省),分支 / 旁聊 / 团队成员子会话 inheritBinding 跟父会话走。绑定按账号落盘
 *     (`forsion_session_targets:<账号>`,只存 unit 条、≤ 500 条、读回逐条 isTargetKey + 设备 id 形状过滤)——只是路由提示,
 *     不是信任依据(hub 逐请求校验属主)。knownTargets() = home + 焦点 + 有绑定会话的 unit(R-20)。
 *     本端会话缺省即 home、不进绑定表,所以撞 id 的闸还要问宿主(EngineHost.isHomeSession:本端列表 / 归档区里的会话往 unit
 *     绑一律 conflict);设备报回的子会话行过 inheritChildRows(conflict 的行丢掉);本端列表到手时 yieldToHomeListing 撤掉
 *     早先被设备抢绑的本端 id(本端胜,唯一的改绑例外,只许 unit → home)。
 */
import type { SessionRecord, StoredDesktopConfig, TanguDesktopConfig } from '../../types'
import { create } from 'zustand'
import { forsionAccountId } from '../../../../shared/forsionAccount'
import { authFetch } from '../http'
import { currentPlatform } from '../platform'
import { cloudApiBaseOf } from './cloudBase'
import { translate } from './messages'
import { assertTargetRef, HOME_REF, isEngineTarget, isTargetKey, mintTarget, sameRef, targetKeyOf, type EngineTarget, type TargetKey, type TargetRef, type TargetVia } from './target'

export type { EngineTarget, TargetKey, TargetRef, TargetVia } from './target'
export { HOME_REF, isEngineTarget, isTargetKey, sameRef, targetKeyOf } from './target'
export { isHomeSession } from '../../types'
export { cloudApiBaseOf } from './cloudBase'

// ── 宿主接缝:本端连接配置由 appStore 在模块求值时装一次(避免 targets ↔ appStore 循环依赖)──
export interface EngineHost {
  /** 本端引擎的连接配置(appStore.cfg,每次现读;home 活目标的 base / token 都从这里取)。 */
  cfg(): TanguDesktopConfig
  /** 宿主配置快照(appStore.desktopConfig);S1 起用来算 cloudApiBase。启动早期可能为 null。 */
  desktopConfig(): Partial<StoredDesktopConfig> | null
  /** S2:焦点换了之后宿主(appStore)清引擎作用域状态并按新焦点重连。setFocusTarget 等它做完才 resolve。 */
  refocus?(next: TargetRef, prev: TargetRef): Promise<void>
  /** S2:焦点**没换**、但那台现在连不上 / 健康态不是 ready(终局态不自动重试,R-32)时的手动出口:没连上 → 重连;
   *  已连上但健康不好 → 探一次。setFocusTarget(同一台)与 retryFocusTarget() 都走它;不清任何状态。 */
  reconnect?(ref: TargetRef): Promise<void>
  /** S4(R-16):这个会话 id 是不是**本端**已知的会话(本端列表 / 归档区里没打 unit 标的那些)。本端列出来的会话从不
   *  bindSession(缺省即 home),绑定表里没有它们 —— 没有这道问询,设备自报一个撞上的 id 第一次绑就得 'bound' 并落盘,
   *  那条本端会话的请求从此改发那台电脑。没装 / 不答 = 不知道(只有绑定表那道闸)。 */
  isHomeSession?(sid: string): boolean
}
let host: EngineHost | null = null
export function installEngineHost(h: EngineHost): void {
  host = h
}

/** 本机引擎的连接模式(managed / external;宿主配置还没到 → null)。targetCaps 的 local.hostFs 与 appStore 的
 *  isHostCapable 同口径(managed 才有真 host FS)。 */
export function hostDesktopMode(): string | null {
  return host?.desktopConfig()?.mode ?? null
}

/** 云端 API 基址(含 /api、无尾斜杠;S1)。宿主配置还没到(启动极早期)或未配置 → ''。 */
export function cloudApiBase(): string {
  return cloudApiBaseOf(host?.desktopConfig())
}

/** home 目标的来路。设备页的 home 是被投射过来的那台引擎;其余按端判定单源(services/platform.ts)。 */
export function homeVia(): TargetVia {
  if (typeof window !== 'undefined' && window.tangu?.unitPage) return 'unitPage'
  return currentPlatform() === 'desktop' ? 'local' : 'cloud'
}

/** 与改造前的 `headers(cfg.token)` 逐字同形(键序也一样)。 */
function bearerHeaders(token: string, json: boolean): Record<string, string> {
  return json
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { Authorization: `Bearer ${token}` }
}

/** 一份引擎连接(基址 + 令牌)。本端宿主当前那份在 appStore.cfg,由 homeTarget() 现读;别的来源走 connectionTarget。 */
export interface EngineConnection { backendUrl: string; token: string }

/** 一份连接 → home 键的目标(按调用的快照:读的是传进来那份)。token 在发请求那一刻从这份读。 */
function fromConnection(cfg: EngineConnection): EngineTarget {
  return mintTarget({
    key: 'home',
    ref: HOME_REF,
    via: homeVia(),
    base: cfg.backendUrl,
    unitBase: null,
    headers: async (json = true): Promise<Record<string, string>> => bearerHeaders(cfg.token, json),
  })
}

/**
 * 显式目标:一份**不是**本端宿主当前配置的引擎连接 —— 设置页外部连接表单现拼的地址、引导 / 重启后刚从主进程读到的配置、
 * 经 tanguSeam 的 waitBackend() 现取的主进程配置(那些模块与 appStore 有 import 环,所在窗口也未必装了引擎宿主)。
 * home 键、按调用的快照(base / token 取自传入那份;头与改造前 `headers(cfg.token)` 同形同序)。
 * 本端当前那份一律用 homeTarget()(活目标)。棘轮 R4 钉住只许在白名单文件里调(engineTargetGuard.test.ts)。
 */
export function connectionTarget<C extends EngineConnection>(conn: C): EngineTarget { // 泛型:整份配置 / 带 modelId 的字面量原样收
  return fromConnection(conn)
}

/**
 * 一份连接的**身份**(不是请求地址):基址(去尾斜杠)+ 令牌(可传 digest 只留指纹)。给「换了引擎 / 令牌就重挂、重拉、换缓存桶」的
 * React key、effect 依赖、草稿 / 缓存分桶键用 —— 那些地方只关心「是不是同一个连接」,不该自己读 cfg.backendUrl(棘轮 R1)。
 * 令牌原样在内(除非传 digest):别落盘、别上屏。
 */
export function connectionKey(conn: EngineConnection, digest: (token: string) => string = (x) => x): string {
  return JSON.stringify([conn.backendUrl.replace(/\/+$/, ''), conn.token ? digest(conn.token) : ''])
}

function requireHost(): EngineHost {
  if (!host) throw new Error('Engine host is not installed (appStore installs it at module load)')
  return host
}

let liveHome: EngineTarget | null = null

/**
 * 本端引擎:桌面 = 本机引擎,web / 手机 = 云网关,设备页 = 被投射的那台。
 * **活目标**:恒为同一个对象,base / via / 鉴权头每次访问都现读宿主(模块级 host,重装宿主也跟上)——
 * 消费方(K3 的待批轮询等)可以拿一次、跨引擎重启 / 重连长期持有,不会打死端口、带旧 token
 * (旧 token 撞 401 会触发 handleAuthExpired → backendRestart,又换一次 token = 重启回环)。
 */
export function homeTarget(): EngineTarget {
  // 解析不要求宿主已装:目标是活的,base / 鉴权头**用到时**才现读宿主(没装 → 那一刻抛)。这样模块求值早期、
  // 或 mock 掉 appStore 的单测里拿目标(交给被 mock 的服务函数)不会炸;真发请求时照样失败关闭。
  return liveHome ??= mintTarget({
    key: 'home',
    ref: HOME_REF,
    get via(): TargetVia { return homeVia() },
    get base(): string { return requireHost().cfg().backendUrl },
    unitBase: null,
    // 函数体在第一个 await 之前同步读完 token:engineFetch 先读 base 再调它,两者出自同一份 cfg。
    headers: async (json = true): Promise<Record<string, string>> => bearerHeaders(requireHost().cfg().token, json),
  })
}

/**
 * 当前已知的全部目标(INTEGRATION R-20)。S0 = [home];S2 = home + 焦点;S4 = home + 焦点 + 有绑定会话的 unit。
 * 数组是按调用现算的(集合会变),里面的 home 是活目标可以长期持有;集合变化(换了焦点)要重新调本函数
 * (或订阅 onFocusChange)。
 */
export function knownTargets(): EngineTarget[] {
  requireHost() // 宿主还没装 → 抛(K3 的待批轮询据此跳过这一拍,不对一个读不出基址的目标发请求)
  const out: EngineTarget[] = [homeTarget()]
  const seen = new Set<TargetKey>(['home'])
  const add = (ref: TargetRef): void => {
    const key = targetKeyOf(ref)
    if (seen.has(key)) return
    seen.add(key)
    const t = targetForRef(ref)
    if (t) out.push(t)
  }
  const f = focusRef()
  if (f.kind === 'unit') add(f)
  ensureBindingsLoaded() // 与调用顺序无关:K3 的轮询可能早于 boot 的 restoreSessionBindings
  for (const key of new Set(sessionTargets.values())) if (key !== 'home') add(refOfKey(key)) // S4:有绑定会话的 unit
  return out
}

// ── 通用出口 ──
/** 调用方能带进来的头:只有这两个。鉴权头归目标所有;`x-forsion-remote*` 这类来源标记只许 unitWeb 盖(C1)。 */
const PASS_HEADERS: Record<string, string> = { 'content-type': 'Content-Type', accept: 'Accept' }

/** 解析 URL 用的固定参照:两侧(基址 / 请求)对**同一个**参照解析即可判出逃逸,与页面实际地址无关。 */
const RESOLVE_REF = 'http://engine-target.invalid/'

/**
 * 请求 URL 必须落在目标基址之下(同源 + 路径前缀),否则 Bearer 会被送到别处。两道:
 *  ① 字面拒:非 `/` 开头、`//`、`scheme://`、反斜杠、以及 **C0 控制符 / 空白 / DEL** —— WHATWG URL 解析器会把
 *     tab / CR / LF 静默剥掉,`'/\t/evil.test'` 于是变成协议相对的 `//evil.test`(评审实测,base 为空时 Bearer 外泄);
 *  ② 解析后比对:`t.base + path` 解析出的地址必须以 `t.base` 解析出的地址(补尾 `/`)为前缀 —— 挡住字面判不全的
 *     变体,也挡住点段(含 `%2e%2e`)逃出基址路径:unit 基址 `…/units/<id>/proxy/engine` + `/../../../../auth/x`
 *     同源,但已经落到云端别的接口上。
 */
function assertEnginePath(base: string, path: unknown): asserts path is string {
  const reject = (): never => {
    throw new TypeError(`engineFetch: expected a relative engine path such as "/agent/…", got ${JSON.stringify(path)}`)
  }
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('://') || path.includes('\\')) reject()
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f]/.test(path as string)) reject()
  let scope: URL
  let url: URL
  try {
    scope = new URL(base || '/', RESOLVE_REF)
    url = new URL(base + (path as string), RESOLVE_REF)
  } catch {
    return reject()
  }
  const prefix = scope.origin + scope.pathname.replace(/\/*$/, '/')
  if (url.origin !== scope.origin || !(url.origin + url.pathname).startsWith(prefix)) reject()
}

/**
 * 对某个目标发一条引擎请求(INTEGRATION R-20,给 K3 的待批索引等消费方)。
 * - 只收 mintTarget 铸出来的目标;path 必须是以单个 `/` 开头、解析后仍落在目标基址之下的相对引擎路径
 *   (见 assertEnginePath:`//host`、`scheme://`、控制符、点段逃逸一律拒 —— 否则 Bearer 会被送到别的主机 / 接口)。
 * - init.headers 只放行 Content-Type / Accept,其余(含 Authorization、x-forsion-remote*)静默丢弃。
 * - 不给缺省超时(SSE / 长轮询要能长挂);需要时显式传 timeoutMs。
 */
export async function engineFetch(
  t: EngineTarget,
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<Response> {
  if (!isEngineTarget(t)) throw new TypeError('engineFetch: the target was not minted by the engine target resolver')
  return scopedFetch(t, t.base, path, init, opts)
}

/** engineFetch 与 unitFetch 的共用体:路径闸 → 目标鉴权头 → 只放行两种调用方头 → authFetch(非 home 带目标键,401 分流)。 */
async function scopedFetch(
  t: EngineTarget, base: string, path: string, init: RequestInit, opts: { timeoutMs?: number },
  headersOf: (json: boolean) => Promise<Record<string, string>> = (json) => t.headers(json),
): Promise<Response> {
  // base 与鉴权头在同一段同步代码里取(headers() 的函数体在第一个 await 之前就读完 token):活目标的 cfg 中途换了,
  // 也不会拼出「新基址 + 旧 token」。
  assertEnginePath(base, path)
  const out: Record<string, string> = { ...(await headersOf(typeof init.body === 'string')) }
  new Headers(init.headers ?? undefined).forEach((value, name) => {
    const canonical = PASS_HEADERS[name]
    if (!canonical) return
    for (const k of Object.keys(out)) if (k.toLowerCase() === name) delete out[k]
    out[canonical] = value
  })
  return authFetch(`${base}${path}`, { ...init, headers: out }, fetchOpts(t, opts.timeoutMs))
}

/**
 * 给 authFetch 的第三参。home 目标与改造前逐字一致(有超时才传);非 home 目标一律带 `target`,
 * 让 401 拦截器知道是哪台引擎拒的(§3.5:unit 的 401 绝不触发本机引擎重启 / 误登出)。
 */
export function fetchOpts(t: EngineTarget, timeoutMs?: number): { timeoutMs?: number; target?: TargetKey } | undefined {
  if (t.key === 'home') return timeoutMs ? { timeoutMs } : undefined
  return timeoutMs ? { timeoutMs, target: t.key } : { target: t.key }
}

/** 设备辅助面只许这几条只读路径(§3.7 与 unitWeb 的 /unit/config 只读白名单)。`/unit/mcp*` 永不经这里发
 *  (方案 §6.2-7:MCP 面永不携带 proxy 调用方断言),`/unit/remote-access*` 归 K4 / K8。 */
const UNIT_SURFACE = /^\/unit\/(?:hostfile|hostdir|hoststat|config)(?:\?|$)/

/**
 * unit 目标的设备辅助面(`{unitBase}/unit/hostfile|hostdir|hoststat|config`,§3.7)。与 engineFetch 同一道路径闸,
 * 只是基址换成 unitBase;只带 Bearer、**不带调用方头**(R-06:调用方断言只随 engine 与 remote-access 走)。
 * 非 unit 目标没有辅助面,直接拒;只收 GET。
 */
export async function unitFetch(t: EngineTarget, path: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
  if (!isEngineTarget(t)) throw new TypeError('unitFetch: the target was not minted by the engine target resolver')
  const bare = bareHeaders.get(t)
  if (t.via !== 'unit' || !t.unitBase || !bare) throw new TypeError('unitFetch: only unit targets have a device surface')
  if (!UNIT_SURFACE.test(path)) throw new TypeError(`unitFetch: not a device surface path: ${JSON.stringify(path)}`)
  return scopedFetch(t, t.unitBase, path, opts.signal ? { signal: opts.signal } : {}, opts, async (json) => bare(json))
}

// ── 会话 → 目标绑定表(路由真源,INTEGRATION R-15 / R-16;S4 起按账号落盘)──
// 只是路由提示,不是信任依据:属主由 hub 逐请求校验(篡改最坏得 404)。Map 的插入序即「最近绑定」序(LRU 淘汰最旧的)。
const sessionTargets = new Map<string, TargetKey>()

/** 绑定表变了(绑定 / 忘掉 / 读回 / 清空)→ version 递增。组件用它订阅「这个会话在哪台」(表本身不是响应式的)。 */
export const useSessionBindings = create<{ version: number }>(() => ({ version: 0 }))
const bumpBindings = (): void => useSessionBindings.setState((s) => ({ version: s.version + 1 }))

const BINDINGS_KEY_PREFIX = 'forsion_session_targets:'
/** 落盘的 unit 绑定条数上限(超出淘汰最久没绑 / 没重绑的)。 */
export const MAX_SESSION_BINDINGS = 500
/** 已把哪个账号的落盘绑定读进内存(null = 还没读)。没读之前绝不写盘:否则一条新绑定会把盘上那 500 条整个盖掉。 */
let bindingsLoadedFor: string | null = null

function refOfKey(key: TargetKey): TargetRef {
  // 表里的键只由 targetKeyOf 写入(已校验);从持久化读回时也逐条过 isTargetKey。这里再兜一道,别让坏键变成 unit。
  if (!isTargetKey(key)) throw new TypeError(`locationOf: malformed target key ${JSON.stringify(key)}`)
  return key === 'home' ? HOME_REF : Object.freeze({ kind: 'unit' as const, unitId: key.slice('unit:'.length) })
}

/** 绑定键按 (云端基址, 令牌) 记一份:locationOf 在渲染 / 每条请求上都会走到,别每次都解一遍 JWT。 */
let bindingsKeyMemo: { input: string; key: string | null } | null = null
function bindingsStorageKey(): string | null {
  if (!host) return null
  const api = cloudApiBase()
  const token = host.cfg().token || ''
  const input = `${api}\n${token}`
  if (bindingsKeyMemo?.input !== input) {
    const id = forsionAccountId(api, token)
    bindingsKeyMemo = { input, key: id ? `${BINDINGS_KEY_PREFIX}${id}` : null }
  }
  return bindingsKeyMemo.key
}

/** 读盘上这个账号的绑定(不可信:逐条过 isTargetKey + 设备 id 形状;home 条不存,读到也丢)。 */
function readPersistedBindings(key: string): Array<[string, TargetKey]> {
  let raw: unknown
  try { raw = JSON.parse(localStorage.getItem(key) || 'null') } catch { return [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: Array<[string, TargetKey]> = []
  for (const [sid, k] of Object.entries(raw as Record<string, unknown>)) {
    if (!sid || sid.length > 200 || !isTargetKey(k) || k === 'home' || !isUnitIdShape(k.slice('unit:'.length))) continue
    out.push([sid, k])
  }
  return out.slice(-MAX_SESSION_BINDINGS)
}

/** 确保当前账号的落盘绑定已读进内存:内存里已有的条目优先(先到先得),盘上的补在它们**之前**(更旧)。 */
function ensureBindingsLoaded(): string | null {
  const key = bindingsStorageKey()
  if (!key || bindingsLoadedFor === key) return key
  const persisted = readPersistedBindings(key)
  if (persisted.length) {
    const current = [...sessionTargets]
    sessionTargets.clear()
    for (const [sid, k] of persisted) sessionTargets.set(sid, k)
    for (const [sid, k] of current) { sessionTargets.delete(sid); sessionTargets.set(sid, k) }
  }
  bindingsLoadedFor = key
  return key
}

/** 只落 unit 条(home = 缺省,不必存),超过上限淘汰最旧的。拿不到账号身份 → 只活在内存。 */
function persistBindings(): void {
  const key = ensureBindingsLoaded()
  // 上限只裁**落盘那份**:内存路由表在本页内一条不删 —— 删了,一条早绑、此刻还开着的会话会悄悄改道 home
  // (设备报回的子会话行能把表灌满,一台设备就能挤掉另一台的绑定;S4 评审 P2)。代价:本页绑满 500 条以上时内存略大,刷新即回到 500。
  const units = [...sessionTargets].filter(([, k]) => k !== 'home')
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(units.slice(-MAX_SESSION_BINDINGS))))
  } catch { /* 隐私模式:只活在内存 */ }
}

/**
 * 把会话绑到一个位置。**先到先得、永不改绑**(R-16):已绑到别处 → 'conflict'(设备自报的会话 id 可能故意撞 id,
 * 不能被它劫持路由);绑到同一处是幂等的 'bound'(顺带刷新「最近」序)。unit 绑定落盘。
 * 本端会话缺省即 home、从不写进绑定表,所以「已绑到别处」还包括**宿主认得的本端会话**(EngineHost.isHomeSession):
 * 它们往 unit 绑一律 'conflict',不写表、不落盘。
 */
export function bindSession(sid: string, ref: TargetRef): 'bound' | 'conflict' {
  if (typeof sid !== 'string' || !sid) throw new TypeError('bindSession: session id is required')
  assertTargetRef(ref, 'bindSession') // 未知 kind(旧形状 {kind:'cloud'}、坏掉的持久化提示)抛,绝不落成 unit:undefined
  const key = targetKeyOf(ref)
  ensureBindingsLoaded()
  const current = sessionTargets.get(sid)
  if (current !== undefined && current !== key) return 'conflict'
  if (current === undefined && key !== 'home' && host?.isHomeSession?.(sid)) return 'conflict'
  sessionTargets.delete(sid)
  sessionTargets.set(sid, key)
  if (key !== 'home') persistBindings()
  if (current === undefined) bumpBindings()
  return 'bound'
}

/**
 * 只问不绑(P1-K7a):这个会话 id 若绑到 ref,会不会 'conflict'(已绑到别处,或宿主认得它是本端会话)。与 bindSession 同一套判据,
 * 但**不写表、不落盘、不通知** —— 设备分组每 10s 列一遍那台的会话,逐行真绑会把绑定表 / 落盘 LRU / knownTargets 灌满。
 * 真正打开那一条时才 bindSession。
 */
export function bindingConflict(sid: string, ref: TargetRef): boolean {
  if (typeof sid !== 'string' || !sid) return true
  assertTargetRef(ref, 'bindingConflict')
  const key = targetKeyOf(ref)
  ensureBindingsLoaded()
  const current = sessionTargets.get(sid)
  if (current !== undefined) return current !== key
  return key !== 'home' && !!host?.isHomeSession?.(sid)
}

/**
 * 子会话跟父会话走(分支 / 旁聊 / 团队成员会话 / 后台子会话 / 图片工作室……):远程污点在引擎侧同向传播(C5),
 * 渲染层的路由也必须同向。父会话没绑(= home)→ 子会话不必绑(缺省就是 home);子会话已绑到别处 → 'conflict'。
 */
export function inheritBinding(childSid: string, parentSid: string): 'bound' | 'conflict' {
  const loc = locationOf(parentSid)
  if (loc.kind === 'home') {
    const cur = sessionTargets.get(childSid)
    return cur && cur !== 'home' ? 'conflict' : 'bound'
  }
  return bindSession(childSid, loc)
}

/**
 * 父会话那台报回来的子会话行(/background、团队成员、@讨论 / Historian 子会话)逐行 inheritBinding;得 'conflict' 的行
 * (撞上本端会话 / 已绑到别处 —— 设备自报的 id 撞 id)**丢掉**,不交给视图(K7 合并规则同口径:console.warn,不提示)。
 */
export function inheritChildRows<R extends { sessionId?: string | null }>(rows: readonly R[], parentSid: string): R[] {
  return rows.filter((r) => {
    if (!r.sessionId || inheritBinding(r.sessionId, parentSid) !== 'conflict') return true
    console.warn(`[engine-target] dropped child session ${r.sessionId} reported under ${parentSid}: it already belongs to another location`)
    return false
  })
}

/**
 * 本端列表(refreshSessions 拉到的活动 + 归档)是「这是本端会话」的**权威证据**。列表里的 id 若绑在某台电脑上,只可能是
 * 设备自报的 id 撞上了本端会话(本端 id 由云端引擎 uuidv4 生成,设备左右不了),而那次绑定早于本端列表到手 —— 启动时列表
 * 还没回来,那台上的父会话已在轮询子会话;或那条本端会话是别的端刚建的。此时撤掉那条 unit 绑定,**本端胜**(与 refreshSessions
 * 的保留规则、K7 合并规则同口径)。这是「永不改绑」唯一的例外,方向只能是 unit → home。返回被撤掉的会话 id。
 */
export function yieldToHomeListing(ids: Iterable<string>): string[] {
  ensureBindingsLoaded()
  const dropped: string[] = []
  for (const sid of ids) {
    const k = sessionTargets.get(sid)
    if (k === undefined || k === 'home') continue
    sessionTargets.delete(sid)
    dropped.push(sid)
  }
  if (!dropped.length) return dropped
  console.warn(`[engine-target] home listing reclaimed ${dropped.length} session id(s) a device had claimed: ${dropped.join(', ')}`)
  persistBindings()
  bumpBindings()
  return dropped
}

/** 会话删掉了(硬删成功)→ 忘掉它的绑定。归档不忘(还会被打开)。 */
export function forgetSession(sid: string): void {
  ensureBindingsLoaded()
  if (!sessionTargets.delete(sid)) return
  persistBindings()
  bumpBindings()
}

/** 会话所在位置;未绑 = home(R-19:永不回落焦点)。 */
export function locationOf(sid: string): TargetRef {
  ensureBindingsLoaded()
  const key = sessionTargets.get(sid)
  return key ? refOfKey(key) : HOME_REF
}

/** 往 appStore.sessions 插记录前一律经它打标(不自己拼 location)。 */
export function withLocation<T extends Pick<SessionRecord, 'id'>>(rec: T): T & { location: TargetRef } {
  return { ...rec, location: locationOf(rec.id) }
}

/** 账号切换 / 测试用:清空内存绑定表(不动盘;下次用到时按新账号读盘)。 */
export function clearSessionBindings(): void {
  sessionTargets.clear()
  bindingsLoadedFor = null
  bumpBindings()
}

/** 启动 / 换号后读回这个账号落盘的绑定(宿主在 boot 里与 restoreFocus 一起调)。返回读回后的条数。 */
export function restoreSessionBindings(): number {
  ensureBindingsLoaded()
  bumpBindings()
  return sessionTargets.size
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S2:unit 目标 + 焦点(整端切到一台电脑)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** hub 的设备 id 是 randomUUID()(小写)。拼进 URL 路径前只认这个形状(encodeURIComponent 之外再兜一道)。 */
const UNIT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUnitIdShape(x: unknown): x is string {
  return typeof x === 'string' && UNIT_ID_SHAPE.test(x)
}

/**
 * 这一端能不能把引擎切到「我的电脑」:只有手机与网页版(home = 云端,手里有 forsion_token 能打 hub 隧道)。
 * 桌面主窗口(渲染层不持 forsion_token,需主进程流式代理,K6 U1 缺省不做)与设备页(§4.7:不得经 A 再驱动 B)恒 false。
 */
export function remoteTargetsSupported(): boolean {
  if (typeof window === 'undefined' || window.tangu?.unitPage) return false
  const p = currentPlatform()
  if (p !== 'mobile' && p !== 'web') return false
  return !!host && !!cloudApiBase() && !!host.cfg().token
}

/** unit 目标发出去的调用方头(R-05):只认 X-Forsion-Caller 一个键;值带换行一律丢(头注入)。 */
function pickCallerHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.toLowerCase() === 'x-forsion-caller' && typeof v === 'string' && v && !/[\r\n\0]/.test(v)) out['X-Forsion-Caller'] = v
  }
  return out
}

/** 取不到调用方身份时的错误(失败关闭:不发匿名请求)。status/code 与 K8 中继合成的 503 同口径,classify 认得。 */
export function callerUnavailableError(cause?: unknown): Error {
  return Object.assign(new Error(translate('engine.target.callerUnavailable', { name: translate('engine.target.defaultName') })), {
    status: 503, code: 'CALLER_UNAVAILABLE', cause,
  })
}

/**
 * 每个请求现取调用方头(R-05:含每次 SSE 重连;caller token 会轮换)。
 * - 宿主没有 `unitCallerHeaders`(K8 中继模式缺省、web)→ 不带头 = hub 眼里的「账号级未识别调用方」(缺席是设计);
 * - 有,但抛错 / 拒绝,**或给不出一个有效的 `X-Forsion-Caller`**(`{}` / 非对象 / 空串 / 错键 / 带换行被丢)→
 *   **失败关闭**:抛 CALLER_UNAVAILABLE,请求不发。桥装着就说明这台手机是按已登记设备的身份在连,只带 Bearer 照发 =
 *   静默降级成账号级未识别调用方,绕开那台电脑按调用方的信任 / 确认(INTEGRATION §4.2「失败关闭」、K8 S4)。
 * ⚠️ 门控字面量逐字写成 `window.tangu?.unitCallerHeaders`(platform-parity 的 D 段靠正则扫它)。
 */
async function callerHeadersFor(unitId: string): Promise<Record<string, string>> {
  if (typeof window === 'undefined' || typeof window.tangu?.unitCallerHeaders !== 'function') return {}
  let picked: Record<string, string>
  try {
    picked = pickCallerHeaders(await window.tangu.unitCallerHeaders(unitId))
  } catch (e) {
    throw callerUnavailableError(e)
  }
  if (!picked['X-Forsion-Caller']) throw callerUnavailableError(new Error('unitCallerHeaders returned no usable X-Forsion-Caller'))
  return picked
}

/** unit 目标只经 bareHeaders 拿「不带调用方头」的 Bearer(设备辅助面用)。 */
const bareHeaders = new WeakMap<EngineTarget, (json: boolean) => Record<string, string>>()
const unitTargets = new Map<string, EngineTarget>()

/** 按 (云端基址, 设备 id) 缓存:同一台电脑恒为同一个对象(消费方可以按对象身份做键)。基址在铸造时定死 ——
 *  手机 / 网页版换账号 = 整页重载,cloudApiBase 一页之内不变;真变了缓存键跟着变。 */
function unitTarget(unitId: string): EngineTarget | null {
  const api = cloudApiBase()
  if (!api) return null
  const id = unitId.toLowerCase()
  const cacheKey = `${api}|${id}`
  const hit = unitTargets.get(cacheKey)
  if (hit) return hit
  const unitBase = `${api}/units/${encodeURIComponent(id)}/proxy`
  // hub 的 `auth` 消费 Bearer(= forsion_token:手机 / 网页版的 home 就是云端,home cfg 的 token 正是它)。
  const bearer = (json: boolean): Record<string, string> => bearerHeaders(requireHost().cfg().token, json)
  const t = mintTarget({
    key: `unit:${id}`,
    ref: { kind: 'unit', unitId: id },
    via: 'unit',
    base: `${unitBase}/engine`,
    unitBase,
    // token 在第一个 await 之前同步读完(与 home 同理);调用方头每次现取。
    headers: async (json = true): Promise<Record<string, string>> => {
      const base = bearer(json)
      const caller = await callerHeadersFor(id)
      return { ...base, ...caller }
    },
  })
  bareHeaders.set(t, bearer)
  unitTargets.set(cacheKey, t)
  return t
}

/** 绑定到了某台电脑、此刻却解析不出目标时的占位(targetForSession 用):不缓存,base 空、没有设备辅助面,
 *  鉴权头一取就抛 TARGET_UNSUPPORTED —— 所有服务函数都先取头再发请求,所以一条请求都发不出去(失败关闭)。 */
function unresolvedUnitTarget(unitId: string): EngineTarget {
  const id = String(unitId).toLowerCase()
  return mintTarget({
    key: `unit:${id}`,
    ref: { kind: 'unit', unitId: id },
    via: 'unit',
    base: '',
    unitBase: null,
    headers: async (): Promise<Record<string, string>> => { throw targetUnsupportedError() },
  })
}

/**
 * 位置 → 目标。home 恒可解析;unit 在 `!remoteTargetsSupported()`(桌面 / 设备页 / 未登录)或 id 形状不对时 → null。
 * 调用方拿到 null 必须当「这里不能在别的电脑上运行」处理,绝不回落 home 静默发出去。
 */
export function targetForRef(ref: TargetRef): EngineTarget | null {
  assertTargetRef(ref, 'targetForRef')
  if (ref.kind === 'home') return homeTarget()
  if (!remoteTargetsSupported() || !isUnitIdShape(ref.unitId)) return null
  return unitTarget(ref.unitId)
}

// ── 焦点 ──
/** 焦点的展示名(设备名,不可信串,只进文本节点)。持久化只作显示,不作任何判断依据。 */
export interface FocusState { ref: TargetRef; name: string | null }
/** 焦点状态(React 用 useEngineFocus(selector) 订阅;非 React 代码用 focusRef())。 */
export const useEngineFocus = create<FocusState>(() => ({ ref: HOME_REF, name: null }))

export function focusRef(): TargetRef {
  return useEngineFocus.getState().ref
}

/** 焦点目标。焦点是 unit 但此刻解析不出来(登出 / 基址还没到)→ home —— 这时 setFocusTarget 的调用方早已被拒,
 *  只有持久化恢复前后的瞬间会走到;不会把 home 的请求发去远端。 */
export function focusTarget(): EngineTarget {
  const f = focusRef()
  return (f.kind === 'unit' ? targetForRef(f) : null) ?? homeTarget()
}

/** 焦点目标的展示名:home = null;unit = 名册给的名字 ?? 兜底「你的电脑」。 */
export function focusName(): string | null {
  const s = useEngineFocus.getState()
  return s.ref.kind === 'home' ? null : (s.name || translate('engine.target.defaultName'))
}

/** 会话所在的位置(纯数据,不铸目标、不要求宿主已装好 —— 审批卡等组件在单测里也要能判)。
 *  S4(R-19):绑定 ?? home,**永不回落焦点**。没给会话 id = home。 */
export function refForSession(sid?: string): TargetRef {
  return sid ? locationOf(sid) : HOME_REF
}

/**
 * 会话所在的目标(S4:绑定 ?? home,见 refForSession)。绑到了 unit 但此刻解析不出来(桌面 / 设备页、登出、启动早期云端基址
 * 还没到)→ 给一个**解析不了的 unit 目标**:键 / 来路照旧(能力按 unit 判、健康按那台记),但发请求那一刻失败关闭
 * (TARGET_UNSUPPORTED,不发任何请求)—— 绝不改道到 home 或焦点。
 */
export function targetForSession(sid?: string): EngineTarget {
  const ref = refForSession(sid)
  if (ref.kind === 'home') return homeTarget()
  return targetForRef(ref) ?? unresolvedUnitTarget(ref.unitId)
}

type FocusListener = (next: TargetRef, prev: TargetRef) => void
const focusListeners = new Set<FocusListener>()
/** 订阅焦点变化(K7 / K8 的「在哪运行」、K3 的待批轮询按 knownTargets 重订)。返回退订函数。 */
export function onFocusChange(cb: FocusListener): () => void {
  focusListeners.add(cb)
  return () => { focusListeners.delete(cb) }
}

// ── 焦点持久化(只是路由提示,不是信任依据:属主由 hub 逐请求校验,篡改最坏得 404)──
const FOCUS_KEY_PREFIX = 'forsion_engine_focus:'
/** 按账号分键(forsionAccountId = 云端源 + userId,JWT 只作识别):换号天然隔离。拿不到身份 → 不落盘,只活在内存。 */
function focusStorageKey(): string | null {
  if (!host) return null
  const id = forsionAccountId(cloudApiBase(), host.cfg().token || '')
  return id ? `${FOCUS_KEY_PREFIX}${id}` : null
}

function persistFocus(s: FocusState): void {
  const key = focusStorageKey()
  if (!key) return
  try {
    if (s.ref.kind === 'home') localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify({ kind: 'unit', unitId: s.ref.unitId, ...(s.name ? { name: s.name.slice(0, 120) } : {}) }))
  } catch { /* 隐私模式:只活在内存 */ }
}

/** 读回持久化的焦点:形状不对 / 这端不支持远端 / id 形状不对 → null(按 home)。 */
function readPersistedFocus(): FocusState | null {
  const key = focusStorageKey()
  if (!key) return null
  let raw: unknown
  try { raw = JSON.parse(localStorage.getItem(key) || 'null') } catch { return null }
  const r = raw as { kind?: unknown; unitId?: unknown; name?: unknown } | null
  if (!r || r.kind !== 'unit' || !isUnitIdShape(r.unitId)) return null
  const ref: TargetRef = Object.freeze({ kind: 'unit' as const, unitId: r.unitId.toLowerCase() })
  if (!targetForRef(ref)) return null
  return { ref, name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 120) : null }
}

/**
 * 启动时恢复上次的焦点(宿主在 boot 里、首次 connect 之前调一次)。不触发 refocus —— 首次 connect 本来就按焦点连。
 * 返回恢复后的位置(不支持 / 没存 → home)。
 */
export function restoreFocus(): TargetRef {
  const s = readPersistedFocus()
  useEngineFocus.setState(s ?? { ref: HOME_REF, name: null })
  if (s) rememberUnitName(s.ref, s.name)
  return focusRef()
}

/** 错误:这一端 / 这个位置不能作焦点(桌面 / 设备页 / 未登录 / 设备 id 形状不对)。 */
export function targetUnsupportedError(): Error {
  return Object.assign(new Error(translate('engine.target.unsupported')), { code: 'TARGET_UNSUPPORTED' })
}

let focusSeq = 0

/**
 * 切「在哪运行」(S2 = 设计文档「最小切片」;K8 的 UnitsSheet「在哪运行」、K7 之前的唯一入口)。
 * S4 起焦点只决定**新会话建在哪**(与那一侧的目录 / 连接态);已有会话按绑定走,换焦点不动它们(SSE、审批、转向照旧打原来那台)。
 * - 校验:位置形状(未知 kind 抛 TypeError);unit 须 `targetForRef` 能解析(否则抛 TARGET_UNSUPPORTED,焦点不动);
 * - 同一个位置不清任何状态(只更新展示名);是 unit 时再交给宿主 reconnect —— 那台没连上 / 健康不是 ready 就重连或探一次
 *   (终局态不自动重试,「再选一次同一台」就是用户的手动重试;已连上且健康时 reconnect 什么都不做);
 * - 先改焦点、落盘、通知订阅者,再交给宿主 refocus(换焦点作用域的目录态、回空白新对话 → 按新焦点重连),等它做完才 resolve。
 *   连续切换时只有最后一次的 refocus 有意义,宿主按焦点代丢弃过期结果。
 */
export async function setFocusTarget(ref: TargetRef, opts: { name?: string | null } = {}): Promise<void> {
  assertTargetRef(ref, 'setFocusTarget')
  const next: TargetRef = ref.kind === 'home' ? HOME_REF : Object.freeze({ kind: 'unit' as const, unitId: String(ref.unitId).toLowerCase() })
  if (next.kind === 'unit' && !targetForRef(next)) throw targetUnsupportedError()
  const name = next.kind === 'unit' && typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 120) : null
  const prevState = useEngineFocus.getState()
  const prev = prevState.ref
  rememberUnitName(next, name)
  if (sameRef(prev, next)) {
    if (next.kind === 'unit' && name && name !== prevState.name) {
      useEngineFocus.setState({ ref: prev, name })
      persistFocus({ ref: prev, name })
    }
    if (next.kind === 'unit') await host?.reconnect?.(prev)
    return
  }
  const state: FocusState = { ref: next, name }
  useEngineFocus.setState(state)
  persistFocus(state)
  const seq = ++focusSeq
  for (const cb of [...focusListeners]) {
    try { cb(next, prev) } catch { /* 订阅者自己的错不拦焦点切换 */ }
  }
  if (seq === focusSeq) await host?.refocus?.(next, prev)
}

/**
 * 焦点那台的手动重试(连接态提示的「重试」、K8 UnitsSheet 等):没连上 → 重连;已连上但健康不是 ready → 探一次。
 * 焦点在本端 → 什么都不做。终局态(身份取不到 / 引擎拒了凭据 / 拒绝)不自动重试(R-32),只经这里由用户触发。
 */
export async function retryFocusTarget(): Promise<void> {
  const f = focusRef()
  if (f.kind === 'unit') await host?.reconnect?.(f)
}

/** @internal 测试 / 账号切换:焦点回 home,不落盘、不触发 refocus。 */
export function resetFocusForTests(): void {
  useEngineFocus.setState({ ref: HOME_REF, name: null })
  unitTargets.clear()
  unitNames.clear()
}

/** 本页见过的设备名(焦点切过去时名册给的名字;S4 起会话可能留在一台已经不是焦点的电脑上,提示里仍叫它的名字)。
 *  不可信串,只进文本节点;不落盘(焦点那份另有落盘)。 */
const unitNames = new Map<string, string>()
function rememberUnitName(ref: TargetRef, name: string | null): void {
  if (ref.kind === 'unit' && name) unitNames.set(ref.unitId, name)
}

/** 名册里见过的设备名(P1-K7a:设备分组列出 / 打开那台上的会话时记下,提示与结局行才叫得出名字)。不可信串,截 120。 */
export function noteUnitName(ref: TargetRef, name: string | null | undefined): void {
  if (ref.kind === 'unit' && typeof name === 'string' && name.trim()) rememberUnitName(ref, name.trim().slice(0, 120))
}

/** 某个位置的展示名:home = null;unit = 焦点名 / 见过的名字 ?? null(调用方自己决定兜底称呼)。 */
export function nameOfRef(ref: TargetRef): string | null {
  if (ref.kind !== 'unit') return null
  const f = useEngineFocus.getState()
  if (f.ref.kind === 'unit' && f.ref.unitId === ref.unitId && f.name) return f.name
  return unitNames.get(ref.unitId) ?? null
}

/** 组件用:输入框 / 提示条对着的位置 —— 有会话 = 它绑定的位置(S4,绑定 ?? home),空白新对话 = 焦点(新会话建在那)。
 *  绑定表或焦点变了会重渲染。 */
export function useComposerRef(sessionId?: string | null): TargetRef {
  useSessionBindings((s) => s.version)
  const focus = useEngineFocus((s) => s.ref)
  return sessionId ? refForSession(sessionId) : focus
}

/** 组件用:这个会话所在那台电脑的名字(审批结局行「在执行的电脑上(名字)」等);没给会话 = 焦点那台;home / 认不出 → null。 */
export function useSessionHostName(sessionId?: string | null): string | null {
  useSessionBindings((s) => s.version)
  useEngineFocus((s) => s.name)
  return nameOfRef(sessionId ? refForSession(sessionId) : focusRef())
}

/** 提示文案里的 {name}:那台的名字(焦点名 / 见过的名字),认不出用兜底称呼;home 没有名字(调用方别拿它拼远端文案)。 */
export function targetLabel(t: EngineTarget): string {
  return nameOfRef(t.ref) || translate('engine.target.defaultName')
}
