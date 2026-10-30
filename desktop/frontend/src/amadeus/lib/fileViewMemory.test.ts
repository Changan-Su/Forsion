// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { fileViewKey, flushFileViews, readFileView, remapFileViews, writeFileView } from './fileViewMemory'
afterEach(() => { flushFileViews(); localStorage.clear(); vi.restoreAllMocks() })

it('keeps pending viewport changes through immediate remounts, separated by vault, file and embedding', () => {
  const key = fileViewKey('drawing', '/a', 'board.md')
  const view = { x: -123, y: -456, z: 0.75 }
  writeFileView('drawing', key, view)
  expect(readFileView('drawing', key)).toEqual(view)
  for (const other of [fileViewKey('drawing', '/b', 'board.md'), fileViewKey('drawing', '/a', 'other.md'), fileViewKey('drawing', '/a', 'board.md', 'note.md')]) expect(readFileView('drawing', other)).toBeNull()
  flushFileViews()
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(view)
})

it('does not overwrite another window\'s file when it flushes', () => {
  const mine = fileViewKey('image', '/v', 'a.png'), theirs = fileViewKey('pdf', '/v', 'b.pdf')
  writeFileView('image', mine, { actual: true, top: 50, left: 20 })
  const remote = { page: 8, scale: '1.5', top: 2345, left: 30 }
  localStorage.setItem(theirs, JSON.stringify(remote))
  flushFileViews()
  expect(readFileView('pdf', theirs)).toEqual(remote)
})

it('moves pending state and embedding context with a folder, keeping other vaults intact', () => {
  const key = fileViewKey('drawing', '/v', 'old/b.md', 'old/n.md'), other = fileViewKey('drawing', '/w', 'old/b.md')
  const view = { x: 20, y: -100, z: 2 }
  writeFileView('drawing', key, view); writeFileView('drawing', other, view)
  remapFileViews('/v', 'old', 'new', true)
  expect(readFileView('drawing', fileViewKey('drawing', '/v', 'new/b.md', 'new/n.md'))).toEqual(view)
  expect(readFileView('drawing', key)).toBeNull()
  expect(readFileView('drawing', other)).toEqual(view)
})

it('rejects malformed state and preserves session memory on unavailable storage', () => {
  const key = fileViewKey('drawing', '/v', 'b.md')
  localStorage.setItem(key, '{broken')
  expect(readFileView('drawing', key)).toBeNull()
  writeFileView('drawing', key, { x: 1, y: 2, z: NaN })
  expect(localStorage.getItem(key)).toBe('{broken')
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
  writeFileView('drawing', key, { x: 1, y: 2, z: 1 })
  flushFileViews()
  expect(readFileView('drawing', key)).toEqual({ x: 1, y: 2, z: 1 })
  spy.mockRestore()
})

it('retains old state when a rename cannot persist the replacement', () => {
  const old = fileViewKey('media', '/v', 'a.wav')
  writeFileView('media', old, { time: 72, rate: 1.5 })
  const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
  remapFileViews('/v', 'a.wav', 'b.wav', false)
  expect(readFileView('media', old)).toEqual({ time: 72, rate: 1.5 })
  spy.mockRestore()
})
