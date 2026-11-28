import type { AmadeusApi } from '@amadeus-shared/ipc'
import { vaultDirName } from '@amadeus-shared/vaultCreate'
import { libraryDeviceNames } from '@amadeus-shared/libraryDevices'
import { vaultSync } from './client'
import type { BindingView, CloudVaultView, LibraryInfo, VaultSyncGet } from './types'
import type { CreatedFolderHost } from './createdFolder'
import type { DownloadLibrary } from './download'

export function folderHost(api: AmadeusApi | undefined) {
  if (!api?.vaultCreate || !api.vaultDefaultParent || !api.vaultEnsureDefaultParent || !api.vaultRollback) return null
  const folder: CreatedFolderHost = {
    rollback: api.vaultRollback,
    async boundRoots() {
      const r = await vaultSync.get()
      return r.ok && r.value?.mode === 'full' && Array.isArray(r.value.bindings) ? r.value.bindings.map((b) => b.root) : null
    },
  }
  return { vaultCreate: api.vaultCreate, parent: api.vaultDefaultParent, ensureParent: api.vaultEnsureDefaultParent, folder }
}

/** Landing never changes the cloud name, even when the host would trim it. */
export const validLandingName = (name: string): boolean => vaultDirName(name) === name

export function bindingLibraryId(binding: BindingView): string | undefined {
  if (binding.target.kind !== 'penzor') return undefined
  const { placement, prefix, vaultId } = binding.target
  return placement === 'legacy-entry' ? vaultId + ':' + prefix : vaultId
}

export function occupiedLibraryIds(data: VaultSyncGet): Set<string> {
  const bound = new Set(data.bindings.map(bindingLibraryId).filter((id): id is string => !!id))
  for (const v of data.localVaults) if (v.libraryId && !data.bindings.some((b) => b.root === v.root)) bound.add(v.libraryId)
  return bound
}

export type CloudRow = DownloadLibrary & { libraryId?: string; files?: number | null; bytes?: number; devices: number; deviceNames?: string[] }
export function libraryRow(lib: LibraryInfo): CloudRow {
  const deviceNames = libraryDeviceNames(lib)
  return { ...lib, libraryId: lib.id, devices: deviceNames.length, deviceNames }
}
export function cloudViewRow(v: CloudVaultView): CloudRow {
  return { ...v, id: v.libraryId ?? v.id }
}

export function cloudOnlyRows(data: VaultSyncGet, libraries: readonly LibraryInfo[] | null): CloudRow[] {
  const occupied = occupiedLibraryIds(data)
  const rows = libraries ? libraries.filter((lib) => !lib.deleted).map(libraryRow) : (data.cloudVaults ?? []).map(cloudViewRow)
  return rows.filter((row) => !occupied.has(row.id))
}

export function canFocusDownload(data: VaultSyncGet, rows: CloudRow[], ready: boolean): boolean {
  return ready && data.mode === 'full' && rows.some((row) => row.libraryId && row.kind !== 'default' && validLandingName(row.name))
}

export function publishSyncFocus(enabled: boolean): void {
  const g = globalThis as typeof globalThis & { __forsionSyncFocus?: number }
  if (enabled) g.__forsionSyncFocus = 1
  else delete g.__forsionSyncFocus
}
