import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteMemoryId,
  readDocumentScroll,
  readNoteSurfaceMode,
  remapNoteViewMemory,
  writeDocumentScroll,
  writeNoteSurfaceMode,
} from './viewMemory'

describe('Amadeus note view memory', () => {
  beforeEach(() => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    })
  })

  it('isolates the same relative note path across vaults', () => {
    expect(noteMemoryId('/a', 'untitled.md')).not.toBe(noteMemoryId('/b', 'untitled.md'))
    writeNoteSurfaceMode('/a', 'untitled.md', 'canvas')
    expect(readNoteSurfaceMode('/a', 'untitled.md')).toBe('canvas')
    expect(readNoteSurfaceMode('/b', 'untitled.md')).toBeNull()
  })

  it('remaps both surface mode and document scroll after rename', () => {
    writeNoteSurfaceMode('/vault', 'old.md', 'canvas')
    writeDocumentScroll('/vault', 'old.md', 712)
    remapNoteViewMemory('/vault', 'old.md', 'new.md')
    expect(readNoteSurfaceMode('/vault', 'new.md')).toBe('canvas')
    expect(readDocumentScroll('/vault', 'new.md')).toBe(712)
  })
})
