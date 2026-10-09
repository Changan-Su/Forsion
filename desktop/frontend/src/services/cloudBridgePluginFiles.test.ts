/**
 * 云桥(web / mobile 共用)「插件文件不是笔记」仪器(2026-10-09)。
 * 服务端按后缀把 `.deck.md` 这类文件记成 page(它不知道这台设备装了哪些插件),于是它们混在 tree.pages 里:
 * 被列进笔记树、当笔记打开,笔记编辑器一存就把插件的格式改坏。给了 cfg.pluginExts 之后,桥把它们从页面列表
 * 挪进文件列表 —— 首屏载荷(含冷启动的树快照)、listPages、listFiles 三个出口同一把尺子。
 * 本地库那一半 + 点开之后的事在 mobile 的 `npm run e2e:pluginfiles`。
 * 负对照(实跑过):把 visiblePage 里的 `&& !isPluginFile(p)` 去掉 → 第 1 / 3 / 4 条红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudAmadeusBridge } from '../../../../web/src/amadeus/cloudBridge'

class FakeES {
  addEventListener(): void { /* noop */ }
  close(): void { /* noop */ }
}
const jwt = `header.${btoa(JSON.stringify({ userId: 'u' }))}.signature`
const TREE = {
  pages: ['note.md', 'cards/Bio.deck.md', 'UPPER.DECK.MD', 'x.excalidraw-not.md', '.trash/old.deck.md'],
  files: [{ path: 'a.png', size: 1 }, { path: 'board.excalidraw.md', size: 2 }],
  folders: ['cards'],
  seq: 1,
}

beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
  })
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('location', { origin: 'https://cloud.test', reload: vi.fn() })
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    let body: unknown = {}
    if (url.pathname.endsWith('/vaults')) body = { vaults: [{ id: 'v1' }] }
    else if (url.pathname.endsWith('/tree')) body = TREE
    else if (url.pathname.endsWith('/asset-token')) body = { token: 't', ttlSec: 600 }
    else if (url.pathname.endsWith('/link-base')) body = { webOrigin: 'https://cloud.test' }
    return new Response(JSON.stringify(body))
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const make = (pluginExts?: () => string[]) =>
  createCloudAmadeusBridge({ apiBase: 'https://cloud.test/api', getToken: () => jwt, onAuthError: vi.fn(), pluginExts })

describe('cloud bridge: plugin-owned files are not notes', () => {
  it('首屏载荷与 listPages 都不含插件文件(后缀比较不分大小写);普通笔记、名字里带点的笔记不受影响', async () => {
    const bridge = make(() => ['.deck.md'])
    const info = await bridge.restoreVault()
    expect(info?.pages).toEqual(['note.md', 'x.excalidraw-not.md'])
    expect(await bridge.listPages()).toEqual(['note.md', 'x.excalidraw-not.md'])
  })

  it('挪出来的插件文件进 listFiles(树上还看得见);点目录里的照旧隐身', async () => {
    const bridge = make(() => ['.deck.md'])
    await bridge.restoreVault()
    expect(await bridge.listFiles()).toEqual(['UPPER.DECK.MD', 'a.png', 'board.excalidraw.md', 'cards/Bio.deck.md'])
  })

  it('名单每次现取:装 / 卸插件之后不用重建桥', async () => {
    let exts: string[] = []
    const bridge = make(() => exts)
    await bridge.restoreVault()
    expect(await bridge.listPages()).toContain('cards/Bio.deck.md')
    exts = ['.deck.md']
    expect(await bridge.listPages()).not.toContain('cards/Bio.deck.md')
    expect(await bridge.listFiles()).toContain('cards/Bio.deck.md')
  })

  it('冷启动先拿上次的树快照上屏:快照里的插件文件同样不进首屏的页面列表', async () => {
    await make(() => ['.deck.md']).restoreVault() // 第一次启动:拉树、落快照(快照存的是服务端原样)
    const treeCalls = (): number => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/tree')).length
    expect(treeCalls()).toBe(1)
    const info = await make(() => ['.deck.md']).restoreVault() // 第二次启动:走快照
    expect(treeCalls()).toBe(1) // 防空过:这一次确实没等网络,上屏的是快照
    expect(info?.pages).toEqual(['note.md', 'x.excalidraw-not.md'])
    // 快照路径的后台刷新要等它落定再收尾(否则它在 window 桩撤掉之后才回来)
    await vi.waitFor(() => expect(treeCalls()).toBe(2))
    await new Promise((r) => setTimeout(r, 0))
  })

  it('不传 pluginExts(网页版今天的接法)= 行为不变', async () => {
    const bridge = make()
    const info = await bridge.restoreVault()
    expect(info?.pages).toEqual(['note.md', 'cards/Bio.deck.md', 'UPPER.DECK.MD', 'x.excalidraw-not.md'])
    expect(await bridge.listFiles()).toEqual(['a.png', 'board.excalidraw.md'])
  })
})
