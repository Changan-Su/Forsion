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

/** 让第一次宽松读失败(不是 ENOENT):那时 amadeus-config.json 是个目录(EISDIR,各平台都报错);读完换回真文件。回读完以后的 settings 模块。 */
async function looseReadFails(cfg: unknown = accountConfig()) {
  await fs.rm(cfgFile(), { recursive: true, force: true })
  await fs.mkdir(cfgFile())
  const settings = await import('./settings')
  expect((await settings.readConfig()).cloudSync).toBeUndefined() // 宽松读把读失败缓存成了「什么都没配」
  expect(settings.looseConfigReadFailed()).toBe(true)
  await fs.rm(cfgFile(), { recursive: true })
  await fs.writeFile(cfgFile(), JSON.stringify(cfg)) // 文件又读得到了
  return settings
}

/** 配置目录里被挪到一边的坏配置(<原文件名>.corrupt-<时间戳>)。 */
const corruptCopies = async () => (await fs.readdir(env.root)).filter((f) => f.startsWith('amadeus-config.json.corrupt-')).sort()

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

  it('a state file that parses but has the wrong shape (owned not a boolean, top level not an object) is "unknown": everything is masked', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig()))
    await fs.mkdir(path.dirname(stateFile()), { recursive: true })
    for (const text of ['{"owned":"true"}', '{"owned":1}', '{"owned":null}', 'null', '[]', '"owned"', 'true']) {
      await fs.writeFile(stateFile(), text)
      expect(legacyEngines(await (await hostDeps()).readConfig()), text).toEqual(STOPPED)
    }
    await fs.writeFile(stateFile(), '{"config":{"revision":1}}') // 没有 owned 键 = 没认领
    expect(legacyEngines(await (await hostDeps()).readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultA, vaultB] })
  })

  it('an account config the old engines cannot read (cloudSync not an object, entrySync not a list of roots) gives them the stopped config, keeping the local fields; never a rejection', async () => {
    const bad: Array<Record<string, unknown>> = [
      { cloudSync: 'on' }, { cloudSync: ['on'] }, { cloudSync: { enabled: 'false' } },
      { entrySync: 'x' }, { entrySync: [{ vaultRoot: 1, entries: [] }] }, { entrySync: [{ vaultRoot: vaultA, entries: 'a.md' }] }, { entrySync: [null] },
    ]
    for (const over of bad) {
      vi.resetModules()
      const cfg = accountConfig()
      Object.assign(cfg.cloudAccounts[NS], over)
      await fs.writeFile(cfgFile(), JSON.stringify(cfg))
      const masked = await (await hostDeps()).readConfig()
      expect(legacyEngines(masked), JSON.stringify(over)).toEqual(STOPPED)
      expect(masked.cloudSync, JSON.stringify(over)).toEqual({ enabled: false })
      expect(masked.lastVault, JSON.stringify(over)).toBe(vaultA)
      expect(masked.localVault).toBe(vaultA)
    }
  })

  it('a config whose top level is null, a list or a string gives the old engines the stopped config, not a rejection', async () => {
    for (const text of ['null', '[]', '"x"', '7']) {
      vi.resetModules()
      await fs.writeFile(cfgFile(), text)
      expect(legacyEngines(await (await hostDeps()).readConfig()), text).toEqual(STOPPED)
      expect(await fs.readFile(cfgFile(), 'utf8')).toBe(text)
    }
  })

  it('the old global claim (owned:true) still masks everything; owned:false does not', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig()))
    await fs.mkdir(path.dirname(stateFile()), { recursive: true })
    await fs.writeFile(stateFile(), JSON.stringify({ owned: true }))
    expect(legacyEngines(await (await hostDeps()).readConfig())).toEqual(STOPPED)
    await fs.writeFile(stateFile(), JSON.stringify({ owned: false }))
    expect(legacyEngines(await (await hostDeps()).readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultA, vaultB] })
  })

  it('a config the loose read cannot open masks everything; once the file reads again the next read picks it up, and nothing is written meanwhile', async () => {
    await fs.mkdir(cfgFile())
    const deps = await hostDeps()
    expect(legacyEngines(await deps.readConfig())).toEqual(STOPPED)
    await fs.rm(cfgFile(), { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig()))
    expect(legacyEngines(await deps.readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultA, vaultB] })
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8'))).toEqual(accountConfig())
  })
})

describe('ordinary writes after a failed loose read take the strict base (Codex 12b round 1, #1)', () => {
  const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: { id: 1 } }, ...args)

  it('writeConfig(lastPage) after the file reads again keeps the vault list, the account config and the claim', async () => {
    const cfg = { ...accountConfig({ syncOwnershipV2: { entryRoots: [vaultA], mirror: 'keep', human: 'engine' } }), vaults: [{ root: vaultA }, { root: vaultB }] }
    const { writeConfig } = await looseReadFails(cfg)
    await writeConfig({ lastPage: 'a.md' })
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8'))).toEqual({ ...cfg, lastPage: 'a.md' })
  })

  it('while the file still cannot be read or parsed, writeConfig throws and the bytes on disk stay', async () => {
    await fs.mkdir(cfgFile())
    const { writeConfig } = await import('./settings')
    await expect(writeConfig({ lastPage: 'a.md' })).rejects.toThrow()
    expect((await fs.stat(cfgFile())).isDirectory()).toBe(true)
    vi.resetModules()
    await fs.rm(cfgFile(), { recursive: true })
    await fs.writeFile(cfgFile(), '{"lastVault":')
    const again = await import('./settings')
    await expect(again.writeConfig({ lastPage: 'a.md' })).rejects.toThrow()
    const update = vi.fn()
    await expect(again.updateConfig(update)).rejects.toThrow()
    expect(update).not.toHaveBeenCalled() // 回调不拿空缓存(Extend 的回调会照它改引擎的范围)
    expect(await fs.readFile(cfgFile(), 'utf8')).toBe('{"lastVault":')
    for (const text of ['null', '[]', '"x"']) { // 解析得出、但不是对象:同样读不出
      vi.resetModules()
      await fs.writeFile(cfgFile(), text)
      const s = await import('./settings')
      await expect(s.writeConfig({ lastPage: 'a.md' }), text).rejects.toThrow()
      expect(await fs.readFile(cfgFile(), 'utf8')).toBe(text)
    }
  })

  it('updateConfig hands its callback the strict base, not the empty cache', async () => {
    const { updateConfig } = await looseReadFails()
    let seen: string[] = []
    await updateConfig((c) => { seen = (c.entrySync ?? []).map((v) => v.vaultRoot); return false })
    expect(seen).toEqual([vaultA, vaultB])
  })

  it('forgetVault returns false and warns when the config remains unreadable', async () => {
    const before = '{"vaults":'
    await fs.writeFile(cfgFile(), before)
    await hostDeps()
    const { IPC } = await import('@amadeus-shared/ipc')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(invoke(IPC.forgetVault, vaultB)).resolves.toBe(false)
    expect(warn).toHaveBeenCalledWith('[amadeus] could not save the vault list')
    expect(await fs.readFile(cfgFile(), 'utf8')).toBe(before)
  })

  it('forgetVault returns false when saving fails after the update callback, and can retry', async () => {
    const cfg = { ...accountConfig(), vaults: [{ root: vaultA }, { root: vaultB }] }
    const before = JSON.stringify(cfg)
    await fs.writeFile(cfgFile(), before)
    await hostDeps()
    const { IPC } = await import('@amadeus-shared/ipc')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('save failed'))
    await expect(invoke(IPC.forgetVault, vaultB)).resolves.toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    expect(await fs.readFile(cfgFile(), 'utf8')).toBe(before)
    await expect(invoke(IPC.forgetVault, vaultB)).resolves.toBe(true)
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8'))).toMatchObject({ vaults: [{ root: vaultA }] })
    await expect(fs.stat(vaultB)).resolves.toBeDefined()
  })

  it('keeps a new page when its lastPage preference fails to save', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig()))
    await hostDeps()
    const { IPC } = await import('@amadeus-shared/ipc')
    await invoke(IPC.restoreVault)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === cfgFile()) throw new Error('save failed')
      await rename(from, to)
    })
    await expect(invoke(IPC.newPage, 'New.md')).resolves.toBeDefined()
    await expect(fs.stat(path.join(vaultA, 'New.md'))).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledWith('[amadeus] rememberPage failed; file operation is committed', 'New.md', expect.any(Error))
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8')).lastPage).toBeUndefined()
  })

  it('restoreVault forwards a default vault save failure through IPC before mounting', async () => {
    await hostDeps()
    const { IPC } = await import('@amadeus-shared/ipc')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('save failed')).mockImplementation(rename)
    await expect(invoke(IPC.restoreVault)).rejects.toThrow('save failed')
    await expect(fs.stat(cfgFile())).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(invoke(IPC.restoreVault)).resolves.toMatchObject({ root: path.join(env.root, 'workspace', 'Amadeus') })
  })

  it('adoptLegacyCloudState resolves false (never rejects) when the config cannot be read, and writes nothing', async () => {
    await fs.writeFile(cfgFile(), '{"lastVault":')
    const { adoptLegacyCloudState } = await import('./settings')
    await expect(adoptLegacyCloudState(ACCOUNT)).resolves.toBe(false)
    expect(await fs.readFile(cfgFile(), 'utf8')).toBe('{"lastVault":')
  })

  it('restoreVault after a transient read failure opens the vault the user chose, not the default one', async () => {
    await looseReadFails()
    await hostDeps()
    const { IPC } = await import('@amadeus-shared/ipc')
    const restored = await invoke(IPC.restoreVault)
    expect(restored.root).toBe(vaultA)
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8')).lastVault).toBe(vaultA)
  })

  it('restoreVault whose own read fails while a later read works does not write the default vault over the user\'s', async () => {
    const failReads = (n: number) => {
      const real = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<string>
      let left = n
      vi.spyOn(fs, 'readFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
        if (left > 0 && String(file) === cfgFile()) { left--; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
        return real(file, ...rest)
      }) as typeof fs.readFile)
    }
    const { IPC } = await import('@amadeus-shared/ipc')
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig()))
    await hostDeps()
    failReads(1) // restoreVault 的那次读失败,再读一次就读到了:打开用户原来的库
    expect((await invoke(IPC.restoreVault)).root).toBe(vaultA)
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8'))).toEqual(accountConfig())
    vi.restoreAllMocks(); vi.resetModules(); env.handlers.clear()
    await hostDeps()
    failReads(2) // 前两次读不到、启动挪坏文件那一步读到的是好内容:不挪,打开原库
    expect((await invoke(IPC.restoreVault)).root).toBe(vaultA)
    vi.restoreAllMocks()
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8'))).toEqual(accountConfig())
    expect(await corruptCopies()).toEqual([])
    vi.resetModules(); env.handlers.clear()
    await hostDeps()
    failReads(50) // 一直读不到(I/O,文件可能是好的):拒绝,不挪、不写默认库
    await expect(invoke(IPC.restoreVault)).rejects.toThrow()
    vi.restoreAllMocks()
    expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8'))).toEqual(accountConfig())
    expect(await corruptCopies()).toEqual([])
  })

})

describe('a config whose content is definitely broken at startup is moved aside, not overwritten (H, after Codex 12b round 1)', () => {
  const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: { id: 1 } }, ...args)
  const defaultRoot = () => path.join(env.root, 'workspace', 'Amadeus')

  it('zero bytes / null / a list / a string / a number / truncated JSON: the first restoreVault renames it to .corrupt-<time> byte for byte, logs the name only, and starts from the default vault', async () => {
    const { IPC } = await import('@amadeus-shared/ipc')
    for (const text of ['', '   \n', 'null', '[]', '"x"', '7', '{"lastVault":"/x/Priv']) {
      vi.restoreAllMocks(); vi.resetModules(); env.handlers.clear()
      for (const f of await corruptCopies()) await fs.rm(path.join(env.root, f))
      await fs.writeFile(cfgFile(), text)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await hostDeps()
      const restored = await invoke(IPC.restoreVault)
      expect(restored.root, JSON.stringify(text)).toBe(defaultRoot())
      const copies = await corruptCopies()
      expect(copies, JSON.stringify(text)).toHaveLength(1)
      expect(copies[0]).toMatch(/^amadeus-config\.json\.corrupt-[0-9TZ-]+$/)
      expect(await fs.readFile(path.join(env.root, copies[0]), 'utf8')).toBe(text) // 不改内容
      expect(JSON.parse(await fs.readFile(cfgFile(), 'utf8')).lastVault).toBe(defaultRoot())
      const lines = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('.corrupt-'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(copies[0])
      expect(lines[0]).not.toContain(env.root) // 只记文件名
      if (text.includes('Priv')) expect(lines[0]).not.toContain('Priv') // 不打内容
    }
  })

  it('a config the startup read cannot open (EISDIR: the file itself may be fine) is refused and nothing is moved', async () => {
    await fs.mkdir(cfgFile())
    await hostDeps()
    const { IPC } = await import('@amadeus-shared/ipc')
    await expect(invoke(IPC.restoreVault)).rejects.toThrow()
    expect((await fs.stat(cfgFile())).isDirectory()).toBe(true)
    expect(await corruptCopies()).toEqual([])
  })

  it('a rename that fails is refused and the broken file stays where it was', async () => {
    await fs.writeFile(cfgFile(), 'null')
    await hostDeps()
    const realRename = fs.rename.bind(fs) as (a: unknown, b: unknown) => Promise<void>
    vi.spyOn(fs, 'rename').mockImplementation((async (from: unknown, to: unknown) => {
      if (String(from) === cfgFile()) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return realRename(from, to)
    }) as typeof fs.rename)
    const { IPC } = await import('@amadeus-shared/ipc')
    await expect(invoke(IPC.restoreVault)).rejects.toThrow()
    expect(await fs.readFile(cfgFile(), 'utf8')).toBe('null')
    expect(await corruptCopies()).toEqual([])
  })

  it('only the first restoreVault moves anything: broken content found later is refused and left in place', async () => {
    await fs.mkdir(cfgFile()) // 启动那一下 I/O 读不了:拒绝
    await hostDeps()
    const { IPC } = await import('@amadeus-shared/ipc')
    await expect(invoke(IPC.restoreVault)).rejects.toThrow()
    await fs.rm(cfgFile(), { recursive: true })
    await fs.writeFile(cfgFile(), '{"lastVault":') // 运行中才发现内容坏了:照旧拒绝,不挪
    await expect(invoke(IPC.restoreVault)).rejects.toThrow()
    expect(await fs.readFile(cfgFile(), 'utf8')).toBe('{"lastVault":')
    expect(await corruptCopies()).toEqual([])
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

  it('end to end: a false flag from ownership.set leaves the disk retirement and the engine mask in place', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(claim({ mirrorRetired: true })))
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
    await seam.set({ entryRoots: [vaultA], mirror: 'keep', human: 'engine', mirrorRetired: false }, ACCOUNT)
    expect(restartSync).toHaveBeenCalledOnce()
    expect((await seam.get(ACCOUNT)).mirrorRetired).toBe(true)
    expect(legacyEngines(await deps.readConfig())).toEqual({ mirror: false, shared: true, entryRoots: [vaultB] })
  })
})

describe('ownership.patchMirrorRetired', () => {
  const seal = { vaultId: 'vault-1', from: false, to: true }
  const unseal = { vaultId: 'vault-1', from: true, to: false }
  const claim = (over: Record<string, unknown> = {}) => ({
    entryRoots: [] as string[], mirror: 'keep' as const, human: 'engine' as const, ...over,
  })
  const readDisk = () => fs.readFile(cfgFile(), 'utf8')

  async function fixture() {
    const settings = await import('./settings')
    const { contentSyncOwnedStrict, contentSyncOwnershipV2 } = await import('../contentSyncHost')
    const { cloudVaultDir } = await import('./cloudPaths')
    const restartSync = vi.fn(async () => { await settings.readSyncOwnershipV2(ACCOUNT) })
    const host = {
      accountId: settings.currentCloudAccountId, ensureBackend: async () => {}, backendStatus: () => ({ state: 'stopped', url: null }),
      engineToken: () => '', loadConfig: async () => ({ mode: 'managed' }), dataDir: () => env.root, stopSync: async () => {},
      restartSync, readV2: settings.readSyncOwnershipV2, writeV2: vi.fn(settings.writeSyncOwnershipV2),
      entryRoots: async (account: string) => (await settings.readConfig(account)).entrySync?.map((v) => v.vaultRoot) ?? [],
      legacyOwned: contentSyncOwnedStrict,
    }
    const seam = contentSyncOwnershipV2({
      ...host,
      patchMirrorRetired: (account, patch, canCommit) =>
        settings.patchSyncOwnershipMirrorRetired(account, patch, canCommit, cloudVaultDir, contentSyncOwnedStrict),
    })
    return { settings, seam, restartSync, mirror: cloudVaultDir(ACCOUNT), host }
  }

  it('keeps the bit clear when an entry root return writes a stale claim after the mirror was unsealed', async () => {
    const { seam, restartSync } = await fixture()
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig({
      syncOwnershipV2: claim({ mirrorRetired: true, entryRoots: [vaultA, vaultB] }),
    })))
    const before = await seam.get(ACCOUNT)
    expect(before.mirrorRetired).toBe(true)
    await expect(seam.patchMirrorRetired!(ACCOUNT, unseal, () => true)).resolves.toBe(true)
    await seam.set({ ...before, entryRoots: [vaultB] }, ACCOUNT)
    const current = await seam.get(ACCOUNT)
    expect(current).not.toHaveProperty('mirrorRetired')
    expect(current.entryRoots).toEqual([await fs.realpath(vaultB)])
    expect(restartSync).toHaveBeenCalledTimes(2)
  })

  it('drains the old entry engine before overlapping patch and set requests can rebuild', async () => {
    const { seam, settings, restartSync } = await fixture()
    const { registerIpc } = await import('./ipc')
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig({ syncOwnershipV2: claim() })))
    let releaseOld!: () => void, stopping!: () => void, secondRestart!: () => void
    const oldHold = new Promise<void>((resolve) => { releaseOld = resolve })
    const oldStopping = new Promise<void>((resolve) => { stopping = resolve })
    const bothRequested = new Promise<void>((resolve) => { secondRestart = resolve })
    const events: string[] = []
    let entryRegistered = true
    const stopAllSync = async () => {
      if (!entryRegistered) return
      entryRegistered = false
      stopping()
      await oldHold
      events.push('old stopped')
    }
    const restartAllSync = vi.fn(async () => {
      await stopAllSync()
      events.push('rebuilt')
      await settings.updateConfig(() => false, ACCOUNT)
      expect((await settings.readSyncOwnershipV2(ACCOUNT))?.entryRoots).toEqual([await fs.realpath(vaultA)])
    })
    const runtime = registerIpc(() => null, () => ({ start() {}, stopAllSync, restartAllSync }))
    restartSync.mockImplementation(() => {
      const restart = runtime.restartSync()
      if (restartSync.mock.calls.length === 2) secondRestart()
      return restart
    })
    const first = seam.patchMirrorRetired!(ACCOUNT, seal, () => true)
    await oldStopping
    const second = seam.set({ ...claim(), entryRoots: [vaultA] }, ACCOUNT)
    await bothRequested
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    releaseOld()
    await expect(Promise.all([first, second])).resolves.toEqual([true, undefined])
    expect(events).toEqual(['old stopped', 'rebuilt'])
    expect(restartAllSync).toHaveBeenCalledOnce()
  })

  it('shares a drain with an explicit stop that supersedes a pending rebuild', async () => {
    const { registerIpc } = await import('./ipc')
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const stopAllSync = vi.fn(() => pending)
    const restartAllSync = vi.fn(async () => {})
    const runtime = registerIpc(() => null, () => ({ start() {}, stopAllSync, restartAllSync }))
    const cancelled = runtime.restartSync()
    const stop = runtime.stopSync()
    release()
    await Promise.all([cancelled, stop])
    expect(stopAllSync).toHaveBeenCalledOnce()
    expect(restartAllSync).not.toHaveBeenCalled()
    await runtime.restartSync()
    expect(restartAllSync).toHaveBeenCalledOnce()
  })

  it('keeps an overlapping account write that adds a root and changes human ownership', async () => {
    const { settings, seam, restartSync } = await fixture()
    const initial = accountConfig({ syncOwnershipV2: claim() })
    await fs.writeFile(cfgFile(), JSON.stringify(initial))
    const rename = fs.rename.bind(fs)
    let staged!: () => void, release!: () => void
    const stagedWrite = new Promise<void>((resolve) => { staged = resolve })
    const paused = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      staged()
      await paused
      await rename(from, to)
    })
    const ownership = { ...claim(), entryRoots: [vaultB, vaultA], human: 'content' as const, futureField: ['keep'] }
    const takeover = settings.writeSyncOwnershipV2(ACCOUNT, ownership)
    await stagedWrite
    const retirement = seam.patchMirrorRetired!(ACCOUNT, seal, () => true)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    release()
    await expect(Promise.all([takeover, retirement])).resolves.toEqual([undefined, true])
    expect(JSON.parse(await readDisk())).toEqual({
      ...initial, cloudAccounts: { [NS]: { ...initial.cloudAccounts[NS], syncOwnershipV2: { ...ownership, mirrorRetired: true } } },
    })
    expect(restartSync).toHaveBeenCalledOnce()
  })

  it('orders the patch after an ownership.set that has read its claim but has yet to queue a write', async () => {
    const { settings, seam, restartSync, host } = await fixture()
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig({ syncOwnershipV2: claim() })))
    const canonicalRoot = await fs.realpath(vaultA)
    let entered!: () => void, release!: () => void
    const atWrite = new Promise<void>((resolve) => { entered = resolve })
    const paused = new Promise<void>((resolve) => { release = resolve })
    host.writeV2.mockImplementationOnce(async (account, next) => {
      entered()
      await paused
      await settings.writeSyncOwnershipV2(account, next)
    })
    const takeover = seam.set({ ...claim(), entryRoots: [vaultA] }, ACCOUNT)
    await atWrite
    const retirement = seam.patchMirrorRetired!(ACCOUNT, seal, () => true)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    release()
    await expect(Promise.all([takeover, retirement])).resolves.toEqual([undefined, true])
    expect(await seam.get(ACCOUNT)).toEqual(claim({ entryRoots: [canonicalRoot], mirrorRetired: true }))
    expect(restartSync).toHaveBeenCalledTimes(2)
  })

  it('seals and unseals just the bit, releases the config queue before restart, and preserves legacy and other-account fields', async () => {
    const { settings, seam, restartSync } = await fixture()
    const initial = {
      ...accountConfig({ syncOwnershipV2: claim({ mirrorRetired: false }) }),
      legacyCloudState: { cloudSync: { vaultId: 'legacy' } },
      cloudSync: { enabled: false, vaultId: 'unscoped' },
    }
    const other = createHash('sha256').update(`${CLOUD}::B`).digest('hex')
    Object.assign(initial.cloudAccounts, { [other]: { cloudSync: { enabled: true, vaultId: 'other' } } })
    await fs.writeFile(cfgFile(), JSON.stringify(initial))
    const deps = await hostDeps()
    restartSync.mockImplementation(async () => { await settings.updateConfig(() => false, ACCOUNT) })

    const expected = (syncOwnershipV2: ReturnType<typeof claim>) => ({
      ...initial, cloudAccounts: { ...initial.cloudAccounts, [NS]: { ...initial.cloudAccounts[NS], syncOwnershipV2 } },
    })
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, () => true)).resolves.toBe(true)
    expect(JSON.parse(await readDisk())).toEqual(expected(claim({ mirrorRetired: true })))
    expect(legacyEngines(await deps.readConfig())).toEqual({ mirror: false, shared: true, entryRoots: [vaultA, vaultB] })

    await expect(seam.patchMirrorRetired!(ACCOUNT, unseal, () => true)).resolves.toBe(true)
    expect(JSON.parse(await readDisk())).toEqual(expected(claim()))
    expect(legacyEngines(await deps.readConfig())).toEqual({ mirror: true, shared: true, entryRoots: [vaultA, vaultB] })
    expect(restartSync).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['stale from', unseal, claim()],
    ['wrong vault', { ...seal, vaultId: 'other' }, claim()],
    ['mirror off', seal, claim({ mirror: 'off' })],
    ['no transition', { ...seal, to: false }, claim()],
  ])('does not write or restart for %s', async (_reason, change, ownership) => {
    const { seam, restartSync } = await fixture()
    const before = JSON.stringify(accountConfig({ syncOwnershipV2: ownership }))
    await fs.writeFile(cfgFile(), before)
    await expect(seam.patchMirrorRetired!(ACCOUNT, change, () => true)).resolves.toBe(false)
    expect(await readDisk()).toBe(before)
    expect(restartSync).not.toHaveBeenCalled()
  })

  it('seals a legacy mirror with no ownership record when the old mask is confirmed off', async () => {
    const { seam, restartSync } = await fixture()
    const before = accountConfig()
    await fs.writeFile(cfgFile(), JSON.stringify(before))
    await fs.mkdir(path.dirname(stateFile()), { recursive: true })
    await fs.writeFile(stateFile(), '{"owned":false}')
    expect(await seam.get(ACCOUNT)).toEqual(claim())
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, () => true)).resolves.toBe(true)
    expect(JSON.parse(await readDisk())).toEqual({
      ...before, cloudAccounts: { [NS]: { ...before.cloudAccounts[NS], syncOwnershipV2: claim({ mirrorRetired: true }) } },
    })
    expect(restartSync).toHaveBeenCalledOnce()
  })

  it('rechecks the commit guard after staging, leaving the original file and no staged copy when it declines', async () => {
    const { seam, restartSync } = await fixture()
    const before = JSON.stringify(accountConfig({ syncOwnershipV2: claim() }))
    await fs.writeFile(cfgFile(), before)
    const write = fs.writeFile.bind(fs)
    let allowed = true
    const canCommit = vi.fn(() => allowed)
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await write(...args)
      allowed = false
    })
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, canCommit)).resolves.toBe(false)
    expect(canCommit).toHaveBeenCalledOnce()
    expect(await readDisk()).toBe(before)
    expect(await fs.readdir(env.root)).not.toContain(`amadeus-config.json.tmp-${process.pid}`)
    expect(restartSync).not.toHaveBeenCalled()
  })

  it('throws on a fresh config read failure even with a populated cache, and the queue recovers after a retry', async () => {
    const { settings, seam, restartSync } = await fixture()
    const before = JSON.stringify(accountConfig({ syncOwnershipV2: claim() }))
    await fs.writeFile(cfgFile(), before)
    expect((await settings.readConfig(ACCOUNT)).cloudSync?.enabled).toBe(true)
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }))
    const canCommit = vi.fn(() => true)
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, canCommit)).rejects.toThrow('amadeus-config-unreadable')
    expect(await readDisk()).toBe(before)
    expect(canCommit).not.toHaveBeenCalled()
    expect(restartSync).not.toHaveBeenCalled()
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, canCommit)).resolves.toBe(true)
  })

  it.each([
    ['null ownership', { syncOwnershipV2: null }, 'syncOwnershipV2 is malformed'],
    ['malformed ownership', { syncOwnershipV2: claim({ mirrorRetired: 'true' }) }, 'syncOwnershipV2 is malformed'],
    ['malformed cloud config', { cloudSync: { enabled: 'true', vaultId: seal.vaultId } }, 'amadeus-config-malformed'],
    ['malformed entry config', { entrySync: [{}] }, 'amadeus-config-malformed'],
  ])('throws before writing or restarting for %s', async (_reason, extra, error) => {
    const { seam, restartSync } = await fixture()
    const before = JSON.stringify(accountConfig({ syncOwnershipV2: claim(), ...extra }))
    await fs.writeFile(cfgFile(), before)
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, () => true)).rejects.toThrow(error)
    expect(await readDisk()).toBe(before)
    expect(restartSync).not.toHaveBeenCalled()
  })

  it('refuses sealing when disabled, but allows unsealing while preserving the disabled setting', async () => {
    const { seam, restartSync } = await fixture()
    const cfg = accountConfig({ syncOwnershipV2: claim() })
    cfg.cloudAccounts[NS].cloudSync.enabled = false
    await fs.writeFile(cfgFile(), JSON.stringify(cfg))
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, () => true)).resolves.toBe(false)
    expect(restartSync).not.toHaveBeenCalled()
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig({
      cloudSync: cfg.cloudAccounts[NS].cloudSync, syncOwnershipV2: claim({ mirrorRetired: true }),
    })))
    await expect(seam.patchMirrorRetired!(ACCOUNT, unseal, () => true)).resolves.toBe(true)
    expect(JSON.parse(await readDisk())).toEqual(cfg)
  })

  it('refuses if a configured vault root points into the mirror through an alias', async () => {
    const { seam, restartSync, mirror } = await fixture()
    const child = path.join(mirror, 'Notes')
    await fs.mkdir(child, { recursive: true })
    const alias = path.join(env.root, 'alias')
    await fs.symlink(child, alias, 'junction')
    const before = JSON.stringify({ ...accountConfig({ syncOwnershipV2: claim() }), lastVault: alias })
    await fs.writeFile(cfgFile(), before)
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, () => true)).resolves.toBe(false)
    expect(await readDisk()).toBe(before)
    expect(restartSync).not.toHaveBeenCalled()
  })

  it.each(['{"owned":true}', '{"owned":'])('leaves missing ownership untouched if the legacy mask is set or unreadable (%s)', async (state) => {
    const { seam, restartSync } = await fixture()
    const before = JSON.stringify(accountConfig())
    await fs.writeFile(cfgFile(), before)
    await fs.mkdir(path.dirname(stateFile()), { recursive: true })
    await fs.writeFile(stateFile(), state)
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, () => true)).resolves.toBe(false)
    expect(await readDisk()).toBe(before)
    expect(restartSync).not.toHaveBeenCalled()
  })

  it.each(['another account', 'another account claim', 'legacy state', 'extra legacy state', 'unscoped registry', 'missing child under an alias'] as const)(
    'refuses to seal a mirror containing a registered root in %s',
    async (source) => {
      const { seam, restartSync, mirror } = await fixture()
      const cfg = accountConfig({ syncOwnershipV2: claim() })
      const child = path.join(mirror, 'Notes')
      const registry = { entrySync: [{ vaultRoot: child, cloudName: 'Notes', entries: [] }] }
      const other = createHash('sha256').update(`${CLOUD}::B`).digest('hex')
      const alias = path.join(env.root, 'alias')
      if (source === 'missing child under an alias') {
        await fs.mkdir(mirror, { recursive: true })
        await fs.symlink(mirror, alias, 'junction')
      }
      const withEntry = {
        'another account': { ...cfg, cloudAccounts: { ...cfg.cloudAccounts, [other]: registry } },
        'another account claim': { ...cfg, cloudAccounts: { ...cfg.cloudAccounts, [other]: { syncOwnershipV2: claim({ entryRoots: [child] }) } } },
        'legacy state': { ...cfg, legacyCloudState: registry },
        'extra legacy state': { ...cfg, legacyCloudStateExtra: [{ entrySync: [] }, registry] },
        'unscoped registry': { ...cfg, ...registry },
        'missing child under an alias': { ...cfg, cloudAccounts: {
          ...cfg.cloudAccounts, [other]: { entrySync: [{ ...registry.entrySync[0], vaultRoot: path.join(alias, 'Notes') }] },
        } },
      }[source]
      const before = JSON.stringify(withEntry)
      await fs.writeFile(cfgFile(), before)
      await expect(seam.patchMirrorRetired!(ACCOUNT, seal, () => true)).resolves.toBe(false)
      expect(await readDisk()).toBe(before)
      expect(restartSync).not.toHaveBeenCalled()
    },
  )

  it('refuses an account change during staging and omits the method from a seam without the patch dependency', async () => {
    const { seam, restartSync, host } = await fixture()
    const { contentSyncOwnershipV2 } = await import('../contentSyncHost')
    expect(contentSyncOwnershipV2(host)).not.toHaveProperty('patchMirrorRetired')
    const before = JSON.stringify(accountConfig({ syncOwnershipV2: claim() }))
    await fs.writeFile(cfgFile(), before)
    const write = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await write(...args)
      env.creds = { cloudUrl: CLOUD, token: token('B') }
    })
    await expect(seam.patchMirrorRetired!(ACCOUNT, seal, () => true)).resolves.toBe(false)
    expect(await readDisk()).toBe(before)
    expect(restartSync).not.toHaveBeenCalled()
  })
})

describe('the config cache and a loose read that lands late (Codex 12b round 1, #2)', () => {
  const RETIRED = { entryRoots: [] as string[], mirror: 'keep' as const, human: 'engine' as const, mirrorRetired: true }
  const rawClaim = async () => JSON.parse(await fs.readFile(cfgFile(), 'utf8')).cloudAccounts[NS].syncOwnershipV2
  const sealMirror = async (settings: typeof import('./settings')) =>
    settings.patchSyncOwnershipMirrorRetired(ACCOUNT, { vaultId: 'vault-1', from: false, to: true },
      () => true, () => path.join(env.root, 'mirror'), () => false)

  it('a loose read that opened the old file before a claim was committed does not put the old claim back; the next ordinary write keeps the new one', async () => {
    await fs.writeFile(cfgFile(), JSON.stringify(accountConfig({ syncOwnershipV2: { entryRoots: [], mirror: 'keep', human: 'engine' } })))
    const { release } = holdFirstConfigRead()
    const settings = await import('./settings')
    const late = settings.readConfig()
    await new Promise((r) => setTimeout(r, 20))
    await expect(sealMirror(settings)).resolves.toBe(true)
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
    await expect(sealMirror(settings)).resolves.toBe(true)
    release(true)
    expect((await late).entrySync?.map((v) => v.vaultRoot)).toEqual([vaultA, vaultB])
    expect(settings.looseConfigReadFailed()).toBe(false)
    await settings.writeConfig({ lastPage: 'a.md' })
    const disk = JSON.parse(await fs.readFile(cfgFile(), 'utf8'))
    expect(disk.lastVault).toBe(vaultA)
    expect(disk.cloudAccounts[NS].syncOwnershipV2).toEqual(RETIRED)
  })
})
