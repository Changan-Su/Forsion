import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteMemoryId,
  readDocumentScroll,
  readNoteLocked,
  readNoteSurfaceMode,
  remapNoteViewMemory,
  writeDocumentScroll,
  writeNoteLocked,
  writeNoteSurfaceMode,
} from './viewMemory'

describe('Amadeus note view memory', () => {
  beforeEach(() => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
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

  // C-07 锁定页面:本机视图状态(不写笔记),按库根隔离、改名跟着走、解锁即删键。
  it('keeps the page lock per vault, carries it across rename, and clears it on unlock', () => {
    writeNoteLocked('/a', 'note.md', true)
    expect(readNoteLocked('/a', 'note.md')).toBe(true)
    expect(readNoteLocked('/b', 'note.md')).toBe(false)
    remapNoteViewMemory('/a', 'note.md', 'renamed.md')
    expect(readNoteLocked('/a', 'renamed.md')).toBe(true)
    expect(readNoteLocked('/a', 'note.md')).toBe(false)
    writeNoteLocked('/a', 'renamed.md', false)
    expect(readNoteLocked('/a', 'renamed.md')).toBe(false)
  })
})
