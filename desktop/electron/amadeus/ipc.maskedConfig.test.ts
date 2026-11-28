/**
 * 宿主递给 Extend 旧引擎(镜像 / 与我共享 / 条目)的 readConfig 遮罩,走真的 registerIpc 接线 + 真的配置文件
 * (智库同步第 3 步 H3 12b,契约 step34「H3 清单(P-7)」第 6 件、「H3 接口定稿」第 1 节)。
 * - 遮罩依赖的读任何一样读不出 = 整份遮掉,旧引擎按「不知道」停着:amadeus-config 坏了 / 这次宽松读建在一次读失败上、
 *   syncOwnershipV2 形状不对、老的全局认领(新同步状态文件)坏了;状态文件不存在 = 没认领,照旧不遮。
 *
 * 「哪些引擎跑」用 legacyEngines 替身算:旧 Extend 的 core/amadeus/engine.ts initialize 对镜像 / 与我共享 / 条目三种引擎
 * 同一个判法(cloudSync.enabled === false → 停),条目引擎只为 entrySync 里有条目的根起(desktop/amadeus/index.ts refreshEntryBindings)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  root: '', creds: {} as { cloudUrl?: string; token?: string },
  handlers: new Map<string, (...args: any[]) => any>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, shell: {},
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, forsionHomeDir: () => path.join(env.root, 'app-data'), defaultWorkspaceDir: () => path.join(env.root, 'workspace'),
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => env.creds }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))

const CLOUD = 'https://cloud.example'
const token = (userId: string) => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.x`
const ACCOUNT = `${CLOUD}::A`
const NS = createHash('sha256').update(ACCOUNT).digest('hex')
const cfgFile = () => path.join(env.root, 'amadeus-config.json')
const stateFile = () => path.join(env.root, 'app-data', 'content-sync', `${NS}.json`)

type Masked = { cloudSync?: { enabled?: boolean; vaultId?: string; deviceId?: string; mirror?: boolean }; entrySync?: Array<{ vaultRoot: string; entries: unknown[] }> }
/** 替身:旧 Extend 拿遮罩后的读数,哪些引擎会跑(见文件头)。镜像另看 cloudSync.mirror === false:那一条是 E3 第 6 条要加的,Extend main 今天不读 mirror。 */
const legacyEngines = (c: Masked) => {
  const on = c.cloudSync?.enabled !== false
  return { mirror: on && c.cloudSync?.mirror !== false, shared: on, entryRoots: on ? (c.entrySync ?? []).filter((v) => v.entries.length > 0).map((v) => v.vaultRoot) : [] }
}
const STOPPED = { mirror: false, shared: false, entryRoots: [] }

let vaultA = '', vaultB = ''
const accountConfig = (extra: Record<string, unknown> = {}) => ({
  lastVault: vaultA, localVault: vaultA,
  cloudAccounts: { [NS]: {
    cloudSync: { enabled: true, vaultId: 'vault-1', deviceId: 'desk-1' },
    entrySync: [vaultA, vaultB].map((vaultRoot) => ({ vaultRoot, cloudName: path.basename(vaultRoot), entries: [{ path: 'a.md', kind: 'page' }] })),
    ...extra,
  } },
})

/** registerIpc 递给 Extend 工厂的那份 deps(真接线)。 */
async function hostDeps() {
  const { registerIpc } = await import('./ipc')
  let deps: import('./cloudSeam').AmadeusSyncHostDeps | null = null
  registerIpc(() => null, (d) => { deps = d; return { start() {}, stopAllSync: async () => {}, restartAllSync: async () => {} } })
  return deps!
}

beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-ipc-mask-'))
  env.handlers.clear()
  env.creds = { cloudUrl: CLOUD, token: token('A') }
  vaultA = path.join(env.root, 'VaultA'); vaultB = path.join(env.root, 'VaultB')
  await fs.mkdir(vaultA); await fs.mkdir(vaultB)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(env.root, { recursive: true, force: true })
})

/** 让配置文件的第一次 readFile 读完原文后挂起,release(ok / 报错)才返回;别的 readFile(严格读)照常。 */
function holdFirstConfigRead() {
  const real = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<string>
  let release!: (fail?: boolean) => void
  const gate = new Promise<boolean>((r) => { release = (fail = false) => r(fail) })
  let held = false
  vi.spyOn(fs, 'readFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
    if (held || String(file) !== cfgFile()) return real(file, ...rest)
    held = true
    const text = await real(file, ...rest) // 读到的是写之前的旧文件
    if (await gate) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    return text
  }) as typeof fs.readFile)
  return { release }
}

describe('the old engines stop when a read the mask depends on fails (H3 list item 6)', () => {
  it('control: nothing claimed and no state file → the config goes through unmasked, every engine runs', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig()))
    const masked = await (await hostDeps()).readConfig()
    expect(legacyEngines(masked)).toEqual({ mirror: true, shared: true, entryRoots: [vaultA, vaultB] })
  })

  it('no config file yet (first run) is not a read failure: the mirror starts as it always did', async () => {
    const masked = await (await hostDeps()).readConfig()
    expect(legacyEngines(masked)).toEqual({ mirror: true, shared: true, entryRoots: [] })
  })

  it('an unparseable amadeus-config masks everything', async () => {
    await fs.writeFile(cfgFile(), '{"cloudAccounts":')
    const masked = await (await hostDeps()).readConfig()
    expect(legacyEngines(masked)).toEqual(STOPPED)
  })

  it('a malformed syncOwnershipV2 masks everything', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig({ syncOwnershipV2: { entryRoots: 'nope', mirror: 'keep', human: 'engine' } })))
    const masked = await (await hostDeps()).readConfig()
    expect(legacyEngines(masked)).toEqual(STOPPED)
  })

  it('a truncated old content-sync state file is "unknown", not "not claimed": everything is masked', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig()))
    await fs.mkdir(path.dirname(stateFile()), { recursive: true })
    await fs.writeFile(stateFile(), '{"owned":tr')
    const masked = await (await hostDeps()).readConfig()
    expect(legacyEngines(masked)).toEqual(STOPPED)
  })

  it('the old global claim (owned:true) still masks everything; owned:false does not', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig()))
    await fs.mkdir(path.dirname(stateFile()), { recursive: true })
    await fs.writeFile(stateFile(), JSON.stringify({ owned: true }))
    expect(legacyEngines(await (await hostDeps()).readConfig())).toEqual(STOPPED)
    await fs.writeFile(stateFile(), JSON.stringify({ owned: false }))
    expect(legacyEngines(await (await hostDeps()).readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultA, vaultB] })
  })

  /** 让第一次宽松读失败(不是 ENOENT):那时 amadeus-config.json 是个目录(EISDIR,各平台都报错);读完换回真文件。回读完以后的 settings 模块。 */
  async function looseReadFails() {
    await fs.rm(cfgFile(), { recursive: true, force: true })
    await fs.mkdir(cfgFile())
    const settings = await import('./settings')
    expect((await settings.readConfig()).cloudSync).toBeUndefined() // 宽松读把读失败缓存成了「什么都没配」
    await fs.rm(cfgFile(), { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig())) // 文件又读得到了:严格读读得出,宽松读的缓存还是空的
    return settings
  }

  it('a config the loose read could not open (cached as empty) masks everything, even once the file reads again', async () => {
    await looseReadFails()
    const masked = await (await hostDeps()).readConfig()
    expect(legacyEngines(masked)).toEqual(STOPPED)
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8'))).toEqual(accountConfig()) // 这份读数只读,不写回
  })

  it('an ordinary write based on that empty cache does not make it trusted: the old engines stay stopped', async () => {
    const { writeConfig } = await looseReadFails()
    const deps = await hostDeps()
    await writeConfig({ lastPage: 'a.md' })
    expect(legacyEngines(await deps.readConfig())).toEqual(STOPPED)
  })

  it('a write based on the strict read puts the real config back in the cache, and the mask trusts it again (ownership / active vault / local vault switch)', async () => {
    const { writeSyncOwnershipV2 } = await looseReadFails()
    const deps = await hostDeps()
    expect(legacyEngines(await deps.readConfig())).toEqual(STOPPED)
    await writeSyncOwnershipV2(ACCOUNT, { entryRoots: [vaultA], mirror: 'keep', human: 'engine' })
    expect(legacyEngines(await deps.readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultB] })

    vi.resetModules()
    const { writeActiveVault } = await looseReadFails()
    const deps2 = await hostDeps()
    await writeActiveVault(null)
    expect(legacyEngines(await deps2.readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultA, vaultB] })

    vi.resetModules()
    const { updateLocalVaultConfig } = await looseReadFails()
    const deps3 = await hostDeps()
    await updateLocalVaultConfig((cfg) => { cfg.lastVault = vaultB; cfg.localVault = vaultB })
    expect(legacyEngines(await deps3.readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultA, vaultB] })
  })
})

describe('mirrorRetired: only the mirror stops (H3 final interface §1)', () => {
  const claim = (over: Record<string, unknown>) => accountConfig({ syncOwnershipV2: { entryRoots: [vaultA], mirror: 'keep', human: 'engine', ...over } })
  const rawCloudSync = async () => JSON.parse(await fs.readFile(cfgFile(), 'utf8')).cloudAccounts[NS].cloudSync

  it('three claim states × which old engines run: keep runs all but the taken root; keep + mirrorRetired stops only the mirror; off stops everything', async () => {
    const cases: Array<[Record<string, unknown>, ReturnType<typeof legacyEngines>]> = [
      [{}, { mirror: true, shared: true, entryRoots: [vaultB] }],
      [{ mirrorRetired: true }, { mirror: false, shared: true, entryRoots: [vaultB] }],
      [{ mirror: 'off' }, STOPPED],
    ]
    for (const [over, want] of cases) {
      vi.resetModules()
      await fs.writeFile(cfgFile(), JSON.stringify(claim(over)))
      const masked = await (await hostDeps()).readConfig()
      expect(legacyEngines(masked), JSON.stringify(over)).toEqual(want)
      if ('mirrorRetired' in over) expect(masked.cloudSync).toEqual({ enabled: true, vaultId: 'vault-1', deviceId: 'desk-1', mirror: false })
      else expect(masked.cloudSync).not.toHaveProperty('mirror')
    }
  })

  it('a write-back built from the masked read never puts cloudSync.mirror on disk (old engine deviceId / vaultId / setEnabled writes)', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(claim({ mirrorRetired: true })))
    const deps = await hostDeps()
    const masked = await deps.readConfig()
    // core/amadeus/engine.ts:{ ...(cfg.cloudSync ?? {}), deviceId: id } / { ...(cs ?? {}), vaultId } / { ...(cfg.cloudSync ?? {}), enabled: on }
    await deps.writeConfig({ cloudSync: { ...masked.cloudSync, deviceId: 'desk-2' } }, ACCOUNT)
    expect(await rawCloudSync()).toEqual({ enabled: true, vaultId: 'vault-1', deviceId: 'desk-2' })
    await deps.writeConfig({ cloudSync: { ...(await deps.readConfig()).cloudSync, enabled: false } }, ACCOUNT)
    expect(await rawCloudSync()).toEqual({ enabled: false, vaultId: 'vault-1', deviceId: 'desk-2' })
    const { readConfig } = await import('./settings')
    expect((await readConfig()).cloudSync).not.toHaveProperty('mirror')
  })

  it('a stray cloudSync.mirror already on disk is neither read back unmasked nor kept by the next cloudSync write', async () => {
    const cfg = accountConfig()
    ;(cfg.cloudAccounts[NS].cloudSync as Record<string, unknown>).mirror = false
    await fs.writeFile(cfgFile(), JSON.stringify(cfg))
    const deps = await hostDeps()
    expect(legacyEngines(await deps.readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultA, vaultB] })
    await deps.writeConfig({ cloudSync: { ...(await deps.readConfig()).cloudSync, vaultId: 'vault-2' } }, ACCOUNT)
    expect(await rawCloudSync()).toEqual({ enabled: true, vaultId: 'vault-2', deviceId: 'desk-1' })
  })

  it('end to end: ownership.set({mirrorRetired:true}) persists, restarts the old engines, and their next read has only the mirror off', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig()))
    const deps = await hostDeps()
    const { contentSyncOwnershipV2 } = await import('../contentSyncHost')
    const { readSyncOwnershipV2, writeSyncOwnershipV2, readConfig } = await import('./settings')
    const restartSync = vi.fn(async () => {})
    const seam = contentSyncOwnershipV2({
      accountId: () => ACCOUNT, ensureBackend: async () => {}, backendStatus: () => ({ state: 'stopped', url: null }), engineToken: () => 't',
      loadConfig: async () => ({ mode: 'managed' }), dataDir: () => env.root, stopSync: async () => {}, restartSync,
      readV2: readSyncOwnershipV2, writeV2: writeSyncOwnershipV2,
      entryRoots: async (a) => (await readConfig(a)).entrySync?.map((v) => v.vaultRoot) ?? [], legacyOwned: () => false,
    })
    await seam.set({ entryRoots: [vaultA], mirror: 'keep', human: 'engine', mirrorRetired: true }, ACCOUNT)
    expect(restartSync).toHaveBeenCalledOnce()
    expect((await seam.get(ACCOUNT)).mirrorRetired).toBe(true)
    expect(legacyEngines(await deps.readConfig())).toEqual({ mirror: false, shared: true, entryRoots: [vaultB] })
    await seam.set({ entryRoots: [vaultA], mirror: 'keep', human: 'engine' }, ACCOUNT) // 不给 = 沿用
    expect(legacyEngines(await deps.readConfig())).toEqual({ mirror: false, shared: true, entryRoots: [vaultB] })
    await seam.set({ entryRoots: [vaultA], mirror: 'keep', human: 'engine', mirrorRetired: false }, ACCOUNT)
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8')).cloudAccounts[NS].syncOwnershipV2).not.toHaveProperty('mirrorRetired')
    expect(legacyEngines(await deps.readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultB] })
  })
})

describe('the config cache and a loose read that lands late (Codex 12b round 1, #2)', () => {
  const RETIRED = { entryRoots: [] as string[], mirror: 'keep' as const, human: 'engine' as const, mirrorRetired: true }
  const rawClaim = async () => JSON.parse(await fs.readFile(cfgFile(), 'utf8')).cloudAccounts[NS].syncOwnershipV2

  it('a loose read that opened the old file before a claim was committed does not put the old claim back; the next ordinary write keeps the new one', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig({ syncOwnershipV2: { entryRoots: [], mirror: 'keep', human: 'engine' } })))
    const { release } = holdFirstConfigRead()
    const settings = await import('./settings')
    const late = settings.readConfig()
    await new Promise((r) => setTimeout(r, 20))
    await settings.writeSyncOwnershipV2(ACCOUNT, RETIRED)
    release()
    await late
    await settings.writeConfig({ lastPage: 'a.md' })
    expect(await rawClaim()).toEqual(RETIRED)
    expect(settings.looseConfigReadFailed()).toBe(false)
  })

  it('a late loose read that fails changes neither the committed cache nor the read-failure mark', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig({ syncOwnershipV2: { entryRoots: [], mirror: 'keep', human: 'engine' } })))
    const { release } = holdFirstConfigRead()
    const settings = await import('./settings')
    const late = settings.readConfig()
    await new Promise((r) => setTimeout(r, 20))
    await settings.writeSyncOwnershipV2(ACCOUNT, RETIRED)
    release(true)
    expect((await late).entrySync?.map((v) => v.vaultRoot)).toEqual([vaultA, vaultB])
    expect(settings.looseConfigReadFailed()).toBe(false)
    await settings.writeConfig({ lastPage: 'a.md' })
    const disk = JSON.parse(await fs.readFile(cfgFile(), 'utf8'))
    expect(disk.lastVault).toBe(vaultA)
    expect(disk.cloudAccounts[NS].syncOwnershipV2).toEqual(RETIRED)
  })
})
