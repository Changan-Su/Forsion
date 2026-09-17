import { describe, expect, it, vi } from 'vitest'
import { targetFor } from './InlineFiles'
import * as api from '../services/backendService'

vi.mock('../services/backendService', () => ({
  readWorkspaceFile: vi.fn(async () => ({ content: 'b2s=', mimeType: 'text/plain', size: 2 })),
  downloadWorkspaceFile: vi.fn(async () => {}),
}))

describe('forwarded file provenance', () => {
  it('previews and downloads against the source session, with parent fallback for ordinary files', async () => {
    const cfg = {} as any
    const target = targetFor({ name: 'report.txt', path: 'report.txt', sourceSessionId: 'child' }, cfg, 'parent', 'sandbox')
    await target.load()
    target.download?.()
    expect(api.readWorkspaceFile).toHaveBeenCalledWith(cfg, 'child', 'report.txt')
    expect(api.downloadWorkspaceFile).toHaveBeenCalledWith(cfg, 'child', 'report.txt')
    await targetFor({ name: 'own.txt', path: 'own.txt' }, cfg, 'parent', 'sandbox').load()
    expect(api.readWorkspaceFile).toHaveBeenLastCalledWith(cfg, 'parent', 'own.txt')
  })
})
