import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recentAttachmentCopy, rememberAttachmentCopy } from './attachmentClipboard'

describe('attachment clipboard recent reference', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T20:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shares a decoded attachment basename with the markdown reference', () => {
    rememberAttachmentCopy('![[a b.png]]', 'attachments/a%20b.png')
    expect(recentAttachmentCopy()).toMatchObject({ reference: '![[a b.png]]', fileName: 'a b.png' })
  })

  it('expires the native-file fallback after 30 seconds', () => {
    rememberAttachmentCopy('![[report.pdf]]', 'report.pdf')
    vi.advanceTimersByTime(30_000)
    expect(recentAttachmentCopy()).toBeNull()
  })
})
