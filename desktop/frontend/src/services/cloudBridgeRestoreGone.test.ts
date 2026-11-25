/**
 * 在线库冷启动「读到 404 ≠ 新建」仪器(2026-11-25)。
 * 事故形态:网页 / 手机 / 进岛的桌面窗口(都挂 web/src/amadeus/cloudBridge)冷启动走树快照,快照还列着上次看的那篇,
 * 它却已在别的设备上删掉了 —— restoreVault → loadPage(lastPage) → 在线桥把 GET 404 当「打开即创建」,
 * 按 baseSeq 0 在被删的路径上写回一篇空笔记(本会话从没见过这条路径,everKnown 守卫拦不住)。
 * 契约(与桌面主进程 loadPage 的 createIfMissing:false 对齐):读只读,404 = 这篇不存在,不写盘;新建只走显式入口
 * (birthNoteFile → writeTextFile create:true、bridge.newPage)。restoreVault 读不到上次那篇 → 刷新树(顺带重写快照)、
 * 回落到第一篇还在的笔记,没有就空态,不挂「加载失败」。
 * 负对照(实跑过):main 上(loadOrCreate 404 → createViaCompiler)第 1 条红在 PUT gone.md、第 2 条红在 loadPage 照建。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeES {
  onopen: (() => void) | null = null
  constructor(readonly url: string) {}
  addEventListener(): void { /* 本仪器不推事件 */ }
  close(): void { /* noop */ }
}

const jwt = `header.${btoa(JSON.stringify({ userId: 'u' }))}.signature`
/** 假服务端的文本行:path → { content, seq }。 */
const rows = new Map<string, { content: string; seq: number }>()
const puts: Array<{ path: string; baseSeq: number }> = []
let storage = new Map<string, string>()
const aborts: AbortController[] = []
/** 故障注入:这些路径的 GET /file 答 500(读失败,不是不存在);treeDown 时 GET /tree 答 500。 */
const fileDown = new Set<string>()
let treeDown = false

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  rows.clear(); puts.length = 0; storage = new Map(); fileDown.clear(); treeDown = false
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
  })
  vi.stubGlobal('location', { origin: 'https://cloud.test', reload: vi.fn() })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const end = url.pathname.split('/').pop()
    if (end === 'vaults') return json(200, { vaults: [{ id: 'v1' }] })
    if (end === 'tree' && treeDown) return json(500, { error: 'boom' })
    if (end === 'tree') return json(200, { pages: [...rows.keys()].sort(), files: [], folders: [], seq: 1 })
    if (end === 'file' && method === 'PUT') {
      const req = JSON.parse(String(init?.body)) as { path: string; content: string; baseSeq: number }
      puts.push({ path: req.path, baseSeq: req.baseSeq })
      const cur = rows.get(req.path)
      if (req.baseSeq === 0 && cur) return json(409, { code: 'EXISTS', seq: cur.seq })
      if (req.baseSeq !== 0 && cur?.seq !== req.baseSeq) return json(409, { code: 'CONFLICT', seq: cur?.seq ?? 0 })
      const seq = (cur?.seq ?? 0) + 1
      rows.set(req.path, { content: req.content, seq })
      return json(200, { path: req.path, seq })
    }
    if (end === 'file') {
      const path = url.searchParams.get('path') ?? ''
      if (fileDown.has(path)) return json(500, { error: 'boom' })
      const r = rows.get(path)
      if (!r) return json(404, { error: 'not found' })
      return json(200, { path, content: r.content, seq: r.seq, hash: `h${r.seq}` })
    }
    if (end === 'asset-token') return json(200, { token: 't', ttlSec: 600 })
    if (end === 'link-base') return json(200, { webOrigin: 'https://cloud.test' })
    return json(200, {})
  }))
})
afterEach(() => {
  for (const a of aborts.splice(0)) a.abort()
  vi.unstubAllGlobals()
})

/** 一次「冷启动」:模块全新(桥的 everKnown / seq / 缓存都是空的),localStorage 沿用上一次会话留下的。 */
async function coldStart() {
  vi.resetModules()
  const win = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true } as Record<string, unknown>
  vi.stubGlobal('window', win)
  const { createCloudAmadeusBridge } = await import('../../../../web/src/amadeus/cloudBridge')
  const ac = new AbortController()
  aborts.push(ac)
  const bridge = createCloudAmadeusBridge({ apiBase: 'https://cloud.test/api', getToken: () => jwt, onAuthError: vi.fn(), signal: ac.signal })
  win.amadeus = bridge
  const { usePageStore } = await import('../amadeus/store/pageStore')
  return { bridge, usePageStore }
}

const page = (title: string): string => `# ${title}\n\nbody of ${title}\n`

describe('cloud vault cold start: a 404 read never creates', () => {
  it('lastPage deleted elsewhere but still in the tree snapshot: no PUT, falls back to a live page, tree refreshed', async () => {
    rows.set('gone.md', { content: page('gone'), seq: 3 })
    rows.set('keep.md', { content: page('keep'), seq: 1 })
    // 第一次会话:装库(落树快照)、打开 gone.md(落 lastPage)
    {
      const { usePageStore } = await coldStart()
      await usePageStore.getState().restoreVault()
      await usePageStore.getState().loadPage('gone.md')
      expect(usePageStore.getState().activePage).toBe('gone.md')
    }
    // 别的设备删掉了 gone.md;本机的快照与 lastPage 还是旧的
    rows.delete('gone.md')
    puts.length = 0

    const { usePageStore } = await coldStart()
    await usePageStore.getState().restoreVault()

    expect(puts).toEqual([]) // 一次写都没有:被删的路径上没有冒出空笔记
    expect(rows.has('gone.md')).toBe(false)
    const s = usePageStore.getState()
    expect(s.activePage).toBe('keep.md') // 回落到还在的那篇
    expect(s.error).toBeNull()
    expect(s.pages).not.toContain('gone.md') // 树刷新过,幽灵条目从侧栏消失
    // 快照也重写过:再冷启动一次,lastPage 已不在快照里,直接开 keep.md,仍零写
    const again = await coldStart()
    await again.usePageStore.getState().restoreVault()
    expect(again.usePageStore.getState().activePage).toBe('keep.md')
    expect(puts).toEqual([])
  })

  it('every page in the stale snapshot is gone: empty state, no error, no PUT', async () => {
    rows.set('gone.md', { content: page('gone'), seq: 1 })
    {
      const { usePageStore } = await coldStart()
      await usePageStore.getState().restoreVault()
      await usePageStore.getState().loadPage('gone.md')
    }
    rows.delete('gone.md')
    puts.length = 0
    const { usePageStore } = await coldStart()
    await usePageStore.getState().restoreVault()
    expect(puts).toEqual([])
    expect(usePageStore.getState()).toMatchObject({ activePage: null, error: null, pages: [] })
  })
})

describe('cloud vault cold start: a failed read is not "gone" (读失败 ≠ 不存在)', () => {
  /** 第一次会话开 a.md(落快照 + lastPage),第二次冷启动前注入故障。 */
  const seed = async () => {
    rows.set('a.md', { content: page('a'), seq: 1 })
    rows.set('b.md', { content: page('b'), seq: 1 })
    const { usePageStore } = await coldStart()
    await usePageStore.getState().restoreVault()
    await usePageStore.getState().loadPage('a.md')
    puts.length = 0
  }

  it('lastPage read fails (500) but the fresh tree still lists it: keep the error for retry, no fallback, no PUT', async () => {
    await seed()
    fileDown.add('a.md')
    const { usePageStore } = await coldStart()
    await usePageStore.getState().restoreVault()
    const s = usePageStore.getState()
    expect(s.activePage).toBeNull() // 没被换成 b.md
    expect(s.error).toMatch(/500|boom/)
    expect(s.pages).toEqual(['a.md', 'b.md'])
    expect(puts).toEqual([])
  })

  it('lastPage read fails and the tree cannot be fetched either: unknown → keep error and the snapshot pages, no PUT', async () => {
    await seed()
    fileDown.add('a.md'); treeDown = true
    const { usePageStore } = await coldStart()
    await usePageStore.getState().restoreVault()
    const s = usePageStore.getState()
    expect(s.activePage).toBeNull()
    expect(s.error).toMatch(/500|boom/)
    expect(s.pages).toEqual(['a.md', 'b.md']) // 列表读失败不当空,侧栏照旧
    expect(puts).toEqual([])
  })
})

describe('cloud bridge: read paths are read-only, creation is explicit', () => {
  it('loadPage / reconcilePage on a never-seen 404 reject with "not found" and write nothing', async () => {
    const { bridge } = await coldStart()
    await bridge.restoreVault()
    await expect(bridge.loadPage('missing.md')).rejects.toThrow(/not found/i)
    await expect(bridge.reconcilePage('missing.md', { title: 'x', blocks: [] } as never, {})).rejects.toThrow(/not found/i)
    expect(puts).toEqual([])
    expect(rows.has('missing.md')).toBe(false)
  })

  it('explicit creation still works: newPage and writeTextFile(create) PUT with baseSeq 0, then loadPage reads it', async () => {
    const { bridge } = await coldStart()
    await bridge.restoreVault()
    await bridge.newPage('made.md')
    expect(puts).toEqual([{ path: 'made.md', baseSeq: 0 }])
    await bridge.writeTextFile('born.md', '', { create: true })
    expect(puts[1]).toEqual({ path: 'born.md', baseSeq: 0 })
    await expect(bridge.loadPage('born.md')).resolves.toHaveProperty('manifest')
    expect(puts).toHaveLength(2)
  })
})
