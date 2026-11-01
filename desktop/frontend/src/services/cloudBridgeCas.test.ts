import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCloudAmadeusBridge } from '../../../../web/src/amadeus/cloudBridge'
import { blankDrawing, parseDrawing } from '@amadeus-shared/excalidraw/format'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { serializeDb, type DbFile } from '@amadeus-shared/db/schema'

vi.mock('../amadeus/store/pageStore', () => ({ onNotePathGone: () => () => {}, usePageStore: { subscribe: () => () => {} } }))
vi.mock('../amadeus/store/automationKick', () => ({ kickAutomation: () => {} }))
const state = vi.hoisted(() => ({ bridge: null as any }))
vi.mock('../amadeus/api', () => ({ amadeus: new Proxy({}, { get: (_t, key) => state.bridge?.[key] }) }))
const { useDbStore, dbBusy } = await import('../amadeus/store/dbStore')
let source: string, seq: number, attempts: any[], beforePut: (() => void) | undefined, offline = false
const drawing = (...ids: string[]) => blankDrawing(JSON.stringify({ elements: ids.map(id => ({ id, version: 1, versionNonce: 1 })), appState: {}, files: {} }))
const db = (): DbFile => ({ version: 2, name: 'T', columns: [{ id: 'c', name: 'Text', type: 'text' }], rows: [] })
beforeEach(async () => {
  seq = 1; source = drawing(); attempts = []; beforePut = undefined; offline = false
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  vi.stubGlobal('location', { origin: 'https://test' })
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/vaults')) return Response.json({ vaults: [{ id: 'v' }] })
    if (url.pathname.endsWith('/tree')) return Response.json({ pages: ['board.excalidraw.md'], files: [{ path: 'T.db' }], folders: [], seq })
    if (url.pathname.endsWith('/file')) {
      if (offline) throw Error('offline')
      if (init.method === 'PUT') {
        const data = JSON.parse(String(init.body)); attempts.push(data); beforePut?.()
        if (data.baseSeq !== seq) return Response.json({ seq, content: source }, { status: 409 })
        source = data.content; seq++; return Response.json({ seq })
      }
      return Response.json({ content: source, seq })
    }
    return Response.json({})
  }))
  state.bridge = createCloudAmadeusBridge({ apiBase: 'https://test/api', getToken: () => 'token', onAuthError: vi.fn() })
  await state.bridge.restoreVault()
  useDbStore.setState(s => ({ entries: {}, gen: s.gen + 1 }))
})
afterEach(() => { useDbStore.setState(s => ({ entries: {}, gen: s.gen + 1 })); vi.unstubAllGlobals() })
it('rejects an old drawing fingerprint even after another read advanced the bridge seq', async () => {
  const old = textFingerprint(source)
  source = drawing('B'); seq++
  await state.bridge.readDrawing('board.excalidraw.md', 'board.excalidraw.md')
  expect(await state.bridge.writeDrawing('board.excalidraw.md', drawing('A'), old)).toMatchObject({ ok: false })
  expect(attempts).toHaveLength(0); expect(parseDrawing(source)?.sceneJson).toContain('B')
})
it('repeated drawing conflicts never force the original snapshot', async () => {
  source = drawing('B')
  beforePut = () => { source = drawing('B', 'C'); seq++ }
  for (let i = 0; i < 2; i++) {
    const base = textFingerprint(source)
    expect(await state.bridge.writeDrawing('board.excalidraw.md', drawing('A', 'B', 'C'), base)).toMatchObject({ ok: false })
  }
  expect(attempts).toHaveLength(2); expect(attempts.every(x => !x.force)).toBe(true)
  expect(parseDrawing(source)?.sceneJson).toContain('C')
})
it('the actual database store replays local rows after a remote CAS conflict', async () => {
  source = serializeDb(db()); await useDbStore.getState().reload('T.db', 'T.db')
  useDbStore.getState().mutate('T.db', d => ({ ...d, rows: [...d.rows, { id: 'local', cells: { c: 'local' } }] }))
  source = serializeDb({ ...db(), rows: [{ id: 'remote', cells: { c: 'remote' } }] }); seq++
  await useDbStore.getState().flushAll(true)
  expect(JSON.parse(source).rows.map((r: any) => r.id).sort()).toEqual(['local', 'remote'])
  expect(attempts).toHaveLength(2); expect(dbBusy('T.db')).toBe(false)
})
it('strict database flush retains pending operations on network failure and recovers', async () => {
  source = serializeDb(db()); await useDbStore.getState().reload('T.db', 'T.db')
  useDbStore.getState().mutate('T.db', d => ({ ...d, rows: [{ id: 'local', cells: {} }] }))
  offline = true
  await expect(useDbStore.getState().flushAll(true)).rejects.toThrow()
  expect(dbBusy('T.db')).toBe(true); offline = false
  await useDbStore.getState().flushAll(true)
  expect(JSON.parse(source).rows.map((r: any) => r.id)).toEqual(['local'])
})
