export const VAULT_CREATE_IPC = {
  parent: 'vaults:default-parent',
  create: 'vaults:register-folder',
  empty: 'vaults:is-empty-folder',
  remove: 'vaults:remove-empty-folder',
  hashes: 'vaults:hash-files',
  movePin: 'vaults:move-sync-pin',
  settingsRequest: 'vaults:settings-request',
  settingsRelay: 'vaults:settings-relay',
  settingsResult: 'vaults:settings-result',
} as const

export interface VaultCreateArgs {
  parent?: string
  name: string
  existing: 'reuse' | 'refuse'
}

export type MoveVaultPinResult = 'moved' | 'unchanged' | 'local-vault-unavailable' | 'legacy-remotesync-not-paused'

/** Use exactly the same filesystem naming rule in the dialogs and the host. */
export function vaultDirName(name: unknown): string | null {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n.length > 80 || n.startsWith('.') || /[/\\:*?"<>|\u0000-\u001f]/.test(n)) return null
  return n
}
