import { afterEach, expect, it, vi } from 'vitest'
import { blankDrawing, parseDrawing } from '@amadeus-shared/excalidraw/format'
import { readBoard } from '@amadeus-shared/excalidraw/board'
import { textFingerprint } from '@amadeus-shared/writeConflict'

vi.mock('./pageStore', () => ({ onNotePathGone: () => () => {}, usePageStore: { getState: () => ({ vaultRoot: '/vault' }), subscribe: () => () => {} } }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const ref = 'board.excalidraw.md'
const scene = (id: string) => JSON.stringify({ elements: [{ id, version: 1, versionNonce: 1 }], files: { [id]: { dataURL: `image-${id}` } } })
it('two independent renderer realms read one base through a barrier, CAS retries preserve A+B and both converge', async () => {
  vi.useFakeTimers()
  let source = blankDrawing(JSON.stringify({ elements: [] }))
  let holdReads = false
  let reads = 0
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const subscribers: Array<(p: string) => void> = []
  let commits = 0
  const makeRealm = async () => {
    vi.resetModules()
    const origin = subscribers.length
    vi.stubGlobal('window', { addEventListener: () => {}, amadeus: {
      onExternalChange: (fn: (p: string) => void) => { subscribers.push(fn); return () => {} },
      readDrawing: async () => {
        const read = source
        if (holdReads && ++reads <= 2) { if (reads === 2) release(); await gate }
        return { status: 'ok', path: ref, source: read }
      },
      writeDrawing: async (_p: string, next: string, base: string) => {
        if (base !== textFingerprint(source)) return { ok: false, current: source }
        source = next
        commits++
        for (const [i, fn] of subscribers.entries()) if (i !== origin) fn(ref)
        return { ok: true }
      },
    } })
    const { useDrawStore } = await import('./drawingStore')
    await useDrawStore.getState().load(ref, ref)
    return useDrawStore
  }
  const a = await makeRealm()
  const b = await makeRealm()
  a.getState().save(ref, scene('A'))
  b.getState().save(ref, scene('B'))
  holdReads = true
  await Promise.all([a.getState().flushAll(true), b.getState().flushAll(true)])
  await vi.advanceTimersByTimeAsync(0)
  const final = JSON.parse(parseDrawing(source)!.sceneJson)
  expect(final.elements.map((e: any) => e.id).sort()).toEqual(['A', 'B'])
  expect(Object.keys(final.files).sort()).toEqual(['A', 'B'])
  for (const realm of [a, b]) expect(realm.getState().seedFor(ref)?.elements?.map((e: { id: string }) => e.id).sort()).toEqual(['A', 'B'])
  expect(commits).toBe(2)
})

it('CAS conflicts retain new pending strokes and failed settings until a later strict flush succeeds', async () => {
  vi.useFakeTimers()
  vi.resetModules()
  let source = blankDrawing(JSON.stringify({ elements: [] }))
  let failing = true
  let store: typeof import('./drawingStore')['useDrawStore']
  let added = false
  vi.stubGlobal('window', { addEventListener: () => {}, amadeus: {
    readDrawing: async () => ({ status: 'ok', path: ref, source }),
    writeDrawing: async (_p: string, next: string, base: string) => {
      if (!added) { added = true; store.getState().save(ref, JSON.stringify({ elements: [{ id: 'A', version: 1 }, { id: 'later', version: 1 }] })) }
      if (failing || base !== textFingerprint(source)) return { ok: false, current: source }
      source = next
      return { ok: true }
    },
  } })
  store = (await import('./drawingStore')).useDrawStore
  await store.getState().load(ref, ref)
  store.getState().save(ref, scene('A'))
  await store.getState().setSettings(ref, { paper: 'A4' })
  await expect(store.getState().flushAll(true)).rejects.toThrow('could not be saved')
  failing = false
  await store.getState().flushAll(true)
  expect(JSON.parse(parseDrawing(source)!.sceneJson).elements.map((e: any) => e.id).sort()).toEqual(['A', 'later'])
  expect(readBoard(source).paper).toBe('A4')
})
