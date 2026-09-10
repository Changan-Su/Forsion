import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ root: '', remoteSeq: 1, remote: new Map<string, string>(), deleted: [] as string[], moved: [] as string[], fail: false, gate: null as null | Promise<void>, treeGate: null as null | Promise<void>, getGate: null as null | Promise<void>, scope: (_p: string): boolean => true, reads: 0, versions: 0, versionGate: null as null | Promise<void>, sse: null as any }))
vi.mock('electron', () => ({ app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() } }))
vi.mock('../../forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => env.root }))
vi.mock('../settings', () => ({ readConfig: async () => ({ cloudSync: { vaultId: 'vault', deviceId: 'dev' } }), writeConfig: vi.fn(), currentCloudAccountId: () => 'a', cloudAccountNamespace: () => 'a' }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn(), close: async () => {} }) } }))
vi.mock('./sseClient', () => ({ startSse: (_config: unknown, handlers: unknown) => { env.sse = handlers; return { stop: vi.fn() } } }))
vi.mock('./cloudClient', () => {
  class CloudHttpError extends Error { constructor(readonly status: number, readonly body = {}) { super(`http ${status}`) } }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { CloudHttpError, createCloudClient: () => ({
    listVersions: async () => { ++env.versions; await env.versionGate; return [{ id: 'v1', seq: 1 }] }, getVersion: async () => 'original body',
    clientId: 'dev', tree: async () => { await env.treeGate; return { seq: 1, folders: [], entries: [...env.remote].map(([path, content]) => ({ path, kind: 'page', hash: hash(content), seq: env.remoteSeq, size: content.length })) } },
    getFile: async (_v: string, p: string) => { ++env.reads; await env.getGate; const content = env.remote.get(p); if (content === undefined) throw new CloudHttpError(404); return { content, hash: hash(content), seq: env.remoteSeq } },
    putFile: async (_v: string, p: string, content: string) => { env.remote.set(p, content); return { seq: 2, hash: hash(content) } },
    deleteFile: async (_v: string, p: string) => { env.deleted.push(p); env.remote.delete(p) },
    move: async (_v: string, from: string, to: string) => {
      env.moved.push(`${from}→${to}`)
      await env.gate
      if (env.fail) throw new CloudHttpError(503)
      if (!env.remote.has(from)) throw new CloudHttpError(404)
      env.remote.set(to, env.remote.get(from)!); env.remote.delete(from); return { seq: 2 }
    }, moveFolder: async (_v: string, from: string, dir: string) => {
      const to = dir ? `${dir}/${from.split('/').pop()}` : from.split('/').pop()!
      env.moved.push(`${from}→${to}`)
      for (const [p, content] of [...env.remote]) if (p.startsWith(`${from}/`)) { env.remote.set(to + p.slice(from.length), content); env.remote.delete(p) }
    }, changes: async () => ({ seq: 1, changes: [] }),
  }) }
})
let stop: (() => Promise<void>) | undefined
beforeEach(async () => { env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-move-engine-')); env.remote = new Map([['A.md', 'original body']]); env.deleted = []; env.moved = []; env.fail = false; env.remoteSeq = 1; env.gate = null; env.treeGate = null; env.getGate = null; env.scope = () => true; env.reads = 0; env.versions = 0; env.versionGate = null })
afterEach(async () => { await stop?.(); vi.restoreAllMocks(); await fs.rm(env.root, { recursive: true, force: true }) })
async function boot(onRemoteApplied?: () => Promise<void>) {
  const { createSyncEngine } = await import('./engine')
  const local = path.join(env.root, 'vault')
  const engine = createSyncEngine({ loadCreds: () => ({ cloudUrl: 'https://example.test', token: 'a' }), onStatus() {}, onRemoteApplied }, { localRoot: local, shadowName: 'moves', vaultId: 'vault', serverDir: '', inScope: (p) => env.scope(p) })
  stop = engine.stop
  await engine.restart()
  await vi.waitFor(async () => expect(await fs.readFile(path.join(local, 'A.md'), 'utf8')).toBe('original body'))
  await vi.waitFor(() => expect(engine.getStatus().state).toBe('idle'))
  await fs.rename(path.join(local, 'A.md'), path.join(local, 'B.md'))
  return { engine, local }
}
it('only releases a move scope after the cloud move actually finishes', async () => {
  const { engine } = await boot()
  let release!: () => void
  env.gate = new Promise<void>((r) => { release = r })
  const done = vi.fn()
  engine.notifyLocalMove('A.md', 'B.md', done)
  await vi.waitFor(() => expect(env.moved).toHaveLength(1))
  const completedBeforeResponse = done.mock.calls.length
  release()
  await vi.waitFor(() => expect(env.remote.has('B.md')).toBe(true))
  await vi.waitFor(() => expect(engine.getStatus().state).toBe('idle'))
  expect(completedBeforeResponse).toBe(0)
  expect(done).toHaveBeenCalledTimes(1)
  expect(env.deleted).toEqual([])
})
it('a failed move survives restart and retries as a move, preserving its cloud identity', async () => {
  const { engine } = await boot()
  env.fail = true
  engine.notifyLocalMove('A.md', 'B.md')
  await vi.waitFor(() => expect(env.moved).toHaveLength(1))
  await new Promise((r) => setTimeout(r, 50))
  expect(env.deleted).toEqual([])
  expect(env.remote.get('A.md')).toBe('original body')
  await engine.stop()
  env.fail = false
  await engine.restart()
  await vi.waitFor(() => expect(env.remote.get('B.md')).toBe('original body'))
  expect(env.moved).toHaveLength(2)
  expect(env.deleted).toEqual([])
})
it('moving a file with unsynced edits uploads those edits instead of recording an old hash with the new stat', async () => {
  const { engine, local } = await boot()
  await fs.writeFile(path.join(local, 'B.md'), 'new body written before the cloud move')
  engine.notifyLocalMove('A.md', 'B.md')
  await vi.waitFor(() => expect(env.moved).toHaveLength(1))
  await vi.waitFor(async () => expect(env.remote.get('B.md')).toBe('new body written before the cloud move'))
})

it('replays A→B→C in order when B has already moved locally before the first HTTP response', async () => {
  const { engine, local } = await boot()
  let release!: () => void
  env.gate = new Promise<void>((r) => { release = r })
  await engine.notifyLocalMove('A.md', 'B.md', undefined, 'file')
  await vi.waitFor(() => expect(env.moved).toHaveLength(1))
  await fs.rename(path.join(local, 'B.md'), path.join(local, 'C.md'))
  await engine.notifyLocalMove('B.md', 'C.md', undefined, 'file')
  release()
  await vi.waitFor(() => expect(env.remote.get('C.md')).toBe('original body'))
  expect(env.moved).toEqual(['A.md→B.md', 'B.md→C.md'])
  expect([...env.remote.keys()]).toEqual(['C.md'])
  expect(env.deleted).toEqual([])
})

it('replays a durable move before a restarted binding drops its now-unregistered source', async () => {
  const { engine } = await boot()
  env.fail = true
  await engine.notifyLocalMove('A.md', 'B.md')
  await vi.waitFor(() => expect(engine.getStatus().state).toBe('offline'))
  await engine.stop()
  const journal = JSON.parse(await fs.readFile(path.join(env.root, 'moves.json'), 'utf8'))
  expect(journal.moves).toEqual([expect.objectContaining({ from: 'A.md', to: 'B.md', kind: 'file' })])
  env.scope = (p) => p === 'B.md'
  env.fail = false
  await engine.restart()
  await vi.waitFor(() => expect(env.remote.get('B.md')).toBe('original body'))
  expect(env.deleted).toEqual([])
  expect(env.moved).toEqual(['A.md→B.md', 'A.md→B.md'])
})

it('a delayed companion .fd move still uses its tracked source after the page scope has converged', async () => {
  env.remote.set('A.fd/Child.md', 'child body')
  const { engine, local } = await boot()
  await fs.mkdir(path.join(local, 'Dest'))
  await fs.rename(path.join(local, 'B.md'), path.join(local, 'Dest', 'A.md'))
  await engine.notifyLocalMove('A.md', 'Dest/A.md')
  await vi.waitFor(() => expect(env.remote.has('Dest/A.md')).toBe(true))
  env.scope = (p) => p === 'Dest/A.md' || p.startsWith('Dest/A.fd')
  await fs.rename(path.join(local, 'A.fd'), path.join(local, 'Dest', 'A.fd'))
  await engine.notifyLocalMove('A.fd', 'Dest/A.fd', undefined, 'folder')
  await vi.waitFor(() => expect(env.remote.get('Dest/A.fd/Child.md')).toBe('child body'))
  expect(env.moved).toContain('A.fd→Dest/A.fd')
  expect(env.remote.has('A.fd/Child.md')).toBe(false)
  expect(env.deleted).toEqual([])
})

it('a journal disk failure rejects before any cloud mutation and can be retried', async () => {
  const { engine } = await boot()
  const write = fs.writeFile.bind(fs)
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args: any[]) => {
    if (String(file).includes('moves.json.tmp')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    return (write as any)(file, ...args)
  })
  await expect(engine.notifyLocalMove('A.md', 'B.md')).rejects.toThrow('ENOSPC')
  expect(env.moved).toEqual([])
  expect(env.deleted).toEqual([])
  spy.mockRestore()
  await engine.notifyLocalMove('A.md', 'B.md')
  await vi.waitFor(() => expect(env.remote.get('B.md')).toBe('original body'))
})

it('an unrelated destination after a 404 remains untouched and the move stays pending', async () => {
  const { engine } = await boot()
  env.remote.delete('A.md')
  env.remote.set('B.md', 'another person’s unrelated document')
  await engine.notifyLocalMove('A.md', 'B.md')
  await vi.waitFor(() => expect(engine.getStatus().skipped).toContainEqual(expect.objectContaining({ reason: 'MOVE_DESTINATION_CHANGED' })))
  expect(env.remote.get('B.md')).toBe('another person’s unrelated document')
  expect(env.deleted).toEqual([])
  await engine.stop()
  expect(JSON.parse(await fs.readFile(path.join(env.root, 'moves.json'), 'utf8')).moves).toHaveLength(1)
})

it('a full scan already waiting on the cloud cannot delete a file that moves before its response', async () => {
  const { engine, local } = await boot()
  // Restore the source for the in-flight scan, then reserve before the real move.
  await fs.rename(path.join(local, 'B.md'), path.join(local, 'A.md'))
  let release!: () => void
  env.treeGate = new Promise<void>((r) => { release = r })
  await engine.syncNow()
  const finish = engine.holdLocalMove('A.md', 'B.md')
  await fs.rename(path.join(local, 'A.md'), path.join(local, 'B.md'))
  await engine.notifyLocalMove('A.md', 'B.md')
  finish()
  release()
  await vi.waitFor(() => expect(env.remote.get('B.md')).toBe('original body'))
  expect(env.deleted).toEqual([])
  await expect(fs.access(path.join(local, 'A.md'))).rejects.toThrow()
})

it.each(['pull', 'merge'] as const)('a delayed remote %s cannot recreate the source after a local move', async (phase) => {
  const { engine, local } = await boot()
  await fs.rename(path.join(local, 'B.md'), path.join(local, 'A.md'))
  if (phase === 'merge') await fs.writeFile(path.join(local, 'A.md'), 'local edit with body')
  env.remote.set('A.md', 'remote body changed')
  env.remoteSeq = 2
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  if (phase === 'pull') env.getGate = gate
  else env.versionGate = gate
  const readsBefore = env.reads
  await engine.syncNow()
  await vi.waitFor(() => expect(phase === 'pull' ? env.reads > readsBefore : env.versions > 0).toBe(true))
  const finish = engine.holdLocalMove('A.md', 'B.md')
  await fs.rename(path.join(local, 'A.md'), path.join(local, 'B.md'))
  await engine.notifyLocalMove('A.md', 'B.md')
  finish()
  release()
  await vi.waitFor(() => expect(env.moved).toHaveLength(1))
  await vi.waitFor(() => expect(engine.getStatus().state).toBe('idle'))
  await expect(fs.access(path.join(local, 'A.md'))).rejects.toThrow()
  expect(env.deleted).toEqual([])
})

it('a failed journal acknowledgement stays recoverable after the cloud already committed', async () => {
  const { engine } = await boot()
  const write = fs.writeFile.bind(fs)
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args: any[]) => {
    if (String(file).includes('moves.json.tmp') && JSON.parse(String(args[0])).moves?.length === 0) throw new Error('ack disk full')
    return (write as any)(file, ...args)
  })
  const done = vi.fn()
  await engine.notifyLocalMove('A.md', 'B.md', done)
  await vi.waitFor(() => expect(engine.getStatus().state).toBe('offline'))
  expect(env.remote.get('B.md')).toBe('original body')
  expect(done).not.toHaveBeenCalled()
  spy.mockRestore()
  await engine.restart()
  await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  expect(env.remote.get('B.md')).toBe('original body')
  expect(env.deleted).toEqual([])
})

it('waits for remote move enrollment before processing the following write at its new path', async () => {
  let release!: () => void
  let entered = false
  const gate = new Promise<void>((r) => { release = r })
  const { engine, local } = await boot(async () => { entered = true; await gate; env.scope = (p) => p === 'B.md' })
  await fs.rename(path.join(local, 'B.md'), path.join(local, 'A.md'))
  env.scope = (p) => p === 'A.md'
  env.remote.delete('A.md')
  env.remote.set('B.md', 'new remote content after rename')
  env.remoteSeq = 3
  env.sse.onChange({ seq: 2, type: 'page', op: 'move', path: 'A.md', newPath: 'B.md', fileSeq: 2, origin: { client: 'other' } })
  env.sse.onChange({ seq: 3, type: 'page', op: 'write', path: 'B.md', newPath: null, fileSeq: 3, origin: { client: 'other' } })
  await vi.waitFor(() => expect(entered).toBe(true))
  await new Promise((r) => setTimeout(r, 20))
  release()
  await vi.waitFor(async () => expect(await fs.readFile(path.join(local, 'B.md'), 'utf8')).toBe('new remote content after rename'))
  expect(env.deleted).toEqual([])
})
