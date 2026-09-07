import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveStudioBriefFile } from './briefFile'
import type { StudioBrief } from './projectBrief'

const root = '/projects/brief'
const path = `${root}/FORSION_BRIEF.md`
const brief: StudioBrief = { idea: 'A useful app', audience: 'Students', constraints: 'Works offline', capabilities: ['chat'], locale: 'en' }
const existing = { name: 'FORSION_BRIEF.md', path, isDir: false }
const file = (mtimeMs: number) => ({ mimeType: 'text/markdown', content: '', size: 0, mtimeMs })
let host: { listDir: ReturnType<typeof vi.fn>; readHostFile: ReturnType<typeof vi.fn>; writeHostFile: ReturnType<typeof vi.fn> }

beforeEach(() => {
  host = { listDir: vi.fn(async () => [existing]), readHostFile: vi.fn(async () => file(10.125)), writeHostFile: vi.fn(async () => ({ ok: true, mtimeMs: 20.125 })) }
  vi.stubGlobal('window', { tangu: host })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('Portable project brief file writes', () => {
  it('updates an existing brief with its exact revision token and complete portable context', async () => {
    await saveStudioBriefFile(root, brief)
    expect(host.readHostFile).toHaveBeenCalledWith(path)
    expect(host.writeHostFile).toHaveBeenCalledWith(path, expect.stringContaining('# brief\n'), 10.125, false)
    const content = host.writeHostFile.mock.calls[0][1] as string
    expect(content).toContain(brief.idea)
    expect(content).toContain(brief.audience)
    expect(content).toContain(brief.constraints)
    expect(content).toContain('window.forsion.ai.chat')
  })

  it('only uses exclusive createNew when the directory listing has no brief', async () => {
    host.listDir.mockResolvedValue([])
    await saveStudioBriefFile(root, brief)
    expect(host.readHostFile).not.toHaveBeenCalled()
    expect(host.writeHostFile).toHaveBeenCalledWith(path, expect.any(String), undefined, true)
  })

  it('never falls back to a force write when an existing file disappears or cannot be read', async () => {
    for (const missing of [null, undefined]) {
      host.readHostFile.mockResolvedValue(missing)
      await expect(saveStudioBriefFile(root, brief)).rejects.toThrow('无法安全更新')
    }
    host.readHostFile.mockRejectedValue(new Error('Read failed'))
    await expect(saveStudioBriefFile(root, brief)).rejects.toThrow('Read failed')
    expect(host.writeHostFile).not.toHaveBeenCalled()
  })

  it('refuses directories, oversized files, and missing or nonfinite revision tokens', async () => {
    host.listDir.mockResolvedValue([{ ...existing, isDir: true }])
    await expect(saveStudioBriefFile(root, brief)).rejects.toThrow('无法安全更新')
    expect(host.readHostFile).not.toHaveBeenCalled()
    host.listDir.mockResolvedValue([existing])
    for (const unsafe of [{ ...file(10), tooLarge: true }, { ...file(10), mtimeMs: undefined }, file(NaN), file(Infinity)]) {
      host.readHostFile.mockResolvedValue(unsafe)
      await expect(saveStudioBriefFile(root, brief)).rejects.toThrow('无法安全更新')
    }
    expect(host.writeHostFile).not.toHaveBeenCalled()
  })

  it('keeps concurrent existing-file saves on CAS so only one can consume the same revision', async () => {
    let diskRevision = 10.125
    host.writeHostFile.mockImplementation(async (_path, _content, expected, createNew) => {
      expect(createNew).toBe(false)
      if (expected !== diskRevision) return { conflict: true, mtimeMs: diskRevision }
      diskRevision = 20.125
      return { ok: true, mtimeMs: diskRevision }
    })
    const results = await Promise.allSettled([saveStudioBriefFile(root, brief), saveStudioBriefFile(root, { ...brief, idea: 'Second' })])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(host.writeHostFile.mock.calls.every(call => call[2] === 10.125)).toBe(true)
  })

  it('never overwrites a file created after the directory listing', async () => {
    host.listDir.mockResolvedValue([])
    let created = false
    host.writeHostFile.mockImplementation(async (_path, _content, expected, createNew) => {
      expect(expected).toBeUndefined(); expect(createNew).toBe(true)
      if (created) throw new Error('Already exists')
      created = true
      return { ok: true, mtimeMs: 20 }
    })
    const results = await Promise.allSettled([saveStudioBriefFile(root, brief), saveStudioBriefFile(root, brief)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(host.writeHostFile).toHaveBeenCalledTimes(2)
  })

  it('requires a confirmed success response and never retries conflicts with an unchecked overwrite', async () => {
    for (const response of [undefined, null, {}, { mtimeMs: 20 }, { ok: false, mtimeMs: 20 }, { ok: 1, mtimeMs: 20 }, { ok: true, mtimeMs: NaN }, { ok: true }]) {
      host.writeHostFile.mockResolvedValue(response)
      await expect(saveStudioBriefFile(root, brief)).rejects.toThrow('未收到')
    }
    host.writeHostFile.mockClear(); host.writeHostFile.mockResolvedValue({ conflict: true, mtimeMs: 30 })
    await expect(saveStudioBriefFile(root, brief)).rejects.toThrow('已被其他操作修改')
    expect(host.writeHostFile).toHaveBeenCalledTimes(1)
    expect(host.writeHostFile.mock.calls[0][2]).toBe(10.125)
  })

  it('fails safely when the host is unavailable, the root is invalid, or listing fails', async () => {
    await expect(saveStudioBriefFile('../outside', brief)).rejects.toThrow('无法安全更新')
    expect(host.listDir).not.toHaveBeenCalled()
    host.listDir.mockRejectedValue(new Error('Listing failed'))
    await expect(saveStudioBriefFile(root, brief)).rejects.toThrow('Listing failed')
    expect(host.writeHostFile).not.toHaveBeenCalled()
    vi.stubGlobal('window', {})
    await expect(saveStudioBriefFile(root, brief)).rejects.toThrow('不支持保存')
  })
})
