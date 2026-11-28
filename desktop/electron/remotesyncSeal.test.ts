/**
 * 智库同步第 2 步 H 包:新同步接手旧 remotesync(契约 §3.8 D、§3.9、实现期修订 H-1 第 1、2 条)。
 * - 封口:闸先关上,在途那一轮跑完 seal 才返回;之后手动 / 定时 / 预演 / 用云端那份一律 sealed;
 * - 握手:落盘持有着、Extend 不在 → 这次启动交还;Extend 在、还没握手 / 已握手 → 拦着;
 * - 归档:remotesync.json 原样复制进档案(只复制一次),原文件只改 intervalMin / syncOnStart 两项,基线挪进档案;
 * - 导入:凭据复制进 sync-targets(0600),同一来源只建一条,接手视图里没有任何凭据;
 * - 读失败 ≠ 空:remotesync.json 读不了时接手视图抛错;设置页再保存先把坏文件挪开,不拿缺省值盖掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const env = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...a: unknown[]) => unknown>(), entrySync: [] as unknown[] }))
vi.mock('electron', () => ({
  app: { getPath: () => join(env.root, 'userData') },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { env.handlers.set(ch, fn) } },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { trashItem: async (p: string) => { rmSync(p, { force: true }) }, openExternal: async () => {} },
}))
vi.mock('./forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => join(env.root, 'home') }))
vi.mock('./amadeus/settings', () => ({
  readConfig: async () => ({ lastVault: join(env.root, 'Vault'), localVault: join(env.root, 'Vault'), entrySync: env.entrySync }),
  // 这份夹具不分账号:当前账号的名单就是全部账号的名单(分账号、登出、待认领那几条路在 remotesyncSignedOut.test.ts 里用真 settings 测)
  readEntrySyncSnapshotStrict: async () => ({
    config: { lastVault: join(env.root, 'Vault'), localVault: join(env.root, 'Vault'), entrySync: env.entrySync },
    allEntrySync: env.entrySync,
  }),
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
const h8 = (x: string): string => createHash('sha256').update(x).digest('hex').slice(0, 8)
/** runNow 的基线文件名:remotesync-state/<hash8(真实库根|指纹)>.json(mac 的临时目录 /var 是 /private/var 的软链)。 */
const baselineName = (fp: string, root = realpathSync.native(join(env.root, 'Vault'))): string => `${h8(`${root}|${fp}`)}.json`
const leak = (o: unknown): string => JSON.stringify(o).replace('"QQQ"', 'fixture-secret-value') // 不带引号的值:V8 的 JSON 报错会带出这一截原文

async function boot(): Promise<Ipc> {
  vi.resetModules()
  env.handlers.clear()
  ipc = await import('./remotesyncIpc')
  ipc.registerRemoteSync()
  return ipc
}

beforeEach(() => {
  env.root = mkdtempSync(join(tmpdir(), 'forsion-rs-seal-'))
  env.entrySync = []
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
    const fp = 'webdav:https://dav.example.test/remote.php/team/vault'
    const mine = baselineName(fp)
    writeFileSync(join(userData(), 'remotesync-state', mine), JSON.stringify({ version: 1, fingerprint: fp, entries: {} }))
    writeFileSync(join(userData(), 'remotesync-state', 'abcd1234.json'), '{"version":1,"fingerprint":"x","entries":{}}') // 用户以前同步过的别的根 × 去处:留着
    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await expect(ipc.legacyRemoteSync.archive(join(env.root, 'archive'))).rejects.toThrow('legacy-not-sealed')
    await ipc.legacyRemoteSync.seal()
    const out = await ipc.legacyRemoteSync.archive(join(env.root, 'archive'))
    expect(readFileSync(join(env.root, 'archive', 'remotesync.json'), 'utf8')).toBe(bytes)
    const now = JSON.parse(readFileSync(cfgFile(), 'utf8'))
    expect(now).toEqual({ ...original(), intervalMin: 0, syncOnStart: false })
    expect(statSync(cfgFile()).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(userData(), 'remotesync-state'))).toEqual(['abcd1234.json'])
    expect(readFileSync(join(env.root, 'archive', 'remotesync-state', mine), 'utf8')).toContain(fp)
    expect(out.copied).toHaveLength(1)
    expect(out.moved).toHaveLength(1)
    // 重跑:档案里那份原件不被改过的内容盖掉
    const again = await ipc.legacyRemoteSync.archive(join(env.root, 'archive'))
    expect(again).toEqual({ copied: [], moved: [] })
    expect(readFileSync(join(env.root, 'archive', 'remotesync.json'), 'utf8')).toBe(bytes)
    expect((await call<any>('remotesync:get')).config).toMatchObject({ intervalMin: 0, syncOnStart: false })
    expect(JSON.parse(readFileSync(join(userData(), 'sync-targets.json'), 'utf8')).legacy).toMatchObject({ holder: 'v2', archived: true })
  })

  it('archive with the key seen at takeover: a config changed meanwhile (another bucket / root) is refused and nothing moves', async () => {
    writeFileSync(cfgFile(), JSON.stringify(original(), null, 2), { mode: 0o600 })
    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await ipc.legacyRemoteSync.seal()
    const seen = (await ipc.legacyRemoteSync.view())!.legacyKey!
    expect(seen).toMatch(/^[a-f0-9]{32}$/)
    expect(JSON.stringify(await ipc.legacyRemoteSync.view())).not.toContain('fixture-secret-value')
    const moved = { ...original(), webdav: { ...original().webdav, baseDir: 'team/other' } }
    writeFileSync(cfgFile(), JSON.stringify(moved, null, 2), { mode: 0o600 })
    await expect(ipc.legacyRemoteSync.archive(join(env.root, 'archive'), { expectKey: seen })).rejects.toThrow('legacy-config-changed')
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8'))).toEqual(moved) // 原文件没动
    expect(existsSync(join(env.root, 'archive', 'remotesync.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(userData(), 'sync-targets.json'), 'utf8')).legacy.archived).toBe(false)
    // 键对得上:照常归档,档案里不留临时文件
    const now = (await ipc.legacyRemoteSync.view())!.legacyKey!
    await ipc.legacyRemoteSync.archive(join(env.root, 'archive'), { expectKey: now })
    expect(readdirSync(join(env.root, 'archive')).filter((n) => n.includes('.tmp-'))).toEqual([])
    expect(JSON.parse(readFileSync(join(env.root, 'archive', 'remotesync.json'), 'utf8'))).toEqual(moved)
  })

  it('a Google Drive config (written by a version with Drive, then downgraded) is refused: nothing copied, the config and every baseline stay put', async () => {
    const drive = { backend: 'gdrive', intervalMin: 15, syncOnStart: true, gdrive: { clientId: '', refreshToken: 'fixture-secret-value', baseDir: 'Vault' } }
    const bytes = JSON.stringify(drive, null, 2)
    writeFileSync(cfgFile(), bytes, { mode: 0o600 })
    mkdirSync(join(userData(), 'remotesync-state'))
    // 两份不同账号 / 目录的 Drive 基线:这一版算不出指纹,认不准该挪哪份,一份都不挪
    const fps = ['gdrive:perm-a/Vault', 'gdrive:perm-b/Other']
    for (const fp of fps) writeFileSync(join(userData(), 'remotesync-state', baselineName(fp)), JSON.stringify({ version: 1, fingerprint: fp, entries: {} }))
    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await ipc.legacyRemoteSync.seal()
    await expect(ipc.legacyRemoteSync.archive(join(env.root, 'archive'))).rejects.toThrow('legacy-backend-unsupported')
    expect(readFileSync(cfgFile(), 'utf8')).toBe(bytes)
    expect(readdirSync(join(userData(), 'remotesync-state')).sort()).toEqual(fps.map((fp) => baselineName(fp)).sort())
    expect(existsSync(join(env.root, 'archive', 'remotesync.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(userData(), 'sync-targets.json'), 'utf8')).legacy.archived).toBe(false)
  })

  it('hand-back after a failed takeover can restore the two auto-sync fields from the archived original; plain unseal keeps manual-only; a user change is kept', async () => {
    writeFileSync(cfgFile(), JSON.stringify(original(), null, 2), { mode: 0o600 })
    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await ipc.legacyRemoteSync.seal()
    await ipc.legacyRemoteSync.archive(join(env.root, 'archive'))
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8'))).toMatchObject({ intervalMin: 0, syncOnStart: false })
    // 不带 restoreAutoSync:同第 2 步以前,交还后只能手动
    await ipc.legacyRemoteSync.unseal()
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8'))).toMatchObject({ intervalMin: 0, syncOnStart: false })
    // 再封一次、带 restoreAutoSync 交还:两项从档案原件回来,别的字段原样
    await ipc.legacyRemoteSync.seal()
    await ipc.legacyRemoteSync.unseal({ restoreAutoSync: true })
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8'))).toEqual(original())
    expect((await call<any>('remotesync:get')).config).toMatchObject({ intervalMin: 15, syncOnStart: true })
    expect(JSON.parse(readFileSync(join(userData(), 'sync-targets.json'), 'utf8')).legacy).toMatchObject({ holder: null, archived: true })
    // 用户在归档之后自己改过(不是 0 / false):不动
    const mine = { ...original(), intervalMin: 30, syncOnStart: false }
    writeFileSync(cfgFile(), JSON.stringify(mine, null, 2), { mode: 0o600 })
    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await ipc.legacyRemoteSync.seal()
    await ipc.legacyRemoteSync.unseal({ restoreAutoSync: true })
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8'))).toEqual(mine)
  })

  it('penzor (its fingerprint needs a whoami round-trip): moves only this root\'s penzor baselines for this vault, recognised by their own recorded fingerprint', async () => {
    writeFileSync(cfgFile(), JSON.stringify({ backend: 'penzor', intervalMin: 5, penzor: { vault: 'notes' } }))
    const sd = join(userData(), 'remotesync-state')
    mkdirSync(sd)
    const put = (fp: string, root?: string): string => { const n = baselineName(fp, root); writeFileSync(join(sd, n), JSON.stringify({ version: 1, fingerprint: fp, entries: {} })); return n }
    const mine = put('penzor:https://cloud.test|u:1|notes')
    const keep = [put('penzor:https://cloud.test|u:1|default'), put('penzor:https://cloud.test|u:1|notes', '/elsewhere/Vault'), put('webdav:https://dav.test/x')]
    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await ipc.legacyRemoteSync.seal()
    const out = await ipc.legacyRemoteSync.archive(join(env.root, 'archive'))
    expect(out.moved.map((p) => basename(p))).toEqual([mine])
    expect(readdirSync(sd).sort()).toEqual([...keep].sort())
  })

  it('archive keeps the gate shut while it waits for a legacy round that started after the hand-back, and moves that round\'s baseline', async () => {
    writeFileSync(join(userData(), 'sync-targets.json'), JSON.stringify({ version: 1, targets: {}, legacy: { holder: 'v2', archived: false } }))
    writeFileSync(cfgFile(), JSON.stringify({ backend: 'slow', intervalMin: 0 }))
    await boot()
    const slow = await slowBackend()
    await new Promise((r) => setTimeout(r, 10))
    ipc.legacyRemoteSync.extendLoaded(false) // Extend 没装载:这次启动交还给 remotesync
    const round = call<any>('remotesync:run')
    await slow.entered
    const archiving = ipc.legacyRemoteSync.archive(join(env.root, 'archive'))
    await new Promise((r) => setTimeout(r, 20))
    expect((await call<any>('remotesync:get')).seal.blocked).toBe(true)
    slow.release()
    expect((await round).ok).toBe(true)
    const out = await archiving
    expect(out.moved.map((p) => basename(p))).toEqual([baselineName('slow:remote')])
  })

  it('a credential saved while the archive rewrites remotesync.json is not lost (one write queue for the file)', async () => {
    writeFileSync(cfgFile(), JSON.stringify(original(), null, 2), { mode: 0o600 })
    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await ipc.legacyRemoteSync.seal()
    await call('remotesync:get')
    const realRead = fsp.readFile.bind(fsp) as (...a: unknown[]) => Promise<unknown>
    let saving: Promise<unknown> | null = null
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const out = await realRead(p, ...rest)
      if (!saving && String(p) === cfgFile()) {
        // 归档刚读完旧文件:设置页(或 OAuth 回调)这时存下新凭据。不在这里等它 —— 有写队列时它排在归档后面
        saving = call('remotesync:set', { webdav: { ...original().webdav, password: 'fixture-new-secret' } })
        await new Promise((r) => setTimeout(r, 30))
      }
      return out
    }) as never)
    try {
      await ipc.legacyRemoteSync.archive(join(env.root, 'archive'))
      await saving
    } finally { spy.mockRestore() }
    const now = JSON.parse(readFileSync(cfgFile(), 'utf8'))
    expect(now.webdav.password).toBe('fixture-new-secret')
    expect(now).toMatchObject({ intervalMin: 0, syncOnStart: false })
    expect(JSON.parse(readFileSync(join(env.root, 'archive', 'remotesync.json'), 'utf8')).webdav.password).toBe('fixture-secret-value')
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

describe('saving the legacy config', () => {
  it('a failed move-aside of an unreadable config stops the save: the old file is not truncated and nothing is cached', async () => {
    writeFileSync(cfgFile(), '{"backend":"webdav","webdav":{"password":"fixture-secret-value"')
    await boot()
    await call('remotesync:get')
    chmodSync(userData(), 0o555) // 改名要目录可写,覆盖写已有文件不要
    try {
      await expect(call('remotesync:set', { backend: 'folder', folder: { path: join(env.root, 'Remote') } })).rejects.toThrow()
    } finally { chmodSync(userData(), 0o755) }
    expect(readFileSync(cfgFile(), 'utf8')).toContain('fixture-secret-value')
    expect((await call<any>('remotesync:get')).config.backend).toBe('off')
  })
})

describe('credential-bearing files never leak into errors or logs', () => {
  it('a corrupt remotesync.json or sync-targets file surfaces fixed codes on the Extend seam, the renderer IPC and the gate log', async () => {
    writeFileSync(cfgFile(), leak({ backend: 'webdav', webdav: { address: 'https://dav.test', password: 'QQQ' } }))
    writeFileSync(join(userData(), 'sync-targets.json'), leak({ version: 1, targets: { t: { kind: 's3', label: 'x', section: { secretAccessKey: 'QQQ' } } } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await boot()
      const { registerSyncTargetsIpc } = await import('./syncTargets')
      registerSyncTargetsIpc()
      await new Promise((r) => setTimeout(r, 10))
      const errs: string[] = []
      const grab = async (p: Promise<unknown>): Promise<void> => { try { await p; errs.push('resolved') } catch (e) { errs.push(String((e as Error)?.message)) } }
      await grab(ipc.legacyRemoteSync.view())
      await grab(ipc.legacyRemoteSync.section())
      await grab(call('remotesync:targets:list'))
      await grab(call('remotesync:targets:save', { kind: 's3', section: { endpoint: 'https://s3.test', bucket: 'b', accessKeyID: 'k', secretAccessKey: 's' } }))
      errs.push((await call<any>('remotesync:targets:check', 't')).error)
      expect([...errs, ...warn.mock.calls.map((c) => c.map(String).join(' '))].join('\n')).not.toContain('fixture-sec')
      expect(errs).toEqual(['remotesync-config-unparseable', 'remotesync-config-unparseable', 'sync-targets-unparseable', 'sync-targets-unparseable', 'sync-targets-unparseable'])
    } finally { warn.mockRestore() }
  })
})

describe('sync targets keep their identity', () => {
  it('saving an existing target with another location or account is refused; the same location may update its credentials', async () => {
    await boot()
    const { saveSyncTarget } = await import('./syncTargets')
    const file = (): any => JSON.parse(readFileSync(join(userData(), 'sync-targets.json'), 'utf8'))
    const s3 = { endpoint: 'https://s3.test', bucket: 'bucket-a', prefix: 'vault', accessKeyID: 'k1', secretAccessKey: 'fixture-secret-1' }
    const a = await saveSyncTarget({ kind: 's3', section: s3 })
    await expect(saveSyncTarget({ id: a.id, kind: 's3', section: { ...s3, bucket: 'bucket-b' } })).rejects.toThrow('target-location-changed')
    await expect(saveSyncTarget({ id: a.id, kind: 's3', section: { ...s3, prefix: 'other' } })).rejects.toThrow('target-location-changed')
    await saveSyncTarget({ id: a.id, kind: 's3', section: { ...s3, accessKeyID: 'k2', secretAccessKey: 'fixture-secret-2' } }) // 换钥匙 = 同一个桶
    expect(file().targets[a.id].section).toMatchObject({ bucket: 'bucket-a', secretAccessKey: 'fixture-secret-2' })
    const dav = { address: 'https://dav.test/remote.php', username: 'fixture-user-a', password: 'p1', baseDir: 'v' }
    const d = await saveSyncTarget({ kind: 'webdav', section: dav })
    await expect(saveSyncTarget({ id: d.id, kind: 'webdav', section: { ...dav, username: 'fixture-user-b' } })).rejects.toThrow('target-location-changed')
    await expect(saveSyncTarget({ id: d.id, kind: 'webdav', section: { ...dav, address: 'https://other.test/remote.php' } })).rejects.toThrow('target-location-changed')
    // 打开时原样用 section:目录多一个空格 = 另一个目录,哪怕 targetLocation 去空格后看着一样
    await expect(saveSyncTarget({ id: d.id, kind: 'webdav', section: { ...dav, baseDir: 'v ' } })).rejects.toThrow('target-location-changed')
    await expect(saveSyncTarget({ id: a.id, kind: 's3', section: { ...s3, bucket: 'bucket-a ' } })).rejects.toThrow('target-location-changed')
    await saveSyncTarget({ id: d.id, kind: 'webdav', section: { ...dav, password: 'p2' } })
    expect(file().targets[d.id].section.password).toBe('p2')
    const dbx = { appKey: 'fixture-app', refreshToken: 'r1', accountId: 'dbid:a', baseDir: 'v' }
    const x = await saveSyncTarget({ kind: 'dropbox', section: dbx })
    await expect(saveSyncTarget({ id: x.id, kind: 'dropbox', section: { ...dbx, accountId: 'dbid:b' } })).rejects.toThrow('target-location-changed')
    await saveSyncTarget({ id: x.id, kind: 'dropbox', section: { ...dbx, refreshToken: 'r2' } })
    mkdirSync(join(env.root, 'Remote2'))
    const f = await saveSyncTarget({ kind: 'folder', section: { path: join(env.root, 'Remote') } })
    await expect(saveSyncTarget({ id: f.id, kind: 'folder', section: { path: join(env.root, 'Remote2') } })).rejects.toThrow('target-location-changed')
  })
})

describe('entry ignores', () => {
  it('compare physical roots: a vault registered through a symlink counts, a missing one does not, an unresolvable one counts (pause rather than guess)', async () => {
    const link = join(env.root, 'link-to-Vault')
    symlinkSync(join(env.root, 'Vault'), link)
    const locked = join(env.root, 'locked')
    mkdirSync(join(locked, 'Inner'), { recursive: true })
    env.entrySync = [
      { vaultRoot: link + '/', cloudName: 'V', entries: [{ path: 'Notes/a.md', kind: 'page' }, { path: 'Shared', kind: 'folder' }] },
      { vaultRoot: join(env.root, 'gone'), cloudName: 'G', entries: [{ path: 'gone.md', kind: 'page' }] },
      { vaultRoot: join(locked, 'Inner'), cloudName: 'L', entries: [{ path: 'locked.md', kind: 'page' }] },
    ]
    writeFileSync(cfgFile(), JSON.stringify({ backend: 'folder', intervalMin: 0, folder: { path: join(env.root, 'Remote') } }))
    await boot()
    chmodSync(locked, 0o000)
    try {
      const view = await ipc.legacyRemoteSync.view()
      expect(view?.entryIgnores).toEqual(['Notes/a.md', 'Notes/a.fd/', 'Shared/', 'locked.md', 'locked.fd/'])
    } finally { chmodSync(locked, 0o755) }
  })

  it('the old engine\'s own round with an unresolvable entry vault root (no permission): not knowing = the round does not run (H3 Codex P1, replaces H-5 item 4)', async () => {
    const locked = join(env.root, 'locked')
    mkdirSync(join(locked, 'Inner'), { recursive: true })
    env.entrySync = [{ vaultRoot: join(locked, 'Inner'), cloudName: 'L', entries: [{ path: 'a.md', kind: 'page' }] }]
    writeFileSync(cfgFile(), JSON.stringify({ backend: 'folder', intervalMin: 0, folder: { path: join(env.root, 'Remote') } }))
    await boot()
    ipc.legacyRemoteSync.extendLoaded(false)
    chmodSync(locked, 0o000)
    try {
      expect((await call<any>('remotesync:run')).errors).toEqual(['entry-ignores-unknown'])
      expect((await ipc.legacyRemoteSync.view())?.entryIgnores).toEqual(['a.md', 'a.fd/']) // 接手视图:不知道 = 让开(口径不变)
    } finally { chmodSync(locked, 0o755) }
    expect(existsSync(join(env.root, 'Remote', 'a.md'))).toBe(false) // 什么都没传
    expect(existsSync(join(env.root, 'Remote', 'b.md'))).toBe(false)
    // 能解析了:那是另一个库,这个库照常整份同步
    expect((await call<any>('remotesync:run')).ok).toBe(true)
    expect(readFileSync(join(env.root, 'Remote', 'a.md'), 'utf8')).toBe('alpha')
    expect(readFileSync(join(env.root, 'Remote', 'b.md'), 'utf8')).toBe('beta')
  })
})

describe('handing back with the key the takeover saw (contract H-13)', () => {
  const original = () => ({
    backend: 'webdav', intervalMin: 15, syncOnStart: true,
    webdav: { address: 'https://dav.example.test/remote.php', username: 'fixture-user', password: 'fixture-secret-value', baseDir: 'team/vault' },
  })
  const holdOnDisk = (): unknown => JSON.parse(readFileSync(join(userData(), 'sync-targets.json'), 'utf8')).legacy?.holder
  async function sealed(): Promise<string> {
    writeFileSync(cfgFile(), JSON.stringify(original(), null, 2), { mode: 0o600 })
    await boot()
    ipc.legacyRemoteSync.extendLoaded(true)
    await ipc.legacyRemoteSync.seal()
    return (await ipc.legacyRemoteSync.view())!.legacyKey!
  }

  it('the key still matches: hands back; with restoreAutoSync the two fields come back from the archived original', async () => {
    const key = await sealed()
    await ipc.legacyRemoteSync.unseal({ expectKey: key })
    expect(holdOnDisk()).toBeNull()
    expect((await call<any>('remotesync:get')).seal.blocked).toBe(false)
    // 再封、归档、带键 + restoreAutoSync 交还
    await ipc.legacyRemoteSync.seal()
    await ipc.legacyRemoteSync.archive(join(env.root, 'archive'), { expectKey: key })
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8'))).toMatchObject({ intervalMin: 0, syncOnStart: false })
    await ipc.legacyRemoteSync.unseal({ restoreAutoSync: true, expectKey: key })
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8'))).toEqual(original())
    expect(holdOnDisk()).toBeNull()
  })

  it('the config changed after the takeover read it: legacy-config-changed, still sealed, config bytes untouched (also with restoreAutoSync)', async () => {
    const key = await sealed()
    await ipc.legacyRemoteSync.archive(join(env.root, 'archive'), { expectKey: key })
    const back = { ...original(), intervalMin: 0, syncOnStart: false, webdav: { ...original().webdav, baseDir: 'team/vault' } }
    // 用户把旧同步存回了另一个目录(同一个网盘)
    const moved = JSON.stringify({ ...back, webdav: { ...back.webdav, baseDir: 'team/other' } }, null, 2)
    writeFileSync(cfgFile(), moved, { mode: 0o600 })
    for (const opts of [{ expectKey: key }, { expectKey: key, restoreAutoSync: true }]) {
      await expect(ipc.legacyRemoteSync.unseal(opts)).rejects.toThrow('legacy-config-changed')
      expect(holdOnDisk()).toBe('v2')
      expect(readFileSync(cfgFile(), 'utf8')).toBe(moved)
      expect((await call<any>('remotesync:run')).errors).toEqual(['sealed'])
    }
    // 配置整个没了:也算对不上
    rmSync(cfgFile())
    await expect(ipc.legacyRemoteSync.unseal({ expectKey: key })).rejects.toThrow('legacy-config-changed')
    expect(holdOnDisk()).toBe('v2')
    // 不带键:照旧交还(老 Extend)
    await ipc.legacyRemoteSync.unseal()
    expect(holdOnDisk()).toBeNull()
  })

  it('an unreadable config is not "nothing to check": the seal stays and nothing is written', async () => {
    const key = await sealed()
    const broken = '{"backend":"webdav","webdav":{"password":"fixture-secret-value"'
    writeFileSync(cfgFile(), broken)
    const err = await ipc.legacyRemoteSync.unseal({ expectKey: key, restoreAutoSync: true }).then(() => null, (e: Error) => e)
    expect(err?.message).toBe('remotesync-config-unparseable')
    expect(leak(err?.message)).not.toContain('fixture-secret-value')
    expect(holdOnDisk()).toBe('v2')
    expect(readFileSync(cfgFile(), 'utf8')).toBe(broken)
  })

  it('a remotesync:set fired during the check waits in the same queue: the hold flips while the checked config is still on disk', async () => {
    const key = await sealed()
    const realRead = fsp.readFile.bind(fsp) as (...a: unknown[]) => Promise<unknown>
    const realRename = fsp.rename.bind(fsp) as (...a: unknown[]) => Promise<unknown>
    let saving: Promise<unknown> | null = null
    let atHandBack: string | null = null
    const readSpy = vi.spyOn(fsp, 'readFile').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const out = await realRead(p, ...rest)
      if (!saving && String(p) === cfgFile()) {
        // 交还正核着配置:设置页这时把旧同步存回原来的网盘目录(换了 baseDir)。有写队列时它排在交还后面
        saving = call('remotesync:set', { webdav: { ...original().webdav, baseDir: 'team/other' } })
        await new Promise((r) => setTimeout(r, 30))
      }
      return out
    }) as never)
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation((async (from: unknown, to: unknown) => {
      const out = await realRename(from, to)
      if (String(to) === join(userData(), 'sync-targets.json') && holdOnDisk() === null && atHandBack === null) atHandBack = readFileSync(cfgFile(), 'utf8')
      return out
    }) as never)
    try {
      await ipc.legacyRemoteSync.unseal({ expectKey: key })
      await saving
    } finally { readSpy.mockRestore(); renameSpy.mockRestore() }
    expect(saving).not.toBeNull()
    expect(JSON.parse(atHandBack ?? '{}').webdav?.baseDir).toBe('team/vault') // 交还那一刻:盘上还是核过的那份
    expect(JSON.parse(readFileSync(cfgFile(), 'utf8')).webdav.baseDir).toBe('team/other') // 存下的照样存下,排在后面
    expect(holdOnDisk()).toBeNull()
  })
})
