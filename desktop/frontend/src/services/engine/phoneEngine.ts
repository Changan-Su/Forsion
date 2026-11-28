/**
 * 「这台手机 / This phone」:Android App 里的本机 Tangu 引擎(第 1 期,docs 手机本机引擎方案 B)。
 *
 * 它在渲染层里是一台**保留 id 的设备**(`{ kind: 'unit', unitId: PHONE_ENGINE_ID }`),而不是第三种 TargetRef:
 * 目标解析、会话绑定、焦点 / 记忆、能力、401 归属这些按 unit 写好的路全部原样复用,请求照旧经原生中继
 * (ForsionUnit.request)出去,原生看到这个 id 就改发 127.0.0.1 上的本机引擎、自己盖本机令牌 —— 端口和令牌页面拿不到。
 * 名册里没有它(它不是一台云端登记的设备,别的端也看不到),所以凡是按名册判状态的地方都先问 isPhoneRef。
 *
 * ⚠️ 与原生 UnitRelay.PHONE_ENGINE_ID 同值;hub 发的 unit id 是随机 v4,撞不上。
 * 本文件不 import capacitor:宿主能力只经 `window.tangu?.localEngine`(mobile/src/localEngine.ts 装上;web / 桌面恒无)。
 */
import { create } from 'zustand'
import type { TargetRef } from './target'
import { registerMessages, translate } from '../../i18n'

export const PHONE_ENGINE_ID = '00000000-0000-4000-8000-000000000001'

registerMessages({
  'phoneEngine.name': { zh: '这台手机', en: 'This phone' },
  'phoneEngine.startFailed': { zh: '本机环境没能启动', en: "The local environment couldn't start" },
  'phoneEngine.unavailable': { zh: '这个版本的 App 不能在手机上运行', en: "This version of the app can't run on the phone" },
})

/** 「这台手机」的展示名(运行位置药丸、侧栏分组、焦点名都用这一份)。 */
export function phoneEngineName(): string {
  return translate('phoneEngine.name')
}
export const PHONE_REF: TargetRef = { kind: 'unit', unitId: PHONE_ENGINE_ID }

export function isPhoneEngineId(id: unknown): boolean {
  return typeof id === 'string' && id.toLowerCase() === PHONE_ENGINE_ID
}

export function isPhoneRef(ref: TargetRef | null | undefined): boolean {
  return !!ref && ref.kind === 'unit' && isPhoneEngineId(ref.unitId)
}

/** 原生 LocalEngine.state() 的形状(字段都可能缺:老包 / 读失败)。 */
export interface PhoneEngineState {
  /** 原生每取一次快照加 1(数大 = 取得晚);比已收到的小 = 过时的快照(调用的回复被变化事件超车),丢掉 */
  seq?: number
  /** 包里带了启动器且是 64 位 ARM。 */
  available?: boolean
  /** 构建里配了环境包清单地址。 */
  configured?: boolean
  installed?: boolean
  baseVersion?: string
  engineVersion?: string
  /** idle | downloading | paused | unpacking | checking | failed */
  phase?: string
  /** 暂停 / 失败打断的那个操作(install | reset | update):继续 / 重试照它再来(resume) */
  op?: string
  /** 有登录的 Forsion 账号(本机引擎的数据按账号分开;没登录不启动) */
  signedIn?: boolean
  error?: string
  layer?: string
  done?: number
  total?: number
  downloadBytes?: number
  unpackedBytes?: number
  engineDownloadBytes?: number
  availableEngineVersion?: string
  availableBaseVersion?: string
  resumeBytes?: number
  updateAvailable?: boolean
  /** stopped | starting | running | failed */
  engine?: string
  engineError?: string
}

export interface PhoneEngineUsage { environment?: number; home?: number; workspace?: number; downloads?: number }

/** 宿主桥(mobile/src/localEngine.ts)。全部异步;拒绝时带 code。 */
export interface PhoneEngineHost {
  state(): Promise<PhoneEngineState>
  check(): Promise<PhoneEngineState>
  install(opts?: { reset?: boolean }): Promise<PhoneEngineState>
  update(): Promise<PhoneEngineState>
  pause(): Promise<PhoneEngineState>
  /** 继续被暂停 / 失败打断的那个操作(暂停的重置还是重置,不会变成只更新引擎) */
  resume(): Promise<PhoneEngineState>
  remove(): Promise<unknown>
  start(): Promise<PhoneEngineState>
  stop(): Promise<PhoneEngineState>
  usage(): Promise<PhoneEngineUsage>
  metered(): Promise<{ metered: boolean }>
  configure(strings: { channel: string; title: string; text: string; stop: string }): Promise<unknown>
  onState(cb: (s: PhoneEngineState) => void): () => void
}

/** ⚠️ 门控字面量逐字写成 `window.tangu?.localEngine`(platform-parity 的 D 段靠正则扫它)。 */
export function phoneEngineHost(): PhoneEngineHost | null {
  if (typeof window === 'undefined') return null
  return window.tangu?.localEngine ?? null
}

export const usePhoneEngine = create<{ state: PhoneEngineState | null }>(() => ({ state: null }))

export function setPhoneEngineState(s: PhoneEngineState | null): void {
  usePhoneEngine.setState({ state: s })
}

/** 这一端能不能把「这台手机」列成运行位置:有宿主桥、包里带启动器、构建配了环境包地址。 */
export function phoneEngineOffered(s: PhoneEngineState | null = usePhoneEngine.getState().state): boolean {
  return !!phoneEngineHost() && !!s?.available && !!s?.configured
}

export function phoneEngineInstalled(s: PhoneEngineState | null = usePhoneEngine.getState().state): boolean {
  return phoneEngineOffered(s) && !!s?.installed
}

/** MB,四舍五入到整数(界面只写约数)。 */
export function mb(bytes: number | undefined): number {
  return Math.max(0, Math.round((bytes || 0) / (1024 * 1024)))
}
