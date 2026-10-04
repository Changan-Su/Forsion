/** Baked into the app; changing the launch environment cannot change its update variant. */
declare const __FORSION_BUNDLE_EXTEND__: boolean | undefined
export const BUNDLE_EXTEND = typeof __FORSION_BUNDLE_EXTEND__ === 'undefined' ? true : __FORSION_BUNDLE_EXTEND__
