/**
 * 评审 G2-04:web 云桥改名 / 移动笔记之后重写全库 `[[链接]]`(此前是纯移动,所有引用断链、点进去新建一篇空笔记)。
 *  - renamePageFile / movePage / renameFolder:别的笔记里的引用跟到新名 / 新路径;没提到它的笔记一个 PUT 都不发
 *  - 重写走桥自己的比对交换写:写前盘上被别人改过(409)→ 按现文重算再写,对方的字不丢
 *  - 改写过的笔记 fireExternal(自己写的 SSE 被回声抑制吃掉,开着它的编辑器只能靠这一声回灌)
 *  - 写不进去 → 提示(amadeus:toast,error 级),不静默吞
 * 假服务端按 server/microserver/amadeus 的契约建模:文件 seq 逐文件自增、baseSeq 不符 409 带现文;move 保 seq。
 * 负对照(实跑过):摘掉 renamePageFile 的 `.then(propagateRenames)` → 第 1 条红(A.md 原样、零重写 PUT)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudAmadeusBridge } from '../../../../web/src/amadeus/cloudBridge'

class FakeES {
  onopen: (() => void) | null = null
  addEventListener(): void { /* noop */ }
  close(): void { /* noop */ }
}

const jwt = `header.${btoa(JSON.stringify({ userId: 'u' }))}.signature`
const files = new Map<string, { content: string; seq: number }>()
const puts: string[] = []
const toasts: Array<{ text: string; level?: string }> = []
let beforePut: (path: string) => void = () => {}
let failPut: (path: string) => boolean = () => false

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const folders = (): string[] => {
  const out = new Set<string>()
  for (const p of files.keys()) {
    const segs = p.split('/')
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join('/'))
  }
  return [...out].sort()
}
const movePrefix = (from: string, to: string): void => {
  for (const [p, f] of [...files]) {
    if (!p.startsWith(`${from}/`)) continue
    files.delete(p)
    files.set(`${to}${p.slice(from.length)}`, f)
  }
}

beforeEach(() => {
  files.clear(); puts.length = 0; toasts.length = 0
  beforePut = () => {}
  failPut = () => false
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
  })
  vi.stubGlobal('window', {
    addEventListener: () => {},
    dispatchEvent: (e: Event) => {
      if (e.type === 'amadeus:toast') toasts.push((e as CustomEvent<{ text: string; level?: string }>).detail)
      return true
    },
  })
  vi.stubGlobal('location', { origin: 'https://cloud.test', reload: vi.fn() })
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const p = url.pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (p.endsWith('/vaults')) return json({ vaults: [{ id: 'v1' }] })
    if (p.endsWith('/tree')) return json({ pages: [...files.keys()].filter((k) => k.endsWith('.md')).sort(), files: [], folders: folders(), seq: 1 })
    if (p.endsWith('/file') && method === 'PUT') {
      beforePut(body.path)
      if (failPut(body.path)) return json({ detail: 'boom' }, 500)
      const cur = files.get(body.path)
      if (!body.force && (cur?.seq ?? 0) !== body.baseSeq) return json({ code: 'CONFLICT', seq: cur?.seq ?? 0, content: cur?.content ?? '' }, 409)
      const seq = (cur?.seq ?? 0) + 1
      files.set(body.path, { content: body.content, seq })
      puts.push(body.path)
      return json({ seq, hash: 'h' })
    }
    if (p.endsWith('/file')) {
      const path = url.searchParams.get('path') ?? ''
      const f = files.get(path)
      return f ? json({ path, kind: 'page', content: f.content, seq: f.seq, hash: 'h', updatedAt: '' }) : json({ detail: 'not found' }, 404)
    }
    if (p.endsWith('/move')) {
      const f = files.get(body.from)!
      files.delete(body.from)
      files.set(body.to, f)
      return json({ path: body.to, seq: f.seq })
    }
    if (p.endsWith('/folders/rename')) {
      const to = [...String(body.path).split('/').slice(0, -1), body.newName].join('/')
      movePrefix(body.path, to)
      return json({ path: to })
    }
    if (p.endsWith('/folders/move')) {
      const to = body.dest ? `${body.dest}/${String(body.path).split('/').pop()}` : String(body.path).split('/').pop()
      movePrefix(body.path, to!)
      return json({ path: to })
    }
    if (p.endsWith('/asset-token')) return json({ token: 't', ttlSec: 600 })
    if (p.endsWith('/link-base')) return json({ webOrigin: 'https://cloud.test' })
    return json({})
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const seed = (entries: Record<string, string>): void => { for (const [p, c] of Object.entries(entries)) files.set(p, { content: c, seq: 1 }) }
const boot = async () => {
  const bridge = createCloudAmadeusBridge({ apiBase: 'https://cloud.test/api', getToken: () => jwt, onAuthError: vi.fn() })
  await bridge.restoreVault()
  const external: string[] = []
  bridge.onExternalChange((p) => external.push(p))
  return { bridge, external }
}

describe('cloud bridge: rename / move rewrites [[links]] vault-wide (G2-04)', () => {
  it('renamePageFile B → C:引用跟到新名,开着的编辑器收到回灌;没提到它的笔记零 PUT', async () => {
    seed({ 'A.md': 'see [[B]] and [[B#H]] and [[B|alias]]\n', 'B.md': 'b\n', 'Other.md': '[[Z]]\n' })
    const { bridge, external } = await boot()
    expect(await bridge.renamePageFile('B.md', 'C')).toBe('C.md')
    expect(files.get('A.md')!.content).toBe('see [[C]] and [[C#H]] and [[C|alias]]\n')
    expect(puts).toEqual(['A.md'])
    expect(external).toContain('A.md')
    expect(toasts).toEqual([])
  })

  it('movePage sub/E → 根目录:带路径的链接改成新路径', async () => {
    seed({ 'sub/D.md': 'see [[sub/E]]\n', 'sub/E.md': 'e\n' })
    const { bridge } = await boot()
    expect(await bridge.movePage('sub/E.md', '')).toBe('E.md')
    expect(files.get('sub/D.md')!.content).toBe('see [[E]]\n')
  })

  it('renameFolder sub → lib:树下每一页的路径限定引用都跟上', async () => {
    seed({ 'X.md': '[[sub/E]] [[sub/F|f]]\n', 'sub/E.md': 'e\n', 'sub/F.md': 'f\n' })
    const { bridge } = await boot()
    expect(await bridge.renameFolder('sub', 'lib')).toBe('lib')
    expect(files.get('X.md')!.content).toBe('[[lib/E]] [[lib/F|f]]\n')
  })

  it('重写撞上别人刚写过(409)→ 按现文重算再写,对方的字不丢', async () => {
    seed({ 'A.md': 'x [[B]]\n', 'B.md': 'b\n' })
    const { bridge } = await boot()
    let raced = false
    beforePut = (p) => {
      if (p !== 'A.md' || raced) return
      raced = true
      const cur = files.get('A.md')!
      files.set('A.md', { content: `${cur.content}别的设备刚写的一行\n`, seq: cur.seq + 1 })
    }
    await bridge.renamePageFile('B.md', 'C')
    expect(files.get('A.md')!.content).toBe('x [[C]]\n别的设备刚写的一行\n')
    expect(toasts).toEqual([])
  })

  it('写不进去 → error 级提示点名那篇,不静默吞;改名本身照常生效', async () => {
    seed({ 'A.md': 'x [[B]]\n', 'K.md': 'k [[B]]\n', 'B.md': 'b\n' })
    const { bridge } = await boot()
    failPut = (p) => p === 'K.md'
    expect(await bridge.renamePageFile('B.md', 'C')).toBe('C.md')
    expect(files.get('A.md')!.content).toBe('x [[C]]\n')
    expect(files.get('K.md')!.content).toBe('k [[B]]\n')
    expect(toasts).toHaveLength(1)
    expect(toasts[0].level).toBe('error')
    expect(toasts[0].text).toContain('K')
  })
})
