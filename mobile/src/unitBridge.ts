/**
 * 手机作为 Unit 的 JS 桥(P1-K8):原生插件 `ForsionUnit`(android …/UnitPlugin.java)+ 中继适配(unitRelay.ts)
 * → mobileShim 装到 window.fetch 前置与 window.tangu.unitSelf / unitEnsureSelf / unitForgetSelf 上。
 *
 * 纯逻辑、**不 import capacitor**:原生插件由 mobileShim 用 registerPlugin 造好注入(评审 P2:这样启动断言与 web 路径
 * 才测得到 —— scripts/unit-bridge.test.cjs)。web 手机形态经 @mobile/mobileEntry 复用的 UnitsSheet 等只能走 window.tangu。
 *
 * 中继模式(INTEGRATION R-05 缺省):调用方票永不进 JS,所以这里**不实现** window.tangu.unitCallerHeaders
 * (那是桥模式的接缝,只在 K8 规格 §8 风险 1 的客观触发条件成立时才切过去)。
 *
 * 启动握手(INTEGRATION §4.2):attach() 取原生烤进 APK 的 apiBase,与 JS 的 cloudApiBase 逐字比 —— 不等时 JS 判为
 * 中继面的 URL 会被原生发往另一台主机,所以不等(或原生缺席)= 中继不可用:中继面上的请求一律合成 503 CALLER_UNSUPPORTED。
 * attach() 同时让原生取消此刻全部在途中继:本页面的中继请求都要等这个握手,所以那一刻在途的只可能属于之前的页面(评审 P1)。
 *
 * web 路径(plugin = null,mobile 的 dev / preview):**不装中继**(K8 §3.4「只在 native 路径装」,评审 P2)——
 * 这条路没有原生身份,与 Genesis web 一样走原 fetch(账号级未识别调用方);失败关闭在这里没有安全收益,
 * 反而让 K6-S2 的 check:enginetarget(正是驱动 mobile dev 构建去打 unit 目标)全红。
 */
import { createRelayFetch, type RelayMsg, type RelayNative, type RelayRequest, type RelayState } from './unitRelay'

/** 原生插件 `ForsionUnit` 的 JS 形状(UnitPlugin.java 的 @PluginMethod)。 */
export interface ForsionUnitPlugin {
  /** 新页面握手:{apiBase} + 原生取消全部在途中继。 */
  attach(): Promise<{ apiBase: string | null }>
  status(): Promise<{ registered: boolean; unitId: string | null; name: string | null }>
  ensureRegistered(): Promise<{ unitId: string; name: string; created: boolean }>
  forget(o: { remote: boolean }): Promise<{ ok: boolean }>
  request(o: RelayRequest, cb: (msg: RelayMsg | null, err?: unknown) => void): Promise<string>
  cancel(o: { id: string }): Promise<{ ok: boolean }>
}

/** relay:'native_only' = 不是安卓 App(web dev / preview 路径);'unsupported' = 原生缺席或启动断言不成立。 */
export type UnitSelf = { registered: boolean; unitId: string | null; name: string | null; relay: RelayState | 'native_only' }
export type UnitEnsure = { ok: true; unitId: string; name: string } | { ok: false; code: string }

export interface UnitBridge {
  /** window.fetch 前置:null = 不交给中继,走原 fetch(web 路径恒为 null)。 */
  relay: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | null
  unitSelf(): Promise<UnitSelf>
  unitEnsureSelf(): Promise<UnitEnsure>
  unitForgetSelf(): Promise<{ ok: boolean }>
}

/**
 * plugin = null:mobile 的 web dev / preview 路径 —— 不装中继,身份三件回「仅安卓 App」。
 * plugin 在:启动即握手一次(不阻塞启动;首个中继请求会等它)。
 */
export function createUnitBridge(apiBase: string, plugin: ForsionUnitPlugin | null, origin: string): UnitBridge {
  if (!plugin) {
    return {
      relay: () => null,
      unitSelf: async () => ({ registered: false, unitId: null, name: null, relay: 'native_only' }),
      unitEnsureSelf: async () => ({ ok: false, code: 'native_only' }),
      unitForgetSelf: async () => ({ ok: false }),
    }
  }
  const state: Promise<RelayState> = plugin.attach().then(
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
  const native: RelayNative = {
    request: (o, cb) => plugin.request(o, cb),
    cancel: (o) => plugin.cancel(o),
  }
  return {
    relay: createRelayFetch(native, apiBase, { state: () => state, origin }),
    unitSelf: async () => {
      const relay = await state
      try {
        const s = await plugin.status()
        return { registered: !!s?.registered, unitId: s?.unitId ?? null, name: s?.name ?? null, relay }
      } catch {
        return { registered: false, unitId: null, name: null, relay }
      }
    },
    unitEnsureSelf: async () => {
      if ((await state) !== 'ready') return { ok: false, code: 'caller_unsupported' }
      try {
        const r = await plugin.ensureRegistered()
        return { ok: true, unitId: r.unitId, name: r.name }
      } catch (e) {
        const code = (e as { code?: unknown })?.code
        return { ok: false, code: typeof code === 'string' && code ? code : 'network' }
      }
    },
    unitForgetSelf: async () => {
      try {
        await plugin.forget({ remote: true })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
  }
}
