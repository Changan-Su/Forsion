/** 文件列表「还在路上」的标记(filesPendingFor,2026-10-09):打开 / 恢复库时 pages 先上屏、files 晚一拍。
 *  这一拍里编辑器面板分不清「不在页面列表里的 .md」是新笔记还是归插件管的文件 —— 标记在,它就不挂编辑器
 *  (amadeus/lib/noteOwnership.ts)。契约:装载即立标记;列表落下才清;读失败不清(宁可等,不放行)。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteOwnership } from '../lib/noteOwnership'

let settle: { ok: (files: string[]) => void; fail: (e: Error) => void }

async function freshStore() {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    amadeus: {
      restoreVault: async () => ({ root: '/v', pages: [], folders: [], lastPage: null }),
      listFiles: () => new Promise<string[]>((ok, fail) => { settle = { ok, fail } }),
      listPages: async () => [],
      listFolders: async () => [],
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  return (await import('./pageStore')).usePageStore
}

afterEach(() => { vi.unstubAllGlobals() })

describe('pageStore.filesPendingFor', () => {
  it('恢复库:文件列表落下之前,不在页面列表里的 .md 归属待确认;落下之后按列表判', async () => {
    const store = await freshStore()
    await store.getState().restoreVault()
    expect(store.getState().filesPendingFor).toBe('/v')
    expect(noteOwnership('Bio.deck.md', store.getState())).toBe('pending')
    settle.ok(['Bio.deck.md'])
    await vi.waitFor(() => expect(store.getState().filesPendingFor).toBeNull())
    expect(noteOwnership('Bio.deck.md', store.getState())).toBe('plugin')
  })

  it('文件列表读失败:标记留着(不放行),之后任何一次成功的重列才清掉', async () => {
    const store = await freshStore()
    await store.getState().restoreVault()
    settle.fail(new Error('EIO'))
    await new Promise((r) => setTimeout(r, 0))
    expect(noteOwnership('Bio.deck.md', store.getState())).toBe('pending')
    const again = store.getState().refreshStructure()
    settle.ok(['Bio.deck.md'])
    await again
    expect(noteOwnership('Bio.deck.md', store.getState())).toBe('plugin')
  })
})
