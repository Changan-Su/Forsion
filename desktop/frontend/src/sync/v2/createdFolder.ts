import type { VaultCreated, VaultRollbackResult } from '@amadeus-shared/vaultCreate'

export interface CreatedFolderHost {
  /** Include disabled bindings. A read failure leaves the operation untouched. */
  boundRoots(): Promise<string[] | null>
  rollback(operationId: string): Promise<VaultRollbackResult>
  samePath?(a: string, b: string): boolean
}

export type DiscardOutcome = VaultRollbackResult | 'kept_not_created' | 'kept_bound' | 'kept_bindings_unknown'

export const discardRemoved = (outcome: DiscardOutcome): boolean => outcome === 'removed' || outcome === 'removed_still_listed'

/** The host owns both the directory and registry checks for this operation. */
export async function discardCreatedFolder(host: CreatedFolderHost, folder: VaultCreated): Promise<DiscardOutcome> {
  if (!folder.created && !folder.registered) return 'kept_not_created'
  const same = host.samePath ?? ((a: string, b: string) => a === b)
  const bound = await host.boundRoots().catch(() => null)
  if (!bound) return 'kept_bindings_unknown'
  if (bound.some((root) => same(root, folder.root))) return 'kept_bound'
  return host.rollback(folder.operationId).catch(() => 'kept_remove_failed')
}
