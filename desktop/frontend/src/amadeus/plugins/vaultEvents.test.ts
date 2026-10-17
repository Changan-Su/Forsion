/**
 * ctx.app.onVaultEvent 的底座:清单比对出新建 / 删除;应用内改名只报一条 rename(不再叠一对删 / 建);
 * 外部改动报 modify(同一批同一文件只报一次);换库报 vault 而不是两个库的全量差;清单没装完不当基线;退订后安静。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let extCb: ((p: string) => void) | null = null
let fileCb: ((p: string) => void) | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// 每例都 resetModules 后重新求值 pageStore 整张图(~3s,全量并行时更久):这是真实成本,放宽超时,不是掩盖漏定时器。
vi.setConfig({ testTimeout: 20_000 })

async function fresh() {
  vi.resetModules()
  extCb = null
  fileCb = null
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    amadeus: {
      listPages: async () => [],
      onExternalChange: (cb: (p: string) => void) => { extCb = cb; return () => { extCb = null } },
      onFileExternalChange: (cb: (p: string) => void) => { fileCb = cb; return () => { fileCb = null } },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  const store = await import('../store/pageStore')
  const ev = await import('./vaultEvents')
  store.usePageStore.setState({ vaultRoot: '/v1', pages: ['a.md', 'dir/b.md'], files: ['x.pdf'], filesPendingFor: null })
  const got: unknown[][] = []
  const off = ev.subscribeVaultEvents((batch) => got.push(batch))
  return { ...store, off, got, set: (p: Record<string, unknown>) => store.usePageStore.setState(p) }
}

beforeEach(() => { vi.unstubAllGlobals() })
afterEach(() => { vi.unstubAllGlobals() })

describe('subscribeVaultEvents', () => {
  it('新建 / 删除按清单比对报;外部改动报 modify,同一批同一文件一次', async () => {
    const h = await fresh()
    h.set({ pages: ['a.md', 'dir/b.md', 'new.md'], files: [] })
    extCb!('a.md'); extCb!('a.md'); fileCb!('cfg.json')
    await sleep(260)
    expect(h.got).toEqual([[
      { kind: 'create', path: 'new.md' },
      { kind: 'delete', path: 'x.pdf' },
      { kind: 'modify', path: 'a.md' },
      { kind: 'modify', path: 'cfg.json' },
    ]])
    h.off()
  })

  it('应用内改名只报一条 rename;文件夹整棵挪是一条 folder rename', async () => {
    const h = await fresh()
    h.set({ pages: ['renamed.md', 'dir/b.md'] })
    h.remapScopePaths('a.md', 'renamed.md', 'file')
    await sleep(260)
    expect(h.got).toEqual([[{ kind: 'rename', path: 'renamed.md', from: 'a.md' }]])

    h.remapScopePaths('dir', 'moved', 'prefix') // 广播先到、清单后到(主进程结构刷新有防抖)也认
    await sleep(260)
    h.set({ pages: ['renamed.md', 'moved/b.md'] })
    await sleep(260)
    expect(h.got.slice(1)).toEqual([[{ kind: 'rename', path: 'moved', from: 'dir', folder: true }]])
    h.off()
  })

  it('换库只报 vault;新库清单没装完不当基线,装完的第一份也不报成新建', async () => {
    const h = await fresh()
    h.set({ vaultRoot: '/v2', pages: [], files: [], filesPendingFor: '/v2' })
    h.set({ pages: ['p.md'], files: ['q.png'], filesPendingFor: null })
    await sleep(260)
    expect(h.got).toEqual([[{ kind: 'vault' }]])
    h.set({ pages: ['p.md', 'r.md'] })
    await sleep(260)
    expect(h.got.slice(1)).toEqual([[{ kind: 'create', path: 'r.md' }]])
    h.off()
  })

  it('退订后不再回调,外部改动监听也摘掉', async () => {
    const h = await fresh()
    h.off()
    expect(extCb).toBeNull()
    h.set({ pages: ['zzz.md'] })
    await sleep(260)
    expect(h.got).toEqual([])
  })
})
