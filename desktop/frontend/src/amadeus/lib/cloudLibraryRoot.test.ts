import { describe, expect, it } from 'vitest'
import { onlineVaultRoot } from '@amadeus-shared/ipc'
import { cloudLibraryRoot, isCloudRootOfVault } from './cloudLibraryRoot'

describe('cloud library roots', () => {
  it('keeps the pre-library root for a whole vault', () => {
    expect(cloudLibraryRoot('vault', 'vault')).toBe('cloud://vault')
    expect(onlineVaultRoot({ vaultId: 'vault', libraryId: 'vault' })).toBe('cloud://vault')
  })

  it('shares the unescaped legacy root with the host and keeps vault matching exact', () => {
    const libraryId = 'vault:Amadeus/My Notes/'
    const root = cloudLibraryRoot('vault', libraryId)
    expect(root).toBe('cloud://vault/vault:Amadeus/My Notes/')
    expect(onlineVaultRoot({ vaultId: 'vault', libraryId })).toBe(root)
    expect(isCloudRootOfVault(root, 'vault')).toBe(true)
    expect(isCloudRootOfVault(root, 'va')).toBe(false)
  })
})
