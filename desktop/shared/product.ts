/** Product identity is shared by desktop, browser projection, and the headless Unit. */
import full from '../products/forsion.json'

export interface ProductProfile {
  id: string
  displayName: string
  defaultSpace: string
  spaces: string[]
  agentBackend: boolean
  market: boolean
  unit?: boolean
  /** Deployed websites can enter their plugin workflow directly. */
  onboarding?: boolean
}

export function resolveProduct(build?: ProductProfile, runtime?: ProductProfile): ProductProfile {
  const profile: ProductProfile = build ?? runtime ?? full
  return { ...profile, unit: profile.unit ?? profile.agentBackend }
}
