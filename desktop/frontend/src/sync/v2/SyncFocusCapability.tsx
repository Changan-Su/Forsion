import { useEffect } from 'react'
import { amadeus } from '@amadeus/api'
import { useApp } from '../../stores/appStore'
import { vaultSync } from './client'
import { useSyncMode } from './mode'
import { canFocusDownload, cloudOnlyRows, folderHost, publishSyncFocus } from './vaultSurfaces'
import { useVaultSyncRaw } from '../vaultSyncStore'

/** Extend reads this in the main renderer, before it asks the settings window to focus a row. */
export function SyncFocusCapability() {
  const account = useApp((s) => s.authInfo?.loggedIn ? s.authInfo.accountId : null)
  const mode = useSyncMode((s) => s.mode)
  const status = useVaultSyncRaw((s) => s.v2)
  const bindings = status?.bindings.map((b) => b.id + ':' + b.root).join('\n')
  useEffect(() => {
    const ready = !!account && mode === 'full' && !!window.tangu?.openFloatingPanel && !!folderHost(amadeus) && !!amadeus?.vaultSyncActions?.().download
    if (!ready) { publishSyncFocus(false); return }
    let request = 0
    const check = async () => {
      const seq = ++request
      const [g, libs] = await Promise.all([vaultSync.get(), vaultSync.libraries()])
      if (seq !== request) return
      publishSyncFocus(g.ok && !!g.value && libs.ok && !!libs.value?.list && !libs.value.stale && canFocusDownload(g.value, cloudOnlyRows(g.value, libs.value.list.libraries), ready))
    }
    void check()
    window.addEventListener('focus', check)
    return () => {
      ++request
      publishSyncFocus(false)
      window.removeEventListener('focus', check)
    }
  }, [account, mode, bindings])
  return null
}
