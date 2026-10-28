import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import path from 'node:path'
import { blankDrawing, parseDrawing } from '@amadeus-shared/excalidraw/format'
import { fileReferenceKey } from './fileIdentity'

vi.mock('./pageStore', () => ({ onNotePathGone: () => () => {}, usePageStore: { getState: () => ({ vaultRoot: '/vault' }), subscribe: () => () => {} } }))
vi.mock('./automationKick', () => ({ kickAutomation: () => {} }))

const resolve = (page: string, ref: string): string => page === ref ? ref : path.posix.normalize(path.posix.join(path.posix.dirname(page), ref))
beforeEach(() => { vi.resetModules(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('relative database refs in A/B resolve independently, while aliases share pending edits and one write queue', async () => {
  const disk = new Map(['A', 'B'].map(dir => [`${dir}/data.db`, { version: 1, name: dir, columns: [], rows: [] as Array<{ id: string; cells: {} }> }]))
  const readDatabase = vi.fn(async (page: string, ref: string) => {
    const p = resolve(page, ref)
    return { status: 'ok', path: p, data: structuredClone(disk.get(p)) }
  })
  const writeDatabase = vi.fn(async (p: string, data: any) => { disk.set(p, structuredClone(data)) })
  vi.stubGlobal('window', { amadeus: { readDatabase, writeDatabase }, addEventListener: () => {} })
  const { useDbStore } = await import('./dbStore')
  await useDbStore.getState().load('A/note.md', './data.db')
  await useDbStore.getState().load('B/note.md', './data.db')
  expect(readDatabase).toHaveBeenCalledTimes(2)
  const a = fileReferenceKey('A/note.md', './data.db')
  const b = fileReferenceKey('B/note.md', './data.db')
  expect(useDbStore.getState().entries[a].data?.name).toBe('A')
  expect(useDbStore.getState().entries[b].data?.name).toBe('B')
  useDbStore.getState().mutate(b, d => ({ ...d, rows: [...d.rows, { id: 'belongs-to-B', cells: {} }] }))
  await useDbStore.getState().load('B/data.db', 'B/data.db')
  expect(useDbStore.getState().entries['B/data.db']).toBe(useDbStore.getState().entries[b])
  useDbStore.getState().mutate('B/data.db', d => ({ ...d, rows: [...d.rows, { id: 'alias-edit', cells: {} }] }))
  await useDbStore.getState().flushAll(true)
  expect(disk.get('A/data.db')!.rows).toEqual([])
  expect(disk.get('B/data.db')!.rows.map(r => r.id)).toEqual(['belongs-to-B', 'alias-edit'])
  expect(writeDatabase).toHaveBeenCalledTimes(1)
})

it('relative drawing refs in A/B save to their own files and full-path aliases see pending scene', async () => {
  const disk = new Map(['A', 'B'].map(dir => [`${dir}/board.excalidraw.md`, blankDrawing(JSON.stringify({ elements: [{ id: dir, version: 1 }] }))]))
  const readDrawing = vi.fn(async (page: string, ref: string) => { const p = resolve(page, ref); return { status: 'ok', path: p, source: disk.get(p) } })
  const writeDrawing = vi.fn(async (p: string, source: string) => { disk.set(p, source) })
  vi.stubGlobal('window', { amadeus: { readDrawing, writeDrawing }, addEventListener: () => {} })
  const { useDrawStore } = await import('./drawingStore')
  await useDrawStore.getState().load('A/note.md', './board.excalidraw.md')
  await useDrawStore.getState().load('B/note.md', './board.excalidraw.md')
  expect(readDrawing).toHaveBeenCalledTimes(2)
  const b = fileReferenceKey('B/note.md', './board.excalidraw.md')
  const scene = JSON.stringify({ elements: [{ id: 'B', version: 1 }, { id: 'new-B', version: 1 }] })
  useDrawStore.getState().save(b, scene)
  await useDrawStore.getState().load('B/board.excalidraw.md', 'B/board.excalidraw.md')
  expect(useDrawStore.getState().seedFor('B/board.excalidraw.md')).toEqual(JSON.parse(scene))
  await useDrawStore.getState().flushAll(true)
  expect(JSON.parse(parseDrawing(disk.get('A/board.excalidraw.md')!)!.sceneJson).elements.map((e: any) => e.id)).toEqual(['A'])
  expect(JSON.parse(parseDrawing(disk.get('B/board.excalidraw.md')!)!.sceneJson).elements.map((e: any) => e.id)).toEqual(['B', 'new-B'])
})
