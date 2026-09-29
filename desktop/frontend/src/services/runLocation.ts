/**
 * 运行位置(P1-K7a;INTEGRATION R-14:`RunLocation ≡ K6 的 TargetRef`,一种形状)。
 * home = 这一端本来就连着的那台引擎(手机 / 网页版 = 云端,桌面 = 本机引擎);unit = 经 hub 的「我的某台电脑」。
 * 本模块只放纯数据的辅助函数(可持久化 / 可比较);「这个位置解析成哪个目标」归 K6 的 targets.ts。
 */
import { HOME_REF, sameRef, type TargetRef } from './engine/target'
import { currentPlatform } from './platform'

export type RunLocation = TargetRef
export const HOME: RunLocation = HOME_REF

/** 设备 id 的形状(与 hub `/units/:id/open` 同口径)。解析成目标时 K6 另有更严的 uuid 闸(isUnitIdShape)。 */
export const UNIT_ID_RE = /^[0-9a-zA-Z-]{8,64}$/

/** '' = home;`unit:<id>` = 那台电脑(小写)。 */
export function formatRunLocation(l: RunLocation): '' | `unit:${string}` {
  return l.kind === 'unit' ? `unit:${l.unitId.toLowerCase()}` : ''
}

/** 不可信输入(持久化 / 设置项 / 设备自报)→ 位置。形状不对一律 HOME(绝不落成 unit:undefined)。 */
export function parseRunLocation(v: unknown): RunLocation {
  if (typeof v === 'string') {
    const m = /^unit:(.+)$/.exec(v)
    return m && UNIT_ID_RE.test(m[1]) ? Object.freeze({ kind: 'unit' as const, unitId: m[1].toLowerCase() }) : HOME
  }
  const o = v as { kind?: unknown; unitId?: unknown } | null
  if (o && typeof o === 'object' && o.kind === 'unit' && typeof o.unitId === 'string' && UNIT_ID_RE.test(o.unitId)) {
    return Object.freeze({ kind: 'unit' as const, unitId: o.unitId.toLowerCase() })
  }
  return HOME
}

export function sameLocation(a: RunLocation, b: RunLocation): boolean {
  return sameRef(a, b)
}

/** home 在这一端叫什么:手机 / 网页版 = 云端,桌面 = 这台电脑。 */
export function homeLabelKey(): 'runloc.cloud' | 'runloc.thisDevice' {
  return currentPlatform() === 'desktop' ? 'runloc.thisDevice' : 'runloc.cloud'
}
