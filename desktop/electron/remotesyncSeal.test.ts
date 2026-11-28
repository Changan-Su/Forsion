/**
 * 智库同步第 2 步 H 包:新同步接手旧 remotesync(契约 §3.8 D、§3.9、实现期修订 H-1 第 1、2 条)。
 * - 封口:闸先关上,在途那一轮跑完 seal 才返回;之后手动 / 定时 / 预演 / 用云端那份一律 sealed;
 * - 握手:落盘持有着、Extend 不在 → 这次启动交还;Extend 在、还没握手 / 已握手 → 拦着;
 * - 归档:remotesync.json 原样复制进档案(只复制一次),原文件只改 intervalMin / syncOnStart 两项,基线挪进档案;
 * - 导入:凭据复制进 sync-targets(0600),同一来源只建一条,接手视图里没有任何凭据;
 * - 读失败 ≠ 空:remotesync.json 读不了时接手视图抛错;设置页再保存先把坏文件挪开,不拿缺省值盖掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...a: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  app: { getPath: () => join(env.root, 'userData') },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { env.handlers.set(ch, fn) } },
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: () => { throw new Error('no network in tests') } },
  shell: { trashItem: async (p: string) => { rmSync(p, { force: true }) }, openExternal: async () => {} },
}))
vi.mock('./forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => join(env.root, 'home') }))
vi.mock('./amadeus/settings', () => ({
  readConfig: async () => ({ lastVault: join(env.root, 'Vault'), localVault: join(env.root, 'Vault'), entrySync: [] }),
  currentCloudAccountId: () => null,
}))
vi.mock('./amadeus/cloudPaths', () => ({
  cloudVaultDir: () => join(env.root, 'cloud-mirror'),
  isManagedCloudVault: () => false,
  hash8: (s: string) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 8),
}))
vi.mock('./contentSyncHost', () => ({ contentSyncOwned: () => false }))
vi.mock('./syncRecordsIpc', () => ({ appendSyncRecord: () => {} }))

type Ipc = typeof import('./remotesyncIpc')
let ipc: Ipc
const call = async <T = any>(ch: string, ...args: unknown[]): Promise<T> => env.handlers.get(ch)!({}, ...args) as Promise<T>
const userData = () => join(env.root, 'userData')
const cfgFile = () => join(userData(), 'remotesync.json')

async function boot(): Promise<Ipc> {
  vi.resetModules()
  env.handlers.clear()
  ipc = await import('./remotesyncIpc')
  ipc.registerRemoteSync()
  return ipc
}

beforeEach(() => {
  env.root = mkdtempSync(join(tmpdir(), 'forsion-rs-seal-'))
  mkdirSync(join(env.root, 'Vault'), { recursive: true })
  mkdirSync(join(env.root, 'Remote'), { recursive: true })
  mkdirSync(userData(), { recursive: true })
  writeFileSync(join(env.root, 'Vault', 'a.md'), 'alpha')
  writeFileSync(join(env.root, 'Vault', 'b.md'), 'beta')
})
afterEach(() => { vi.useRealTimers(); rmSync(env.root, { recursive: true, force: true }) })

/** 一个可控的慢后端:写第一个文件时停住,直到 release()。 */
async function slowBackend() {
  const { registerRemoteSyncBackend } = await import('./remotesync/backends')
  const { createDirRemote } = await import('./remotesync/fsLocal')
  let entered!: () => void, release!: () => void
  const enteredP = new Promise<void>((r) => { entered = r })
  const releaseP = new Promise<void>((r) => { release = r })
  let held = false
  registerRemoteSyncBackend('slow', async () => {
    const inner = createDirRemote(join(env.root, 'Remote'))
    return { fingerprint: 'slow:remote', remote: { ...inner, kind: 'slow', async writeFile(...a: Parameters<typeof inner.writeFile>) { if (!held) { held = true; entered(); await releaseP } return inner.writeFile(...a) } } }
  })
  return { entered: enteredP, release }
}

describe('sealing the legacy remotesync', () => {
  it('closes the gate first, waits for the round in flight, then blocks manual, timer, dry-run and adopt entries', async () => {
    await boot()
    const slow = await slowBackend()
    await call('remotesync:set', { backend: 'slow', intervalMin: 5, syncOnStart: true })
    ipc.legacyRemoteSync.extendLoaded(true)
    const round = call<any>('remotesync:run')
    await slow.entered
    let sealed = false
    const seal = ipc.legacyRemoteSync.seal().then(() => { sealed = true })
    await new Promise((r) => setTimeout(r, 20))
    expect(sealed).toBe(false) // 在途那一轮还没跑完
    expect((await call<any>('remotesync:run')).errors).toEqual(['already-running'])
    slow.release()
    const report = await round
    expect(report.ok).toBe(true)
    expect(report.pushed).toBe(2)
    await seal
    expect(sealed).toBe(true)
    for (const opts of [undefined, { dryRun: true }, { allowMassDelete: true }]) expect((await call<any>('remotesync:run', opts)).errors).toEqual(['sealed'])
    expect((await call<any>('remotesync:adoptRemote', 'backup')).error).toBe('sealed')
    const st = await call<any>('remotesync:get')
    expect(st.seal).toMatchObject({ state: 'v2-holds', hold: 'v2', blocked: true, handshake: 'ok' })
    expect(JSON.parse(readFileSync(join(userData(), 'sync-targets.json'), 'utf8')).legacy).toMatchObject({ holder: 'v2', archived: false })
    // 交还(接手中途退回):旧入口回来
    await ipc.legacyRemoteSync.unseal()
    expect((await call<any>('remotesync:run')).ok).toBe(true)
  })

  it('across a restart: Extend absent hands the legacy sync back for this launch; Extend present keeps it blocked', async () => {
    writeFileSync(join(userData(), 'sync-targets.json'), JSON.stringify({ version: 1, targets: {}, legacy: { holder: 'v2', archived: true } }))
    writeFileSync(cfgFile(), JSON.stringify({ backend: 'folder', intervalMin: 0, folder: { path: join(env.root, 'Remote') } }))
    await boot()
    await new Promise((r) => setTimeout(r, 10))
    expect((await call<any>('remotesync:run')).errors).toEqual(['sealed']) // 握手前:按持有拦着
    ipc.legacyRemoteSync.extendLoaded(false)
    expect((await call<any>('remotesync:run')).ok).toBe(true) // Extend 没装载 = 没有第二个写者,交还
    expect(JSON.parse(readFileSync(join(userData(), 'sync-targets.json'), 'utf8')).legacy.holder).toBe('v2') // 落盘的持有不改

    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await new Promise((r) => setTimeout(r, 10))
    expect((await call<any>('remotesync:run')).errors).toEqual(['sealed'])
    await ipc.legacyRemoteSync.touch()
    expect((await call<any>('remotesync:run')).errors).toEqual(['sealed'])
  })

  it('an unreadable hold state is treated as held until Extend is known to be absent', async () => {
    writeFileSync(join(userData(), 'sync-targets.json'), '{"version":1,')
    writeFileSync(cfgFile(), JSON.stringify({ backend: 'folder', intervalMin: 0, folder: { path: join(env.root, 'Remote') } }))
    await boot()
    await new Promise((r) => setTimeout(r, 10))
    ipc.legacyRemoteSync.extendLoaded(true)
    expect((await call<any>('remotesync:run')).errors).toEqual(['sealed'])
    await expect(ipc.legacyRemoteSync.view()).rejects.toThrow()
    await expect(ipc.legacyRemoteSync.seal()).rejects.toThrow()
    expect(readFileSync(join(userData(), 'sync-targets.json'), 'utf8')).toBe('{"version":1,') // 读不了的不被一份「不知道」盖掉
  })
})

describe('archiving the legacy remotesync', () => {
  const original = () => ({
    backend: 'webdav', intervalMin: 15, syncOnStart: true, direction: 'push', ignore: ['Private/**'], maxFileMB: 20, concurrency: 3,
    webdav: { address: 'https://dav.example.test/remote.php', username: 'fixture-user', password: 'fixture-secret-value', baseDir: 'team/vault' },
  })

  it('copies the config verbatim once, flips only the two auto-sync fields, moves the baselines, and is idempotent', async () => {
    const bytes = JSON.stringify(original(), null, 2)
    writeFileSync(cfgFile(), bytes, { mode: 0o600 })
    mkdirSync(join(userData(), 'remotesync-state'))
    writeFileSync(join(userData(), 'remotesync-state', 'abcd1234.json'), '{"version":1,"fingerprint":"x","entries":{}}')
    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await expect(ipc.legacyRemoteSync.archive(join(env.root, 'archive'))).rejects.toThrow('legacy-not-sealed')
    await ipc.legacyRemoteSync.seal()
    const out = await ipc.legacyRemoteSync.archive(join(env.root, 'archive'))
    expect(readFileSync(join(env.root, 'archive', 'remotesync.json'), 'utf8')).toBe(bytes)
    const now = JSON.parse(readFileSync(cfgFile(), 'utf8'))
    expect(now).toEqual({ ...original(), intervalMin: 0, syncOnStart: false })
    expect(statSync(cfgFile()).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(userData(), 'remotesync-state'))).toEqual([])
    expect(readFileSync(join(env.root, 'archive', 'remotesync-state', 'abcd1234.json'), 'utf8')).toContain('"fingerprint":"x"')
    expect(out.copied).toHaveLength(1)
    expect(out.moved).toHaveLength(1)
    // 重跑:档案里那份原件不被改过的内容盖掉
    const again = await ipc.legacyRemoteSync.archive(join(env.root, 'archive'))
    expect(again).toEqual({ copied: [], moved: [] })
    expect(readFileSync(join(env.root, 'archive', 'remotesync.json'), 'utf8')).toBe(bytes)
    expect((await call<any>('remotesync:get')).config).toMatchObject({ intervalMin: 0, syncOnStart: false })
    expect(JSON.parse(readFileSync(join(userData(), 'sync-targets.json'), 'utf8')).legacy).toMatchObject({ holder: 'v2', archived: true })
  })

  it('imports credentials into sync-targets (0600) once per source; the Extend-facing view carries no credentials', async () => {
    writeFileSync(cfgFile(), JSON.stringify(original(), null, 2))
    await boot()
    const { createSyncTargets } = await import('./syncTargets')
    const seam = createSyncTargets()
    const view = await seam.legacyRemoteSync()
    expect(view).toMatchObject({ config: { backend: 'webdav', dir: 'team/vault', direction: 'push', ignore: ['Private/**'], maxFileMB: 20, intervalMin: 15, syncOnStart: true, concurrency: 3 }, hold: 'none', archived: false, targetId: null })
    expect(JSON.stringify(view)).not.toContain('fixture-secret-value')
    expect(JSON.stringify(view)).not.toContain('fixture-user')
    const before = readFileSync(cfgFile(), 'utf8')
    const { targetId } = await seam.importLegacyRemoteSync()
    expect(readFileSync(cfgFile(), 'utf8')).toBe(before) // 原文件不动
    const file = join(userData(), 'sync-targets.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    expect(stored.targets[targetId]).toMatchObject({ kind: 'webdav', section: original().webdav })
    expect((await seam.importLegacyRemoteSync()).targetId).toBe(targetId)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).targets)).toEqual([targetId])
    expect((await seam.legacyRemoteSync())?.targetId).toBe(targetId)
    const listed = await seam.list()
    expect(listed).toEqual([{ id: targetId, kind: 'webdav', label: 'dav.example.test', dirDefault: 'team/vault', source: 'remotesync' }])
    expect(JSON.stringify(listed)).not.toContain('fixture-secret-value')
  })

  it('refuses to import the penzor backend (it moves to a vault by name instead)', async () => {
    writeFileSync(cfgFile(), JSON.stringify({ backend: 'penzor', intervalMin: 5, penzor: { vault: 'default' } }))
    await boot()
    const { createSyncTargets } = await import('./syncTargets')
    await expect(createSyncTargets().importLegacyRemoteSync()).rejects.toThrow('penzor-not-importable')
  })
})

describe('reading the legacy config strictly', () => {
  it('an unreadable remotesync.json is not "no config"; saving from the old settings page moves it aside instead of overwriting it', async () => {
    writeFileSync(cfgFile(), '{"backend":"webdav","webdav":{"password":"fixture-secret-value"')
    await boot()
    await expect(ipc.legacyRemoteSync.view()).rejects.toThrow()
    await expect(ipc.legacyRemoteSync.section()).rejects.toThrow()
    await call('remotesync:get')
    await call('remotesync:set', { backend: 'off' })
    const aside = readdirSync(userData()).filter((n) => n.startsWith('remotesync.json.unreadable-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(userData(), aside[0]), 'utf8')).toContain('fixture-secret-value')
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8')).backend).toBe('off')
  })

  it('no config file at all = null (nothing to take over)', async () => {
    await boot()
    expect(await ipc.legacyRemoteSync.view()).toBeNull()
    expect(existsSync(cfgFile())).toBe(false)
  })
})
