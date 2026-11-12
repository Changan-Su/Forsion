import { expect, it } from 'vitest'
import { vaultClipboardPath } from './vaultClipboardPath'

it('resolves local note paths without inventing cloud filesystem paths', () => {
  expect(vaultClipboardPath('/Users/me/Notes/', 'MOC.fd/Forsion.md')).toBe('/Users/me/Notes/MOC.fd/Forsion.md')
  expect(vaultClipboardPath('C:\\Notes', 'MOC.fd/Forsion.md')).toBe('C:\\Notes\\MOC.fd\\Forsion.md')
  expect(vaultClipboardPath('\\\\server\\notes', 'A.md')).toBe('\\\\server\\notes\\A.md')
  expect(vaultClipboardPath('/', 'A.md')).toBe('/A.md')
  expect(vaultClipboardPath('cloud://account/vault', 'A.md')).toBeNull()
  expect(vaultClipboardPath('/notes', '../A.md')).toBeNull()
})
