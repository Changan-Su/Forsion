/**
 * 引擎目标解析层(P1-K6):「这条请求发给哪台引擎」只在这里决定。
 * 规格:docs/ToBeImproved/设备能力MCP_P1规格_2026-09-28/K6-session-engine-binding.md §3.4;
 * 裁决以 INTEGRATION.md §1(R-14 / R-15 / R-16 / R-19 / R-20)为准。
 *
 * S0(本步)只有 home 一个目标,且**行为逐字不变**:
 *   - 服务函数的参数改为 `EngineArg = EngineTarget | LegacyCfg`;传整份 cfg 的老调用点由 asTarget 折成
 *     home 目标,base = cfg.backendUrl 原样(不削尾斜杠)、鉴权头与以前同形同序、token 现取。
 *   - knownTargets() = [home];engineFetch 是给 K3 等消费方的通用出口。homeTarget() 是**活目标**(同一个对象,
 *     base / via / 鉴权头每次访问现读宿主配置),可以跨重连长期持有;asTarget(cfg) 是按调用的快照。
 *   - 会话绑定表只在内存(S4 起持久化);bindSession 先到先得、永不改绑(R-16),withLocation 是往
 *     appStore.sessions 插记录时唯一的打标入口(R-15)。
 * S1:cloudApiBase()(云端 API 基址,含 /api)与引擎基址分家 —— 凡是打 Forsion 云端 API 的读者(登录态、额度、
 *     名册、Amadeus 云桥、收件箱广播、区域探测)一律读它,不再拿 backendUrl 当云端用。形态见 cloudBase.ts。
 * S2(设计文档「最小切片:整端切到一台电脑」):**焦点目标**。手机 / 网页版可以把整端切到「我的某台电脑」
 *     (unit 目标 = `${cloudApiBase()}/units/<id>/proxy/engine`,经 hub 隧道);只有**目录 + 会话类**请求跟焦点走,
 *     设置 / 管理 / 收件箱恒打 home(K6 待定 2 的缺省)。targetForSession(sid) 在 S2 恒 = 焦点(R-19;S4 起改为
 *     绑定 ?? home)。桌面主窗口与设备页永不提供远端目标(targetForRef(unit) === null,K6 U1 缺省)。
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

/**
 * @deprecated 两阶段迁移的 Phase A 兼容口(K6-S0):服务函数暂时仍收整份 cfg。S3 codemod 把调用点改成
 * `homeTarget()` / `targetForSession(sid)` 后删除,届时 `api.fn(get().cfg)` 直接编译失败。新代码别再传它。
 */
export type LegacyCfg = TanguDesktopConfig
/** 引擎服务函数的目标参数。 */
export type EngineArg = EngineTarget | LegacyCfg

// ── 宿主接缝:本端连接配置由 appStore 在模块求值时装一次(避免 targets ↔ appStore 循环依赖)──
export interface EngineHost {
  /** 本端引擎的连接配置(appStore.cfg,每次现读;home 活目标的 base / token 都从这里取)。 */
  cfg(): TanguDesktopConfig
  /** 宿主配置快照(appStore.desktopConfig);S1 起用来算 cloudApiBase。启动早期可能为 null。 */
  desktopConfig(): Partial<StoredDesktopConfig> | null
  /** S2:焦点换了之后宿主(appStore)清引擎作用域状态并按新焦点重连。setFocusTarget 等它做完才 resolve。 */
  refocus?(next: TargetRef, prev: TargetRef): Promise<void>
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

/** 整份 cfg → home 目标(按调用的快照:读的是传进来那份 cfg)。token 在发请求那一刻从这份 cfg 读。 */
function fromLegacy(cfg: LegacyCfg): EngineTarget {
  return mintTarget({
    key: 'home',
    ref: HOME_REF,
    via: homeVia(),
    base: cfg.backendUrl,
    unitBase: null,
    headers: async (json = true): Promise<Record<string, string>> => bearerHeaders(cfg.token, json),
  })
}

/** 服务函数入口:已是目标就原样用,老调用点传来的 cfg 折成 home 目标(Phase A)。 */
export function asTarget(arg: EngineArg): EngineTarget {
  return isEngineTarget(arg) ? arg : fromLegacy(arg)
}

/**
 * **会话类**服务函数的目标(S2,§3.3 的 session 类:listMessages / 工作区 / run 事件流 / 审批兑现……)。
 * - 已是目标 → 原样用;
 * - 焦点在 home,或传来的 cfg 不是本端那份(设置页外部连接表单现拼的地址)→ 与改造前逐字一样折成 home;
 * - 焦点在 unit 且传来的是本端 cfg(老调用点 `api.fn(get().cfg, sid)`)→ 会话所在的目标(S2 恒 = 焦点,R-19)。
 * 这样 20 来个会话作用域视图(InlineFiles / RightPanel / FilesPanel / ChildChatPanel……)不用改调用点就跟着会话走;
 * 目录类(target 类)函数**不**走这里 —— 管理面板也调它们,那些必须留在 home,由调用点(appStore)显式传焦点。
 * S3 codemod 把调用点改成显式 targetForSession(sid) 后,本函数随 LegacyCfg 一起删。
 */
export function routeSession(arg: EngineArg, sid?: string): EngineTarget {
  if (isEngineTarget(arg)) return arg
  if (focusRef().kind === 'home' || !host || arg.backendUrl !== host.cfg().backendUrl) return fromLegacy(arg)
  return targetForSession(sid)
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
  requireHost()
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
  const home = homeTarget()
  const f = focusRef()
  const focus = f.kind === 'unit' ? targetForRef(f) : null
  return focus ? [home, focus] : [home]
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

// ── 会话 → 目标绑定表(路由真源,INTEGRATION R-15 / R-16)──
// 只是路由提示,不是信任依据:属主由 hub 逐请求校验(篡改最坏得 404)。S0 只在内存;S4 起按 userId 持久化。
const sessionTargets = new Map<string, TargetKey>()

function refOfKey(key: TargetKey): TargetRef {
  // 表里的键只由 targetKeyOf 写入(已校验);S4 从持久化读回时也逐条过 isTargetKey。这里再兜一道,别让坏键变成 unit。
  if (!isTargetKey(key)) throw new TypeError(`locationOf: malformed target key ${JSON.stringify(key)}`)
  return key === 'home' ? HOME_REF : Object.freeze({ kind: 'unit' as const, unitId: key.slice('unit:'.length) })
}

/**
 * 把会话绑到一个位置。**先到先得、永不改绑**:已绑到别处 → 'conflict'(设备自报的会话 id 可能故意撞 id,
 * 不能被它劫持路由);绑到同一处是幂等的 'bound'。
 */
export function bindSession(sid: string, ref: TargetRef): 'bound' | 'conflict' {
  if (typeof sid !== 'string' || !sid) throw new TypeError('bindSession: session id is required')
  assertTargetRef(ref, 'bindSession') // 未知 kind(旧形状 {kind:'cloud'}、坏掉的持久化提示)抛,绝不落成 unit:undefined
  const key = targetKeyOf(ref)
  const current = sessionTargets.get(sid)
  if (current !== undefined) return current === key ? 'bound' : 'conflict'
  sessionTargets.set(sid, key)
  return 'bound'
}

export function forgetSession(sid: string): void {
  sessionTargets.delete(sid)
}

/** 会话所在位置;未绑 = home。 */
export function locationOf(sid: string): TargetRef {
  const key = sessionTargets.get(sid)
  return key ? refOfKey(key) : HOME_REF
}

/** 往 appStore.sessions 插记录前一律经它打标(不自己拼 location)。 */
export function withLocation<T extends Pick<SessionRecord, 'id'>>(rec: T): T & { location: TargetRef } {
  return { ...rec, location: locationOf(rec.id) }
}

/** @internal 账号切换 / 测试用:清空内存绑定表(S2 的 resetEngineScopedState 接上)。 */
export function clearSessionBindings(): void {
  sessionTargets.clear()
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
 * - 宿主没有 `unitCallerHeaders`(K8 中继模式缺省、web)→ 不带头 = hub 眼里的「账号级未识别调用方」;
 * - 有但抛错 / 拒绝 → **失败关闭**:抛 CALLER_UNAVAILABLE,请求不发(绝不静默降级成匿名)。
 * ⚠️ 门控字面量逐字写成 `window.tangu?.unitCallerHeaders`(platform-parity 的 D 段靠正则扫它)。
 */
async function callerHeadersFor(unitId: string): Promise<Record<string, string>> {
  if (typeof window === 'undefined' || typeof window.tangu?.unitCallerHeaders !== 'function') return {}
  try {
    return pickCallerHeaders(await window.tangu.unitCallerHeaders(unitId))
  } catch (e) {
    throw callerUnavailableError(e)
  }
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
 *  S2(R-19):整端切换,会话一律在焦点上。S4 起改为「绑定 ?? home」,永不回焦点。 */
export function refForSession(sid?: string): TargetRef {
  void sid
  return focusRef()
}

/** 会话所在的目标(S2 = 焦点目标,见 refForSession)。 */
export function targetForSession(sid?: string): EngineTarget {
  void sid
  return focusTarget()
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
  return focusRef()
}

/** 错误:这一端 / 这个位置不能作焦点(桌面 / 设备页 / 未登录 / 设备 id 形状不对)。 */
export function targetUnsupportedError(): Error {
  return Object.assign(new Error(translate('engine.target.unsupported')), { code: 'TARGET_UNSUPPORTED' })
}

let focusSeq = 0

/**
 * 把整端切到某个位置(S2 = 设计文档「最小切片」;K8 的 UnitsSheet「在哪运行」、K7 之前的唯一入口)。
 * - 校验:位置形状(未知 kind 抛 TypeError);unit 须 `targetForRef` 能解析(否则抛 TARGET_UNSUPPORTED,焦点不动);
 * - 同一个位置是幂等的(只更新展示名);
 * - 先改焦点、落盘、通知订阅者,再交给宿主 refocus(清引擎作用域状态 → 按新焦点重连),等它做完才 resolve。
 *   连续切换时只有最后一次的 refocus 有意义,宿主按 authGeneration 丢弃过期结果。
 */
export async function setFocusTarget(ref: TargetRef, opts: { name?: string | null } = {}): Promise<void> {
  assertTargetRef(ref, 'setFocusTarget')
  const next: TargetRef = ref.kind === 'home' ? HOME_REF : Object.freeze({ kind: 'unit' as const, unitId: String(ref.unitId).toLowerCase() })
  if (next.kind === 'unit' && !targetForRef(next)) throw targetUnsupportedError()
  const name = next.kind === 'unit' && typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 120) : null
  const prevState = useEngineFocus.getState()
  const prev = prevState.ref
  if (sameRef(prev, next)) {
    if (next.kind === 'unit' && name && name !== prevState.name) {
      useEngineFocus.setState({ ref: prev, name })
      persistFocus({ ref: prev, name })
    }
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

/** @internal 测试 / 账号切换:焦点回 home,不落盘、不触发 refocus。 */
export function resetFocusForTests(): void {
  useEngineFocus.setState({ ref: HOME_REF, name: null })
  unitTargets.clear()
}

/** 提示文案里的 {name}:焦点那台用名册给的名字,别的 unit 用兜底称呼;home 没有名字(调用方别拿它拼远端文案)。 */
export function targetLabel(t: EngineTarget): string {
  const f = useEngineFocus.getState()
  if (f.ref.kind === 'unit' && t.key === targetKeyOf(f.ref) && f.name) return f.name
  return translate('engine.target.defaultName')
}
