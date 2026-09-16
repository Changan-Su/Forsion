import { PRODUCT } from '../product'
import { nativeFeatureEnabled, type NativeFeatureId } from '../../../shared/nativeFeatures'

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
