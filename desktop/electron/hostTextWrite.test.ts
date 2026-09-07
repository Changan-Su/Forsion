import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHostTextWriter, type HostTextWriteIO } from './hostTextWrite'

let home: string
let path: string
let expected: number
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'studio-host-write-'))
  path = join(home, 'source.ts')
  await fs.writeFile(path, 'original')
  // A historical timestamp makes both successful writes and external mutations
  // deterministic even on filesystems with relatively coarse clock resolution.
  await fs.utimes(path, 1_700_000_000, 1_700_000_000.125)
  expected = (await fs.stat(path)).mtimeMs
})
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })
const read = () => fs.readFile(path, 'utf8')
const noTemporary = async () => { expect(await fs.readdir(home)).toEqual(['source.ts']) }
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
/** Exercise real fsync and real target files, scheduling another writer at the
 * exact await boundary the original main-process handler left unprotected. */
function afterSync(action: () => Promise<void>): HostTextWriteIO['open'] {
  return async (temporary, flags) => {
    const file = await fs.open(temporary, flags)
    return { writeFile: (content, encoding) => file.writeFile(content, encoding), sync: async () => { await file.sync(); await action() }, close: () => file.close() }
  }
}

describe('Host text writes', () => {
  it('atomically replaces UTF-8 text and returns the exact timestamp of the saved content', async () => {
    const write = createHostTextWriter()
    const result = await write(path, 'const name = "扶桑"\n', expected)
    expect(result).toEqual({ ok: true, mtimeMs: (await fs.stat(path)).mtimeMs })
    expect(await read()).toBe('const name = "扶桑"\n')
    await noTemporary()
  })

  it('serializes concurrent same-path requests so two writes with the same expected mtime cannot both succeed', async () => {
    const reached = deferred(); const release = deferred()
    const open = vi.fn(afterSync(async () => { reached.resolve(); await release.promise }))
    const write = createHostTextWriter({ open })
    const first = write(path, 'first writer', expected)
    await reached.promise
    const second = write(join(home, '.', 'source.ts'), 'second writer', expected)
    await Promise.resolve(); await Promise.resolve()
    expect(open).toHaveBeenCalledTimes(1)
    release.resolve()
    const result = await first
    expect(result.ok).toBe(true)
    expect(await second).toEqual({ conflict: true, mtimeMs: result.mtimeMs })
    expect(await read()).toBe('first writer')
    await noTemporary()
  })

  it('detects an external write during temporary-file fsync and preserves the external content', async () => {
    const write = createHostTextWriter({ open: afterSync(async () => {
      await fs.writeFile(path, 'external writer')
      await fs.utimes(path, 1_700_000_100, 1_700_000_100.125)
    }) })
    const result = await write(path, 'local edit', expected)
    expect(result).toEqual({ conflict: true, mtimeMs: (await fs.stat(path)).mtimeMs })
    expect(await read()).toBe('external writer')
    await noTemporary()
  })

  it('rejects a concurrently reused revision even when the filesystem clock reports the same mtime', async () => {
    const write = createHostTextWriter({ stat: async () => ({ mtimeMs: expected }) })
    const [first, second] = await Promise.all([write(path, 'first', expected), write(path, 'second', expected)])
    expect(first).toEqual({ ok: true, mtimeMs: expected })
    expect(second).toEqual({ conflict: true, mtimeMs: expected })
    expect(await read()).toBe('first')
    // The client can deliberately continue after receiving that saved revision.
    expect(await write(path, 'later edit', first.mtimeMs)).toEqual({ ok: true, mtimeMs: expected })
    expect(await read()).toBe('later edit'); await noTemporary()
  })

  it('does not resurrect a target removed while the temporary file was being synced', async () => {
    const write = createHostTextWriter({ open: afterSync(() => fs.unlink(path)) })
    expect(await write(path, 'local edit', expected)).toEqual({ conflict: true, mtimeMs: 0 })
    expect(await fs.readdir(home)).toEqual([])
  })

  it('does not accept even a sub-millisecond revision mismatch', async () => {
    const open = vi.fn()
    const write = createHostTextWriter({ stat: async () => ({ mtimeMs: 10.25 }), open })
    expect(await write(path, 'local edit', 10)).toEqual({ conflict: true, mtimeMs: 10.25 })
    expect(open).not.toHaveBeenCalled()
    expect(await read()).toBe('original')
  })

  it('does not return a later external revision as the baseline of the local content it saved', async () => {
    let savedMtime = 0
    const write = createHostTextWriter({ rename: async (temporary, target) => {
      savedMtime = (await fs.stat(temporary)).mtimeMs
      await fs.rename(temporary, target)
      await fs.writeFile(target, 'external after replacement')
      await fs.utimes(target, 1_700_000_200, 1_700_000_200)
    } })
    const result = await write(path, 'local edit', expected)
    expect(result).toEqual({ ok: true, mtimeMs: savedMtime })
    expect(result.mtimeMs).not.toBe((await fs.stat(path)).mtimeMs)
    expect(await write(path, 'another local edit', result.mtimeMs)).toMatchObject({ conflict: true })
    expect(await read()).toBe('external after replacement')
    await noTemporary()
  })

  it.each(['write', 'sync', 'rename'] as const)('cleans temporary files after %s failure and allows the next queued request', async failure => {
    let fail = true
    const close = vi.fn()
    const write = createHostTextWriter({
      open: async (temporary, flags) => {
        const file = await fs.open(temporary, flags)
        return {
          writeFile: async (content, encoding) => { if (fail && failure === 'write') throw new Error('write failed'); await file.writeFile(content, encoding) },
          sync: async () => { if (fail && failure === 'sync') throw new Error('sync failed'); await file.sync() },
          close: async () => { close(); await file.close() },
        }
      },
      rename: async (from, to) => { if (fail && failure === 'rename') throw new Error('rename failed'); await fs.rename(from, to) },
    })
    await expect(write(path, 'local edit', expected)).rejects.toThrow(`${failure} failed`)
    expect(close).toHaveBeenCalledTimes(1)
    expect(await read()).toBe('original'); await noTemporary()
    fail = false
    expect(await write(path, 'retry', expected)).toMatchObject({ ok: true })
    expect(await read()).toBe('retry'); await noTemporary()
  })

  it('reports real stat errors during the second revision check and still removes its temporary file', async () => {
    let targetReads = 0
    const write = createHostTextWriter({ stat: async candidate => {
      if (candidate === path && ++targetReads === 2) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return fs.stat(candidate)
    } })
    await expect(write(path, 'local edit', expected)).rejects.toThrow('permission denied')
    expect(await read()).toBe('original'); await noTemporary()
  })

  it('keeps createNew exclusive: existing content survives and only one competing creation succeeds', async () => {
    const write = createHostTextWriter()
    await expect(write(path, 'overwrite', undefined, true)).rejects.toThrow('同名文件/文件夹已存在')
    expect(await read()).toBe('original')
    await fs.unlink(path)
    const outcomes = await Promise.allSettled([write(path, 'first', undefined, true), write(path, 'second', undefined, true)])
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await read()).toBe('first'); await noTemporary()
  })

  it('rejects nonfinite revision tokens rather than silently allowing an unchecked overwrite', async () => {
    const open = vi.fn()
    const write = createHostTextWriter({ open })
    for (const bad of [NaN, Infinity, -Infinity]) await expect(write(path, 'unsafe', bad)).rejects.toThrow('非法的写入参数')
    expect(open).not.toHaveBeenCalled()
    expect(await read()).toBe('original')
  })
})
