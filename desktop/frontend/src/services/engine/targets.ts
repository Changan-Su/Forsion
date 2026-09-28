/**
 * 引擎目标解析层(P1-K6):「这条请求发给哪台引擎」只在这里决定。
 * 规格:docs/ToBeImproved/设备能力MCP_P1规格_2026-09-28/K6-session-engine-binding.md §3.4;
 * 裁决以 INTEGRATION.md §1(R-14 / R-15 / R-16 / R-19 / R-20)为准。
 *
 * S0(本步)只有 home 一个目标,且**行为逐字不变**:
 *   - 服务函数的参数改为 `EngineArg = EngineTarget | LegacyCfg`;传整份 cfg 的老调用点由 asTarget 折成
 *     home 目标,base = cfg.backendUrl 原样(不削尾斜杠)、鉴权头与以前同形同序、token 现取。
 *   - knownTargets() = [home];engineFetch 是给 K3 等消费方的通用出口。
 *   - 会话绑定表只在内存(S4 起持久化);bindSession 先到先得、永不改绑(R-16),withLocation 是往
 *     appStore.sessions 插记录时唯一的打标入口(R-15)。
 * S1:cloudApiBase()(云端 API 基址,含 /api)与引擎基址分家 —— 凡是打 Forsion 云端 API 的读者(登录态、额度、
 *     名册、Amadeus 云桥、收件箱广播、区域探测)一律读它,不再拿 backendUrl 当云端用。形态见 cloudBase.ts。
 */
import type { SessionRecord, StoredDesktopConfig, TanguDesktopConfig } from '../../types'
import { authFetch } from '../http'
import { currentPlatform } from '../platform'
import { cloudApiBaseOf } from './cloudBase'
import { assertTargetRef, HOME_REF, isEngineTarget, isTargetKey, mintTarget, targetKeyOf, type EngineTarget, type TargetKey, type TargetRef, type TargetVia } from './target'

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
  /** 本端引擎的连接配置(appStore.cfg,每次现读)。 */
  cfg(): TanguDesktopConfig
  /** 宿主配置快照(appStore.desktopConfig);S1 起用来算 cloudApiBase。启动早期可能为 null。 */
  desktopConfig(): Partial<StoredDesktopConfig> | null
}
let host: EngineHost | null = null
export function installEngineHost(h: EngineHost): void {
  host = h
}

/** 云端 API 基址(含 /api、无尾斜杠;S1)。宿主配置还没到(启动极早期)或未配置 → ''。 */
export function cloudApiBase(): string {
  return cloudApiBaseOf(host?.desktopConfig())
}

/** home 目标的来路。设备页的 home 是被投射过来的那台引擎;其余按端判定单源(services/platform.ts)。 */
function homeVia(): TargetVia {
  if (typeof window !== 'undefined' && window.tangu?.unitPage) return 'unitPage'
  return currentPlatform() === 'desktop' ? 'local' : 'cloud'
}

/** 整份 cfg → home 目标。与改造前的 `headers(cfg.token)` 逐字同形(键序也一样);token 在发请求那一刻现读。 */
function fromLegacy(cfg: LegacyCfg): EngineTarget {
  return mintTarget({
    key: 'home',
    ref: HOME_REF,
    via: homeVia(),
    base: cfg.backendUrl,
    unitBase: null,
    headers: async (json = true): Promise<Record<string, string>> => (json
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` }
      : { Authorization: `Bearer ${cfg.token}` }),
  })
}

/** 服务函数入口:已是目标就原样用,老调用点传来的 cfg 折成 home 目标(Phase A)。 */
export function asTarget(arg: EngineArg): EngineTarget {
  return isEngineTarget(arg) ? arg : fromLegacy(arg)
}

/** 本端引擎:桌面 = 本机引擎,web / 手机 = 云网关,设备页 = 被投射的那台。 */
export function homeTarget(): EngineTarget {
  if (!host) throw new Error('Engine host is not installed (appStore installs it at module load)')
  return fromLegacy(host.cfg())
}

/** 当前已知的全部目标(INTEGRATION R-20)。S0 = [home];S2 = home + 焦点;S4 = home + 焦点 + 有绑定会话的 unit。 */
export function knownTargets(): EngineTarget[] {
  return [homeTarget()]
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
  // base 与鉴权头在同一段同步代码里取(headers() 的函数体在第一个 await 之前就读完 token):活目标的 cfg 中途换了,
  // 也不会拼出「新基址 + 旧 token」。
  const base = t.base
  assertEnginePath(base, path)
  const out: Record<string, string> = { ...(await t.headers(typeof init.body === 'string')) }
  new Headers(init.headers ?? undefined).forEach((value, name) => {
    const canonical = PASS_HEADERS[name]
    if (!canonical) return
    for (const k of Object.keys(out)) if (k.toLowerCase() === name) delete out[k]
    out[canonical] = value
  })
  return authFetch(`${base}${path}`, { ...init, headers: out }, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined)
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
