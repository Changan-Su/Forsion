/**
 * 云桥(web / mobile 共用):非 .md / .db 的文本文件(插件的旁挂 .json、导出的 .canvas)读写落到二进制端点(2026-10-09)。
 * 起因:服务端按扩展名分 kind,文本端点对这类路径答 400(写 BINARY_PATH / 读 BINARY)—— 手机缺省用云端库,
 * 插件的索引 / 缓存 / 快照全写不下、别的设备传上来的也读不回。桌面同步引擎本来就按二进制传它们,所以两端是同一行。
 * 假服务端的判据镜像 server/microserver/amadeus(同 mobile/scripts/plugin-install.e2e.cjs 的 startFakeCloud;那台是整条
 * 插件链路的端到端,这里钉它覆盖不到的:仅新建 / 比对交换写两条分支、对象字节一时取不到、BOM)。
 * 负对照(实跑过):writeTextFile 去掉分流 → 写的用例红(HTTP 400);取字节的 ref 不带尾斜杠 → 读成别的目录的同名文件(OTHER);
 * 把资源端点的 404 一律当「没有」→ 「对象取不到」那条红(读成 null);改回 Response.text() → BOM 那条红;
 * 取字节的请求不带中止信号 → 超时那条挂到用例超时。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudAmadeusBridge } from '../../../../web/src/amadeus/cloudBridge'
import { textFingerprint } from '../../../shared/amadeus/writeConflict'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b)
type Row = { kind: 'text' | 'binary'; body: Uint8Array; seq: number }
const rows = new Map<string, Row>()
const calls: string[] = []
/** 下一次 POST /binary 判 CAS 之前,别的设备先写进来的内容(模拟「取完 seq 之后被抢先」)。 */
let raceWith: string | null = null
/** 上面那次之后,再下一次 POST /binary 之前又有一台设备写进来(重试的那一下也被抢先)。 */
let raceAgain: string | null = null
/** 接下来这么多次取字节答 404 asset bytes missing(行在、对象取不到:别处正好在覆盖,旧对象刚被删)。 */
let bytesMissing = 0

const isText = (p: string): boolean => /\.(md|db)$/i.test(p)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })
const put = (p: string, body: string | Uint8Array, kind: Row['kind']): number => {
  const seq = (rows.get(p)?.seq ?? 0) + 1
  rows.set(p, { kind, body: typeof body === 'string' ? enc(body) : body, seq })
  return seq
}
const text = (p: string): string | undefined => { const r = rows.get(p); return r && dec(r.body) }
/** 显式的文件夹行(空文件夹、被整个搬进回收站的文件夹);有文件的目录另由路径推出来。 */
const dirs = new Set<string>()
const folders = (): string[] => {
  const out = new Set(dirs)
  for (const p of rows.keys()) for (let d = p; d.includes('/');) { d = d.slice(0, d.lastIndexOf('/')); out.add(d) }
  return [...out]
}
const moveTree = (from: string, to: string): void => {
  for (const [p, r] of [...rows]) if (p.startsWith(`${from}/`)) { rows.delete(p); rows.set(`${to}${p.slice(from.length)}`, r) }
  for (const d of [...dirs]) if (d === from || d.startsWith(`${from}/`)) dirs.delete(d)
  dirs.add(to)
}

beforeEach(() => {
  rows.clear(); dirs.clear(); calls.length = 0; raceWith = null; raceAgain = null; bytesMissing = 0
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
  })
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('location', { origin: 'https://cloud.test', reload: vi.fn() })
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const end = url.pathname.split('/').pop()
    const tail = url.pathname.split('/vaults/v1/')[1] ?? ''
    calls.push(`${method} ${end}`)
    if (end === 'vaults') return json(200, { vaults: [{ id: 'v1' }] })
    if (end === 'tree') {
      const entries = [...rows].map(([path, r]) => ({ path, kind: r.kind === 'text' ? 'page' : 'binary', seq: r.seq }))
      return json(200, { pages: [], files: entries.map((e) => ({ path: e.path, size: 0 })), folders: folders(), entries, seq: 1 })
    }
    // 回收站用到的结构端点(server routes.ts:POST /move、/folders/move、/folders/rename,DELETE /file、/folders)
    if (method === 'POST' && (tail === 'move' || tail === 'folders/move' || tail === 'folders/rename')) {
      const b = JSON.parse(String(init?.body)) as { from?: string; to?: string; path?: string; dest?: string; newName?: string }
      if (tail === 'move') {
        const r = rows.get(b.from!)
        if (!r) return json(404, { detail: 'file not found' })
        if (rows.has(b.to!) || folders().includes(b.to!)) return json(409, { code: 'EXISTS' })
        rows.delete(b.from!); rows.set(b.to!, { ...r, seq: r.seq + 1 })
        return json(200, { path: b.to, seq: r.seq + 1 })
      }
      const from = b.path!
      if (!folders().includes(from)) return json(404, { detail: 'folder not found' })
      const name = from.split('/').pop()!
      const to = tail === 'folders/move' ? (b.dest ? `${b.dest}/${name}` : name) : [...from.split('/').slice(0, -1), b.newName!].join('/')
      if (rows.has(to) || folders().includes(to)) return json(409, { code: 'EXISTS' })
      moveTree(from, to)
      return json(200, { path: to })
    }
    if (method === 'DELETE' && tail.startsWith('file')) {
      return rows.delete(url.searchParams.get('path') ?? '') ? json(200, {}) : json(404, { detail: 'file not found' })
    }
    if (method === 'DELETE' && tail.startsWith('folders')) {
      const dir = url.searchParams.get('path') ?? ''
      if (!folders().includes(dir)) return json(404, { detail: 'folder not found' })
      for (const k of [...rows.keys()]) if (k.startsWith(`${dir}/`)) rows.delete(k)
      for (const d of [...dirs]) if (d === dir || d.startsWith(`${dir}/`)) dirs.delete(d)
      return json(200, {})
    }
    if (end === 'file' && method === 'GET') {
      const r = rows.get(url.searchParams.get('path') ?? '')
      if (!r) return json(404, { detail: 'file not found' })
      if (r.kind === 'binary') return json(400, { code: 'BINARY', detail: 'binary file: use GET /vaults/:v/asset' })
      return json(200, { content: dec(r.body), seq: r.seq, hash: 'h' })
    }
    if (end === 'file' && method === 'PUT') {
      const b = JSON.parse(String(init?.body)) as { path: string; content: string }
      if (!isText(b.path)) return json(400, { code: 'BINARY_PATH', detail: 'binary path: use POST /vaults/:v/binary' })
      return json(200, { seq: put(b.path, b.content, 'text'), hash: 'h' })
    }
    if (end === 'binary') {
      const form = init?.body as FormData
      const p = String(form.get('path'))
      if (isText(p)) return json(400, { detail: 'text path (.md/.db): use PUT /vaults/:v/file' })
      if (raceWith !== null) { put(p, raceWith, 'binary'); raceWith = raceAgain; raceAgain = null }
      const cur = rows.get(p)
      if (cur && form.get('ifAbsent')) return json(409, { code: 'EXISTS' })
      const base = form.get('baseSeq')
      if (base !== null) {
        const n = Number(base)
        if (n === 0 && cur) return json(409, { code: 'EXISTS', seq: cur.seq })
        if (n > 0 && cur?.seq !== n) return json(409, { code: 'CONFLICT', seq: cur?.seq ?? 0 })
      }
      const body = new Uint8Array(await (form.get('file') as Blob).arrayBuffer()) // 原字节(Blob.text() 会吞 BOM)
      return json(200, { path: p, size: body.length, seq: put(p, body, 'binary') })
    }
    if (end === 'asset') {
      const raw = url.searchParams.get('ref')
      if (!raw) return json(400, { detail: 'ref required' })
      const ref = raw.replace(/\/+$/, '') // normalizePath 剥尾斜杠
      let r = rows.get(ref)
      // 原始 ref 不含 '/':精确找不到就按文件名全库兜底(跳过点开头的路径)
      if (!r && !raw.includes('/')) r = [...rows].find(([k]) => !k.split('/').some((s) => s.startsWith('.')) && k.split('/').pop() === ref)?.[1]
      if (!r) return json(404, { detail: 'asset not found' })
      if (bytesMissing > 0) { bytesMissing--; return json(404, { detail: 'asset bytes missing' }) }
      return new Response(r.body as BodyInit)
    }
    return json(404, { detail: 'not found' })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const boot = () => createCloudAmadeusBridge({ apiBase: 'https://cloud.test/api', getToken: () => 'h.e30.s', onAuthError: vi.fn() })
const IDX = '记忆闪卡/.deck-index.json'

describe('cloud bridge: non-.md/.db text files go through the binary endpoints', () => {
  it('writeTextFile / readTextFile round-trip a sidecar .json as a binary row; .md stays on the text endpoint', async () => {
    const bridge = boot()
    await bridge.writeTextFile(IDX, '{"decks":[]}')
    await bridge.writeTextFile(IDX, '{"decks":[1]}')
    expect(rows.get(IDX)?.kind).toBe('binary')
    expect(rows.get(IDX)?.seq).toBe(2)
    expect(await bridge.readTextFile(IDX)).toBe('{"decks":[1]}')
    expect(calls).not.toContain('PUT file')
    await bridge.writeTextFile('记忆闪卡/a.deck.md', '# a')
    expect(rows.get('记忆闪卡/a.deck.md')?.kind).toBe('text')
  })

  it('reads a row another device uploaded; a missing file is null; a missing root-level name never resolves to a namesake elsewhere', async () => {
    const bridge = boot()
    put('.bluebird/x.json', '{"from":"desktop"}', 'binary')
    put('sub/queue.json', 'OTHER', 'binary')
    expect(await bridge.readTextFile('.bluebird/x.json')).toBe('{"from":"desktop"}')
    expect(await bridge.readTextFile('记忆闪卡/.nope.json')).toBeNull()
    expect(await bridge.readTextFile('queue.json')).toBeNull()
    await expect(bridge.readVaultBytes('queue.json')).rejects.toThrow()
    expect(dec(await bridge.readVaultBytes('sub/queue.json'))).toBe('OTHER')
    put('queue.json', 'ROOT', 'binary')
    expect(await bridge.readTextFile('queue.json')).toBe('ROOT')
  })

  it('a row whose bytes cannot be fetched right now is retried, then fails loudly: never reported as missing', async () => {
    const bridge = boot()
    put(IDX, '{"decks":[1,2,3]}', 'binary')
    bytesMissing = 1 // 别处正好在覆盖:第一次取到的是刚被删掉的旧对象
    expect(await bridge.readTextFile(IDX)).toBe('{"decks":[1,2,3]}')
    bytesMissing = 5
    await expect(bridge.readTextFile(IDX)).rejects.toThrow() // null 会让插件按「还没有索引」把整份盖掉
  })

  it('a read that never answers times out as a failure instead of hanging the plugin', async () => {
    const bridge = boot()
    put(IDX, '{}', 'binary')
    await bridge.readTextFile(IDX) // 选库等前置请求先走完
    const real = globalThis.fetch as unknown as (i: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => (input.includes('/asset?')
      ? new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      : real(input, init)))
    vi.useFakeTimers()
    try {
      const pending = expect(bridge.readTextFile(IDX)).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(30_000)
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a UTF-8 BOM through read and write', async () => {
    const bridge = boot()
    put('a.csv', '﻿a,b', 'binary')
    const got = await bridge.readTextFile('a.csv')
    expect(got).toBe('﻿a,b')
    expect(await bridge.writeTextFile('a.csv', `${got}\n1,2`, { base: textFingerprint('﻿a,b') })).toEqual({ ok: true })
    expect([...rows.get('a.csv')!.body.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('create: writes only when absent, otherwise hands back what is there', async () => {
    const bridge = boot()
    expect(await bridge.writeTextFile('n.canvas', '{"a":1}', { create: true })).toEqual({ ok: true })
    expect(await bridge.writeTextFile('n.canvas', '{"b":2}', { create: true })).toEqual({ ok: false, current: '{"a":1}' })
    expect(text('n.canvas')).toBe('{"a":1}')
  })

  it('base: writes on a matching baseline, refuses a stale one, and refuses when another device wins the race', async () => {
    const bridge = boot()
    put('a.txt', 'v1', 'binary')
    expect(await bridge.writeTextFile('a.txt', 'v2', { base: textFingerprint('v1') })).toEqual({ ok: true })
    expect(await bridge.writeTextFile('a.txt', 'v3', { base: textFingerprint('v1') })).toEqual({ ok: false, current: 'v2' })
    expect(text('a.txt')).toBe('v2')
    raceWith = 'theirs' // 本端取完 seq、比对通过之后,别的设备先写了一版
    expect(await bridge.writeTextFile('a.txt', 'mine', { base: textFingerprint('v2') })).toEqual({ ok: false, current: 'theirs' })
    expect(text('a.txt')).toBe('theirs')
    expect(await bridge.writeTextFile('new.txt', 'x', { base: textFingerprint('') })).toEqual({ ok: true }) // 基线「没有这个文件」
  })
})

/**
 * 回收站账本 `.trash/.meta.json` 也是非 .md / .db 的文本 —— 同一个病:此前走文本端点,账本从来没写上去过。
 * 修复前(实跑,假服务端与 server 的真路由各一遍):trashEntry 把文件搬进 .trash/ 之后抛 HTTP 400,listTrash 恒为空,
 * restoreTrash 抛「回收站条目不存在」—— 所以线上存量条目全都没有记录,列出 / 恢复 / 彻底删都得以 .trash/ 下的实存为准。
 * 负对照(实跑过):账本名不从条目里剔掉 → 列表里多出一条 .meta.json;409 后不重读重写 → 「抢先」那条红(HTTP 409);
 * 409 后撤掉比对硬盖 → 「重试时又被抢先」那条红(少一条 y.md);没记录就当不存在 → 「没记录的条目」那条红;
 * 认不出的账本直接盖掉 → 「认不出」那条红(原内容没了);不剥 BOM → 「BOM」那条红(旧记录被当成认不出、挪走);
 * 落进回收站的名字不避开账本名 → 「叫 .meta.json 的文件」那条红(用户的文件被账本盖掉)。
 */
describe('cloud bridge: the trash ledger (.trash/.meta.json) is a binary row', () => {
  const LEDGER = '.trash/.meta.json'
  const ledger = (): Record<string, { original: string; dir: boolean }> => JSON.parse(text(LEDGER) ?? '{}')
  const listed = async (bridge: ReturnType<typeof boot>): Promise<Array<[string, string, boolean]>> =>
    (await bridge.listTrash!()).map((e): [string, string, boolean] => [e.name, e.original, e.dir]).sort((a, b) => (a[0] < b[0] ? -1 : 1)) // 按码位排,不随 locale

  it('trash, list and restore a file and a folder; the ledger is written and kept in step', async () => {
    const bridge = boot()
    put('Projects/Plan.md', '# plan', 'text')
    put('Docs/a.md', 'a', 'text')
    await bridge.trashEntry!('Projects/Plan.md')
    expect(rows.has('.trash/Projects__Plan.md')).toBe(true)
    expect(rows.get(LEDGER)?.kind).toBe('binary')
    expect(ledger()['Projects__Plan.md']).toMatchObject({ original: 'Projects/Plan.md', dir: false })
    await bridge.trashEntry!('Docs')
    expect(await listed(bridge)).toEqual([['Docs', 'Docs', true], ['Projects__Plan.md', 'Projects/Plan.md', false]])
    expect(await bridge.restoreTrash!('Projects__Plan.md')).toBe('Projects/Plan.md')
    expect(await bridge.restoreTrash!('Docs')).toBe('Docs')
    expect(text('Projects/Plan.md')).toBe('# plan')
    expect(text('Docs/a.md')).toBe('a')
    expect(ledger()).toEqual({})
    expect(await bridge.listTrash!()).toEqual([])
  })

  it('entries the ledger never recorded are still listed, restorable and deletable; the ledger itself is not an entry', async () => {
    const bridge = boot()
    put('Projects/keep.md', 'k', 'text')
    put('.trash/Projects__Old.md', 'old', 'text') // 扁平名里的 __ 不反推成目录(和名字里本来就带的 __ 分不开):按现名回库根
    put('.trash/Archive/x.md', 'x', 'text')
    put(LEDGER, '{}', 'binary')
    expect(await listed(bridge)).toEqual([['Archive', 'Archive', true], ['Projects__Old.md', 'Projects__Old.md', false]])
    expect(await bridge.restoreTrash!('Projects__Old.md')).toBe('Projects__Old.md')
    expect(text('Projects__Old.md')).toBe('old')
    await bridge.deleteTrashEntry!('Archive')
    expect(rows.has('.trash/Archive/x.md')).toBe(false)
    expect(rows.get(LEDGER)?.seq).toBe(1) // 这几条本来就不在账本里:没有为它们白写账本
    expect(await bridge.listTrash!()).toEqual([])
    await expect(bridge.restoreTrash!('nope.md')).rejects.toThrow()
  })

  it('a ledger update that loses the race to another device keeps both records', async () => {
    const bridge = boot()
    put('a.md', 'a', 'text'); put('b.md', 'b', 'text')
    await bridge.trashEntry!('a.md')
    // 本端读完账本之后、写之前,另一台设备把它自己的那条记了上去
    raceWith = JSON.stringify({ ...ledger(), 'other.md': { original: 'other.md', deletedAt: 1, dir: false } })
    await bridge.trashEntry!('b.md')
    expect(Object.keys(ledger()).sort()).toEqual(['a.md', 'b.md', 'other.md'])
  })

  it('a second device slipping in while the first conflict is being retried is not overwritten either', async () => {
    const bridge = boot()
    put('a.md', 'a', 'text'); put('b.md', 'b', 'text')
    await bridge.trashEntry!('a.md')
    const x = { ...ledger(), 'x.md': { original: 'x.md', deletedAt: 1, dir: false } }
    raceWith = JSON.stringify(x)
    raceAgain = JSON.stringify({ ...x, 'y.md': { original: 'y.md', deletedAt: 2, dir: false } })
    await bridge.trashEntry!('b.md')
    expect(Object.keys(ledger()).sort()).toEqual(['a.md', 'b.md', 'x.md', 'y.md'])
  })

  it('something unrecognisable sitting on the ledger path is renamed aside, never overwritten', async () => {
    const bridge = boot()
    put(LEDGER, '{oops', 'binary')
    put('a.md', 'a', 'text')
    expect(await bridge.listTrash!()).toEqual([]) // 读的一面:认不出就当空账本,不抛
    await bridge.trashEntry!('a.md')
    const aside = [...rows.keys()].filter((k) => /^\.trash\/.+-\.meta\.json$/.test(k))
    expect(aside.map(text)).toEqual(['{oops']) // 原内容还在,换了个名字留在回收站里
    expect(Object.keys(ledger())).toEqual(['a.md'])
    expect((await listed(bridge)).map((e) => e[0]).sort()).toEqual([aside[0].slice('.trash/'.length), 'a.md'].sort())
  })

  it('a ledger saved with a BOM is still a ledger: its records survive the next update', async () => {
    const bridge = boot()
    put('.trash/old.md', 'o', 'text')
    put(LEDGER, `\uFEFF${JSON.stringify({ 'old.md': { original: 'Notes/old.md', deletedAt: 5, dir: false } })}`, 'binary')
    put('a.md', 'a', 'text')
    await bridge.trashEntry!('a.md')
    expect(await listed(bridge)).toEqual([['a.md', 'a.md', false], ['old.md', 'Notes/old.md', false]])
    expect(Object.keys(ledger()).sort()).toEqual(['a.md', 'old.md'])
  })

  it('a file or folder that is itself called .meta.json never lands on the ledger path', async () => {
    const bridge = boot()
    put('.meta.json', 'USER', 'binary')
    put('sub/.meta.json/x.md', 'x', 'text')
    await bridge.trashEntry!('.meta.json')
    await bridge.trashEntry!('sub/.meta.json')
    const names = Object.keys(ledger())
    expect(names).toHaveLength(2)
    expect(names).not.toContain('.meta.json')
    const file = names.find((n) => !ledger()[n].dir)!
    const dir = names.find((n) => ledger()[n].dir)!
    expect(text(`.trash/${file}`)).toBe('USER')
    expect(await bridge.restoreTrash!(file)).toBe('.meta.json')
    expect(text('.meta.json')).toBe('USER')
    expect(await bridge.restoreTrash!(dir)).toBe('sub/.meta.json')
    expect(text('sub/.meta.json/x.md')).toBe('x')
  })

  it('two folders of the same name trashed one after the other both come back', async () => {
    const bridge = boot()
    put('Docs/a.md', '1', 'text')
    await bridge.trashEntry!('Docs')
    put('Docs/a.md', '2', 'text')
    await bridge.trashEntry!('Docs')
    const later = Object.keys(ledger()).find((n) => n !== 'Docs')! // 第二条撞名,带时间戳
    expect(await bridge.restoreTrash!(later)).toBe('Docs') // 第一条还躺在回收站里的时候就能恢复
    expect(text('Docs/a.md')).toBe('2')
    expect(await bridge.restoreTrash!('Docs')).toBe('Docs (2)')
    expect(text('Docs (2)/a.md')).toBe('1')
  })

  it('delete forever and empty', async () => {
    const bridge = boot()
    put('a.md', 'a', 'text'); put('b.md', 'b', 'text'); put('c.md', 'c', 'text')
    await bridge.trashEntry!('a.md'); await bridge.trashEntry!('b.md'); await bridge.trashEntry!('c.md')
    await bridge.deleteTrashEntry!('a.md')
    await bridge.deleteTrashEntry!('.meta.json') // 账本不是条目:不许经这个口子把它删掉
    expect(await listed(bridge)).toEqual([['b.md', 'b.md', false], ['c.md', 'c.md', false]])
    expect(Object.keys(ledger()).sort()).toEqual(['b.md', 'c.md'])
    await bridge.emptyTrash!()
    expect([...rows.keys()].filter((k) => k.startsWith('.trash/'))).toEqual([])
    expect(await bridge.listTrash!()).toEqual([])
    put('d.md', 'd', 'text')
    await bridge.trashEntry!('d.md') // 清空连账本一起删了:下一次是新建
    expect(Object.keys(ledger())).toEqual(['d.md'])
  })
})
