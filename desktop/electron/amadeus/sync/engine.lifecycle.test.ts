import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '', tree: null as null | (() => Promise<unknown>), writes: [] as string[] }))
vi.mock('electron', () => ({ app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() } }))
vi.mock('../../forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => env.root, defaultWorkspaceDir: () => env.root }))
vi.mock('../settings', () => ({
  readConfig: async () => ({ cloudSync: { vaultId: 'vault-a', deviceId: 'dev' }, cloudAccountId: 'account-a' }),
  writeConfig: vi.fn(), currentCloudAccountId: () => 'account-a', cloudAccountNamespace: () => 'account-a',
}))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn(), close: async () => {} }) } }))
vi.mock('./sseClient', () => ({ startSse: () => ({ stop: vi.fn() }) }))
vi.mock('./cloudClient', () => ({
  CloudHttpError: class extends Error {},
  createCloudClient: () => ({ clientId: 'dev', tree: () => env.tree!(),
    putFile: async (_vault: string, file: string) => { env.writes.push(file); return { seq: 1, hash: 'written' } },
    putBinary: async (_vault: string, file: string) => { env.writes.push(file); return { path: file, size: 0, seq: 1 } },
    listVaults: async () => [{ id: 'vault-a' }],
  }),
}))
let stop: (() => unknown) | undefined
beforeEach(async () => {
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-stop-'))
  env.writes = []
})
afterEach(async () => { await stop?.(); await fs.rm(env.root, { recursive: true, force: true }) })

it('stop waits for an active reconcile and discards queued work before another account can start', async () => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((r) => { entered = r })
  const gate = new Promise<void>((r) => { release = r })
  env.tree = async () => { entered(); await gate; return { entries: [], folders: [], seq: 0 } }
  await fs.writeFile(path.join(env.root, 'A.md'), 'Account A note')
  const { createSyncEngine } = await import('./engine')
  const engine = createSyncEngine({ loadCreds: () => ({ cloudUrl: 'https://cloud.example', token: 'a' }), onStatus: () => {} }, {
    localRoot: env.root, shadowName: 'a-shadow', vaultId: 'first', serverDir: '',
  })
  stop = () => engine.stop()
  await engine.restart()
  await started
  engine.notifyLocal('Queued.md', 'write')
  let settled = false
  const stopping = Promise.resolve(engine.stop()).then(() => { settled = true })
  await new Promise((r) => setTimeout(r, 20))
  const settledTooEarly = settled
  release()
  await stopping
  expect(settledTooEarly).toBe(false)
  const completed = [...env.writes]
  await fs.writeFile(path.join(env.root, 'B.md'), 'Account B note')
  engine.notifyLocal('B.md', 'write')
  await new Promise((r) => setTimeout(r, 20))
  expect(env.writes).toEqual(completed)
  expect(engine.getStatus().pending).toBe(0)
  expect(engine.getStatus().lastSyncAt).toBeNull()
})

it('binary pushes follow tree.maxFileBytes (tier limit); an old server without the field keeps the 5MB cap', async () => {
  const MB = 1024 * 1024
  const limit: { bytes?: number } = {}
  env.tree = async () => ({ entries: [], folders: [], seq: 0, maxFileBytes: limit.bytes })
  const mirror = path.join(env.root, 'mirror') // 与 shadow json(落在 userData = env.root)分开,免得 shadow 被当库文件推
  await fs.mkdir(mirror)
  await fs.writeFile(path.join(mirror, 'big.bin'), Buffer.alloc(6 * MB))
  const { createSyncEngine } = await import('./engine')
  const engine = createSyncEngine({ loadCreds: () => ({ cloudUrl: 'https://cloud.example', token: 'a' }), onStatus: () => {} }, {
    localRoot: mirror, shadowName: 'limit-shadow', vaultId: 'first', serverDir: '',
  })
  stop = () => engine.stop()
  await engine.restart()
  await vi.waitFor(() => expect(engine.getStatus().skipped).toEqual([{ path: 'big.bin', reason: 'TOO_LARGE' }]))
  expect(engine.getStatus().maxFileBytes).toBeNull()
  expect(env.writes).toEqual([])

  limit.bytes = 10 * MB // 开了 Plus:下一轮全量对账就按新上限推,之前 TOO_LARGE 跳过的文件重新判定
  await engine.syncNow()
  await vi.waitFor(() => expect(env.writes).toEqual(['big.bin']))
  expect(engine.getStatus().maxFileBytes).toBe(10 * MB)
  expect(engine.getStatus().skipped).toEqual([])
})
