import { useState, type ReactNode } from 'react'
import type { ViewProps } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { ViewContribution } from '@amadeus/plugins/types'
import { claimedHostView } from '../../../shared/corePlugins'
import { PluginViewHost } from '../pluginViews'

/** Keep native identity/layout. Missing or failed plugin renderers use the native fallback. */
export function CoreViewSlot({ type, fallback, ...props }: ViewProps & { type: string; fallback: ReactNode }) {
  const claim = usePluginStore((s) => claimedHostView(s, type))
  const [failed, setFailed] = useState<ViewContribution | null>(null)
  return claim && claim.item !== failed
    ? <PluginViewHost def={claim.item} pluginId={claim.pluginId} onMountError={() => setFailed(claim.item)} {...props} />
    : fallback
}
