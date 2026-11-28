/**
 * 智库同步 H3 清单第 5 件:退出登录 → 旧 remotesync 跑一轮 → 重新登录。
 * 条目同步(entrySync)按账号存(amadeus-config 的 cloudAccounts[账号]),旧 remotesync 的忽略名单读的是当前账号那份。
 * 退出登录时读不到任何账号的条目名单:旧同步这一轮不能把它当「这个库没有条目同步」,去碰条目路径(条目引擎重新登录后会把
 * 这些改动当成用户的改动推上云,或者两边的同名文件互相盖)。这里钉住:
 * - 登录时:条目路径让开(同第 2 步);
 * - 退出登录:这个根上有别的账号的条目同步 = 不知道,这一轮不跑(固定码),零读零写零删;
 *   这个根上没有任何账号的条目同步(从没用过条目同步的人):照常跑,不因为没登录就停;
 * - 重新登录后再跑:条目路径仍然让开,零删除。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...a: unknown[]) => unknown>(), account: null as string | null, signOutAfter: -1, calls: 0 }))
const ACCOUNT = 'https://cloud.test/api::account-1'
vi.mock('electron', () => ({
  app: { getPath: () => join(env.root, 'userData') },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { env.handlers.set(ch, fn) } },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { trashItem: async (p: string) => { rmSync(p, { force: true }) }, openExternal: async () => {} },
}))
vi.mock('./forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => join(env.root, 'home') }))
vi.mock('./forsionAuth', () => ({ loadTanguCreds: () => ({ cloudUrl: 'https://cloud.test/api', token: '' }) }))
// signOutAfter >= 0:问过这么多次账号以后就当退出登录了(一轮跑到一半登出)
vi.mock('../shared/forsionAccount', () => ({ forsionAccountId: () => (env.signOutAfter >= 0 && env.calls++ >= env.signOutAfter ? null : env.account) }))
vi.mock('./amadeus/fs/vaultHandlers', () => ({ withTextWriteLock: async (_p: string, fn: () => Promise<void>) => fn() }))
vi.mock('./amadeus/cloudPaths', () => ({
  cloudVaultDir: () => join(env.root, 'cloud-mirror'),
  isManagedCloudVault: () => false,
  hash8: (s: string) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 8),
}))
vi.mock('./syncRecordsIpc', () => ({ appendSyncRecord: () => {} }))
vi.mock('./contentSyncHost', () => ({ contentSyncOwned: () => false }))

const call = async <T = any>(ch: string, ...args: unknown[]): Promise<T> => env.handlers.get(ch)!({}, ...args) as Promise<T>
const vault = () => join(env.root, 'Vault')
const remote = () => join(env.root, 'Remote')
const read = (p: string): string => readFileSync(p, 'utf8')

beforeEach(() => {
  env.root = realpathSync(mkdtempSync(join(tmpdir(), 'forsion-rs-signout-')))
  env.handlers.clear()
  env.account = ACCOUNT
  env.signOutAfter = -1
  env.calls = 0
  mkdirSync(join(vault(), 'Shared'), { recursive: true })
  mkdirSync(join(remote(), 'Shared'), { recursive: true })
  mkdirSync(join(env.root, 'userData'), { recursive: true })
  writeFileSync(join(vault(), 'a.md'), 'alpha (entry sync manages this)')
  writeFileSync(join(vault(), 'Shared', 's.md'), 'shared (entry sync manages this)')
  writeFileSync(join(vault(), 'b.md'), 'beta (legacy sync manages this)')
  writeFileSync(join(remote(), 'a.md'), 'another a.md on the legacy target')
  writeFileSync(join(remote(), 'Shared', 'only-remote.md'), 'only on the legacy target')
  writeFileSync(join(env.root, 'userData', 'remotesync.json'), JSON.stringify({ backend: 'folder', intervalMin: 0, folder: { path: remote() } }))
})
afterEach(() => { vi.resetModules(); rmSync(env.root, { recursive: true, force: true }) })

async function bootWith(entrySyncRoot: string | null): Promise<void> {
  vi.resetModules()
  const settings = await import('./amadeus/settings')
  const ns = settings.cloudAccountNamespace(ACCOUNT)
  const entrySync = entrySyncRoot ? [{ vaultRoot: entrySyncRoot, cloudName: 'Vault', entries: [{ path: 'a.md', kind: 'page' }, { path: 'Shared', kind: 'folder' }] }] : []
  writeFileSync(join(env.root, 'userData', 'amadeus-config.json'), JSON.stringify({
    lastVault: vault(), localVault: vault(),
    cloudAccounts: { [ns]: { entrySync } },
  }))
  const ipc = await import('./remotesyncIpc')
  ipc.registerRemoteSync()
  ipc.legacyRemoteSync.extendLoaded(false)
}

/** 条目范围里零读零写零删(本机、远端各看一遍)。 */
function entryPathsUntouched(): void {
  expect(read(join(vault(), 'a.md'))).toBe('alpha (entry sync manages this)')
  expect(read(join(remote(), 'a.md'))).toBe('another a.md on the legacy target')
  expect(existsSync(join(vault(), 'Shared', 'only-remote.md'))).toBe(false)
  expect(existsSync(join(remote(), 'Shared', 's.md'))).toBe(false)
  expect(existsSync(join(remote(), 'Shared', 'only-remote.md'))).toBe(true)
  expect(existsSync(join(vault(), 'Shared', 's.md'))).toBe(true)
}

describe('signing out, a legacy round, signing back in', () => {
  it('signed out: the root has entry sync under an account we cannot read now → the round does not run; back in: still skipped, nothing deleted', async () => {
    await bootWith(vault())
    const first = await call<any>('remotesync:run')
    expect(first.ok).toBe(true)
    entryPathsUntouched()
    expect(read(join(remote(), 'b.md'))).toBe('beta (legacy sync manages this)')

    env.account = null // 退出登录
    const out = await call<any>('remotesync:run')
    expect(out.ok).toBe(false)
    expect(out.errors).toEqual(['entry-ignores-unknown'])
    entryPathsUntouched()

    env.account = ACCOUNT // 重新登录
    writeFileSync(join(vault(), 'b2.md'), 'another legacy file')
    const back = await call<any>('remotesync:run')
    expect(back.ok).toBe(true)
    expect(back.deletedLocal + back.deletedRemote).toBe(0)
    entryPathsUntouched()
    expect(read(join(remote(), 'b2.md'))).toBe('another legacy file')
  })

  it('signed out and no account has entry sync on this root (never used it, or it is on another vault): the round runs as before', async () => {
    await bootWith(join(env.root, 'OtherVault'))
    mkdirSync(join(env.root, 'OtherVault'), { recursive: true })
    env.account = null
    const out = await call<any>('remotesync:run')
    expect(out.ok).toBe(true)
    expect(read(join(remote(), 'b.md'))).toBe('beta (legacy sync manages this)')
  })

  it('signed out and the config on disk can no longer be read (the cached copy still can): not knowing = the round does not run', async () => {
    await bootWith(vault())
    expect((await call<any>('remotesync:run')).ok).toBe(true) // 读进缓存
    writeFileSync(join(env.root, 'userData', 'amadeus-config.json'), '{"cloudAccounts":')
    env.account = null
    expect((await call<any>('remotesync:run')).errors).toEqual(['entry-ignores-unknown'])
    entryPathsUntouched()
  })

  it('signed out halfway through a round: the ignore list is read for the account the round started with, never as empty', async () => {
    await bootWith(vault())
    env.calls = 0
    env.signOutAfter = 1 // 这一轮开头那一次还是登录着的,之后都是登出
    const out = await call<any>('remotesync:run')
    expect(env.calls).toBeGreaterThan(1) // 这一轮里确实又问过账号
    expect(out.ok).toBe(true)
    entryPathsUntouched()
    expect(read(join(remote(), 'b.md'))).toBe('beta (legacy sync manages this)')
  })

  it('an entry sync registered through a symlink to this root counts too', async () => {
    const { symlinkSync } = await import('node:fs')
    symlinkSync(vault(), join(env.root, 'VaultLink'))
    await bootWith(join(env.root, 'VaultLink'))
    env.account = null
    expect((await call<any>('remotesync:run')).errors).toEqual(['entry-ignores-unknown'])
    entryPathsUntouched()
  })
})
