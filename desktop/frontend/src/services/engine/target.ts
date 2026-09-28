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
  /** 引擎基址(请求 = base + '/agent/…')。legacy 配置折算来的目标逐字沿用 cfg.backendUrl。 */
  readonly base: string
  /** via==='unit' 时 = {cloudApiBase}/units/<id>/proxy(设备辅助面 /unit/hostfile 等);其余 null。 */
  readonly unitBase: string | null
  /** 每个请求现取(unit 目标的调用方头会轮换)。只可能含 Authorization / Content-Type / Accept / X-Forsion-Caller。 */
  headers(json?: boolean): Promise<Record<string, string>>
}

export type EngineTargetInit = Omit<EngineTarget, typeof ENGINE_TARGET>

export const HOME_REF: TargetRef = Object.freeze({ kind: 'home' }) as TargetRef

const minted = new WeakSet<EngineTarget>()

/** @internal 只许 services/engine/ 下调用(棘轮 R3 钉住)。别处要目标,找 targets.ts 的解析函数。 */
export function mintTarget(p: EngineTargetInit): EngineTarget {
  const ref: TargetRef = p.ref.kind === 'home' ? HOME_REF : Object.freeze({ kind: 'unit', unitId: p.ref.unitId })
  const t = Object.freeze({ ...p, ref }) as unknown as EngineTarget
  minted.add(t)
  return t
}

/** 只认 mintTarget 铸出来的对象(运行期品牌)。 */
export function isEngineTarget(x: unknown): x is EngineTarget {
  return typeof x === 'object' && x !== null && minted.has(x as EngineTarget)
}

export function targetKeyOf(ref: TargetRef): TargetKey {
  return ref.kind === 'home' ? 'home' : `unit:${ref.unitId}`
}

export function sameRef(a: TargetRef, b: TargetRef): boolean {
  return a.kind === b.kind && (a.kind === 'home' || a.unitId === (b as { unitId: string }).unitId)
}
