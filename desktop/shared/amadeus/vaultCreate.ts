export const VAULT_CREATE_IPC = {
  hashes: 'vaults:hash-files',
  request: 'vaults:folder-request',
  status: 'vaults:folder-status',
  relay: 'vaults:folder-relay',
  accept: 'vaults:folder-accept',
} as const

export interface VaultCreateArgs {
  parent?: string
  name: string
  existing: 'reuse' | 'refuse'
}

export type MoveVaultPinResult = 'moved' | 'unchanged' | 'local-vault-unavailable' | 'legacy-remotesync-not-paused'

export interface VaultCreated {
  root: string
  created: boolean
  registered: boolean
  operationId: string
}

export interface VaultDefaultLocation { path: string; exists: boolean; freeBytes: number | null }

export type VaultRollbackResult = 'removed' | 'removed_still_listed' | 'unregistered' | 'kept_in_use'
  | 'kept_not_empty' | 'kept_unreadable' | 'kept_remove_failed' | 'kept_adopted'

export interface VaultPinCheck { checkOnly: true; nextRoot?: string }

export type VaultFolderRequest =
  | { kind: 'parent' | 'ensureParent' }
  | { kind: 'create'; args: VaultCreateArgs }
  | { kind: 'rollback'; operationId: string }
  | { kind: 'movePin'; root: string; check?: VaultPinCheck }

export type VaultFolderStatus =
  | { state: 'pending' }
  | { state: 'ok'; value: unknown }
  | { state: 'failed'; error: string }

/** Use exactly the same filesystem naming rule in the dialogs and the host. */
export function vaultDirName(name: unknown): string | null {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n.length > 80 || n.startsWith('.') || /[/\\:*?"<>|\u0000-\u001f]/.test(n)) return null
  return n
}
