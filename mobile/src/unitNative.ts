/**
 * 手机作为 Unit 的 JS 桥(P1-K8):原生插件 `ForsionUnit`(android …/UnitPlugin.java)+ 中继适配(unitRelay.ts)
 * → mobileShim 装到 window.fetch 前置与 window.tangu.unitSelf / unitEnsureSelf / unitForgetSelf 上。
 *
 * ⚠️ 只许 mobileShim import(它本来就不在 web 包图里):这里 import 了 @capacitor/core 的 registerPlugin 真身,
 *    web 手机形态经 @mobile/mobileEntry 复用的 UnitsSheet 等只能走 window.tangu 上的这几个方法。
 *
 * 中继模式(INTEGRATION R-05 缺省):调用方票永不进 JS,所以这里**不实现** window.tangu.unitCallerHeaders
 * (那是桥模式的接缝,只在 K8 规格 §8 风险 1 的客观触发条件成立时才切过去)。
 *
 * 启动断言(INTEGRATION §4.2):JS 的 cloudApiBase 与原生烤进 APK 的 apiBase 必须逐字相等 —— 不等时 JS 判为中继面的
 * URL 会被原生发往另一台主机。所以不等(或原生缺席)= 中继不可用:中继面上的请求一律合成 503 CALLER_UNSUPPORTED。
 */
import { registerPlugin } from '@capacitor/core'
import { createRelayFetch, type RelayMsg, type RelayNative, type RelayRequest, type RelayState } from './unitRelay'

interface ForsionUnitPlugin {
  config(): Promise<{ apiBase: string | null }>
  status(): Promise<{ registered: boolean; unitId: string | null; name: string | null }>
  ensureRegistered(): Promise<{ unitId: string; name: string; created: boolean }>
  forget(o: { remote: boolean }): Promise<{ ok: boolean }>
  request(o: RelayRequest, cb: (msg: RelayMsg | null, err?: unknown) => void): Promise<string>
  cancel(o: { id: string }): Promise<{ ok: boolean }>
}

const ForsionUnit = registerPlugin<ForsionUnitPlugin>('ForsionUnit')

const relayNative: RelayNative = {
  request: (o, cb) => ForsionUnit.request(o, cb),
  cancel: (o) => ForsionUnit.cancel(o),
}

export type UnitSelf = { registered: boolean; unitId: string | null; name: string | null; relay: RelayState }
export type UnitEnsure = { ok: true; unitId: string; name: string } | { ok: false; code: string }

export interface UnitBridge {
  /** window.fetch 前置:null = 不是中继面,走原 fetch。 */
  relay: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | null
  unitSelf(): Promise<UnitSelf>
  unitEnsureSelf(): Promise<UnitEnsure>
  unitForgetSelf(): Promise<{ ok: boolean }>
}

/**
 * native=false(mobile 的 web dev / preview 路径):没有原生身份 → 中继面上的请求照样失败关闭(503 CALLER_UNSUPPORTED),
 * 身份三件回「仅安卓 App」。
 */
export function createUnitBridge(apiBase: string, native: boolean, origin: string): UnitBridge {
  if (!native) {
    return {
      relay: createRelayFetch(null, apiBase, { state: async () => 'unsupported', origin }),
      unitSelf: async () => ({ registered: false, unitId: null, name: null, relay: 'unsupported' }),
      unitEnsureSelf: async () => ({ ok: false, code: 'native_only' }),
      unitForgetSelf: async () => ({ ok: false }),
    }
  }
  // 启动即断言一次(不阻塞启动;首个中继请求会等它)。
  const state: Promise<RelayState> = ForsionUnit.config().then(
    (c) => {
      if (c?.apiBase && c.apiBase === apiBase) return 'ready' as const
      console.warn('[unit] relay disabled: native apiBase differs from the web apiBase')
      return 'unsupported' as const
    },
    () => {
      console.warn('[unit] relay disabled: native ForsionUnit plugin unavailable')
      return 'unsupported' as const
    },
  )
  return {
    relay: createRelayFetch(relayNative, apiBase, { state: () => state, origin }),
    unitSelf: async () => {
      const relay = await state
      try {
        const s = await ForsionUnit.status()
        return { registered: !!s?.registered, unitId: s?.unitId ?? null, name: s?.name ?? null, relay }
      } catch {
        return { registered: false, unitId: null, name: null, relay }
      }
    },
    unitEnsureSelf: async () => {
      if ((await state) !== 'ready') return { ok: false, code: 'caller_unsupported' }
      try {
        const r = await ForsionUnit.ensureRegistered()
        return { ok: true, unitId: r.unitId, name: r.name }
      } catch (e) {
        const code = (e as { code?: unknown })?.code
        return { ok: false, code: typeof code === 'string' && code ? code : 'network' }
      }
    },
    unitForgetSelf: async () => {
      try {
        await ForsionUnit.forget({ remote: true })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
  }
}
