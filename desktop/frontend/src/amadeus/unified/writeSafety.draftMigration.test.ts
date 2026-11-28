import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateDraftRoot, readDraft, stashDraft } from './draftStorage'

const from = 'cloud://vault/vault:Amadeus/Notes/'
const to = 'cloud://split'
const key = (root: string, path: string) => `amadeus.unsavedDraft:${root}:${path}`

describe('cloud draft migration', () => {
  const data = new Map<string, string>()
  const failRead = new Set<string>()
  const failWrite = new Set<string>()
  let afterWrite: ((key: string) => void) | undefined
  beforeEach(() => {
    data.clear()
    failRead.clear()
    failWrite.clear()
    afterWrite = undefined
    vi.stubGlobal('localStorage', {
      get length() { return data.size },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => { if (failRead.has(k)) throw new Error('Read failure'); return data.get(k) ?? null },
      setItem: (k: string, value: string) => {
        if (failWrite.has(k)) throw new Error('Write failure')
        data.set(k, value)
        afterWrite?.(k)
      },
      removeItem: (k: string) => data.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('moves every available slot, keeps occupied slots at both roots and leaves other roots alone', () => {
    const path = 'sub/a.md'
    stashDraft(from, path, 'old plain', 'base')
    stashDraft(from, path, 'old first', 'base', 'leaf-1')
    stashDraft(from, path, 'old second', 'base', 'leaf-2')
    stashDraft(to, path, 'new first', 'base', 'leaf-1')
    stashDraft('cloud://vault', path, 'another library', 'base')
    migrateDraftRoot(from, to)
    const result = [...data]
    migrateDraftRoot(from, to)
    expect([...data]).toEqual(result)
    expect(readDraft(to, path)?.text).toBe('old plain')
    expect(readDraft(to, path, 'leaf-1')?.text).toBe('new first')
    expect(readDraft(to, path, 'leaf-2')?.text).toBe('old second')
    expect(readDraft(from, path, 'leaf-1')?.text).toBe('old first')
    expect(readDraft(from, path, 'leaf-2')).toBeNull()
    expect(readDraft('cloud://vault', path)?.text).toBe('another library')
  })

  it('keeps the original when either read or the write fails, or the draft is invalid', () => {
    for (const path of ['source.md', 'dest.md', 'quota.md']) stashDraft(from, path, path, 'base')
    data.set(key(from, 'invalid.md'), '{broken')
    failRead.add(key(from, 'source.md'))
    failRead.add(key(to, 'dest.md'))
    failWrite.add(key(to, 'quota.md'))
    const before = [...data]
    migrateDraftRoot(from, to)
    expect([...data]).toEqual(before)
    failRead.clear()
    failWrite.clear()
    migrateDraftRoot(from, to)
    expect(readDraft(to, 'source.md')?.text).toBe('source.md')
    expect(readDraft(to, 'dest.md')?.text).toBe('dest.md')
    expect(readDraft(to, 'quota.md')?.text).toBe('quota.md')
    expect(data.get(key(from, 'invalid.md'))).toBe('{broken')
    expect(data.has(key(to, 'invalid.md'))).toBe(false)
  })

  it('keeps a newer draft written to the source while the destination is being saved', () => {
    const path = 'a.md'
    stashDraft(from, path, 'first draft', 'base')
    afterWrite = (writtenKey) => {
      if (writtenKey === key(to, path)) stashDraft(from, path, 'newer source draft', 'base')
    }
    migrateDraftRoot(from, to)
    expect(readDraft(to, path)?.text).toBe('first draft')
    expect(readDraft(from, path)?.text).toBe('newer source draft')
  })
})
