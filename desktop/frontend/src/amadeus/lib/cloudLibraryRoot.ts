import { onlineVaultRoot } from '@amadeus-shared/ipc'

/** Online note and plugin storage use the same identity as the host. */
export function cloudLibraryRoot(vaultId: string, libraryId: string): string {
  return onlineVaultRoot({ vaultId, libraryId })
}

/** 这个根是不是这个库(vaultId)的某一个视图:与我共享 / 只读判断只认库,不认视图。老形状 `cloud://<vaultId>` 也认。 */
export function isCloudRootOfVault(root: string | null | undefined, vaultId: string): boolean {
  if (!root || !vaultId) return false
  const head = cloudLibraryRoot(vaultId, vaultId)
  return root === head || root.startsWith(`${head}/`)
}
