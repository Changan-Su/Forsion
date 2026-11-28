/**
 * 智库同步第 2 步(契约 P-7):同一个库根既有条目同步、又配着旧 remotesync 时,A 接手以后旧 remotesync 仍让开条目路径。
 * A 接手只写 syncOwnershipV2(遮罩只给旧的条目引擎看,amadeus/ipc 里经 maskAmadeusConfig 套上),不改盘上的 entrySync。
 * 旧 remotesync 的忽略名单读的是没遮罩的 readConfig:认领了这个根以后,它照样算出条目路径,不变空。
 * 守的是这一条:哪天有人把 remotesync 的读法换成遮罩过的那份,这里会红,旧同步会去碰 v2 管着的文件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...a: unknown[]) => unknown>() }))
const ACCOUNT = 'https://cloud.test/api::account-1'
vi.mock('electron', () => ({
  app: { getPath: () => join(env.root, 'userData') },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { env.handlers.set(ch, fn) } },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { trashItem: async (p: string) => { rmSync(p, { force: true }) }, openExternal: async () => {} },
}))
vi.mock('./forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => join(env.root, 'home') }))
vi.mock('./forsionAuth', () => ({ loadTanguCreds: () => ({ cloudUrl: 'https://cloud.test/api', token: '' }) }))
vi.mock('../shared/forsionAccount', () => ({ forsionAccountId: () => ACCOUNT }))
vi.mock('./amadeus/fs/vaultHandlers', () => ({ withTextWriteLock: async (_p: string, fn: () => Promise<void>) => fn() }))
vi.mock('./amadeus/cloudPaths', () => ({
  cloudVaultDir: () => join(env.root, 'cloud-mirror'),
  isManagedCloudVault: () => false,
  hash8: (s: string) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 8),
}))
vi.mock('./syncRecordsIpc', () => ({ appendSyncRecord: () => {} }))
vi.mock('./contentSyncHost', async (orig) => ({ ...(await orig<typeof import('./contentSyncHost')>()), contentSyncOwned: () => false }))

const call = async <T = any>(ch: string, ...args: unknown[]): Promise<T> => env.handlers.get(ch)!({}, ...args) as Promise<T>
const vault = () => join(env.root, 'Vault')
const remote = () => join(env.root, 'Remote')

beforeEach(() => {
  env.root = realpathSync(mkdtempSync(join(tmpdir(), 'forsion-rs-owned-')))
  env.handlers.clear()
  mkdirSync(join(vault(), 'Shared'), { recursive: true })
  mkdirSync(join(remote(), 'Shared'), { recursive: true })
  mkdirSync(join(env.root, 'userData'), { recursive: true })
  writeFileSync(join(vault(), 'a.md'), 'alpha (v2 manages this)')
  writeFileSync(join(vault(), 'Shared', 's.md'), 'shared (v2 manages this)')
  writeFileSync(join(vault(), 'b.md'), 'beta (legacy sync manages this)')
  writeFileSync(join(remote(), 'a.md'), 'another a.md on the legacy target')
  writeFileSync(join(remote(), 'Shared', 'only-remote.md'), 'only on the legacy target')
})
afterEach(() => { vi.resetModules(); rmSync(env.root, { recursive: true, force: true }) })

describe('entry ignores after A took the root over', () => {
  it('the ownership mask hides the root from the old entry engine, but the legacy remotesync still skips its entry paths', async () => {
    vi.resetModules()
    const settings = await import('./amadeus/settings')
    const ns = settings.cloudAccountNamespace(ACCOUNT)
    const entrySync = [{ vaultRoot: vault(), cloudName: 'Vault', entries: [{ path: 'a.md', kind: 'page' }, { path: 'Shared', kind: 'folder' }] }]
    const owned = { entryRoots: [vault()], mirror: 'keep' as const, human: 'engine' as const }
    writeFileSync(join(env.root, 'userData', 'amadeus-config.json'), JSON.stringify({
      lastVault: vault(), localVault: vault(),
      cloudAccounts: { [ns]: { entrySync, syncOwnershipV2: owned } },
    }))
    writeFileSync(join(env.root, 'userData', 'remotesync.json'), JSON.stringify({ backend: 'folder', intervalMin: 0, folder: { path: remote() } }))

    // 前提:认领在,遮罩确实把这个根从旧条目引擎那份里拿掉了
    const host = await import('./contentSyncHost')
    expect(await settings.readSyncOwnershipV2(ACCOUNT)).toEqual(owned)
    const cfg = await settings.readConfig()
    expect(cfg.entrySync?.map((v) => v.vaultRoot)).toEqual([vault()])
    expect(host.maskAmadeusConfig(cfg, { kind: 'v2', value: owned }, false).entrySync).toEqual([])

    const ipc = await import('./remotesyncIpc')
    ipc.registerRemoteSync()
    ipc.legacyRemoteSync.extendLoaded(false)
    expect((await ipc.legacyRemoteSync.view())?.entryIgnores).toEqual(['a.md', 'a.fd/', 'Shared/'])

    const rep = await call<any>('remotesync:run')
    expect(rep.ok).toBe(true)
    expect(rep.deletedLocal + rep.deletedRemote).toBe(0)
    // 条目之外的照常同步
    expect(readFileSync(join(remote(), 'b.md'), 'utf8')).toBe('beta (legacy sync manages this)')
    // 条目范围里:零读、零写、零删
    expect(readFileSync(join(vault(), 'a.md'), 'utf8')).toBe('alpha (v2 manages this)')
    expect(readFileSync(join(remote(), 'a.md'), 'utf8')).toBe('another a.md on the legacy target')
    expect(existsSync(join(vault(), 'Shared', 'only-remote.md'))).toBe(false)
    expect(existsSync(join(remote(), 'Shared', 's.md'))).toBe(false)
    expect(existsSync(join(remote(), 'Shared', 'only-remote.md'))).toBe(true)
  })
})
