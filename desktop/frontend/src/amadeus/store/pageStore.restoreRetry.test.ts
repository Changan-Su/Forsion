/** 断网冷启动后重开云端库(2026-11-09):restoreVault 记失败、迟到的结果作废、重开不顶掉正在看的笔记。
 *  界面层的重试时机(online / 再进笔记 / 在途时来的请求)由 mobile `npm run e2e:cloudnote` 场景 C 钉住。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

type Info = { root: string; pages: string[]; folders: string[]; lastPage?: string }
let pending: { ok: (i: Info | null) => void; fail: (e: Error) => void } | null = null
const bridge = {
  restoreVault: vi.fn(() => new Promise<Info | null>((ok, fail) => { pending = { ok, fail } })),
  listFiles: vi.fn(async () => [] as string[]),
  listPages: vi.fn(async () => [] as string[]),
  listFolders: vi.fn(async () => [] as string[]),
  loadPage: vi.fn(async () => { throw new Error('loadPage must not run') }),
  readTextFile: vi.fn(async () => { throw new Error('readTextFile must not run') }),
  writeTextFile: vi.fn(async () => { throw new Error('writeTextFile must not run') }),
  savePage: vi.fn(async () => { throw new Error('savePage must not run') }),
}

async function freshStore() {
  vi.resetModules()
  for (const fn of Object.values(bridge)) fn.mockClear()
  pending = null
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', { amadeus: bridge, addEventListener: () => {}, removeEventListener: () => {} })
  return import('./pageStore')
}
const info: Info = { root: 'cloud://default', pages: ['a.md', 'b.md'], folders: [], lastPage: 'a.md' }
const noWrites = () => {
  for (const fn of [bridge.loadPage, bridge.readTextFile, bridge.writeTextFile, bridge.savePage]) expect(fn).not.toHaveBeenCalled()
}

afterEach(() => { vi.unstubAllGlobals() })

describe('pageStore.restoreVault × 断网重开', () => {
  it('抛错且没装上库 → 记 vaultRestoreFailed;下一次成功清掉', async () => {
    const { usePageStore } = await freshStore()
    const first = usePageStore.getState().restoreVault()
    pending!.fail(new Error('HTTP 0'))
    await first
    expect(usePageStore.getState()).toMatchObject({ vaultRoot: null, vaultRestoreFailed: true, vaultLoading: false })
    const again = usePageStore.getState().restoreVault({ keepOpenNote: true })
    pending!.ok(info)
    await again
    expect(usePageStore.getState()).toMatchObject({ vaultRoot: 'cloud://default', vaultRestoreFailed: false })
  })

  it('返回 null(本地没选过库)不算失败', async () => {
    const { usePageStore } = await freshStore()
    const p = usePageStore.getState().restoreVault()
    pending!.ok(null)
    await p
    expect(usePageStore.getState().vaultRestoreFailed).toBe(false)
  })

  it('在途时切到了本地库:迟到的云端结果整份作废,不进店、不读不写(Codex 评审 P1)', async () => {
    const { usePageStore } = await freshStore()
    usePageStore.setState({ vaultSide: 'cloud' })
    const p = usePageStore.getState().restoreVault({ keepOpenNote: true })
    usePageStore.setState({ vaultSide: 'local', vaultRoot: null })
    pending!.ok(info)
    await p
    expect(usePageStore.getState().vaultRoot).toBeNull()
    noWrites()
  })

  it('在途时别处开了库:迟到的结果不覆盖它', async () => {
    const { usePageStore } = await freshStore()
    const p = usePageStore.getState().restoreVault()
    usePageStore.setState({ vaultRoot: '/local/vault', pages: ['x.md'] })
    pending!.ok(info)
    await p
    expect(usePageStore.getState()).toMatchObject({ vaultRoot: '/local/vault', pages: ['x.md'] })
    noWrites()
  })

  it('invalidateVaultRestore(换账号)让在途那一趟作废,失败也不记', async () => {
    const { usePageStore, invalidateVaultRestore } = await freshStore()
    const ok = usePageStore.getState().restoreVault()
    invalidateVaultRestore()
    pending!.ok(info)
    await ok
    expect(usePageStore.getState().vaultRoot).toBeNull()
    const bad = usePageStore.getState().restoreVault()
    invalidateVaultRestore()
    pending!.fail(new Error('HTTP 0'))
    await bad
    expect(usePageStore.getState().vaultRestoreFailed).toBe(false)
    noWrites()
  })

  it('keepOpenNote:已经开着一篇时装上库但不跳到 lastPage', async () => {
    const { usePageStore } = await freshStore()
    usePageStore.setState({ activeNotePath: 'b.md' })
    const p = usePageStore.getState().restoreVault({ keepOpenNote: true })
    pending!.ok(info)
    await p
    expect(usePageStore.getState()).toMatchObject({ vaultRoot: 'cloud://default', activeNotePath: 'b.md', pendingPage: null })
    noWrites()
  })
})
