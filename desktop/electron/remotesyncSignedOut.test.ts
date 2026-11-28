/**
 * 智库同步 H3 清单第 5 件 + Codex P1:旧 remotesync 一轮的条目忽略名单是一条规矩 ——
 * 盘上**所有**条目同步登记里落在这个根上的路径(当前账号的、别的账号的、待认领的 legacyCloudState、还没挪进去的顶层老字段),
 * 都从同一次严格读来;「不知道」才整轮不跑(entry-ignores-unknown):配置严格读不出 / 名单读不懂 / 某个条目库根解析出
 * ENOENT、ENOTDIR 以外的错。
 * 第一版(只看当前账号)跑出的红:退出登录那一轮名单读成空,条目里的 a.md 被换成远端那份(本机那份成了冲突副本)、
 * Shared/s.md 推上了远端、远端独有的文件拉进了条目文件夹。现在:登出也照名单让开着跑;登录着 B、条目在 A 名下也让开。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

const ENTRIES = [{ path: 'a.md', kind: 'page' }, { path: 'Shared', kind: 'folder' }]
const OTHER = 'https://cloud.test/api::account-2'

/** where:条目同步登记放在哪 —— 'A' = 账号 1 名下、'B' = 账号 2 名下、'legacy' = 待认领的 legacyCloudState、
 *  'top' = 还没挪进 legacyCloudState 的顶层老字段(旁边已经有一份别的 legacyCloudState)、null = 哪儿都没有。 */
async function bootWith(entrySyncRoot: string | null, where: 'A' | 'B' | 'legacy' | 'top' = 'A'): Promise<void> {
  vi.resetModules()
  const settings = await import('./amadeus/settings')
  const entrySync = entrySyncRoot ? [{ vaultRoot: entrySyncRoot, cloudName: 'Vault', entries: ENTRIES }] : []
  const nsA = settings.cloudAccountNamespace(ACCOUNT)
  const nsB = settings.cloudAccountNamespace(OTHER)
  const stored: Record<string, unknown> = { lastVault: vault(), localVault: vault(), cloudAccounts: { [nsA]: { entrySync: [] }, [nsB]: { entrySync: [] } } }
  if (where === 'A') stored.cloudAccounts = { [nsA]: { entrySync }, [nsB]: { entrySync: [] } }
  if (where === 'B') stored.cloudAccounts = { [nsA]: { entrySync: [] }, [nsB]: { entrySync } }
  if (where === 'legacy') stored.legacyCloudState = { entrySync }
  if (where === 'top') { stored.entrySync = entrySync; stored.legacyCloudState = { entrySync: [{ vaultRoot: join(env.root, 'Elsewhere'), cloudName: 'E', entries: [] }] } }
  writeFileSync(join(env.root, 'userData', 'amadeus-config.json'), JSON.stringify(stored))
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
  it('signed out: the list is still known (all accounts), so the round runs and stays off the entry paths; back in: nothing deleted', async () => {
    await bootWith(vault())
    const first = await call<any>('remotesync:run')
    expect(first.ok).toBe(true)
    entryPathsUntouched()
    expect(read(join(remote(), 'b.md'))).toBe('beta (legacy sync manages this)')

    env.account = null // 退出登录
    writeFileSync(join(vault(), 'b2.md'), 'written while signed out')
    const out = await call<any>('remotesync:run')
    expect(out.ok).toBe(true)
    entryPathsUntouched()
    expect(read(join(remote(), 'b2.md'))).toBe('written while signed out') // 条目之外照常同步

    env.account = ACCOUNT // 重新登录
    writeFileSync(join(vault(), 'b3.md'), 'another legacy file')
    const back = await call<any>('remotesync:run')
    expect(back.ok).toBe(true)
    expect(back.deletedLocal + back.deletedRemote).toBe(0)
    entryPathsUntouched()
    expect(read(join(remote(), 'b3.md'))).toBe('another legacy file')
  })

  it('signed in as another account, the entry sync registered under the first one is still stayed off', async () => {
    await bootWith(vault(), 'A')
    env.account = OTHER
    expect((await call<any>('remotesync:run')).ok).toBe(true)
    entryPathsUntouched()
  })

  it('entry sync waiting to be adopted (legacyCloudState) and the old top-level field next to it are stayed off too', async () => {
    for (const where of ['legacy', 'top'] as const) {
      await bootWith(vault(), where)
      expect((await call<any>('remotesync:run')).ok).toBe(true)
      entryPathsUntouched()
    }
  })

  it('no entry sync on this root anywhere (never used it, or it is on another vault): the whole vault syncs as before, signed in or out', async () => {
    mkdirSync(join(env.root, 'OtherVault'), { recursive: true })
    await bootWith(join(env.root, 'OtherVault'))
    env.account = null
    const out = await call<any>('remotesync:run')
    expect(out.ok).toBe(true)
    expect(read(join(remote(), 'b.md'))).toBe('beta (legacy sync manages this)')
    expect(existsSync(join(remote(), 'Shared', 's.md'))).toBe(true) // 不是条目:照常推
  })

  it('the config on disk can no longer be read (the cached copy still can): not knowing = the round does not run', async () => {
    await bootWith(vault())
    expect((await call<any>('remotesync:run')).ok).toBe(true) // 读进缓存
    writeFileSync(join(env.root, 'userData', 'amadeus-config.json'), '{"cloudAccounts":')
    for (const acct of [ACCOUNT, null]) {
      env.account = acct
      expect((await call<any>('remotesync:run')).errors).toEqual(['entry-ignores-unknown'])
      entryPathsUntouched()
    }
  })

  it('a list it cannot make sense of (an account\'s entrySync is not a list) is not "no entry sync": the round does not run', async () => {
    await bootWith(vault(), 'A')
    const settings = await import('./amadeus/settings')
    const cfgPath = join(env.root, 'userData', 'amadeus-config.json')
    const cur = JSON.parse(read(cfgPath))
    cur.cloudAccounts[settings.cloudAccountNamespace(OTHER)] = { entrySync: 'broken' }
    writeFileSync(cfgPath, JSON.stringify(cur))
    expect((await call<any>('remotesync:run')).errors).toEqual(['entry-ignores-unknown'])
    entryPathsUntouched()
  })

  it('another entry vault root that cannot be resolved (no permission) is not "another vault": the round does not run', async () => {
    const locked = join(env.root, 'locked')
    mkdirSync(join(locked, 'Inner'), { recursive: true })
    await bootWith(join(locked, 'Inner'), 'B')
    chmodSync(locked, 0o000)
    try {
      expect((await call<any>('remotesync:run')).errors).toEqual(['entry-ignores-unknown'])
    } finally { chmodSync(locked, 0o755) }
    expect(existsSync(join(remote(), 'b.md'))).toBe(false)
  })

  it('an entry sync still being written when the round starts is waited for (the snapshot reads after the settings write queue)', async () => {
    await bootWith(null)
    const settings = await import('./amadeus/settings')
    const realRename = fsp.rename.bind(fsp) as (...a: unknown[]) => Promise<unknown>
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (from: unknown, to: unknown) => {
      if (String(to).endsWith('amadeus-config.json')) await new Promise((r) => setTimeout(r, 80)) // 写到一半:临时文件写好了,还没换上
      return realRename(from, to)
    }) as never)
    try {
      const writing = settings.writeConfig({ entrySync: [{ vaultRoot: vault(), cloudName: 'Vault', entries: ENTRIES as never }] }, ACCOUNT)
      const out = await call<any>('remotesync:run')
      await writing
      expect(out.ok).toBe(true)
    } finally { spy.mockRestore() }
    entryPathsUntouched()
  })

  it('signed out halfway through a round: still stayed off (the list does not depend on who is signed in)', async () => {
    await bootWith(vault())
    env.calls = 0
    env.signOutAfter = 1
    const out = await call<any>('remotesync:run')
    expect(env.calls).toBeGreaterThan(1)
    expect(out.ok).toBe(true)
    entryPathsUntouched()
  })

  it('an entry sync registered through a symlink to this root counts too (signed out)', async () => {
    symlinkSync(vault(), join(env.root, 'VaultLink'))
    await bootWith(join(env.root, 'VaultLink'))
    env.account = null
    expect((await call<any>('remotesync:run')).ok).toBe(true)
    entryPathsUntouched()
  })
})

describe('the takeover view reads one strict settings snapshot (Codex P2)', () => {
  it('amadeus-config broken while remotesync.json and sync-targets are fine: the view throws a fixed code, never root:null with empty entryIgnores', async () => {
    await bootWith(vault())
    const ipc = await import('./remotesyncIpc')
    expect((await ipc.legacyRemoteSync.view())?.entryIgnores).toEqual(['a.md', 'a.fd/', 'Shared/'])
    writeFileSync(join(env.root, 'userData', 'sync-targets.json'), JSON.stringify({ version: 1, targets: {} }))
    writeFileSync(join(env.root, 'userData', 'amadeus-config.json'), '{"lastVault":')
    const err = await ipc.legacyRemoteSync.view().then(() => null, (e: Error) => e)
    expect(err?.message).toBe('amadeus-config-unparseable')
    const { createSyncTargets } = await import('./syncTargets')
    await expect(createSyncTargets().legacyRemoteSync()).rejects.toThrow('amadeus-config-unparseable')
  })
})
