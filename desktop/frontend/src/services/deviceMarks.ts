/**
 * 每台电脑最近的探针结果与粘滞拒绝(P1-K7a;状态口径 services/deviceStatus.ts,R-22)。叶子模块,只在内存。
 *
 * 为什么单独一个叶子:写它的有三处 —— 设备分组逐台拉会话列表(探针)、K8「在哪运行」弹层的确认流程(探针 / 粘滞)、
 * appStore.send() 在那台电脑上建会话被拒(粘滞:读会话列表是基础档,开关关着也照样 200,只有建会话才知道会话档被拒)。
 * appStore 不能 import 设备分组的 store(那边 import appStore),所以两边都只认这张表。
 * 设备自报 / 探针的结果只驱动界面,永不作授权依据。
 */
import { create } from 'zustand'
import type { ProbeResult, StickyRefusal } from './deviceStatus'

export interface DeviceMarks {
  probes: Record<string, ProbeResult>
  sticky: Record<string, StickyRefusal>
}

export const useDeviceMarks = create<DeviceMarks>(() => ({ probes: {}, sticky: {} }))

const id = (unitId: string): string => String(unitId).toLowerCase()

/** 记一次探针结果(列会话 / 探引擎)。 */
export function noteDeviceProbe(unitId: string, probe: ProbeResult): void {
  useDeviceMarks.setState((s) => ({ probes: { ...s.probes, [id(unitId)]: probe } }))
}

/** 请求抛出来的错误 → 探针失败(status 0 = 网络错 / 超时 / 失败关闭)。 */
export function probeOfError(e: unknown): ProbeResult {
  const o = (e && typeof e === 'object' ? e : {}) as { status?: unknown; code?: unknown; state?: unknown; reason?: unknown }
  return {
    ok: false,
    status: typeof o.status === 'number' ? o.status : 0,
    ...(typeof o.code === 'string' ? { code: o.code } : {}),
    ...(typeof o.state === 'string' ? { state: o.state } : {}),
    ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
  }
}

/** 建会话被拒(REMOTE_SESSIONS_OFF / REMOTE_CALLER_UNCONFIRMED …)→ 粘滞 5 分钟(deviceStatus.STICKY_TTL_MS)。不是拒绝码 → 什么都不记。 */
export function noteDeviceRefusal(unitId: string, e: unknown): void {
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; state?: unknown; reason?: unknown }
  const code = typeof o.code === 'string' ? o.code : ''
  if (!/^REMOTE_/.test(code)) return
  const sticky: StickyRefusal = {
    code,
    ...(typeof o.state === 'string' ? { state: o.state } : {}),
    ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
    at: Date.now(),
  }
  useDeviceMarks.setState((s) => ({ sticky: { ...s.sticky, [id(unitId)]: sticky } }))
}

/** 直接记一条粘滞(K8 弹层的确认流程已经算好了)。 */
export function noteDeviceSticky(unitId: string, sticky: StickyRefusal): void {
  useDeviceMarks.setState((s) => ({ sticky: { ...s.sticky, [id(unitId)]: sticky } }))
}

/** 在那台电脑上建会话成功 / 确认通过 → 撤掉它的粘滞拒绝。 */
export function clearDeviceSticky(unitId: string): void {
  const k = id(unitId)
  if (!useDeviceMarks.getState().sticky[k]) return
  useDeviceMarks.setState((s) => {
    const sticky = { ...s.sticky }
    delete sticky[k]
    return { sticky }
  })
}

// ── 「点一台电脑」流程落在这张表上的三步(桌面的运行位置胶囊用;手机弹层有自己的一份本地表,口径相同:unitsSheetModel 的
//    beginAttempt / noteAttempt / endAttempts)。describeDevice 里**探针失败排在粘滞前面**,所以上一轮的结果必须先清掉。──
const dropPending = (sticky: Record<string, StickyRefusal>): Record<string, StickyRefusal> =>
  Object.fromEntries(Object.entries(sticky).filter(([, v]) => v.state !== 'pending'))

/** 点一行 = 从零开始问这台电脑:清掉它上一轮的探针与粘滞;别的行上的「请允许」也收掉(上一轮已被中止,没人在轮询了)。 */
export function beginDeviceAttempt(unitId: string): void {
  const k = id(unitId)
  useDeviceMarks.setState((s) => {
    const probes = { ...s.probes }
    const sticky = dropPending(s.sticky)
    delete probes[k]
    delete sticky[k]
    return { probes, sticky }
  })
}

/** 流程的过程 / 结果落到这一行:谁新听谁 —— 那台电脑的回答(粘滞)顶掉旧探针;探针(成功或失败)顶掉旧粘滞。 */
export function noteDeviceAttempt(unitId: string, p: { probe?: ProbeResult; sticky?: StickyRefusal }): void {
  const k = id(unitId)
  useDeviceMarks.setState((s) => {
    const probes = { ...s.probes }
    const sticky = { ...s.sticky }
    if (p.sticky) { delete probes[k]; sticky[k] = p.sticky }
    else if (p.probe) { probes[k] = p.probe; delete sticky[k] }
    return { probes, sticky }
  })
}

/** 流程被收掉(菜单关了 / 选了别处):「请允许」是进行中的标记,不留;拒绝与探针结果照留。 */
export function endDeviceAttempts(): void {
  useDeviceMarks.setState((s) => ({ sticky: dropPending(s.sticky) }))
}

/** 换号 / 登出:整张表清空。 */
export function resetDeviceMarks(): void {
  useDeviceMarks.setState({ probes: {}, sticky: {} })
}
