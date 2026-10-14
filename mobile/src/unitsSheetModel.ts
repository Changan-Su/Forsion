/**
 * UnitsSheet「在哪运行」的纯模型(P1-K8,规格 K8 §3.7;状态口径 = services/deviceStatus.ts,INTEGRATION R-22)。
 * 无 React / 无 capacitor 依赖(web 手机形态也 import 得到;node 单测 scripts/units-sheet-model.test.cjs)。
 *
 * - runRows:只列 `kind === 'desktop'` 且不是本机的设备(手机没有引擎、也没有设备页;INTEGRATION R-28 把 K1 的滤手机并到这里)。
 *   ⚠️ kind 缺席按 desktop:server 2.3.23 之前的名册不回 kind(生产今天就是这样),严格滤会把所有电脑一起滤掉。
 * - runOn:点一台电脑之后的流程 —— 懒登记本机 → 问那台电脑认不认这台手机(`GET /unit/remote-access`,经原生中继带票)
 *   → 需要就发起确认并每 2s 轮询(截止 = 那台查名册 + 弹框时限 + 余量,过了再核一次)→ 探一次引擎(`GET /engine/agent/sessions`,远端允许的基础档)→ 生效。
 *   **reason 先于 state**(P1-KF):回包带 reason(严格档 / 名册缺失 / 那台没登录 / 没人答 / 排满 …)= 那台电脑上不会有弹框 ——
 *   不发起确认、不进「请在 X 上允许」的轮询,直接按 reason 落到行上;轮询中弹框收了没回答(回 unconfirmed)也就此停下。
 *   生效 = 调注入的 select(ref);UnitsSheet 里那一个 selectRunLocation = K6-S2 的 setFocusTarget。
 * - removeThisPhone:「移除本机登记」—— 先切回云端(并等它生效)再移除,顺序由单测钉住(评审 P2)。
 * - beginAttempt / noteAttempt / endAttempts:UnitsSheet 每行「探针 / 粘滞拒绝」两张表的唯一改法(P1-KF 评审):谁新听谁,
 *   上一轮的「连不上」不许盖住这一轮那台电脑的真回答;没人在轮询时不留「请允许」。
 */
import type { UnitInfo } from '@/types'
import { HOME_REF, type TargetRef } from '@/services/engine/target'
import { describeDevice, isTrustReason, RETRY_SOON_REASONS, type DeviceStatus, type ProbeResult, type RefusalDetail, type StickyRefusal, type TrustReason } from '@/services/deviceStatus'

export interface RunRow {
  id: string
  name: string
  icon: string | null
  platform: string | null
  status: DeviceStatus
  /** 决定 status 的那条拒绝的 state / reason(awaitingConfirm / denied / callerBlocked 的文案按它选,P1-KF)。 */
  refusal?: RefusalDetail
  /** 设备自报「引擎在跑」(还没探过时的提示,不等于可用)。 */
  capsReady: boolean
  selected: boolean
}

/**
 * 切到一台电脑时交给整端焦点的展示名(M1B):名册里那台的名字(与「在哪运行」那一行同一个字段);home / 名册里没有 / 名字空 → null。
 * 焦点名是不可信串、只作展示(审批结局行「在执行的电脑上(名字)」、连接态提示),setFocusTarget 自己再截 120。
 */
export function rosterNameOf(units: ReadonlyArray<Pick<UnitInfo, 'id' | 'name'>>, ref: TargetRef): string | null {
  if (ref.kind !== 'unit') return null
  const id = ref.unitId.toLowerCase()
  const name = units.find((u) => u.id.toLowerCase() === id)?.name?.trim()
  return name || null
}

/** 名册里能当运行位置 / 能打开设备页的:电脑(kind 缺席按电脑),且不是本机。 */
export function isRunnableUnit(u: Pick<UnitInfo, 'id' | 'kind'>, selfId: string | null): boolean {
  return (u.kind ?? 'desktop') === 'desktop' && u.id !== selfId
}

export function runRows(
  units: UnitInfo[],
  selfId: string | null,
  current: TargetRef,
  probes: Readonly<Record<string, ProbeResult | undefined>> = {},
  sticky: Readonly<Record<string, StickyRefusal | undefined>> = {},
  now: number = Date.now(),
): RunRow[] {
  return units.filter((u) => isRunnableUnit(u, selfId)).map((u) => {
    const d = describeDevice(u, probes[u.id] ?? null, sticky[u.id], now)
    return {
      id: u.id,
      name: u.name,
      icon: u.icon ?? null,
      platform: u.platform ?? null,
      status: d.status,
      ...(d.refusal ? { refusal: d.refusal } : {}),
      capsReady: !!(u.online && u.capsLive && u.caps?.engine === 'ready'),
      selected: current.kind === 'unit' && current.unitId === u.id,
    }
  })
}

/** reason → 行上文案键(P1-KF)。Record 键钉住 TrustReason 全集:新增 reason 不补这里就编不过。 */
export const REASON_STATUS_KEYS: Record<TrustReason, string> = {
  strict: 'unitm.reason.strict',
  'never-prompts': 'unitm.reason.neverPrompts',
  'not-signed-in': 'unitm.reason.notSignedIn',
  'roster-miss': 'unitm.reason.rosterMiss',
  'roster-unreachable': 'unitm.reason.rosterUnreachable',
  'no-answer': 'unitm.reason.noAnswer',
  busy: 'unitm.reason.busy',
}

/**
 * 行上的状态文案键(unitm.*;devstatus.* 是 K7 的命名空间,这里不注册以免集成时撞键)。
 * 拒绝类**先看 reason、再看 state**(P1-KF):带 reason = 那台电脑上不会弹框,绝不出「请在 X 上允许」;
 * denied 才说「10 分钟后可再请求」(那是用户点了「不允许」之后的真实冷却),严格档 / 名册缺失不许诺它。
 */
export function statusKey(row: Pick<RunRow, 'status' | 'capsReady'> & { refusal?: RefusalDetail }, probing: boolean): string {
  const reason = row.refusal?.reason
  if (isTrustReason(reason) && (row.status === 'callerBlocked' || row.status === 'denied' || row.status === 'awaitingConfirm')) return REASON_STATUS_KEYS[reason]
  switch (row.status) {
    case 'checking':
      if (probing) return 'unitm.checking'
      return row.capsReady ? 'unitm.ready' : 'unitm.unknown'
    case 'ready': return 'unitm.ready'
    case 'starting': return 'unitm.starting'
    case 'engineStopped': return 'unitm.engineOff'
    case 'noEngine': return 'unitm.noEngine'
    case 'offline': return 'unitm.offline'
    case 'unreachable': return 'unitm.unreachable'
    case 'remoteOff': return 'unitm.remoteOff'
    case 'awaitingConfirm': return row.refusal?.state === 'unconfirmed' ? 'unitm.confirmNotAsked' : 'unitm.confirmPending'
    case 'denied': return 'unitm.confirmDenied'
    case 'callerBlocked': return 'unitm.confirmDenied' // 只在 reason 不认得时到这里(describeDevice 只在认得 reason 时给 callerBlocked)
  }
}

export type RowTone = '' | 'ok' | 'warn' | 'err'
const TONE: Record<DeviceStatus, RowTone> = {
  checking: '', ready: 'ok', starting: 'warn', engineStopped: 'warn', noEngine: 'err', offline: '',
  unreachable: 'err', remoteOff: 'warn', awaitingConfirm: 'warn', denied: 'err', callerBlocked: 'err',
}
/** 行首状态点:callerBlocked 里「稍后再试就行」的几种(名册查不了 / 没人答 / 排满)是 warn,要那台电脑上先做点什么的是 err。 */
export function rowTone(row: Pick<RunRow, 'status' | 'capsReady'> & { refusal?: RefusalDetail }, probing: boolean): RowTone {
  if (row.status === 'checking') return !probing && row.capsReady ? 'ok' : ''
  const reason = row.refusal?.reason
  if (row.status === 'callerBlocked' && isTrustReason(reason) && RETRY_SOON_REASONS.has(reason)) return 'warn'
  return TONE[row.status]
}

// runOn 那一段(点一台电脑之后的流程)与桌面的运行位置胶囊共用,住在 desktop/frontend/src/services/runOnDevice.ts。
export { CONFIRM_GRACE_MS, CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS, phoneIssueOfCode, runOn, type PhoneIssue, type RunOnDeps, type RunOnOutcome } from '@/services/runOnDevice'

/**
 * UnitsSheet 每行的两张表:最近一次探针结果、最近一次拒绝(粘滞)。只经下面三个函数改(评审 P2)。
 * 为什么要管:describeDevice 里**探针失败排在粘滞前面**(连不上时开关与信任无从谈起)—— 表里留着上一轮的
 * `{ok:false,status:0}`,这一轮那台电脑明明回了 roster-miss / pending,行上照样是「暂时连不上」,「请允许」也永远出不来。
 */
export interface RowMarks {
  probes: Readonly<Record<string, ProbeResult>>
  sticky: Readonly<Record<string, StickyRefusal>>
}
export const NO_MARKS: RowMarks = { probes: {}, sticky: {} }

function without<T>(m: Readonly<Record<string, T>>, id: string): Readonly<Record<string, T>> {
  if (!Object.prototype.hasOwnProperty.call(m, id)) return m
  const n = { ...m }
  delete n[id]
  return n
}
/** 「请允许」是**进行中**的标记(只在有流程在轮询时成立),不是拒绝:流程没了就收掉。 */
function withoutPending(m: Readonly<Record<string, StickyRefusal>>): Readonly<Record<string, StickyRefusal>> {
  const ids = Object.keys(m).filter((id) => m[id].state === 'pending')
  return ids.reduce((acc, id) => without(acc, id), m)
}

/**
 * 点一行 = 从零开始问这台电脑:清掉这一行上一轮的探针与粘滞(行上是「正在连接…」,等这一轮的回答);
 * 别的行上的「请允许」也收掉 —— 点新一行时上一轮已被中止,没人在轮询了。
 */
export function beginAttempt(m: RowMarks, id: string): RowMarks {
  return { probes: without(m.probes, id), sticky: withoutPending(without(m.sticky, id)) }
}

/** runOn 的过程 / 结果落到这一行:谁新听谁 —— 那台电脑的回答(粘滞)顶掉旧探针;探针(成功或失败)顶掉旧粘滞。 */
export function noteAttempt(m: RowMarks, id: string, p: { probe?: ProbeResult; sticky?: StickyRefusal }): RowMarks {
  if (p.sticky) return { probes: without(m.probes, id), sticky: { ...m.sticky, [id]: p.sticky } }
  if (p.probe) return { probes: { ...m.probes, [id]: p.probe }, sticky: without(m.sticky, id) }
  return m
}

/** 流程被收掉(弹层关了 / 选了云端):收掉所有「请允许」,拒绝与探针结果照留(5 分钟内再打开还看得到)。 */
export function endAttempts(m: RowMarks): RowMarks {
  const sticky = withoutPending(m.sticky)
  return sticky === m.sticky ? m : { probes: m.probes, sticky }
}

export interface RemoveDeps {
  /** 当前运行位置(= focusRef())。 */
  current(): TargetRef
  /** 同 runOn 的 select:UnitsSheet 唯一的生效出口 selectRunLocation;它等切换(含重连)完成。 */
  select(ref: TargetRef): void | Promise<void>
  /** window.tangu.unitForgetSelf:删本地身份 + DELETE 名册那一行。 */
  forget(): Promise<{ ok: boolean }>
}

/**
 * 「移除本机登记」(评审 P2):**先**切回云端并等它生效,**再**移除。反过来的话,移除途中那台电脑的轮询 / SSE 重连还经中继发着,
 * 撞 403(那行没了、票作废)→ 原生强制换票 → 懒登记 → 悄悄登记出一个新身份,电脑上刚被撤销就又弹「允许这台手机?」。
 * (原生另有一道闩:移除后懒登记与自愈一律拒绝,直到下一次显式登记 —— 两道都在。)
 */
export async function removeThisPhone(deps: RemoveDeps): Promise<{ ok: boolean }> {
  if (deps.current().kind === 'unit') await deps.select(HOME_REF)
  return deps.forget()
}
