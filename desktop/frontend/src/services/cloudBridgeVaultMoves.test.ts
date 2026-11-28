/**
 * 云端桥(web / 手机共用)× 智库同步第 3 步:原位置库以 X/ 为根、能力头、分库(409 VAULT_MOVED / SSE vault-moved)、删库(410 / vault-deleted)。
 * 假服务端照 server microserver/amadeus 的线上形状:声明了 vault-moves 的请求看不到影子(X/ 读 404,树给 moved[]),写 X/ 回 409 VAULT_MOVED。
 *
 * B11(写回的 409 VAULT_MOVED 不许当冲突)逐个 409 分支两种情形:
 *   A. 回包带着新库 → 换路由重发,写进新库;不重载、不换名、不装载既有文件。
 *   B. 回包认不出新库(没有 vaultId)→ 这一篇停写:操作拒掉(调用方保留草稿),不重载、不换名、不强写、不当冲突交回现文。
 * 负对照(实跑过,不入库):cloudHttp.isConflict409 改回「任何 409」→ B 组全红;routed() 里去掉「换路由重发」→ A 组全红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { activeCloudViewPath, activeCloudWirePath, createCloudAmadeusBridge, setCloudNotify, type CloudBridgeCfg } from '../../../../web/src/amadeus/cloudBridge'
import { installCloudCollab } from '../../../../web/src/amadeus/cloudCollab'
import { cloudLibraryState, onCloudLibraryState, readCloudLibrary, rememberCloudLibrary, setPendingOpenNote, type CloudLibraryState } from '../../../../web/src/amadeus/cloudScope'
import { cloudLibraryRoot } from '../amadeus/lib/cloudLibraryRoot'
import { readDraft, stashDraft } from '../amadeus/unified/draftStorage'
import { readNoteSurfaceMode, writeNoteSurfaceMode } from '../amadeus/unified/viewMemory'
import { clearCloudAccountCache } from './cloudAccountCache'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { emptyDb } from '@amadeus-shared/db/schema'

const V = 'vault-default'
const T = 'vault-split'
const LEGACY = `${V}:Amadeus/Notes/`
const jwt = `header.${btoa(JSON.stringify({ userId: 'u' }))}.signature`

class FakeES {
  static all: FakeES[] = []
  private listeners = new Map<string, (e: { data: string }) => void>()
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) { FakeES.all.push(this) }
  addEventListener(type: string, fn: (e: { data: string }) => void): void { this.listeners.set(type, fn) }
  close(): void { this.closed = true }
  emit(type: string, data: unknown): void { this.listeners.get(type)?.({ data: JSON.stringify(data) }) }
  static last(): FakeES { return FakeES.all[FakeES.all.length - 1] }
}

type Row = { content: string; seq: number; kind: 'page' | 'binary' | 'file' }
interface Req { method: string; vault: string | null; route: string; path?: string; body?: Record<string, unknown>; caps: string; force?: boolean }

/** 内存里的服务端:几个库、分库记录、钩子(某个请求到达时先做点什么,例如这时候恰好分库)。 */
function fakeServer() {
  const vaults = new Map<string, Map<string, Row>>([[V, new Map()], [T, new Map()]])
  const splits: Array<{ prefix: string; to: string }> = []
  const reqs: Req[] = []
  const state = {
    librariesStatus: 200,
    /** 写 X/ 回的 409 VAULT_MOVED 带不带 vaultId(false = 认不出新库,B 组)。 */
    movedBodyHasVault: true,
    /** 删进回收站的库。 */
    deleted: new Set<string>(),
    hook: null as null | ((r: Req) => void),
  }
  const put = (v: string, path: string, content: string, kind: Row['kind'] = 'page', seq = 1) => vaults.get(v)!.set(path, { content, seq, kind })
  const split = (prefix: string, to: string) => {
    const from = vaults.get(V)!
    for (const [p, row] of [...from]) if (p.startsWith(prefix)) { from.delete(p); vaults.get(to)!.set(p.slice(prefix.length), row) } // 行搬家,seq 不变
    splits.push({ prefix, to })
  }
  const splitOf = (v: string, p: string) => (v === V ? splits.find((s) => p === s.prefix.slice(0, -1) || p.startsWith(s.prefix)) : undefined)
  const kindOf = (p: string): Row['kind'] => (/\.(md|db)$/i.test(p) ? 'page' : 'binary')
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  const handle = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const caps = headers['X-Content-Caps'] ?? ''
    const moves = caps.split(',').includes('vault-moves')
    const m = /^\/api\/amadeus\/vaults\/([^/]+)(\/.*)?$/.exec(url.pathname)
    const vault = m ? decodeURIComponent(m[1]) : null
    const route = m ? (m[2] ?? '') : url.pathname.replace(/^\/api\/amadeus/, '')
    let body: Record<string, unknown> | undefined
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    else if (init?.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<blob>']))
    const path = (url.searchParams.get('path') ?? url.searchParams.get('ref') ?? (body?.path as string | undefined)) ?? undefined
    const r: Req = { method, vault, route, path, body, caps, force: body?.force === true }
    reqs.push(r)
    state.hook?.(r)

    if (!vault) {
      if (route === '/libraries') {
        if (state.librariesStatus !== 200) return json(state.librariesStatus, { detail: 'nope' })
        if (!caps.split(',').includes('vaults')) return json(409, { code: 'CLIENT_UPGRADE_REQUIRED' })
        const libs: unknown[] = [{ id: V, kind: 'default', vaultId: V, prefix: 'Amadeus/', name: 'My Vault' }]
        if (!splits.some((s) => s.prefix === 'Notes/')) libs.push({ id: LEGACY, kind: 'legacy', vaultId: V, prefix: 'Amadeus/Notes/', name: 'Notes' })
        else libs.push({ id: T, kind: 'own', vaultId: T, prefix: 'Amadeus/', name: 'Notes', splitFrom: { splitId: 's1', vaultId: V, prefix: 'Amadeus/Notes/', at: 'x' } })
        return json(200, { generatedAt: 'x', libraries: libs })
      }
      if (route === '/vaults') return json(200, { vaults: [{ id: V, name: 'My Vault' }, { id: T, name: 'Notes' }] })
      if (route === '/shared-with-me') return json(200, { items: [] })
      if (route === '/collab/link-base') return json(200, { webOrigin: 'https://cloud.test' })
      return json(404, {})
    }
    if (state.deleted.has(vault)) return json(410, { code: 'VAULT_DELETED', purgeAt: '2030-01-01T00:00:00.000Z' })
    const files = vaults.get(vault)!
    const movedErr = (p: string) => {
      const s = splitOf(vault, p)
      if (!s) return null
      return moves ? json(409, { code: 'VAULT_MOVED', prefix: s.prefix, ...(state.movedBodyHasVault ? { vaultId: s.to } : {}), detail: 'moved' }) : json(423, { code: 'VAULT_MOVED' })
    }
    if (route === '/tree') {
      const visible = [...files].filter(([p]) => !(moves && splitOf(vault, p)))
      return json(200, {
        pages: visible.filter(([, x]) => x.kind === 'page').map(([p]) => p),
        files: visible.filter(([, x]) => x.kind !== 'page').map(([p]) => ({ path: p, size: 1 })),
        folders: [...new Set(visible.flatMap(([p]) => { const parts = p.split('/'); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')) }))],
        entries: visible.map(([p, x]) => ({ path: p, kind: x.kind, seq: x.seq })),
        seq: 1,
        ...(moves && vault === V && splits.length && state.movedBodyHasVault ? { moved: splits.map((s) => ({ prefix: s.prefix, vaultId: s.to, at: 'x' })) } : {}),
      })
    }
    if (route === '/asset-token') return json(200, { token: 'at', ttlSec: 600 })
    if (route === '/file' && method === 'GET') {
      const row = files.get(path!)
      if (!row) return json(404, { detail: 'file not found' })
      if (row.kind === 'binary') return json(400, { code: 'BINARY' })
      return json(200, { id: `id-${path}`, path, kind: row.kind, content: row.content, seq: row.seq, hash: 'h' })
    }
    if (route === '/file' && method === 'PUT') {
      const moved = movedErr(path!); if (moved) return moved
      const cur = files.get(path!)
      const base = Number(body!.baseSeq)
      if (!body!.force) {
        if (base === 0 && cur) return json(409, { code: 'EXISTS', seq: cur.seq, content: cur.content })
        if (base > 0 && (!cur || cur.seq !== base)) return json(409, { code: 'CONFLICT', seq: cur?.seq ?? 0, content: cur?.content })
      }
      const seq = (cur?.seq ?? 0) + 1
      files.set(path!, { content: String(body!.content), seq, kind: 'page' })
      return json(200, { seq, hash: 'h' })
    }
    if (route === '/binary') {
      const p = String(body!.path)
      const moved = movedErr(p); if (moved) return moved
      const cur = files.get(p)
      if (body!.ifAbsent && cur) return json(409, { code: 'EXISTS' })
      if (body!.baseSeq !== undefined && Number(body!.baseSeq) !== (cur?.seq ?? 0)) return json(409, { code: 'CONFLICT', seq: cur?.seq ?? 0 })
      const seq = (cur?.seq ?? 0) + 1
      files.set(p, { content: '<bytes>', seq, kind: kindOf(p) === 'page' ? 'page' : 'binary' })
      return json(200, { path: p, size: 1, seq })
    }
    if (route === '/move') {
      const from = String(body!.from), to = String(body!.to)
      const moved = movedErr(from) ?? movedErr(to); if (moved) return moved
      if (files.has(to)) return json(409, { code: 'EXISTS' })
      const row = files.get(from); if (!row) return json(404, {})
      files.delete(from); files.set(to, row)
      return json(200, { path: to, seq: row.seq })
    }
    if (route.startsWith('/folders')) {
      const p = String(body?.path ?? body?.parent ?? path ?? '')
      const moved = movedErr(p) ?? (body?.dest !== undefined ? movedErr(String(body.dest)) : null); if (moved) return moved
      if (route === '/folders') return json(200, { path: [body!.parent, body!.name].filter(Boolean).join('/') })
      if (route === '/folders/rename') return json(200, { path: [p.split('/').slice(0, -1).join('/'), body!.newName].filter(Boolean).join('/') })
      if (route === '/folders/move') return json(200, { path: [body!.dest, p.split('/').pop()].filter(Boolean).join('/') })
      return json(200, {})
    }
    if (route === '/asset') {
      const ref = String(url.searchParams.get('ref')).replace(/\/$/, '')
      return files.get(ref) ? new Response('bytes', { status: 200 }) : json(404, {})
    }
    if (route === '/search') {
      const q = url.searchParams.get('q') ?? ''
      const prefix = (url.searchParams.get('prefix') ?? '').replace(/\/?$/, '/')
      return json(200, [...files].filter(([p, x]) => x.kind === 'page' && x.content.includes(q) && (prefix === '/' || p.startsWith(prefix)))
        .map(([p]) => ({ path: p, title: p, snippet: q, line: 1, score: 1 })))
    }
    if (route === '/page-props') return json(200, [])
    return json(200, {})
  }
  return { vaults, splits, reqs, state, put, split, handle, files: (v: string) => vaults.get(v)! }
}

/** localStorage 替身:条目是自有可枚举属性(clearCloudAccountCache 用 Object.keys 扫),方法不可枚举。 */
function makeStorage(): Record<string, string> & Storage {
  const s = {} as Record<string, string>
  Object.defineProperties(s, {
    getItem: { value: (k: string) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null) },
    setItem: { value: (k: string, v: string) => { s[k] = String(v) } },
    removeItem: { value: (k: string) => { delete s[k] } },
    key: { value: (i: number) => Object.keys(s)[i] ?? null },
    clear: { value: () => { for (const k of Object.keys(s)) delete s[k] } },
    length: { get: () => Object.keys(s).length },
  })
  return s as Record<string, string> & Storage
}

let srv: ReturnType<typeof fakeServer>
let notes: Array<{ text: string; err: boolean }>
let store: Record<string, string> & Storage
const states: CloudLibraryState[] = []
let offState: () => void = () => {}

beforeEach(() => {
  srv = fakeServer()
  notes = []
  FakeES.all = []
  store = makeStorage()
  states.length = 0
  vi.stubGlobal('localStorage', store)
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('location', { origin: 'https://cloud.test', href: 'https://cloud.test/', reload: vi.fn(), assign: vi.fn() })
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => srv.handle(input, init)))
  setCloudNotify((text, isError) => { notes.push({ text, err: !!isError }) })
  offState = onCloudLibraryState((s) => { states.push(s) })
})
afterEach(() => {
  offState()
  vi.unstubAllGlobals()
})

const ac = new Set<AbortController>()
afterEach(() => { for (const c of ac) c.abort(); ac.clear() })

/** 按 library 开桥(默认 = 原位置库 Notes,以 Notes/ 为根)。 */
async function boot(library: string | null = LEGACY, options: Pick<CloudBridgeCfg, 'migratePluginStorage' | 'library' | 'rootPrefix'> = {}) {
  if (library) rememberCloudLibrary(library)
  const ctrl = new AbortController()
  ac.add(ctrl)
  const bridge = createCloudAmadeusBridge({ apiBase: 'https://cloud.test/api', getToken: () => jwt, onAuthError: vi.fn(), signal: ctrl.signal, ...options })
  const external: string[] = []
  bridge.onExternalChange((p) => { external.push(p) })
  const info = (await bridge.restoreVault())!
  return { bridge, info, external, stop: () => ctrl.abort(), es: () => FakeES.last() }
}

const writesTo = (v: string) => srv.reqs.filter((r) => r.vault === v && r.method !== 'GET')
const putsTo = (v: string) => srv.reqs.filter((r) => r.vault === v && (r.route === '/file' && r.method === 'PUT' || r.route === '/binary'))
const getsOf = (v: string, path: string) => srv.reqs.filter((r) => r.vault === v && r.method === 'GET' && r.route === '/file' && r.path === path)
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('B9 / E3: library views', () => {
  it('legacy library opens with Notes/ as its root; cloud notes hide the legacy prefix; root identity carries the library', async () => {
    srv.put(V, 'top.md', '# top')
    srv.put(V, 'Notes/a.md', '# a')
    srv.put(V, 'Notes/sub/b.md', '# b')
    srv.put(V, 'Notes/.forsion-vault.md', '')
    const legacy = await boot(LEGACY)
    expect(legacy.info.root).toBe(cloudLibraryRoot(V, LEGACY))
    expect(legacy.info.root).toBe(`cloud://${V}/${V}:Amadeus/Notes/`) // 与 shared onlineVaultRoot 同一拼法:不转义
    expect(legacy.info.pages.sort()).toEqual(['a.md', 'sub/b.md'])
    expect(legacy.info.folders).toEqual(['sub'])
    await legacy.bridge.writeTextFile('sub/b.md', 'edited')
    expect(srv.files(V).get('Notes/sub/b.md')!.content).toBe('edited')
    // 越出前缀一律拒(契约:新建 / 移动出前缀)
    await expect(legacy.bridge.writeTextFile('../top.md', 'x')).rejects.toThrow()
    expect(srv.files(V).get('top.md')!.content).toBe('# top')
    // 搜索带 ?prefix=,结果换回视图路径
    srv.reqs.length = 0
    const hits = await legacy.bridge.search('a')
    expect(srv.reqs.find((r) => r.route === '/search')).toBeTruthy()
    expect(hits.map((h) => h.path)).toEqual(['a.md'])
    const searchReq = (fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map(([u]) => u).find((u) => u.includes('/search'))!
    expect(new URL(searchReq).searchParams.get('prefix')).toBe('Notes')

    const cloudNotes = await boot(V)
    expect(cloudNotes.info.root).toBe(cloudLibraryRoot(V, V))
    expect(cloudNotes.info.pages).toEqual(['top.md']) // Notes/ 不露在云端笔记的根上
    expect(cloudNotes.info.folders).toEqual([])
  })

  it('B10: every request (GET included) and the SSE URL declare vaults,vault-moves', async () => {
    srv.put(V, 'Notes/a.md', '# a')
    const { bridge, es } = await boot()
    await bridge.loadPage('a.md')
    expect(srv.reqs.length).toBeGreaterThan(3)
    for (const r of srv.reqs) expect(r.caps).toBe('vaults,vault-moves')
    expect(new URL(es().url).searchParams.get('caps')).toBe('vaults,vault-moves')
  })

  it('old server without /libraries (404) falls back to GET /vaults; other failures are not an empty list', async () => {
    srv.state.librariesStatus = 404
    srv.put(V, 'Notes/a.md', '# a')
    const { info } = await boot(V)
    expect(info.pages).toEqual(['Notes/a.md']) // 老服务端:不知道原位置库,整库照旧
    expect(srv.reqs.some((r) => r.route === '/vaults')).toBe(true)

    srv.state.librariesStatus = 500
    rememberCloudLibrary(LEGACY)
    const ctrl = new AbortController(); ac.add(ctrl)
    const bridge = createCloudAmadeusBridge({ apiBase: 'https://cloud.test/api', getToken: () => jwt, onAuthError: vi.fn(), signal: ctrl.signal })
    await expect(bridge.listPages()).rejects.toBeTruthy()
    expect(readCloudLibrary()).toBe(LEGACY) // 读失败不改写选的库
  })
})

describe('E1 / E2: library list and choice', () => {
  it('collab.listLibraries reads /libraries with the caps header; 404 falls back to /vaults; switchLibrary stores the libraryId', async () => {
    srv.put(V, 'Notes/a.md', '# a')
    await boot(V)
    installCloudCollab({ apiBase: 'https://cloud.test/api', getToken: () => jwt })
    const collab = window.amadeusCollab!
    const libs = await collab.listLibraries!()
    expect(libs.map((l) => [l.id, l.kind, l.isDefault])).toEqual([[V, 'default', true], [LEGACY, 'legacy', false]])
    expect(srv.reqs.filter((r) => r.route === '/libraries').every((r) => r.caps.includes('vaults'))).toBe(true)
    expect(await collab.listVaults()).toHaveLength(2) // listVaults 语义不变:真 vault id
    collab.switchLibrary!(LEGACY)
    expect(location.reload).toHaveBeenCalled()
    expect(readCloudLibrary()).toBe(LEGACY)
    srv.state.librariesStatus = 404
    expect((await collab.listLibraries!()).map((l) => l.id)).toEqual([V, T])
    srv.state.librariesStatus = 503
    await expect(collab.listLibraries!()).rejects.toBeTruthy()
  })

  it('new key amadeus.cloudLibrary wins; an old-key-only writer (older tab) wins back; account switch clears the new key', () => {
    rememberCloudLibrary(LEGACY)
    expect(store.getItem('amadeus.cloudLibrary')).toBe(LEGACY)
    expect(store.getItem('amadeus.cloudVaultId')).toBe(V)
    expect(readCloudLibrary()).toBe(LEGACY)
    store.setItem('amadeus.cloudVaultId', T) // 只认老键的老版本标签页切了库
    expect(readCloudLibrary()).toBe(T)
    store.removeItem('amadeus.cloudLibrary')
    expect(readCloudLibrary()).toBe(T) // 读不到新键退回老键
    rememberCloudLibrary(LEGACY)
    store.setItem('amadeus_cloud_moved_from:cloud://split', 'cloud://vault/vault:Amadeus/Notes/')
    clearCloudAccountCache()
    expect(store.getItem('amadeus.cloudLibrary')).toBeNull()
    expect(store.getItem('amadeus.cloudVaultId')).toBeNull()
    expect(store.getItem('amadeus_cloud_moved_from:cloud://split')).toBeNull()
  })

  it('deep link (?vault=&note=) into a legacy folder opens that legacy library and maps the note to the view path', async () => {
    srv.put(V, 'top.md', '# top')
    srv.put(V, 'Notes/a.md', '# a')
    setPendingOpenNote(V, 'Notes/a.md')
    const { info } = await boot(V)
    expect(info.root).toBe(cloudLibraryRoot(V, LEGACY))
    expect(activeCloudViewPath('Notes/a.md')).toBe('a.md')
    expect(activeCloudWirePath('a.md')).toBe('Notes/a.md')
    setPendingOpenNote(V, 'top.md')
    const plain = await boot(V)
    expect(plain.info.root).toBe(cloudLibraryRoot(V, V))
  })

  it('a stored legacy library that was split follows splitFrom to the new vault instead of falling back to cloud notes', async () => {
    srv.put(V, 'Notes/a.md', '# a')
    srv.split('Notes/', T)
    const oldRoot = cloudLibraryRoot(V, LEGACY)
    stashDraft(oldRoot, 'a.md', 'unsaved changes', '# a', 'leaf-a')
    const { info } = await boot(LEGACY)
    expect(info.root).toBe(cloudLibraryRoot(T, T))
    expect(info.pages).toEqual(['a.md'])
    expect(readDraft(info.root, 'a.md', 'leaf-a')?.text).toBe('unsaved changes')
    expect(readDraft(oldRoot, 'a.md', 'leaf-a')).toBeNull()
  })

  it('keeps drafts previously saved under the whole-vault root on upgrade', async () => {
    srv.put(V, 'top.md', '# top')
    stashDraft(`cloud://${V}`, 'top.md', 'saved before upgrade', '# top')
    store.setItem('amadeus.cloudVaultId', V)
    const { info } = await boot(null)
    expect(info.root).toBe(`cloud://${V}`)
    expect(readDraft(info.root, 'top.md')?.text).toBe('saved before upgrade')
  })

  it('moves the last draft and note memory when an SSE move is followed by a cached reopen', async () => {
    srv.put(V, 'Notes/a.md', '# a')
    const old = await boot()
    const oldRoot = old.info.root
    const newRoot = cloudLibraryRoot(T, T)
    stashDraft(oldRoot, 'a.md', 'before move', '# a')
    srv.split('Notes/', T)
    old.es().emit('vault-moved', { prefix: 'Notes/', vaultId: T })
    expect(readCloudLibrary()).toBe(T)
    await old.bridge.listPages() // Save the new tree snapshot before the old editor unloads.
    stashDraft(oldRoot, 'a.md', 'last edit on unload', '# a')
    writeNoteSurfaceMode(oldRoot, 'a.md', 'canvas')
    old.stop()

    const migrateStorage = vi.fn(async () => {})
    const next = await boot(null, { migratePluginStorage: migrateStorage })
    expect(next.info.root).toBe(newRoot)
    expect(migrateStorage).toHaveBeenCalledExactlyOnceWith(oldRoot, newRoot)
    expect(readDraft(newRoot, 'a.md')?.text).toBe('last edit on unload')
    expect(readDraft(oldRoot, 'a.md')).toBeNull()
    expect(readNoteSurfaceMode(newRoot, 'a.md')).toBe('canvas')
    expect(readNoteSurfaceMode(oldRoot, 'a.md')).toBeNull()
  })

  it('uses the confirmed new root when reopening from the old legacy tree snapshot', async () => {
    srv.put(V, 'Notes/a.md', '# a')
    const old = await boot()
    stashDraft(old.info.root, 'a.md', 'on the old root', '# a')
    old.stop()
    srv.split('Notes/', T)
    const next = await boot(null)
    expect(next.info.root).toBe(`cloud://${T}`)
    expect(readDraft(next.info.root, 'a.md')?.text).toBe('on the old root')
  })

  it('asks the host to reopen if the split is confirmed after the legacy snapshot was published', async () => {
    srv.put(V, 'Notes/a.md', '# a')
    const first = await boot()
    first.stop()
    srv.split('Notes/', T)
    let release!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname.endsWith('/libraries')) await delayed
      return srv.handle(input, init)
    }))
    vi.useFakeTimers()
    try {
      const booting = boot(null)
      await vi.advanceTimersByTimeAsync(3_000)
      const stale = await booting
      expect(stale.info.root).toBe(first.info.root)
      release()
      await vi.waitFor(() => expect(cloudLibraryState()).toMatchObject({ kind: 'moved', reopen: true, prefix: 'Notes/' }))
      expect(readCloudLibrary()).toBe(T)
      stashDraft(stale.info.root, 'a.md', 'typed before the delayed reopen', '# a')
      await vi.advanceTimersByTimeAsync(0)
      expect(cloudLibraryState()).toMatchObject({ kind: 'moved', reopen: true })
      stale.stop()
      const next = await boot(null)
      expect(readDraft(next.info.root, 'a.md')?.text).toBe('typed before the delayed reopen')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['unverified', 'reverted'])('keeps source drafts when a cached target is %s', async (scenario) => {
    srv.put(V, 'Notes/a.md', '# a')
    const first = await boot()
    srv.split('Notes/', T)
    first.es().emit('vault-moved', { prefix: 'Notes/', vaultId: T })
    await first.bridge.listPages()
    first.stop()
    stashDraft(first.info.root, 'a.md', 'keep at the old root', '# a')
    if (scenario === 'unverified') srv.state.librariesStatus = 503
    else {
      srv.splits.length = 0
      srv.state.deleted.add(T)
    }
    const migrateStorage = vi.fn(async () => {})
    const next = await boot(null, { migratePluginStorage: migrateStorage })
    expect(next.info.root).toBe(`cloud://${T}`)
    expect(readDraft(first.info.root, 'a.md')?.text).toBe('keep at the old root')
    expect(readDraft(next.info.root, 'a.md')).toBeNull()
    expect(migrateStorage).not.toHaveBeenCalled()
  })

  it('moves drafts on explicit reopen before the destination tree has ever been cached', async () => {
    srv.put(V, 'Notes/a.md', '# a')
    const old = await boot()
    srv.split('Notes/', T)
    old.es().emit('vault-moved', { prefix: 'Notes/', vaultId: T })
    stashDraft(old.info.root, 'a.md', 'before host reopen', '# a')
    old.stop()
    srv.reqs.length = 0
    const next = await boot(null, { library: { vaultId: T, libraryId: T } })
    expect(srv.reqs.some((request) => request.route === '/libraries')).toBe(false)
    expect(next.info.root).toBe(`cloud://${T}`)
    expect(readDraft(next.info.root, 'a.md')?.text).toBe('before host reopen')
  })
})

/** 原位置库 Notes 开着(a.md 等读过 = 本会话见过),然后在**第一个写请求到达服务端时**分库成 T(读都在分库前,写撞上 409)。
 *  movedBodyHasVault=false:409 回包和树都认不出新库(B 组:这一篇只能停写)。每次一个干净的服务端和本机存储。 */
async function openedThenSplit(opts: { movedBodyHasVault?: boolean } = {}) {
  srv = fakeServer()
  store.clear()
  FakeES.all = []
  notes.length = 0
  srv.put(V, 'Notes/a.md', '# a\n')
  srv.put(V, 'Notes/db.db', '{}')
  srv.put(V, 'Notes/d.excalidraw.md', 'drawing')
  srv.put(V, 'Notes/idx.json', '{}', 'binary')
  srv.put(V, 'Notes/sub/c.md', '# c')
  const b = await boot(LEGACY)
  const page = await b.bridge.loadPage('a.md')
  await b.bridge.readTextFile('d.excalidraw.md')
  srv.state.movedBodyHasVault = opts.movedBodyHasVault ?? true
  srv.state.hook = (r) => { if (r.vault === V && r.method !== 'GET' && r.route !== '/asset-token' && !srv.splits.length) srv.split('Notes/', T) }
  srv.reqs.length = 0
  return { ...b, page }
}

describe('B11: 409 VAULT_MOVED on write is not a conflict', () => {
  it('savePage (v3): no reload, the text lands in the new vault (A); unresolvable → rejects, no reload, no recovered copy (B)', async () => {
    const a = await openedThenSplit()
    const blockId = Object.keys(a.page.blocks)[0]
    await a.bridge.savePage('a.md', a.page.manifest, { [blockId]: 'typed after split' })
    await flush()
    expect(a.external).toEqual([]) // 没走「云端更新了」重载
    expect(notes.map((n) => n.text).join()).not.toMatch(/重新载入|reload/i)
    expect(srv.files(T).get('a.md')!.content).toContain('typed after split')
    expect(srv.files(V).has('Notes/a.md')).toBe(false)
    expect(cloudLibraryState()).toMatchObject({ kind: 'moved', to: { vaultId: T, libraryId: T }, reopen: true })
    expect(store.getItem('amadeus.cloudLibrary')).toBe(T) // 刷新页面开新库

    const b = await openedThenSplit({ movedBodyHasVault: false })
    const blockB = Object.keys(b.page.blocks)[0]
    await expect(b.bridge.savePage('a.md', b.page.manifest, { [blockB]: 'draft kept' })).rejects.toBeTruthy()
    await flush()
    expect(b.external).toEqual([])
    expect(notes.map((n) => n.text).join()).not.toMatch(/重新载入|reload/i)
    expect(putsTo(V)).toHaveLength(1) // 一发,不另存 recovered 副本、不重试换名
    expect(putsTo(T)).toHaveLength(0)
  })

  it('newPage (create → 409 would load the existing file): A creates in the new vault without loading; B rejects without loading', async () => {
    const a = await openedThenSplit()
    await a.bridge.newPage('fresh.md')
    expect(srv.files(T).has('fresh.md')).toBe(true)
    expect(getsOf(V, 'Notes/fresh.md')).toHaveLength(0)
    expect(getsOf(T, 'fresh.md')).toHaveLength(0) // 没「装载既有文件」

    const b = await openedThenSplit({ movedBodyHasVault: false })
    await expect(b.bridge.newPage('fresh.md')).rejects.toBeTruthy()
    expect(getsOf(V, 'Notes/fresh.md')).toHaveLength(0)
  })

  it('saveAsset (409 → rename and retry): A keeps the same name in the new vault; B rejects after one attempt', async () => {
    const a = await openedThenSplit()
    const ref = await a.bridge.saveAsset('a.md', 'pic.png', new Uint8Array([1]))
    expect(putsTo(V)).toHaveLength(1)
    expect(putsTo(T)).toHaveLength(1)
    expect(srv.files(T).has(ref)).toBe(true) // 页面在库根:`.amadeus/<名>` 就是库内路径
    expect(putsTo(T)[0].body!.path).toBe(putsTo(V)[0].body!.path!.toString().replace(/^Notes\//, ''))

    const b = await openedThenSplit({ movedBodyHasVault: false })
    await expect(b.bridge.saveAsset('a.md', 'pic.png', new Uint8Array([1]))).rejects.toBeTruthy()
    expect(putsTo(V)).toHaveLength(1)
  })

  it('saveAttachment (409 → next free name): A keeps the original name in the new vault; B rejects without trying -1', async () => {
    const a = await openedThenSplit()
    const same = { mode: 'same' } as never
    const r = await a.bridge.saveAttachment('a.md', 'doc.pdf', new Uint8Array([1]), same)
    expect(r.base).toBe('doc.pdf')
    expect(putsTo(T).map((x) => x.body!.path)).toEqual(['doc.pdf'])

    const b = await openedThenSplit({ movedBodyHasVault: false })
    await expect(b.bridge.saveAttachment('a.md', 'doc.pdf', new Uint8Array([1]), same)).rejects.toBeTruthy()
    expect(putsTo(V)).toHaveLength(1)
  })

  it('writeTextFile plain / CAS / create: A lands in the new vault; B rejects — never force, never {ok:false} as a conflict', async () => {
    const a = await openedThenSplit()
    await a.bridge.writeTextFile('a.md', 'plain')
    expect(srv.files(T).get('a.md')!.content).toBe('plain')
    await expect(a.bridge.writeTextFile('a.md', 'cas', { base: textFingerprint('plain') })).resolves.toEqual({ ok: true })
    await expect(a.bridge.writeTextFile('new.md', 'made', { create: true })).resolves.toEqual({ ok: true })
    expect(srv.files(T).get('new.md')!.content).toBe('made')

    const b = await openedThenSplit({ movedBodyHasVault: false })
    await expect(b.bridge.writeTextFile('a.md', 'plain')).rejects.toBeTruthy()
    await expect(b.bridge.writeTextFile('a.md', 'cas', { base: textFingerprint('# a\n') })).rejects.toBeTruthy()
    await expect(b.bridge.writeTextFile('new.md', 'made', { create: true })).rejects.toBeTruthy()
    expect(srv.reqs.some((r) => r.force)).toBe(false) // 老路的「409 → 拉最新 seq 强写」没走
  })

  it('writeTextFile strictExisting (updateExisting retries on 409): A writes once in the new vault; B rejects after one PUT', async () => {
    const a = await openedThenSplit()
    await expect(a.bridge.writeTextFile('a.md', 'strict', { base: textFingerprint('# a\n'), strictExisting: true, expectedRoot: cloudLibraryRoot(V, LEGACY) }))
      .resolves.toEqual({ ok: true })
    expect(srv.files(T).get('a.md')!.content).toBe('strict')

    const b = await openedThenSplit({ movedBodyHasVault: false })
    await expect(b.bridge.writeTextFile('a.md', 'strict', { base: textFingerprint('# a\n'), strictExisting: true, expectedRoot: cloudLibraryRoot(V, LEGACY) }))
      .rejects.toBeTruthy()
    expect(putsTo(V)).toHaveLength(1)
  })

  it('writeDatabaseCas / writeDrawing: A ok in the new vault; B rejects instead of {ok:false} (which would reload and replay)', async () => {
    const a = await openedThenSplit()
    const db = emptyDb('db')
    await expect(a.bridge.writeDatabaseCas!('db.db', db, '1')).resolves.toMatchObject({ ok: true })
    await expect(a.bridge.writeDrawing!('d.excalidraw.md', 'drawing 2', textFingerprint('drawing'))).resolves.toEqual({ ok: true })
    expect(srv.files(T).get('d.excalidraw.md')!.content).toBe('drawing 2')

    const b = await openedThenSplit({ movedBodyHasVault: false })
    // 画板先:它写前现读一次,读要落在分库之前(分库后新客户端读旧位置是 404,那是「不见了」,另一条路)
    await expect(b.bridge.writeDrawing!('d.excalidraw.md', 'drawing 2', textFingerprint('drawing'))).rejects.toBeTruthy()
    await expect(b.bridge.writeDatabaseCas!('db.db', db, '1')).rejects.toBeTruthy()
  })

  it('setPageFrontmatter (409 → conflict retry, then swallow): A writes in the new vault; B rejects instead of silently dropping', async () => {
    const a = await openedThenSplit()
    await a.bridge.setPageFrontmatter!('a.md', { status: 'done' })
    expect(srv.files(T).get('a.md')!.content).toMatch(/status: done/)

    const b = await openedThenSplit({ movedBodyHasVault: false })
    await expect(b.bridge.setPageFrontmatter!('a.md', { status: 'done' })).rejects.toBeTruthy()
    expect(putsTo(V)).toHaveLength(1)
  })

  it('sidecar text (writeBinaryText create/base → {ok:false,current} on 409): A ok; B rejects', async () => {
    const a = await openedThenSplit()
    await expect(a.bridge.writeTextFile('idx2.json', '{"a":1}', { create: true })).resolves.toEqual({ ok: true })
    expect(srv.files(T).has('idx2.json')).toBe(true)

    const b = await openedThenSplit({ movedBodyHasVault: false })
    await expect(b.bridge.writeTextFile('idx2.json', '{"a":1}', { create: true })).rejects.toBeTruthy()
  })

  it('trash ledger (409 → replay with the seq from the body, up to 3 times): A ok in the new vault; B rejects after one ledger write', async () => {
    // 分库恰好落在「搬进 .trash 之后、写账本之前」:撞上 409 的是账本那一发
    const splitAtLedger = (r: Req) => { if (r.route === '/binary' && r.vault === V && !srv.splits.length) srv.split('Notes/', T) }
    const a = await openedThenSplit()
    srv.state.hook = splitAtLedger
    await a.bridge.trashEntry!('a.md')
    expect(srv.files(T).has('.trash/a.md')).toBe(true)
    expect(srv.files(T).has('.trash/.meta.json')).toBe(true)
    expect(srv.reqs.filter((r) => r.route === '/binary').map((r) => r.vault)).toEqual([V, T])

    const b = await openedThenSplit({ movedBodyHasVault: false })
    srv.state.hook = splitAtLedger
    await expect(b.bridge.trashEntry!('a.md')).rejects.toBeTruthy()
    expect(srv.reqs.filter((r) => r.route === '/binary')).toHaveLength(1) // 不拿 409 回包里的 seq 重放
  })

  it('moves and folder ops (409 → "already exists"): A moves in the new vault; B surfaces the error untranslated', async () => {
    const a = await openedThenSplit()
    await expect(a.bridge.movePage('a.md', 'sub')).resolves.toBe('sub/a.md')
    expect(srv.files(T).has('sub/a.md')).toBe(true)
    await expect(a.bridge.createFolder('', 'box')).resolves.toBe('box')

    const b = await openedThenSplit({ movedBodyHasVault: false })
    const exists = /已存在|exists/i
    for (const op of [
      () => b.bridge.movePage('a.md', 'sub'),
      () => b.bridge.renamePageFile!('a.md', 'b', false),
      () => b.bridge.renameDbFile!('db.db', 'db2'),
      () => b.bridge.createFolder('', 'box'),
      () => b.bridge.renameFolder('sub', 'sub2'),
      () => b.bridge.moveFolder('sub', 'box'),
    ]) {
      const e = await op().then(() => null, (x: unknown) => x as Error)
      expect(e).toBeTruthy()
      expect(String(e?.message)).not.toMatch(exists)
    }
  })

  it('recovered copy (409 → next suffix): a split right before the recovered write lands it in the new vault once; unresolvable stops after one name', async () => {
    srv.put(V, 'Notes/a.md', '# a\n')
    const a = await boot(LEGACY)
    await a.bridge.loadPage('a.md')
    srv.files(V).delete('Notes/a.md') // 别处真删了(不是分库)
    srv.state.hook = (r) => { if (r.method === 'PUT' && /recovered/.test(String(r.path)) && !srv.splits.length) srv.split('Notes/', T) }
    srv.reqs.length = 0
    await a.bridge.writeTextFile('a.md', 'draft')
    const recovered = [...srv.files(T).keys()].filter((p) => /recovered/.test(p))
    expect(recovered).toHaveLength(1)
    expect(srv.reqs.filter((r) => r.method === 'PUT' && /recovered/.test(String(r.path)) && r.vault === V)).toHaveLength(1)

    srv = fakeServer()
    store.clear()
    srv.put(V, 'Notes/a.md', '# a\n')
    const b = await boot(LEGACY)
    await b.bridge.loadPage('a.md')
    srv.files(V).delete('Notes/a.md')
    srv.state.movedBodyHasVault = false
    srv.state.hook = (r) => { if (r.method === 'PUT' && /recovered/.test(String(r.path)) && !srv.splits.length) srv.split('Notes/', T) }
    srv.reqs.length = 0
    await expect(b.bridge.writeTextFile('a.md', 'draft')).rejects.toBeTruthy()
    expect(srv.reqs.filter((r) => r.method === 'PUT' && /recovered/.test(String(r.path)))).toHaveLength(1) // 不换后缀再试
  })

  it('source scan: the bridge has no bare is409() left (every 409 branch goes through isConflict409)', () => {
    const src = readFileSync(resolve(__dirname, '../../../../web/src/amadeus/cloudBridge.ts'), 'utf8')
    expect(src.match(/\bis409\(/g) ?? []).toEqual([])
  })
})

describe('B11: the first sign of a split can be a 404 (no shadow for vault-moves clients)', () => {
  it('reset then vault-moved: open note re-read 404 → learn moved[] from the tree → read and write in the new vault; no recovered copy, no "deleted elsewhere"', async () => {
    srv.put(V, 'Notes/a.md', '# a\n')
    const b = await boot(LEGACY)
    await b.bridge.loadPage('a.md')
    srv.split('Notes/', T)
    srv.reqs.length = 0
    const es = b.es()
    es.emit('reset', {}) // 服务端先发 reset ……
    await expect(b.bridge.reconcilePage('a.md', { title: 'x', blocks: [] } as never, {})).resolves.toBeTruthy() // …… 回灌开着的笔记:404 → 认分库 → 到新库读
    es.emit('vault-moved', { prefix: 'Notes/', vaultId: T }) // …… 再发 vault-moved(已经认过,不重复)
    await b.bridge.writeTextFile('a.md', 'after split')
    expect(srv.files(T).get('a.md')!.content).toBe('after split')
    expect([...srv.files(T).keys()].some((p) => /recovered/.test(p))).toBe(false)
    expect(notes.filter((n) => n.err)).toEqual([])
    expect(states.filter((s) => s.kind === 'moved')).toHaveLength(1)
    // 事件流换到新库重起
    expect(es.closed).toBe(true)
    expect(FakeES.last().url).toContain(`/vaults/${T}/events`)
  })

  it('SSE vault-moved alone reopens on the new vault (state reopen:true), writes follow', async () => {
    srv.put(V, 'Notes/a.md', '# a\n')
    const b = await boot(LEGACY)
    await b.bridge.loadPage('a.md')
    srv.split('Notes/', T)
    b.es().emit('vault-moved', { prefix: 'Notes/', vaultId: T })
    expect(cloudLibraryState()).toEqual({ kind: 'moved', from: { vaultId: V, libraryId: LEGACY }, to: { vaultId: T, libraryId: T }, prefix: 'Notes/', reopen: true })
    await b.bridge.writeTextFile('a.md', 'x')
    expect(srv.files(T).get('a.md')!.content).toBe('x')
    expect(putsTo(V)).toHaveLength(0)
  })

  it('treats an Amadeus folder name as a relative split prefix on the wire', async () => {
    srv.put(V, 'Amadeus/a.md', '# a')
    const first = await boot(null, { library: { vaultId: V, libraryId: `${V}:Amadeus/Amadeus/` }, rootPrefix: 'Amadeus/Amadeus/' })
    srv.split('Amadeus/', T)
    first.es().emit('vault-moved', { prefix: 'Amadeus/', vaultId: T })
    expect(cloudLibraryState()).toMatchObject({ kind: 'moved', reopen: true, to: { vaultId: T } })
    stashDraft(first.info.root, 'a.md', 'draft from the folder', '# a')
    first.stop()
    const next = await boot(null, { library: { vaultId: T, libraryId: T } })
    expect(readDraft(next.info.root, 'a.md')?.text).toBe('draft from the folder')
  })

  it('cloud notes view: a stale editor on an excluded/moved prefix writes into the new vault, the prefix disappears from the tree', async () => {
    srv.put(V, 'top.md', '# top')
    srv.put(V, 'Notes/a.md', '# a\n')
    srv.state.librariesStatus = 404 // 不知道原位置库:Notes/ 露在整库里(老服务端那种),然后分库
    const b = await boot(V)
    await b.bridge.loadPage('Notes/a.md')
    srv.state.librariesStatus = 200
    srv.split('Notes/', T)
    await b.bridge.writeTextFile('Notes/a.md', 'stale editor')
    expect(srv.files(T).get('a.md')!.content).toBe('stale editor')
    expect(await b.bridge.listPages()).toEqual(['top.md'])
    expect(cloudLibraryState()).toMatchObject({ kind: 'moved', prefix: 'Notes/', reopen: false })
  })
})

describe('B12 / E4: deleted vault', () => {
  it('reads the handshake 410 obscured by EventSource and closes the write gate', async () => {
    srv.put(V, 'a.md', '# a')
    const { bridge, es } = await boot(V)
    srv.state.deleted.add(V)
    es().onerror?.()
    await vi.waitFor(() => expect(cloudLibraryState()).toMatchObject({ kind: 'deleted', vaultId: V, purgeAt: '2030-01-01T00:00:00.000Z' }))
    expect(srv.reqs.filter((r) => r.route === '/events').map((r) => r.caps)).toEqual(['vaults,vault-moves'])
    const before = srv.reqs.length
    await expect(bridge.writeTextFile('a.md', 'pending')).rejects.toMatchObject({ status: 410 })
    expect(srv.reqs).toHaveLength(before)
  })

  it('keeps a generic handshake failure out of the deleted state', async () => {
    srv.put(V, 'a.md', '# a')
    const { bridge, es } = await boot(V)
    es().onerror?.() // The fake server replies 404 to the handshake probe for a live vault.
    await flush()
    expect(cloudLibraryState()).toMatchObject({ kind: 'open', vaultId: V })
    await bridge.writeTextFile('a.md', 'still live')
    expect(srv.files(V).get('a.md')?.content).toBe('still live')
  })

  it('410 VAULT_DELETED: stop writing, nothing deleted locally, state handed up; later writes send no request', async () => {
    srv.put(V, 'Notes/a.md', '# a\n')
    const b = await boot(LEGACY)
    await b.bridge.loadPage('a.md')
    srv.state.deleted.add(V)
    await expect(b.bridge.writeTextFile('a.md', 'x')).rejects.toBeTruthy()
    expect(cloudLibraryState()).toEqual({ kind: 'deleted', vaultId: V, libraryId: LEGACY, purgeAt: '2030-01-01T00:00:00.000Z' })
    const before = srv.reqs.length
    await expect(b.bridge.writeTextFile('a.md', 'y')).rejects.toBeTruthy()
    await expect(b.bridge.saveAsset('a.md', 'p.png', new Uint8Array([1]))).rejects.toBeTruthy()
    expect(srv.reqs.length).toBe(before) // 停写:一发都没出去
    expect(srv.reqs.some((r) => r.method === 'DELETE')).toBe(false)
    expect(b.es().closed).toBe(true)
    expect(store.getItem('amadeus.cloudLibrary')).toBe(LEGACY) // 选的库不改(上层决定退回哪里)
  })

  it('SSE vault-deleted: the event loop stops (no reconnect), state handed up', async () => {
    srv.split('Notes/', T) // T 出现在 /libraries 里(独立库)
    srv.put(T, 'a.md', '# a')
    const b = await boot(T)
    const es = b.es()
    const n = FakeES.all.length
    es.emit('vault-deleted', { purgeAt: '2030-01-01T00:00:00.000Z' })
    expect(cloudLibraryState()).toMatchObject({ kind: 'deleted', vaultId: T })
    expect(es.closed).toBe(true)
    es.onerror?.()
    await new Promise((r) => setTimeout(r, 30))
    expect(FakeES.all.length).toBe(n)
  })
})
