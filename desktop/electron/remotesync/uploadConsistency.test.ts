import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runSync } from './engine'
import { sha256 } from './fsLocal'
import type { RemoteFs } from './types'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))) })
async function fixture(initial: string | null = null) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'sync-upload-')); roots.push(dir)
  const localRoot = path.join(dir, 'local'); await fs.mkdir(localRoot)
  const file = path.join(localRoot, 'note.md'); await fs.writeFile(file, 'AAAAA'); await fs.utimes(file, 1000, 1000)
  let bytes = initial, rev = initial === null ? 0 : 1
  const entity = () => ({ key: 'note.md', id: String(rev), hash: sha256(bytes!), size: Buffer.byteLength(bytes!), mtimeMs: rev })
  const remote: RemoteFs = { kind: 'cas', walk: async () => bytes === null ? [] : [entity()], readFile: async () => Buffer.from(bytes!), check: async () => ({ ok: true }),
    async writeFile(_key, data, _time, _signal, expected) {
      if (expected !== (bytes === null ? null : String(rev))) throw Error('CAS conflict')
      bytes = data.toString(); rev++; return entity()
    }, async rm() { bytes = null; rev++ } }
  return { file, remote, get: () => bytes, change: (text: string) => { bytes = text; rev++ },
    run: (direction?: 'push') => runSync({ localRoot, statePath: path.join(dir, 'state.json'), fingerprint: 'test', remote, direction }) }
}

it.each(['BBBBB', 'longer bytes', 'B', null])('does not mark an edit during upload as synced: %s', async text => {
  const f = await fixture(), write = f.remote.writeFile.bind(f.remote)
  let once = true
  f.remote.writeFile = async (...args) => {
    const result = await write(...args)
    if (once) { once = false; if (text === null) await fs.unlink(f.file); else { await fs.writeFile(f.file, text); await fs.utimes(f.file, 2000, 2000) } }
    return result
  }
  expect((await f.run()).ok).toBe(true)
  expect((await f.run()).ok).toBe(true)
  expect(f.get()).toBe(text)
})
it('invalidates the cache when reading overlaps an atomic replacement', async () => {
  const f = await fixture(), read = fs.readFile.bind(fs)
  let once = true
  vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await read(...args)
    if (args[0] === f.file && once) { once = false; await fs.writeFile(f.file + '.new', 'BBBBB'); await fs.utimes(f.file + '.new', 2000, 2000); await fs.rename(f.file + '.new', f.file) }
    return bytes
  }) as typeof fs.readFile)
  await f.run(); await f.run(); expect(f.get()).toBe('BBBBB')
})
it('push-only uses the observed remote version for first join and two-sided edits', async () => {
  const f = await fixture('remote')
  expect((await f.run('push')).ok).toBe(true); expect(f.get()).toBe('AAAAA')
  f.change('remote again'); await fs.writeFile(f.file, 'local again')
  expect((await f.run('push')).ok).toBe(true); expect(f.get()).toBe('local again')
})
it('push-only still rejects a remote edit after the scan', async () => {
  const f = await fixture('remote'), walk = f.remote.walk
  f.remote.walk = async () => { const snapshot = await walk(); f.change('concurrent'); return snapshot }
  expect((await f.run('push')).ok).toBe(false); expect(f.get()).toBe('concurrent')
})
