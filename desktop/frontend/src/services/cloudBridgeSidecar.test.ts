/**
 * 云桥(web / mobile 共用):非 .md / .db 的文本文件(插件的旁挂 .json、导出的 .canvas)读写落到二进制端点(2026-10-09)。
 * 起因:服务端按扩展名分 kind,文本端点对这类路径答 400(写 BINARY_PATH / 读 BINARY)—— 手机缺省用云端库,
 * 插件的索引 / 缓存 / 快照全写不下、别的设备传上来的也读不回。桌面同步引擎本来就按二进制传它们,所以两端是同一行。
 * 假服务端的判据镜像 server/microserver/amadeus(同 mobile/scripts/plugin-install.e2e.cjs 的 startFakeCloud;那台是整条
 * 插件链路的端到端,这里钉它覆盖不到的仅新建 / 比对交换写两条分支)。
 * 负对照(实跑过):writeTextFile 去掉分流 → 三条写的用例红(HTTP 400);fetchAssetExact 去掉库根探测 → 读的那条红(读成 OTHER)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudAmadeusBridge } from '../../../../web/src/amadeus/cloudBridge'
import { textFingerprint } from '../../../shared/amadeus/writeConflict'

type Row = { kind: 'text' | 'binary'; body: string; seq: number }
const rows = new Map<string, Row>()
const calls: string[] = []
/** 下一次 POST /binary 判 CAS 之前,别的设备先写进来的内容(模拟「取完 seq 之后被抢先」)。 */
let raceWith: string | null = null

const isText = (p: string): boolean => /\.(md|db)$/i.test(p)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })
const put = (p: string, body: string, kind: Row['kind']): number => {
  const seq = (rows.get(p)?.seq ?? 0) + 1
  rows.set(p, { kind, body, seq })
  return seq
}

beforeEach(() => {
  rows.clear(); calls.length = 0; raceWith = null
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
    calls.push(`${method} ${end}`)
    if (end === 'vaults') return json(200, { vaults: [{ id: 'v1' }] })
    if (end === 'tree') {
      const entries = [...rows].map(([path, r]) => ({ path, kind: r.kind === 'text' ? 'page' : 'binary', seq: r.seq }))
      return json(200, { pages: [], files: entries.map((e) => ({ path: e.path, size: 0 })), folders: [], entries, seq: 1 })
    }
    if (end === 'file' && method === 'GET') {
      const r = rows.get(url.searchParams.get('path') ?? '')
      if (!r) return json(404, { detail: 'file not found' })
      if (r.kind === 'binary') return json(400, { code: 'BINARY', detail: 'binary file: use GET /vaults/:v/asset' })
      return json(200, { content: r.body, seq: r.seq, hash: 'h' })
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
      if (raceWith !== null) { put(p, raceWith, 'binary'); raceWith = null }
      const cur = rows.get(p)
      if (cur && form.get('ifAbsent')) return json(409, { code: 'EXISTS' })
      const base = form.get('baseSeq')
      if (base !== null) {
        const n = Number(base)
        if (n === 0 && cur) return json(409, { code: 'EXISTS', seq: cur.seq })
        if (n > 0 && cur?.seq !== n) return json(409, { code: 'CONFLICT', seq: cur?.seq ?? 0 })
      }
      const body = await (form.get('file') as Blob).text()
      return json(200, { path: p, size: body.length, seq: put(p, body, 'binary') })
    }
    if (end === 'asset') {
      const ref = url.searchParams.get('ref')
      if (!ref) return json(400, { detail: 'ref required' })
      let r = rows.get(ref)
      // 不带 '/' 的 ref:精确找不到就按文件名全库兜底(跳过点开头的路径)
      if (!r && !ref.includes('/')) r = [...rows].find(([k]) => !k.split('/').some((s) => s.startsWith('.')) && k.split('/').pop() === ref)?.[1]
      return r ? new Response(r.body) : json(404, { detail: 'asset not found' })
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
    expect(rows.get(IDX)).toEqual({ kind: 'binary', body: '{"decks":[1]}', seq: 2 })
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
    expect(new TextDecoder().decode(await bridge.readVaultBytes('sub/queue.json'))).toBe('OTHER')
  })

  it('create: writes only when absent, otherwise hands back what is there', async () => {
    const bridge = boot()
    expect(await bridge.writeTextFile('n.canvas', '{"a":1}', { create: true })).toEqual({ ok: true })
    expect(await bridge.writeTextFile('n.canvas', '{"b":2}', { create: true })).toEqual({ ok: false, current: '{"a":1}' })
    expect(rows.get('n.canvas')?.body).toBe('{"a":1}')
  })

  it('base: writes on a matching baseline, refuses a stale one, and refuses when another device wins the race', async () => {
    const bridge = boot()
    put('a.txt', 'v1', 'binary')
    expect(await bridge.writeTextFile('a.txt', 'v2', { base: textFingerprint('v1') })).toEqual({ ok: true })
    expect(await bridge.writeTextFile('a.txt', 'v3', { base: textFingerprint('v1') })).toEqual({ ok: false, current: 'v2' })
    expect(rows.get('a.txt')?.body).toBe('v2')
    raceWith = 'theirs' // 本端取完 seq、比对通过之后,别的设备先写了一版
    expect(await bridge.writeTextFile('a.txt', 'mine', { base: textFingerprint('v2') })).toEqual({ ok: false, current: 'theirs' })
    expect(rows.get('a.txt')?.body).toBe('theirs')
    expect(await bridge.writeTextFile('new.txt', 'x', { base: textFingerprint('') })).toEqual({ ok: true }) // 基线「没有这个文件」
  })
})
