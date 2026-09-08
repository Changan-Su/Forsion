/**
 * 云桥(web/mobile 共用)「别处删了/挪了的页不许复活」仪器(2026-09-07 云同步事故,跨端幽灵文件那半 + Codex 终审)。
 *  - SSE delete/move/文件夹事件只走明细回调,**不**走 onPageChange 回灌(回灌 = loadOrCreate 404→重建 = 复活)
 *  - 本会话见过、现 404 的路径:loadPage / reconcilePage 抛 VanishedError,零 PUT;从未见过的 404 照常创建
 *  - 别处删了、本端还有正文 → 另存 recovered 副本并让后续保存落到那份;空白草稿放弃;新建意图(create)不受禁令
 *  - 别处改名 A→B / 文件夹改名:写旧路径落到新路径(别名),旧路径不重建
 * 负对照(实跑过):去掉 cloudEvents 各分支的 return → 第 1 条红;去掉 loadOrCreate 的 everKnown 守卫 → 第 2 条红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudAmadeusBridge } from '../../../../web/src/amadeus/cloudBridge'
import { startCloudEvents } from '../../../../web/src/amadeus/cloudEvents'

class FakeES {
  static last: FakeES | null = null
  private listeners = new Map<string, (e: { data: string }) => void>()
  onopen: (() => void) | null = null
  constructor(readonly url: string) { FakeES.last = this }
  addEventListener(type: string, fn: (e: { data: string }) => void): void { this.listeners.set(type, fn) }
  close(): void { /* noop */ }
  emit(type: string, data: unknown): void { this.listeners.get(type)?.({ data: JSON.stringify(data) }) }
}

const jwt = `header.${btoa(JSON.stringify({ userId: 'u' }))}.signature`
const gone = new Set<string>()
const puts: Array<{ path: string; baseSeq: number }> = []
const other = { client: 'other' }

beforeEach(() => {
  gone.clear(); puts.length = 0; FakeES.last = null
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
  })
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('location', { origin: 'https://cloud.test', reload: vi.fn() })
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    let body: unknown = {}
    if (url.pathname.endsWith('/vaults')) body = { vaults: [{ id: 'v1' }] }
    else if (url.pathname.endsWith('/tree')) body = { pages: ['seen.md'], files: [], folders: [], seq: 1 }
    else if (url.pathname.endsWith('/file') && init?.method === 'PUT') {
      const req = JSON.parse(String(init.body)) as { path: string; baseSeq: number }
      puts.push({ path: req.path, baseSeq: req.baseSeq })
      body = { seq: 2 }
    } else if (url.pathname.endsWith('/file')) {
      const path = url.searchParams.get('path') ?? ''
      if (gone.has(path)) return new Response('{"error":"not found"}', { status: 404 })
      body = { path, content: `# ${path}`, seq: 1, hash: 'h' }
    } else if (url.pathname.endsWith('/asset-token')) body = { token: 't', ttlSec: 600 }
    else if (url.pathname.endsWith('/link-base')) body = { webOrigin: 'https://cloud.test' }
    return new Response(JSON.stringify(body))
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const boot = async () => {
  const bridge = createCloudAmadeusBridge({ apiBase: 'https://cloud.test/api', getToken: () => jwt, onAuthError: vi.fn() })
  await bridge.restoreVault() // 选库 + 起 SSE(桥只在这里 startEvents)
  return { bridge, es: () => FakeES.last! }
}

describe('cloud events: delete/move/folder dispatch', () => {
  it('delete/move/folder → 只走明细回调,绝不 onPageChange;write → onPageChange(阳性对照)', () => {
    const cfg = {
      url: () => 'https://cloud.test/sse', clientId: 'me', knownSeq: () => undefined, lastLoadedPage: () => null,
      onPageChange: vi.fn(), onDbChange: vi.fn(), onPageMoved: vi.fn(), onPageDeleted: vi.fn(),
      onFolderMoved: vi.fn(), onFolderDeleted: vi.fn(), onStructureChange: vi.fn(),
    }
    const stop = startCloudEvents(cfg)
    const es = FakeES.last!
    es.emit('change', { seq: 1, op: 'delete', path: 'a.md', origin: other })
    expect(cfg.onPageDeleted).toHaveBeenCalledWith('a.md')
    es.emit('change', { seq: 2, op: 'move', path: 'a.md', newPath: 'b.md', fileSeq: 7, origin: other })
    expect(cfg.onPageMoved).toHaveBeenCalledWith('a.md', 'b.md', 7)
    es.emit('change', { seq: 3, type: 'structure', op: 'rename-folder', path: 'docs', newPath: 'archive', origin: other })
    expect(cfg.onFolderMoved).toHaveBeenCalledWith('docs', 'archive')
    es.emit('change', { seq: 4, type: 'structure', op: 'delete-folder', path: 'old', origin: other })
    expect(cfg.onFolderDeleted).toHaveBeenCalledWith('old')
    expect(cfg.onPageChange).not.toHaveBeenCalled() // 以上四种事件一次内容回灌都没有
    es.emit('change', { seq: 5, op: 'write', path: 'c.md', origin: other })
    expect(cfg.onPageChange).toHaveBeenCalledWith('c.md')
    stop()
  })
})

describe('cloud bridge: vanished pages are not recreated', () => {
  it('seen page deleted elsewhere: loadPage/reconcilePage reject with zero PUT; unseen 404 still creates', async () => {
    const { bridge, es } = await boot()
    await bridge.loadPage('seen.md') // 学到 seq → everKnown
    gone.add('seen.md')
    es().emit('change', { seq: 5, op: 'delete', path: 'seen.md', origin: other }) // 桥的 SSE:清 seq/缓存
    await expect(bridge.loadPage('seen.md')).rejects.toThrow(/vanished/)
    await expect(bridge.reconcilePage('seen.md', { title: 'x', blocks: [] } as never, {})).rejects.toThrow(/vanished/)
    expect(puts).toEqual([])
    gone.add('fresh.md')
    await bridge.loadPage('fresh.md') // 从未见过 → 「打开即创建」照旧
    expect(puts.map((p) => p.path)).toEqual(['fresh.md'])
  })

  it('deleted elsewhere with a draft: saved as a recovered copy, later writes follow it; blank draft is dropped; create intent bypasses', async () => {
    const { bridge, es } = await boot()
    await bridge.loadPage('seen.md')
    gone.add('seen.md')
    es().emit('change', { seq: 5, op: 'delete', path: 'seen.md', origin: other })
    await bridge.writeTextFile('seen.md', '   ') // 空白草稿:没什么可保,不重建
    expect(puts).toEqual([])
    await bridge.writeTextFile('seen.md', 'draft one')
    expect(puts).toHaveLength(1)
    expect(puts[0].path).toMatch(/^seen \(recovered \d{4}-\d{2}-\d{2} \d{4}\)\.md$/)
    expect(puts[0].baseSeq).toBe(0)
    await bridge.writeTextFile('seen.md', 'draft two') // 别名:后续保存落到 recovered 副本,不碰原路径
    expect(puts[1]).toEqual({ path: puts[0].path, baseSeq: 2 })
    await bridge.writeTextFile('seen.md', '', { create: true }) // 显式新建同名:合法,按新文件创建
    expect(puts[2]).toEqual({ path: 'seen.md', baseSeq: 0 })
  })

  it('moved elsewhere (A→B) and folder renamed: writes to the old path land on the new path, old path is never recreated', async () => {
    const { bridge, es } = await boot()
    await bridge.loadPage('seen.md')
    await bridge.loadPage('docs/x.md')
    gone.add('seen.md'); gone.add('docs/x.md')
    es().emit('change', { seq: 5, op: 'move', path: 'seen.md', newPath: 'moved.md', fileSeq: 1, origin: other })
    es().emit('change', { seq: 6, type: 'structure', op: 'rename-folder', path: 'docs', newPath: 'archive', origin: other })
    await bridge.writeTextFile('seen.md', 'edit after move')
    await bridge.writeTextFile('docs/x.md', 'edit after folder rename')
    expect(puts.map((p) => p.path)).toEqual(['moved.md', 'archive/x.md'])
    await expect(bridge.loadPage('seen.md')).rejects.toThrow(/vanished/) // 旧路径仍算见过:陈旧标签页打开不重建
    await expect(bridge.loadPage('docs/x.md')).rejects.toThrow(/vanished/)
    expect(puts).toHaveLength(2)
    // 别名链 A→B→C 跟到底;C 被删 → 整条上游链作废,写 A 不再落到 B,而是另存 recovered 副本
    gone.add('moved.md'); gone.add('final.md')
    es().emit('change', { seq: 7, op: 'move', path: 'moved.md', newPath: 'final.md', fileSeq: 1, origin: other })
    await bridge.writeTextFile('seen.md', 'edit after second move')
    expect(puts[2].path).toBe('final.md')
    es().emit('change', { seq: 8, op: 'delete', path: 'final.md', origin: other })
    await bridge.writeTextFile('seen.md', 'edit after chain end deleted')
    expect(puts[3].path).toMatch(/^seen \(recovered /)
  })
})
