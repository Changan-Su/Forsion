/**
 * 引擎目标(EngineTarget)的类型与**唯一**铸造点。
 *
 * 一个 EngineTarget = 「这条请求发给哪台引擎」的全部信息:基址 + 鉴权头 + 来路。渲染层的引擎服务函数
 * (backendService / agentRunService)最终只认它;会话 → 目标的解析在 targets.ts。
 * 规格:docs/ToBeImproved/设备能力MCP_P1规格_2026-09-28/K6-session-engine-binding.md §3.1。
 *
 * 两道守卫(缺一不可,§3.9):
 *   1. 编译期品牌:`[ENGINE_TARGET]` 是只在本文件声明的 unique symbol,对象字面量永远凑不齐 → 造不出来
 *      (负对照 brand.typecheck.ts)。
 *   2. 运行期登记:mintTarget 铸出的对象进 WeakSet,`isEngineTarget` 只认登记过的 —— `as any` 硬塞的假目标
 *      过不了 engineFetch。源码棘轮(engineTargetGuard.test.ts R3)钉住 `mintTarget(` 只许出现在 services/engine/。
 *
 * 本文件是叶子模块:不 import 任何运行时依赖(types.ts 反过来 import type 它)。
 */

declare const ENGINE_TARGET: unique symbol

/** 目标的稳定键:home = 本端的引擎(桌面 = 本机引擎,web / 手机 = 云端),unit:<id> = 经 hub 的「我的某台电脑」。 */
export type TargetKey = 'home' | `unit:${string}`

/** 运行位置(可持久化、可比较的纯数据)。K7 的 RunLocation ≡ 它(INTEGRATION R-14)。 */
export type TargetRef = { kind: 'home' } | { kind: 'unit'; unitId: string }

/** 来路:local = 桌面本机引擎(managed / external);cloud = web / 手机的云网关;
 *  unitPage = 设备页里被投射过来的那台引擎;unit = 经 hub 隧道的「我的电脑」(S2 起)。 */
export type TargetVia = 'local' | 'cloud' | 'unitPage' | 'unit'

export interface EngineTarget {
  readonly [ENGINE_TARGET]: true
  readonly key: TargetKey
  readonly ref: TargetRef
  readonly via: TargetVia
  /** 引擎基址(请求 = base + '/agent/…')。legacy 配置折算来的目标逐字沿用 cfg.backendUrl。
   *  homeTarget() 的 home 是**活目标**:base 是访问器,每次读都现取宿主配置(引擎重启换端口立即跟上)。 */
  readonly base: string
  /** via==='unit' 时 = {cloudApiBase}/units/<id>/proxy(设备辅助面 /unit/hostfile 等);其余 null。 */
  readonly unitBase: string | null
  /** 每个请求现取:home 活目标现读宿主 token(引擎重启换 token 立即跟上),unit 目标的调用方头会轮换。
   *  例外:asTarget(cfg) 折出来的 legacy 目标读的是传进来那份 cfg(按调用的快照 —— 老调用点每次都现传 get().cfg)。
   *  只可能含 Authorization / Content-Type / Accept / X-Forsion-Caller。 */
  headers(json?: boolean): Promise<Record<string, string>>
}

export type EngineTargetInit = Omit<EngineTarget, typeof ENGINE_TARGET>

export const HOME_REF: TargetRef = Object.freeze({ kind: 'home' }) as TargetRef

const minted = new WeakSet<EngineTarget>()

/**
 * 运行期校验位置。类型只挡得住有类型的调用点;持久化的路由提示(S4 `forsion_session_targets`)、R-14 之前的旧形状
 * `{ kind: 'cloud' }` 这类无类型输入照样进得来 —— 不校验的话非 home 一律被当成 unit,绑成 `unit:undefined`,
 * 而绑定先到先得、永不改绑,之后正确的 home 绑定只能拿到 'conflict'(评审实测)。只认 home 与带非空 unitId 的 unit。
 */
export function assertTargetRef(ref: unknown, who: string): asserts ref is TargetRef {
  const r = ref as { kind?: unknown; unitId?: unknown } | null | undefined
  if (typeof r !== 'object' || r === null) throw new TypeError(`${who}: target ref is required`)
  if (r.kind === 'home') return
  if (r.kind !== 'unit') throw new TypeError(`${who}: unknown target kind ${JSON.stringify(r.kind)}`)
  if (typeof r.unitId !== 'string' || !r.unitId) throw new TypeError(`${who}: unit id is required`)
}

/** 目标键的运行期判定('home' | 'unit:<非空 id>');从持久化读回绑定时逐条过它,过不了的丢掉。 */
export function isTargetKey(x: unknown): x is TargetKey {
  return x === 'home' || (typeof x === 'string' && x.startsWith('unit:') && x.length > 'unit:'.length)
}

/** @internal 只许 services/engine/ 下调用(棘轮 R3 钉住)。别处要目标,找 targets.ts 的解析函数。 */
export function mintTarget(p: EngineTargetInit): EngineTarget {
  assertTargetRef(p.ref, 'mintTarget')
  const ref: TargetRef = p.ref.kind === 'home' ? HOME_REF : Object.freeze({ kind: 'unit', unitId: p.ref.unitId })
  // 按描述符拷贝、保留访问器:home 活目标的 base / via 是 getter。写成 `{ ...p }` 会在铸造那一刻把 getter
  // 求值成快照 —— 持有目标的消费方(K3 的轮询)跨引擎重启就一直打死端口、带旧 token。
  const t = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(p), ref: { value: ref, enumerable: true } }) as unknown as EngineTarget
  Object.freeze(t)
  minted.add(t)
  return t
}

/** 只认 mintTarget 铸出来的对象(运行期品牌)。 */
export function isEngineTarget(x: unknown): x is EngineTarget {
  return typeof x === 'object' && x !== null && minted.has(x as EngineTarget)
}

/** 穷举:未知 kind / 空 unitId 直接抛(别让非 home 默认落成 `unit:undefined`)。 */
export function targetKeyOf(ref: TargetRef): TargetKey {
  assertTargetRef(ref, 'targetKeyOf')
  return ref.kind === 'home' ? 'home' : `unit:${ref.unitId}`
}

export function sameRef(a: TargetRef, b: TargetRef): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'home') return true
  return a.kind === 'unit' && typeof a.unitId === 'string' && !!a.unitId && a.unitId === (b as { unitId?: unknown }).unitId
}
