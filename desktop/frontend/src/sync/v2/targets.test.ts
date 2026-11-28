// 「同步到哪」的去处(网盘 / 本地文件夹)辅助:错误码取法、文案键、预演沿用的去处、读不到 ≠ 没有
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addFolderTarget, codeOf, currentTargetKey, listTargets, previewTargetOf, targetErrorKey, TARGET_ERROR_CODES } from './targets'
import type { BindingView } from './types'

const binding = (target: BindingView['target']): BindingView => ({
  id: 'b1', root: '/v', name: 'v', enabled: true, paused: false, state: 'active', role: 'primary', target,
  scope: { mode: 'all' }, status: { phase: 'idle', lastSyncAt: null, pendingChanges: 0, held: 0, deletesPending: 0, failures: 0 },
} as unknown as BindingView)

afterEach(() => { vi.unstubAllGlobals() })

describe('sync targets', () => {
  it('takes the trailing error code from an IPC error', () => {
    expect(codeOf(new Error("Error invoking remote method 'remotesync:targets:save': Error: folder-overlaps-vault"))).toBe('folder-overlaps-vault')
    expect(codeOf('auth-timeout')).toBe('auth-timeout')
    expect(codeOf(new Error('boom'))).toBe('unknown')
  })
  it('maps known codes to their own key and never leaks an unknown code as a key', () => {
    for (const c of TARGET_ERROR_CODES) expect(targetErrorKey(c)).toBe(`ssync.targetErr.${c}`)
    expect(targetErrorKey('something-else')).toBe('ssync.targetErr.unknown')
  })
  it('previews a drive row against its own target, not Penzor Cloud', () => {
    const remote = binding({ kind: 'remote', targetId: 't1', backend: 'dropbox', label: 'Box', dir: 'v', direction: 'both', conditionalWrites: true })
    expect(previewTargetOf(remote)).toEqual({ kind: 'remote', targetId: 't1', dir: 'v', direction: 'both' })
    expect(currentTargetKey(remote)).toBe('t1')
    const penzor = binding({ kind: 'penzor', vaultId: 'x', vaultName: 'v', placement: 'own', prefix: 'Amadeus/' })
    expect(previewTargetOf(penzor)).toEqual({ kind: 'penzor' })
    expect(currentTargetKey(penzor)).toBe('penzor')
  })
  it('treats an unreadable target list as unknown (null), not as no targets', async () => {
    vi.stubGlobal('window', { remoteSync: { targets: { list: () => Promise.reject(new Error('read failed')), save: vi.fn() } } })
    expect(await listTargets()).toBeNull()
    vi.stubGlobal('window', {})
    expect(await listTargets()).toBeNull()
  })
  it('returns the host code when saving a folder target fails', async () => {
    vi.stubGlobal('window', { remoteSync: { targets: { list: vi.fn(), save: () => Promise.reject(new Error("Error invoking remote method 'x': Error: folder-overlaps-vault")) } } })
    expect(await addFolderTarget('/tmp/x')).toEqual({ ok: false, error: 'folder-overlaps-vault' })
  })
})
