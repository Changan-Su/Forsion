/** Native UI implementations are shared code; installed packages grant activation. */
export const NATIVE_FEATURE_IDS = ['amadeus', 'tangu', 'calendar', 'automation', 'public'] as const
export type NativeFeatureId = typeof NATIVE_FEATURE_IDS[number]
export const NATIVE_FEATURE_SPACES: Readonly<Record<NativeFeatureId, readonly string[]>> = {
  amadeus: ['amadeus'], tangu: ['tangu'], calendar: ['calendar'], automation: ['automation'], public: ['public'],
}
export const isNativeFeatureId = (value: unknown): value is NativeFeatureId =>
  typeof value === 'string' && (NATIVE_FEATURE_IDS as readonly string[]).includes(value)
export function nativeFeatureSpaceIds(features: readonly NativeFeatureId[]): string[] {
  return [...new Set(features.flatMap((feature) => NATIVE_FEATURE_SPACES[feature]))]
}

/** An explicit installation list is authoritative, including an empty list.
 * Legacy products without this field keep their existing capability defaults. */
export function nativeFeatureEnabled(
  profile: { nativeFeatures?: readonly NativeFeatureId[]; spaces: readonly string[] },
  feature: NativeFeatureId,
  legacyEnabled = profile.spaces.includes(feature),
): boolean {
  return profile.nativeFeatures === undefined ? legacyEnabled : profile.nativeFeatures.includes(feature)
}
