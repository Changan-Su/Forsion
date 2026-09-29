import { PRODUCT } from '../product'
import { nativeFeatureEnabled, type NativeFeatureId } from '../../../shared/nativeFeatures'
import { remoteTargetsSupported } from '../services/engine/targets' // P1-K7a

export const hasNativeFeature = (feature: NativeFeatureId): boolean => nativeFeatureEnabled(PRODUCT, feature)
/** Legacy hosts expose editor helpers wherever a vault bridge exists. A Unit's
 * plugin-data bridge alone must not activate the Amadeus editing capability. */
export const amadeusAvailable = (): boolean => !!window.amadeus && nativeFeatureEnabled(PRODUCT, 'amadeus', true)
export const miniFeatureAvailable = (feature: NativeFeatureId): boolean => nativeFeatureEnabled(PRODUCT, feature, true)

export const sessionsAvailable = (): boolean => nativeFeatureEnabled(PRODUCT, 'tangu', true)

/** Inbox and Muse are faces of the local Tangu backend (`/agent/inbox`, `/agent/special/muse`).
 * Legacy profiles opt in through `spaces`; a Unit host empties `spaces` and grants both with the
 * tangu package. Both still need a local engine: a cloud-only Unit or the web shim has no backendStatus. */
const tanguLocalFace = (space: 'inbox' | 'muse'): boolean => nativeFeatureEnabled(PRODUCT, 'tangu', PRODUCT.spaces.includes(space))
export const inboxAvailable = (): boolean => tanguLocalFace('inbox') && !!(window.tangu?.backendStatus || window.tangu?.mobile)
export const museAvailable = (): boolean => tanguLocalFace('muse') && !!window.tangu?.backendStatus

// P1-K7a ── 跨设备会话聚合 / 「在哪运行」选择器的两道闸(规格 K7 §3.9;INTEGRATION K7 U1 / U2 缺省)
// ⚠️ 门控字面量逐字写成 `window.tangu?.X`(platform-parity 的 D 段靠正则扫它)。
/** 名册可读(设备分组要列哪些电脑):手机 App / 桌面有 unitsList;网页版与设备页没有。设备页**无条件**关(§4.7 b6:不得经 A 的隧道再驱动 B)。 */
export const rosterAvailable = (): boolean => !!window.tangu?.unitsList && !window.tangu?.unitPage
/** 选择器、设备分组、逐台拉会话列表:名册可读 **且** 这一端能把会话建到别的电脑上(K6:只有手机 / 网页版,且已登录)。
 *  桌面主窗口(K7 U1)、网页版(U2,无名册)、设备页恒 false。 */
export const runLocationsAvailable = (): boolean => rosterAvailable() && remoteTargetsSupported()
