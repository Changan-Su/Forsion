// @vitest-environment happy-dom
// 「→工作区」同名的第二份不进草稿:两份落在工作区同一路径,移除其中一个会把另一个的文件删掉(Codex 评审 P1)。
import { expect, it, vi } from 'vitest'
import { addDraftFile, removeDraftFile } from './composerUploads'
import { useComposerDrafts } from './composerDrafts'
import * as api from '../../services/backendService'
vi.mock('../../services/backendService', () => ({
  uploadWorkspaceFiles: vi.fn(async () => ({ success: true, saved: 1, total: 1, errors: [] })),
  deleteWorkspaceFile: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../services/engine/targets', () => ({ targetForSession: () => ({ key: 'home' }) }))

it('refuses a second same-name workspace file; images may repeat', () => {
  const f = () => new File([new Uint8Array(4)], 'report.pdf', { type: 'application/pdf' })
  expect(addDraftFile('k', 'wsFiles', f(), 's1')).toBe(true)
  expect(addDraftFile('k', 'wsFiles', f(), 's1')).toBe(false)
  expect(useComposerDrafts.getState().k.wsFiles).toHaveLength(1)
  const img = () => new File([new Uint8Array(4)], 'image.png', { type: 'image/png' })
  expect(addDraftFile('k', 'attachments', img(), null)).toBe(true)
  expect(addDraftFile('k', 'attachments', img(), null)).toBe(true)
  // 移除后同名可以再加
  removeDraftFile('k', 'wsFiles', useComposerDrafts.getState().k.wsFiles[0])
  expect(addDraftFile('k', 'wsFiles', f(), 's1')).toBe(true)
  expect(api.deleteWorkspaceFile).not.toHaveBeenCalled() // 移除时还没传上去:不去删
})
