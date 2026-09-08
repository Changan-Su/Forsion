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
