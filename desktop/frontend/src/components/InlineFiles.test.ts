import { describe, expect, it, vi } from 'vitest'
import { targetFor } from './InlineFiles'
import * as api from '../services/backendService'
import { targetForSession } from '../services/engine/targets'

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
    // P1-K6 S3:目标按**来源会话**解析(targetForSession),不再传整份 cfg。目标是活对象(base / 头现读宿主),
    // 按对象身份比,别让深比较去读 getter(本测没装宿主)。
    const read = vi.mocked(api.readWorkspaceFile).mock.calls
    const down = vi.mocked(api.downloadWorkspaceFile).mock.calls
    expect(read[0][0]).toBe(targetForSession('child'))
    expect(read[0].slice(1)).toEqual(['child', 'report.txt'])
    expect(down[0][0]).toBe(targetForSession('child'))
    expect(down[0].slice(1)).toEqual(['child', 'report.txt'])
    await targetFor({ name: 'own.txt', path: 'own.txt' }, cfg, 'parent', 'sandbox').load()
    expect(read[read.length - 1][0]).toBe(targetForSession('parent'))
    expect(read[read.length - 1].slice(1)).toEqual(['parent', 'own.txt'])
  })
})
