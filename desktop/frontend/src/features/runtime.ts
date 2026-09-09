import { PRODUCT } from '../product'
import { nativeFeatureEnabled, type NativeFeatureId } from '../../../shared/nativeFeatures'

export const hasNativeFeature = (feature: NativeFeatureId): boolean => nativeFeatureEnabled(PRODUCT, feature)
/** Legacy hosts expose editor helpers wherever a vault bridge exists. A Unit's
 * plugin-data bridge alone must not activate the Amadeus editing capability. */
export const amadeusAvailable = (): boolean => !!window.amadeus && nativeFeatureEnabled(PRODUCT, 'amadeus', true)
export const miniFeatureAvailable = (feature: NativeFeatureId): boolean => nativeFeatureEnabled(PRODUCT, feature, true)

export const sessionsAvailable = (): boolean => nativeFeatureEnabled(PRODUCT, 'tangu', true)
