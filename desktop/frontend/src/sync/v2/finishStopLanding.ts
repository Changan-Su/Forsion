import type { AmadeusApi, LocalVaultRow } from '@amadeus-shared/ipc'
import type { BindingView } from './types'

export function stopLocalPlan(rows: LocalVaultRow[], root: string, openRoot: string | null) {
  const row = rows.find((v) => v.root === root)
  const current = row?.current || openRoot === root
  const fallback = current ? rows.find((v) => v.root !== root && v.exists) : undefined
  return { row, current, fallback, blocked: !!current && !fallback }
}

export async function prepareStopLanding(
  api: AmadeusApi, binding: BindingView, currentRoot: () => string | null, switchVault: (root: string) => Promise<void>,
): Promise<string | null> {
  if (!api.listVaults || !api.forgetVault || !api.moveSyncVaultPin) return 'channel_missing'
  try {
    const plan = stopLocalPlan(await api.listVaults(), binding.root, currentRoot())
    if (plan.blocked) return 'local-vault-unavailable'
    if (!plan.row) return 'vault_list_unreadable'
    // Check the explicit pin before switching where possible, so old sync can block without changing the active vault.
    if (plan.row?.pinned && !plan.current) {
      const moved = await api.moveSyncVaultPin(binding.root)
      return moved === 'moved' || moved === 'unchanged' ? null : moved
    }
    if (plan.fallback) {
      await switchVault(plan.fallback.root)
      const fresh = (await api.listVaults()).find((v) => v.root === binding.root)
      if (!fresh) return 'vault_list_unreadable'
      if (fresh.current || currentRoot() === binding.root) return 'vault-switch-failed'
      if (fresh.pinned) {
        const moved = await api.moveSyncVaultPin(binding.root)
        if (moved !== 'moved' && moved !== 'unchanged') return moved
      }
    }
    return null
  } catch { return 'vault-switch-failed' }
}
