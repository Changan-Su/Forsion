/**
 * 「允许远程会话」开关 / 调用方信任 / 远程会话最高审批档(设备能力 MCP 方案 P1 · K4)的跨层类型。
 * 主进程(electron/remoteSessions.ts、remoteSessionGate.ts)、unitWeb、渲染层设置页与设备页 / 手机的拒绝码本地化共用。
 * 刻意零依赖:渲染层、electron 与 vitest 都直接 import。
 *
 * 裁决(INTEGRATION §1.1):R-01(K4 独占 remoteSessions* 全套)、R-07(同步闸)、R-09(调用方四主体)、R-10(拒绝码)、
 * R-11(isEnabled / trustedCaller)、R-24(K5 门控)、R-25(确认框名字 = registeredName ?? name + 快照)、U1 缺省
 * (一条可撤销的「本账号的浏览器与网页版」信任条目,principal='account';p2p 按它判、永不高于局域网配对)。
 */

/** 远程会话最高审批档(config.json `remote.maxApprovalMode`,引擎 C3 每次现读)。只有三值,永不写 custom。 */
export type CapMode = 'readonly' | 'auto-edit' | 'full-auto'
export const CAP_MODES: readonly CapMode[] = ['readonly', 'auto-edit', 'full-auto']

/** 与引擎 remoteApprovalCap() 同口径:缺省 / 非法 → auto-edit(主进程与渲染层各自读,不跨包 import 引擎)。 */
export function normalizeCap(v: unknown): CapMode {
  return v === 'readonly' || v === 'full-auto' || v === 'auto-edit' ? v : 'auto-edit'
}

/** 一个调用方主体(设备 id 或「本账号」)在本机的信任状态。 */
export type TrustState = 'trusted' | 'pending' | 'denied' | 'unconfirmed'

/** /engine 会话档被拒的两个码(R-10;K4 所有,设备页 / 手机 / web 经 remoteRefusalMessage 本地化)。 */
export const REMOTE_SESSIONS_OFF = 'REMOTE_SESSIONS_OFF'
export const REMOTE_CALLER_UNCONFIRMED = 'REMOTE_CALLER_UNCONFIRMED'
export type RemoteGateCode = typeof REMOTE_SESSIONS_OFF | typeof REMOTE_CALLER_UNCONFIRMED

/**
 * 为什么**不是**「在等那台电脑上的人点允许」(R-10 的只增补充,P1-K4 评审)。有 reason 时调用方不在等弹框 ——
 * 按 reason 出文案,**不要**当成 awaitingConfirm(R-10 让 K7 / K8 把 state∈{pending,unconfirmed} 显示成「等待确认」,有 reason 时先看 reason)。
 * 没有 reason:pending = 弹框开着 / 在队里;denied = 那台电脑上的人点了「不允许」(冷却 10 分钟);unconfirmed = 还没问过(状态面;再请求会弹)。
 */
export type TrustReason =
  /** 「本账号的浏览器与网页版」在那台电脑上被撤销(D8 严格档):account / p2p 只有基础档,不再弹框,只能在那台电脑的设置里重新允许。state='denied'。 */
  | 'strict'
  /** P2P 从不弹框(R-09:P2P 信道可由只有局域网配对凭据的设备开出,不能凭它授出账号级条目)。state='unconfirmed'。 */
  | 'never-prompts'
  /** 那台电脑没登录 Forsion,记不了信任。state='unconfirmed'。 */
  | 'not-signed-in'
  /** 调用方设备不在那台电脑所登录账号的名册里(或 kind 对不上):不弹框。state='denied'(冷却 10 分钟)。 */
  | 'roster-miss'
  /** 那台电脑这会儿查不了名册:不弹框,30 秒后可再试。state='unconfirmed'。 */
  | 'roster-unreachable'
  /** 弹框 2 分钟没人答:1 分钟后可再试(不让无人值守的电脑被连着弹框)。state='unconfirmed'。 */
  | 'no-answer'
  /** 待确认队列满了(全局 1 框 + 3 排队):稍后再试。state='unconfirmed'。 */
  | 'busy'

/** P1-KF:TrustReason 的运行期清单(消费方判「认得的 reason」用;Record 键钉住与类型逐项一致,新增 reason 不补这里就编不过)。 */
const TRUST_REASON_SET: Record<TrustReason, true> = {
  strict: true, 'never-prompts': true, 'not-signed-in': true, 'roster-miss': true, 'roster-unreachable': true, 'no-answer': true, busy: true,
}
export const TRUST_REASONS = Object.keys(TRUST_REASON_SET) as readonly TrustReason[]
export function isTrustReason(v: unknown): v is TrustReason {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TRUST_REASON_SET, v)
}
/** 稍后再试就可能弹框的几种(冷却 ≤ 1 分钟 / 排满);其余要那台电脑上的人先做点什么(登录 / 同账号 / 在设置里允许)。 */
export const RETRY_SOON_REASONS: ReadonlySet<TrustReason> = new Set<TrustReason>(['roster-unreachable', 'no-answer', 'busy'])

/**
 * 确认框的时序(P1-KF 评审):主进程 remoteSessions.ts 与手机 runOn 的等待截止**同源**。
 * 执行设备先查名册(≤ ROSTER_LOOKUP_TIMEOUT_MS),查完才弹框并起 REMOTE_PROMPT_TTL_MS 的计时 —— 到点没人答 → reason no-answer。
 * 手机从拿到 pending 起等,截止必须晚于「查名册 + 弹框时限」,否则会先于桌面放弃、把一个已经收掉的框当成「请允许」挂着。
 */
export const REMOTE_PROMPT_TTL_MS = 2 * 60_000
export const ROSTER_LOOKUP_TIMEOUT_MS = 10_000

export type GateBody = { code: RemoteGateCode; detail: string; state?: TrustState; reason?: TrustReason }
export type GateResult = { ok: true } | { ok: false; status: 403; body: GateBody }

/** 调用方主体的种类(= callerPrincipal 去掉 unit id;局域网配对叫 lan)。 */
export type RemotePrincipalKind = 'unit' | 'account' | 'lan' | 'p2p'

/** GET /unit/remote-access 的回包:**只回调用方自己的状态**,永不回信任列表或别的设备。 */
export interface RemoteAccessStatus {
  /** 本机「允许远程会话」此刻是否生效(存档开 && 设备凭据已绑系统加密)。 */
  remoteSessions: boolean
  principal: RemotePrincipalKind
  /** 局域网配对设备 = paired(配对时已本机核对 6 位码);其余按信任条目。 */
  caller: TrustState | 'paired'
  /** 见 TrustReason(可选,只增)。 */
  reason?: TrustReason
  maxApprovalMode: CapMode
}

/** 信任列表里的一台设备(本机确认那一刻记下的快照,之后以它为准,名册改名不影响)。 */
export interface TrustedUnitView {
  principal: 'unit'
  unitId: string
  name: string
  kind: 'phone' | 'desktop'
  platform: string | null
  registeredAt: string | null
  confirmedAt: number
}
/** 「本账号的浏览器与网页版」(浏览器打开的设备页、Genesis web、老 App 等不带调用方断言的客户端;P2P 跟随它)。 */
export interface TrustedAccountView {
  principal: 'account'
  confirmedAt: number
  /** 升级迁移时预置(老用户已开「允许其他设备连接本机」),不是用户在弹框里点的。 */
  preconfirmed: boolean
}
export type TrustedView = TrustedUnitView | TrustedAccountView

/** 正在等本机确认的请求(弹框开着或在队里)。 */
export interface PendingView {
  principal: 'unit' | 'account'
  unitId?: string
  name?: string
  kind?: 'phone' | 'desktop'
  since: number
}

/** 渲染层看到的全部(remoteSessions:get / changed)。 */
export interface RemoteSessionsView {
  /** 父开关「允许其他设备连接本机」(只读展示;改它仍走设备切换器的 setConfig)。 */
  hostEnabled: boolean
  /** 存档里的开关意愿。生效 = enabled && permitted。 */
  enabled: boolean
  /** 设备凭据已绑系统加密(K5 remoteSessionsPermitted);false 时开关置灰、打不开。
   *  null = 父开关关着、没去问 K5(问 = 判定钥匙串等级,macOS 可能弹框;K5 懒加载契约)—— 是「未知」,**不是**「未加密」。 */
  permitted: boolean | null
  maxApprovalMode: CapMode
  trusted: TrustedView[]
  pending: PendingView[]
  /**
   * 「本账号的浏览器与网页版」条目(U1)此刻的状态:trusted = 已允许;strict = 撤销过(D8 严格档,不再弹框,只能在这里重新允许);
   * none = 还没允许(浏览器 / 网页版第一次起会话时弹框;P2P 不弹框,只能在这里允许);null = 本机没登录 Forsion(记不了信任)。
   */
  accountEntry: 'trusted' | 'strict' | 'none' | null
}

/** preload 暴露的 window.tangu.remoteSessions(IPC 全部只收本机可信发送方)。 */
export interface RemoteSessionsApi {
  get(): Promise<RemoteSessionsView>
  /** 打开时设备凭据未绑系统加密 → reject(secret-store-insecure)。 */
  setEnabled(on: boolean): Promise<RemoteSessionsView>
  setMaxApprovalMode(mode: CapMode): Promise<RemoteSessionsView>
  /** unit id 或 'account'。撤销 'account' = D8 严格档(不再弹框,直到 allowAccount)。 */
  revoke(principal: string): Promise<RemoteSessionsView>
  /** 在本机设置里直接允许「本账号的浏览器与网页版」(清掉严格档;等同在弹框里点「允许」)。本机没登录 → reject(not-signed-in)。 */
  allowAccount(): Promise<RemoteSessionsView>
  onChanged(cb: (view: RemoteSessionsView) => void): () => void
}

/** setEnabled(true) 在 K5 门控不允许时抛的错(渲染层据此提示,不当成通用失败)。 */
export const SECRET_STORE_INSECURE = 'secret-store-insecure'
