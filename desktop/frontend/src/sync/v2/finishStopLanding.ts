import type { AmadeusApi, LocalVaultRow } from '@amadeus-shared/ipc'
import type { BindingView } from './types'

export function stopLocalPlan(rows: LocalVaultRow[], root: string, openRoot: string | null) {
  const row = rows.find((v) => v.root === root)
  const current = row?.current || openRoot === root
  const fallback = current ? rows.find((v) => v.root !== root && v.exists) : undefined
  return { row, current, fallback, blocked: !!current && !fallback }
}

export function stopBindingIdentity(binding: BindingView): string {
  const target = binding.target
  if (target.kind !== 'penzor') return ''
  return JSON.stringify([binding.id, binding.root, target.vaultId, target.prefix, target.placement,
    binding.generation, binding.scope, binding.role, binding.enabled, binding.paused, binding.state, binding.renamedFrom])
}

const pinProblem = (outcome: string): string | null => outcome === 'moved' || outcome === 'unchanged' ? null : outcome

/** Check the local handoff and its prospective pin without writing either. */
export async function prepareStopLanding(api: AmadeusApi, root: string, openRoot: string | null): Promise<string | null> {
  if (!api.listVaults || !api.forgetVault || !api.moveSyncVaultPin) return 'channel_missing'
  try {
    const plan = stopLocalPlan(await api.listVaults(), root, openRoot)
    if (plan.blocked) return 'local-vault-unavailable'
    if (!plan.row) return 'vault_list_unreadable'
    if (!plan.row.pinned) return null
    return pinProblem(await api.moveSyncVaultPin(root, { checkOnly: true, ...(plan.fallback ? { nextRoot: plan.fallback.root } : {}) }))
  } catch { return 'vault_list_unreadable' }
}

/** Only a committed unbind may reach this path. Re-read the local state before acting. */
export async function finishStopLanding(
  api: AmadeusApi, root: string, currentRoot: () => string | null, switchVault: (root: string) => Promise<void>,
): Promise<string | null> {
  if (!api.listVaults || !api.moveSyncVaultPin) return 'channel_missing'
  try {
    const plan = stopLocalPlan(await api.listVaults(), root, currentRoot())
    if (plan.blocked) return 'local-vault-unavailable'
    if (!plan.row) return 'vault_list_unreadable'
    if (plan.fallback) await switchVault(plan.fallback.root)
    const fresh = plan.fallback ? (await api.listVaults()).find((v) => v.root === root) : plan.row
    if (!fresh) return 'vault_list_unreadable'
    if (fresh.current || currentRoot() === root) return 'vault-switch-failed'
    return fresh.pinned ? pinProblem(await api.moveSyncVaultPin(root)) : null
  } catch { return 'vault-switch-failed' }
}
