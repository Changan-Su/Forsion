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

export type GateBody = { code: RemoteGateCode; detail: string; state?: TrustState }
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
}

/** preload 暴露的 window.tangu.remoteSessions(IPC 全部只收本机可信发送方)。 */
export interface RemoteSessionsApi {
  get(): Promise<RemoteSessionsView>
  /** 打开时设备凭据未绑系统加密 → reject(secret-store-insecure)。 */
  setEnabled(on: boolean): Promise<RemoteSessionsView>
  setMaxApprovalMode(mode: CapMode): Promise<RemoteSessionsView>
  /** unit id 或 'account'。 */
  revoke(principal: string): Promise<RemoteSessionsView>
  onChanged(cb: (view: RemoteSessionsView) => void): () => void
}

/** setEnabled(true) 在 K5 门控不允许时抛的错(渲染层据此提示,不当成通用失败)。 */
export const SECRET_STORE_INSECURE = 'secret-store-insecure'
