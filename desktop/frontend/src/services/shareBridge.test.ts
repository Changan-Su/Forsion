/**
 * 公开分享页只读桥(web/src/amadeus/shareBridge.ts)仪器(2026-09-07 P4 只读编辑器)。
 *  - 读:file / asset / tree 三个公开端点,404 → null / missing,页面原文只拉一次(缓存)
 *  - 写:一律 ShareReadOnlyError,且**一个非 GET 请求都不发**(桥是第二道闸,UnifiedPage.readOnly 是第一道)
 *  - 嵌入解析:`Note#id`(v4 惰性锚 = 首个单元)/ `Note#标题`(小节回退)/ 范围外 → null
 *  - 资产 URL:toAssetUrl 带 ref + 当前页(服务端按页做范围与「本页显式引用」兜底解析)
 * 负对照(实跑过):把 deny 换成 `async () => {}` → 「写一律拒绝」红;把 findEmbedBlock 的 firstBlockUnit 去掉 → 「惰性锚只取首单元」红。
 * desktop vitest 直接 import web 源(precedent:cloudBridgeVanished.test.ts)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShareBridge, findEmbedBlock, installShareBridge, parseEmbedTarget, ShareReadOnlyError } from '../../../../web/src/amadeus/shareBridge'
import { toAssetUrl } from '@amadeus-shared/assets'
import { emptyDb, serializeDb } from '@amadeus-shared/db/schema'

const NOTE = ['---', 'tags:', '  - alpha', '---', '# 标题一', '', '第一段。', '', '<!-- a k1 -->', '锚定段落。', '', '锚后第二段。', '', '## 小节', '', '小节正文。', ''].join('\n')
const CHILD = '子页正文。\n'
const tree = { root: 'Docs/Note.md', pages: ['Docs/Note.md', 'Docs/Note.fd/Child.md'], folders: ['Docs/Note.fd'] }
const files: Record<string, string> = { 'Docs/Note.md': NOTE, 'Docs/Note.fd/Child.md': CHILD }
const assets: Record<string, string> = { 'tasks.db': serializeDb(emptyDb('tasks')), 'broken.db': '{not json', 'Board.excalidraw.md': '# board\n' }

let calls: Array<{ url: string; method: string }> = []
const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  calls.push({ url, method: init?.method ?? 'GET' })
  const u = new URL(url)
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (u.pathname.endsWith('/file')) {
    const p = u.searchParams.get('path') ?? ''
    return p in files ? json(200, { path: p, kind: 'page', content: files[p], title: p }) : json(404, { detail: 'not found' })
  }
  if (u.pathname.endsWith('/asset')) {
    const ref = u.searchParams.get('ref') ?? ''
    return ref in assets ? new Response(assets[ref], { status: 200 }) : new Response('nf', { status: 404 })
  }
  return json(404, {})
}) as unknown as typeof fetch

const mk = () => createShareBridge({ apiBase: 'https://cloud.test/api', token: 'tok', tree: () => tree, currentPage: () => 'Docs/Note.md', fetch: fakeFetch })

beforeEach(() => { calls = [] })

describe('shareBridge 读', () => {
  it('readTextFile / loadPage 走 /file,404 → null,同页只拉一次', async () => {
    const b = mk()
    expect(await b.readTextFile('Docs/Note.md')).toBe(NOTE)
    expect(await b.readTextFile('Docs/Nope.md')).toBeNull()
    const page = await b.loadPage('Docs/Note.md')
    expect(page.manifest.title).toBe('Note')
    expect(Object.keys(page.blocks).length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.url.includes('path=Docs%2FNote.md')).length).toBe(1)
    expect(await b.listPages()).toEqual(tree.pages)
  })

  it('readDatabase / readDrawing 走 /asset 并带当前页;404 → missing,坏 JSON → corrupt', async () => {
    const b = mk()
    const ok = await b.readDatabase('Docs/Note.md', 'tasks.db')
    expect(ok.status).toBe('ok')
    expect(calls.at(-1)?.url).toContain('/asset?ref=tasks.db&page=Docs%2FNote.md')
    expect((await b.readDatabase('Docs/Note.md', 'nope.db')).status).toBe('missing')
    expect((await b.readDatabase('Docs/Note.md', 'broken.db')).status).toBe('corrupt')
    const d = await b.readDrawing('Docs/Note.md', 'Board.excalidraw')
    expect(d).toEqual({ status: 'ok', path: 'Docs/Board.excalidraw.md', source: '# board\n' })
  })

  it('listPageProps 给文件夹直属子页的 frontmatter', async () => {
    const rows = await mk().listPageProps('Docs')
    expect(rows).toEqual([{ path: 'Docs/Note.md', title: 'Note', fm: { tags: expect.any(String) } }])
  })

  it('事件订阅返回退订函数,不发请求', () => {
    const b = mk()
    expect(typeof b.onExternalChange(() => {})).toBe('function')
    expect(typeof b.onStructureChange(() => {})).toBe('function')
    expect(typeof b.onDbExternalChange(() => {})).toBe('function')
    expect(calls).toEqual([])
  })
})

describe('shareBridge 写一律拒绝', () => {
  it('每个写方法都抛 ShareReadOnlyError,且零非 GET 请求', async () => {
    const b = mk()
    const writes: Array<Promise<unknown>> = [
      b.writeTextFile('Docs/Note.md', 'x'),
      b.savePage('Docs/Note.md', {} as never, {}),
      b.newPage('Docs/New.md'),
      b.writeDatabase('Docs/tasks.db', emptyDb('t')),
      b.writeDrawing('Docs/Board.excalidraw.md', 'x'),
      b.deletePage('Docs/Note.md'),
      b.movePage('Docs/Note.md', ''),
      b.renamePageFile('Docs/Note.md', 'Nope'),
      b.saveAttachment('Docs/Note.md', 'a.png', new Uint8Array(), { mode: 'same', folder: '' }),
      b.setPageFrontmatter('Docs/Note.md', { a: 1 }),
      b.createFolder('', 'x'),
    ]
    for (const w of writes) await expect(w).rejects.toBeInstanceOf(ShareReadOnlyError)
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    expect(calls).toEqual([]) // 拒绝发生在发请求之前
  })
})

describe('shareBridge 嵌入解析', () => {
  it('parseEmbedTarget 与服务端同口径', () => {
    expect(parseEmbedTarget('Note#K1.block')).toEqual({ noteKey: 'note', id: 'k1' })
    expect(parseEmbedTarget('k1')).toEqual({ noteKey: null, id: 'k1' })
  })
  it('v4 惰性锚只取首个单元;标题回退取整小节;范围外 → null', async () => {
    expect(findEmbedBlock(NOTE, 'k1')).toBe('锚定段落。')
    expect(findEmbedBlock(NOTE, '小节')).toBe('## 小节\n\n小节正文。')
    const b = mk()
    expect(await b.resolveEmbed('Note#k1')).toEqual({ owner: 'Docs/Note.md', content: '锚定段落。', type: 'markdown' })
    expect(await b.resolveEmbed('k1')).toEqual({ owner: 'Docs/Note.md', content: '锚定段落。', type: 'markdown' })
    expect(await b.resolveEmbed('Elsewhere#k1')).toBeNull()
    expect(await b.resolveEmbed('Note#zz')).toBeNull()
  })
})

describe('installShareBridge', () => {
  it('挂 window.amadeus 并把 toAssetUrl 接到公开资产端点(ref + 当前页)', () => {
    vi.stubGlobal('window', {})
    let cur: string | null = 'Docs/Note.md'
    installShareBridge({ apiBase: 'https://cloud.test/api', token: 'to/k', tree: () => tree, currentPage: () => cur, fetch: fakeFetch })
    expect(typeof (globalThis as unknown as { window: { amadeus?: unknown } }).window.amadeus).toBe('object')
    expect(toAssetUrl('Docs/.amadeus/pic.png')).toBe('https://cloud.test/api/amadeus/public/shares/to%2Fk/asset?ref=Docs%2F.amadeus%2Fpic.png&page=Docs%2FNote.md')
    cur = null
    expect(toAssetUrl('x.png')).toBe('https://cloud.test/api/amadeus/public/shares/to%2Fk/asset?ref=x.png')
    vi.unstubAllGlobals()
  })
})
