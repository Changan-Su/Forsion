/** Run the production component's write/flush closures without mounting Milkdown. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'sucrase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeFm } from './fm'
import { flushUnifiedScopes, registerUnifiedPipe } from './lifecycle'

const source = readFileSync(new URL('./UnifiedPage.tsx', import.meta.url), 'utf8')
const writer = source.slice(source.indexOf('  const writeNow ='), source.indexOf('  /** 从编辑器 doc 派生'))
const registration = source.slice(source.indexOf('    return registerUnifiedPipe({'))
const flushStart = registration.indexOf('      flush: ')
const flushEnd = registration.indexOf('      insertFiles:', flushStart)
const flushProperty = registration.slice(flushStart, flushEnd)
const disposers: Array<() => void> = []
afterEach(() => { while (disposers.length) disposers.pop()!() })

function harness() {
  const pipe = { retired: false, fm: '', body: 'Unsaved note', lastSaved: 'Old note', pending: true, timer: null, chain: Promise.resolve() }
  const writeTextFile = vi.fn<(path: string, content: string) => Promise<void>>()
  const script = writer + '\n({ writeNow, handle: { path, ' + flushProperty + ' retire() {} } })'
  const result = runInNewContext(transform(script, { transforms: ['typescript'] }).code, {
    path: 'Note.md', pipe, composeFm, amadeus: { writeTextFile },
    scoped: { getState: () => ({ bumpLinkGraph: vi.fn() }) },
    syncFromEditor() {}, clearTimeout,
  }) as { writeNow: (strict?: boolean) => Promise<void>; handle: Parameters<typeof registerUnifiedPipe>[0] }
  disposers.push(registerUnifiedPipe(result.handle))
  return { pipe, writeTextFile, ...result }
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
