/**
 * 设备互联云端通道的宿主接缝(2026-09-28,Forsion Extend 0.6):隧道客户端 UnitHost(出站 SSE 通道 + 整包 / 流式回包)、
 * caps 上报器与名册四通道 units:list / update / remove / openInBrowser 住在 Extend 的主进程半身。
 * 宿主留:局域网面 unitWeb、配对落盘(deviceSecrets)、调用方断言的签发与校验(unitCaller.ts)、P2P、设备页的鉴权注入、远程会话 ——
 * 没有 Extend 时「允许其他设备连接本机」只起局域网面。
 * 装载分两拍(同云同步):Extend 装载时(开窗前)handle 名册四通道并登记工厂;宿主每次 doRefreshUnitHost 重建设备互联时调工厂,
 * 递进这份 deps,拿回通道面。Forsion-Extend 仓 src/desktop/host.d.ts 是它的镜像,两边同改。
 * ⚠️ 渲染层(UnitSwitcher)拿 window.tangu.unitsList 在不在当「有云端中转」的信号:Extend 那边名册四通道与工厂同进同出(它的 registerCloud.test 钉着)。
 */

export interface UnitPairing { unitId: string; secret: string }
/** 名册 caps.engine(手机据此分「在线但引擎没起」与「可以用」)。 */
export type EngineCapsState = 'ready' | 'starting' | 'external' | 'stopped'
export interface UnitHubStatus { running: boolean; connected: boolean; unitId: string | null; lastError: string | null }
/** target = **实际发出**的本机 unitWeb 请求 URL(已规整);proxyCaller 是信封原样(不信形状)。 */
export interface UnitCallerInput { dispatchId: string; method: string; target: URL; proxyCaller: unknown }

export interface UnitHubHostDeps {
  /** 云端地址(不含 /api)+ 当前 forsion_token,每次现读(续期自然生效)。 */
  getCreds(): { cloudUrl: string; token: string }
  /** 本机 unitWeb:url(null = 未起)+ 「loopback + 内部密钥头」的 per-boot 密钥(server 已验 owner 的隧道豁免)。 */
  getUnitWeb(): { url: string | null; internalSecret: string }
  /** 调用方断言头(P1 · K1):钥、「哪些路径签」与验签都在宿主(unitCaller.ts makeCallerHeaders);回 {} = 不签。 */
  callerHeaders(input: UnitCallerInput): Record<string, string>
  /** 随通道自报给名册的局域网直连地址。 */
  getLanUrl(): string | null
  /** 已配对凭据;null = 未入册。save / clear 落进加密存储,且只认当前这一轮(换号 / 停用后迟到的入册不写回)。 */
  getPairing(): UnitPairing | null
  savePairing(p: UnitPairing): Promise<void>
  clearPairing(): Promise<void>
  /** 此刻的引擎态(caps 上报器每次现算,见 engineCapsState)。 */
  engineCaps(): EngineCapsState
  log(message: string): void
}
export interface UnitHubInstance {
  start(): void
  stop(): void
  /** 立即重拨(系统唤醒);未运行时无操作。 */
  reconnect(reason: string): void
  status(): UnitHubStatus
  /** 引擎态可能变了(起停 / 崩溃 / 项目根种子做完):去抖后变了才报。 */
  engineChanged(): void
}
export type UnitHubFactory = (deps: UnitHubHostDeps) => UnitHubInstance

/** 引擎态 → caps.engine。seeded = 本机项目根种子做完(没做完之前 unitWeb 对远端回 503 ENGINE_NOT_READY,手机上应显示「在启动」)。 */
export function engineCapsState(i: { agentBackend: boolean; backend: 'stopped' | 'starting' | 'ready' | 'crashed'; seeded: boolean }): EngineCapsState {
  if (!i.agentBackend) return 'external'
  if (i.backend === 'ready') return i.seeded ? 'ready' : 'starting'
  if (i.backend === 'starting') return 'starting'
  return 'stopped'
}
