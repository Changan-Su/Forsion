import icon from '../assets/forsion-logo-arioso.png?inline'
import splash from '../assets/forsion-startup-arioso.webp?inline'
import type { AppearancePreset } from '../../../shared/startupAppearance'

/** Optional first-party artwork. A null selection still means the original tree mark. */
export const BUILTIN_APPEARANCES: (AppearancePreset & { key: string })[] = [
  { id: 'arioso', key: 'builtin:arioso', label: 'Arioso', labelEn: 'Arioso', icon, splash },
]
