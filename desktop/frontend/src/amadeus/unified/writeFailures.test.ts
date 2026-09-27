/** Run the production component's write/flush closures without mounting Milkdown. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'sucrase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeFm } from './fm'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { flushUnifiedScopes, registerUnifiedPipe } from './lifecycle'

const source = readFileSync(new URL('./UnifiedPage.tsx', import.meta.url), 'utf8')
const writer = source.slice(source.indexOf('  const writeNow ='), source.indexOf('  /** 从编辑器 doc 派生'))
const registration = source.slice(source.indexOf('    return registerUnifiedPipe({'))
const flushStart = registration.indexOf('      flush: ')
const flushEnd = registration.indexOf('      insertFiles:', flushStart)
const flushProperty = registration.slice(flushStart, flushEnd)
const disposers: Array<() => void> = []
afterEach(() => { while (disposers.length) disposers.pop()!() })

type WriteResult = void | { ok: true } | { ok: false; current: string }
function harness() {
  const pipe = { retired: false, fm: '', body: 'Unsaved note', lastSaved: 'Old note', pending: true, timer: null, chain: Promise.resolve(), unpreserved: null as string | null }
  const writeTextFile = vi.fn<(path: string, content: string, opts?: { base?: string }) => Promise<WriteResult>>()
  // 写盘安全件(评审 G1-01 / D-03 / D-04)在组件里住在 writeNow 前面,这里注入桩:只验 writeNow 的控制流。
  const safety = {
    preserveExternal: vi.fn<(content: string) => Promise<void>>(async () => {}),
    noteWriteFailed: vi.fn<(error: unknown) => void>(),
    noteWriteOk: vi.fn<() => void>(),
    settleUnsaved: vi.fn<() => void>(),
    isPristine: vi.fn<() => boolean>(() => false),
    reconcileNow: vi.fn<() => void>(),
  }
  const script = writer + '\n({ writeNow, handle: { path, ' + flushProperty + ' retire() {} } })'
  const result = runInNewContext(transform(script, { transforms: ['typescript'] }).code, {
    path: 'Note.md', pipe, composeFm, textFingerprint, amadeus: { writeTextFile }, ...safety,
    scoped: { getState: () => ({ bumpLinkGraph: vi.fn() }) },
    syncFromEditor() {}, clearTimeout,
  }) as { writeNow: (strict?: boolean) => Promise<void>; handle: Parameters<typeof registerUnifiedPipe>[0] }
  disposers.push(registerUnifiedPipe(result.handle))
  return { pipe, writeTextFile, ...safety, ...result }
}

describe('unified editor account-switch persistence barrier', () => {
  it('rejects a real file-write failure and preserves the draft for a successful retry', async () => {
    const h = harness()
    h.writeTextFile.mockRejectedValueOnce(new Error('ENOSPC: Disk is full'))
    await expect(flushUnifiedScopes(true)).rejects.toThrow('ENOSPC')
    expect(h.pipe).toMatchObject({ pending: true, body: 'Unsaved note', lastSaved: 'Old note', retired: false })
    h.writeTextFile.mockResolvedValueOnce()
    await flushUnifiedScopes(true)
    expect(h.pipe.pending).toBe(false)
    expect(h.pipe.lastSaved).toBe(composeFm('', 'Unsaved note'))
    expect(h.writeTextFile).toHaveBeenCalledTimes(2)
  })

  it('retains the existing best-effort behavior of ordinary editor saves', async () => {
    const h = harness()
    h.writeTextFile.mockRejectedValueOnce(new Error('Offline'))
    await expect(h.writeNow()).resolves.toBeUndefined()
    expect(h.pipe.pending).toBe(true)
    expect(h.pipe.lastSaved).toBe('Old note')
  })

  it('strict flush also saves an edit arriving while the first file write is pending', async () => {
    const h = harness()
    h.pipe.pending = false // flush may discover a just-serialized draft before the debounce marks it dirty.
    let finish!: () => void
    h.writeTextFile.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      .mockResolvedValueOnce()
    const flushing = flushUnifiedScopes(true)
    await Promise.resolve()
    h.pipe.body = 'Newer edit during write'
    finish()
    await flushing
    expect(h.pipe.pending).toBe(false)
    expect(h.pipe.lastSaved).toBe(composeFm('', 'Newer edit during write'))
    expect(h.writeTextFile).toHaveBeenCalledTimes(2)
  })
})

describe('unified editor write safety (review 2026-09-27 D-03 / D-04 / G1-01)', () => {
  it('every write carries the fingerprint of what the editor believes is on disk', async () => {
    const h = harness()
    h.writeTextFile.mockResolvedValueOnce(undefined)
    await h.writeNow()
    expect(h.writeTextFile).toHaveBeenCalledWith('Note.md', composeFm('', 'Unsaved note'), { base: textFingerprint('Old note') })
    expect(h.noteWriteOk).toHaveBeenCalledTimes(1)
  })

  it('a failed ordinary save is reported (toast / unsaved bar / backoff) instead of being swallowed', async () => {
    const h = harness()
    const error = new Error('EACCES: permission denied')
    h.writeTextFile.mockRejectedValueOnce(error)
    await h.writeNow()
    expect(h.noteWriteFailed).toHaveBeenCalledWith(error)
    expect(h.noteWriteOk).not.toHaveBeenCalled()
  })

  it('CAS reject with local edits: the disk version is preserved first, then the local version is written on the new base', async () => {
    const h = harness()
    h.writeTextFile.mockResolvedValueOnce({ ok: false, current: 'Written by another window' }).mockResolvedValueOnce({ ok: true })
    await h.writeNow()
    expect(h.preserveExternal).toHaveBeenCalledWith('Written by another window')
    expect(h.preserveExternal.mock.invocationCallOrder[0]).toBeLessThan(h.writeTextFile.mock.invocationCallOrder[1])
    expect(h.writeTextFile).toHaveBeenLastCalledWith('Note.md', composeFm('', 'Unsaved note'), { base: textFingerprint('Written by another window') })
    expect(h.pipe).toMatchObject({ pending: false, lastSaved: composeFm('', 'Unsaved note'), unpreserved: null })
  })

  it('never overwrites the disk version when its conflict copy cannot be written', async () => {
    const h = harness()
    h.writeTextFile.mockResolvedValueOnce({ ok: false, current: 'Theirs' })
    h.preserveExternal.mockRejectedValueOnce(new Error('ENOSPC'))
    await h.writeNow()
    expect(h.writeTextFile).toHaveBeenCalledTimes(1) // only the rejected CAS attempt — no overwrite
    expect(h.noteWriteFailed).toHaveBeenCalled()
    expect(h.pipe).toMatchObject({ pending: true, unpreserved: 'Theirs', lastSaved: 'Theirs' })
  })

  it('CAS reject without user edits (only editor normalization) yields to the disk version: no write, no copy', async () => {
    const h = harness()
    h.isPristine.mockReturnValue(true)
    h.writeTextFile.mockResolvedValueOnce({ ok: false, current: 'Newer on disk' })
    await h.writeNow()
    expect(h.writeTextFile).toHaveBeenCalledTimes(1)
    expect(h.preserveExternal).not.toHaveBeenCalled()
    expect(h.reconcileNow).toHaveBeenCalledTimes(1)
    expect(h.pipe.pending).toBe(false)
  })

  it('a failed save the user undid back to the disk version settles the unsaved state (bar / stale draft) without writing', async () => {
    const h = harness()
    h.writeTextFile.mockRejectedValueOnce(new Error('Offline'))
    await h.writeNow()
    expect(h.noteWriteFailed).toHaveBeenCalledTimes(1)
    h.pipe.body = h.pipe.lastSaved // backspaced the unsaved words away: local == disk again
    await h.writeNow() // retry timer / online / focus kick
    expect(h.writeTextFile).toHaveBeenCalledTimes(1)
    expect(h.settleUnsaved).toHaveBeenCalledTimes(1)
    expect(h.noteWriteOk).not.toHaveBeenCalled() // nothing was written: no peer announcement
    expect(h.pipe.pending).toBe(false)
  })

  it('a strict barrier rejects when the disk keeps changing under it, instead of spinning out conflict copies', async () => {
    const h = harness()
    let n = 0
    h.writeTextFile.mockImplementation(async () => ({ ok: false, current: `Someone else ${++n}` }))
    await expect(flushUnifiedScopes(true)).rejects.toThrow(/kept changing/)
    expect(h.writeTextFile).toHaveBeenCalledTimes(4)
    expect(h.pipe.pending).toBe(true)
  })
})
