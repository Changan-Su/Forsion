import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_UNIT_MARKER } from '../shared/localUnits'
import {
  addExistingLocalUnit, clearLocalUnitRunRecord, createLocalUnit, defaultUserDataDir, listLocalUnits, localUnitDisplayPath,
  localUnitPaths, localUnitRunningPid, localUnitSpawnArgs, localUnitSpawnEnv, localUnitsDefaultParent, lookupLocalUnit,
  mutateLocalUnitRegistry, parseLocalUnitArgs, readLocalUnitMarker, readLocalUnitRegistry, removeLocalUnit, renameLocalUnit,
  resolveLocalUnitLaunch, writeLocalUnitMarker, writeLocalUnitRunRecord, type LocalUnitsContext,
  LOCAL_UNIT_SHORTCUT, localUnitAppUserModelId, macAppBundleOf,
} from './localUnits'
import { createWindowShortcut, windowShortcutPlan } from './spaceShortcut'

let root = ''
let registryFile = ''
let parent = ''
let ctx: LocalUnitsContext & { defaultParent: string }
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let seq = 0
const newId = () => ID(++seq)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'forsion-localunits-')))
  registryFile = join(root, 'default-ud', 'local-units.json')
  parent = join(root, 'units')
  mkdirSync(parent)
  ctx = { registryFile, channel: 'dev', self: null, home: root, defaultParent: join(root, 'default-parent') }
  seq = 0
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const create = (name = 'Bench A', extra: Record<string, unknown> = {}) => createLocalUnit({ ...ctx, name, icon: '🧪', parentDir: parent, newId, now: 1000, ...extra })
const registryIds = () => { const r = readLocalUnitRegistry(registryFile); return r.state === 'ok' ? r.registry.units.map((u) => u.id) : null }

describe('启动参数', () => {
  it('只认 --forsion-unit=<id>;写法不对 / 两个不同 id = 出现了但 id 为空(拒绝,不回落成默认那台)', () => {
    expect(parseLocalUnitArgs(['/app', `--forsion-unit=${ID(1)}`])).toEqual({ present: true, id: ID(1), quit: false })
    expect(parseLocalUnitArgs([`--forsion-unit=${ID(1)}`, '--forsion-unit-quit'])).toEqual({ present: true, id: ID(1), quit: true })
    expect(parseLocalUnitArgs(['--forsion-unit', ID(1)])).toEqual({ present: true, id: null, quit: false })
    expect(parseLocalUnitArgs(['--forsion-unit=../../etc'])).toEqual({ present: true, id: null, quit: false })
    expect(parseLocalUnitArgs([`--forsion-unit=${ID(1)}`, `--forsion-unit=${ID(2)}`]).id).toBeNull()
    expect(parseLocalUnitArgs([`--forsion-unit=${ID(1)}`, `--forsion-unit=${ID(1)}`]).id).toBe(ID(1))
    expect(parseLocalUnitArgs(['/app', 'forsion://space/x'])).toEqual({ present: false, id: null, quit: false })
    expect(parseLocalUnitArgs(['--forsion-unit-quit'])).toEqual({ present: false, id: null, quit: true })
  })

  it('默认 userData / 缺省父目录 / 给人看的路径', () => {
    expect(defaultUserDataDir('/a/forsion-desktop', false)).toBe('/a/forsion-desktop-dev')
    expect(defaultUserDataDir('/a/Forsion', true)).toBe('/a/Forsion')
    expect(localUnitsDefaultParent(true, '/Users/x')).toBe('/Users/x/Forsion Units')
    expect(localUnitsDefaultParent(false, '/Users/x')).toBe('/Users/x/.forsion-dev/units')
    expect(localUnitDisplayPath('/Users/x/Forsion Units/A', '/Users/x')).toBe('~/Forsion Units/A')
    expect(localUnitDisplayPath('/Users/xy/A', '/Users/x')).toBe('/Users/xy/A')
  })
})

describe('名册读取:读不出 ≠ 空', () => {
  it('不存在 = 空名册;零字节 / 坏 JSON / 结构不对 = unreadable', () => {
    expect(readLocalUnitRegistry(registryFile)).toEqual({ state: 'ok', registry: { schema: 1, units: [] } })
    mkdirSync(join(root, 'default-ud'))
    for (const bad of ['', '{"schema":1,', '{"schema":2,"units":[]}', '[]', '{"schema":1,"units":[{"id":1}]}']) {
      writeFileSync(registryFile, bad)
      expect(readLocalUnitRegistry(registryFile).state).toBe('unreadable')
    }
  })

  it('名册读不出时:新建 / 加入 / 改名 / 移除都回 registry_unreadable,名册原样,盘上不多出文件夹', async () => {
    const a = await create()
    expect(a.ok).toBe(true)
    writeFileSync(registryFile, '') // 断电后的零字节
    expect(await create('Bench B')).toEqual({ ok: false, code: 'registry_unreadable', message: expect.any(String) })
    expect(existsSync(join(parent, 'Bench B'))).toBe(false)
    const id = a.ok ? a.unit.id : ''
    expect((await addExistingLocalUnit({ ...ctx, dir: join(parent, 'Bench A') })).ok).toBe(false)
    expect((await renameLocalUnit({ ...ctx, id, patch: { name: 'X' } }) as { code?: string }).code).toBe('registry_unreadable')
    expect((await removeLocalUnit({ ...ctx, id }) as { code?: string }).code).toBe('registry_unreadable')
    expect(readFileSync(registryFile, 'utf8')).toBe('')
    expect(readLocalUnitMarker(join(parent, 'Bench A'))?.name).toBe('Bench A') // 改名没写进标记
    const snap = listLocalUnits(ctx)
    expect(snap.registry).toBe('unreadable')
    expect(snap.units).toEqual([])
  })
})

describe('新建', () => {
  it('建文件夹 + 标记 + 三个子目录 + 登记;不打开', async () => {
    const r = await create()
    expect(r).toMatchObject({ ok: true, unit: { id: ID(1), name: 'Bench A', icon: '🧪', state: 'stopped', current: false } })
    const dir = join(parent, 'Bench A')
    expect(readdirSync(dir).sort()).toEqual(['Forsion', 'app-data', 'forsion-unit.json', 'home'])
    expect(readLocalUnitMarker(dir)).toEqual({ schema: 1, id: ID(1), name: 'Bench A', icon: '🧪', channel: 'dev', createdAt: 1000 })
    expect(readLocalUnitRegistry(registryFile)).toEqual({ state: 'ok', registry: { schema: 1, units: [{ id: ID(1), path: dir, addedAt: 1000 }] } })
    expect(readdirSync(join(root, 'default-ud')).filter((f) => f !== 'local-units.json')).toEqual([]) // 锁和临时文件都收干净
  })

  it('目标已存在 → path_exists;名字不行 → name_invalid;父目录相对 / 不存在 → parent_invalid', async () => {
    mkdirSync(join(parent, 'Taken'))
    expect(await create('Taken')).toEqual({ ok: false, code: 'path_exists' })
    expect((await create('   ')).ok).toBe(false)
    expect(await create('a/b')).toMatchObject({ ok: true, unit: { name: 'a/b' } }) // 文件夹名洗成「a b」
    expect(existsSync(join(parent, 'a b'))).toBe(true)
    expect(await create('C', { parentDir: 'relative/x' })).toEqual({ ok: false, code: 'parent_invalid' })
    expect(await create('C', { parentDir: join(root, 'nope') })).toEqual({ ok: false, code: 'parent_invalid' })
    expect(existsSync(join(root, 'nope'))).toBe(false)
    expect(registryIds()).toEqual([ID(1)])
  })

  it('缺省父目录不存在就建出来;别的父目录不替用户建', async () => {
    const r = await createLocalUnit({ ...ctx, name: 'Default', icon: '', newId })
    expect(r.ok).toBe(true)
    expect(existsSync(join(ctx.defaultParent, 'Default', LOCAL_UNIT_MARKER))).toBe(true)
  })

  it('并发新建:两条都登记上(锁内现读现改,不互相盖掉)', async () => {
    const [a, b] = await Promise.all([create('P1'), create('P2')])
    expect(a.ok && b.ok).toBe(true)
    expect(registryIds()?.sort()).toEqual([ID(1), ID(2)])
  })

  it('陈旧的锁(10 秒没动)被挪开,写照常进行', async () => {
    mkdirSync(join(root, 'default-ud'), { recursive: true })
    const lock = `${registryFile}.lock`
    writeFileSync(lock, 'dead-process')
    const old = (Date.now() - 20_000) / 1000
    utimesSync(lock, old, old)
    expect((await create()).ok).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })
})

describe('加入已有的文件夹:四种情形', () => {
  it('新的 → 登记;同一个文件夹再加 → 成功不重复;拷贝出来的 → duplicate_id;原文件夹搬走了 → 改路径', async () => {
    // 先在另一份名册里建出来,再加进这份(= 名册里没有这个 id)
    const other = { ...ctx, registryFile: join(root, 'other-ud', 'local-units.json') }
    const made = await createLocalUnit({ ...other, name: 'Movable', icon: '', parentDir: parent, newId })
    expect(made.ok).toBe(true)
    const dir = join(parent, 'Movable')
    expect(await addExistingLocalUnit({ ...ctx, dir, now: 5 })).toMatchObject({ ok: true, unit: { id: ID(1), path: dir } })
    expect(readLocalUnitRegistry(registryFile)).toEqual({ state: 'ok', registry: { schema: 1, units: [{ id: ID(1), path: dir, addedAt: 5 }] } })

    expect(await addExistingLocalUnit({ ...ctx, dir })).toMatchObject({ ok: true })
    expect(registryIds()).toEqual([ID(1)])

    const copy = join(root, 'copies', 'Movable copy')
    cpSync(dir, copy, { recursive: true })
    expect(await addExistingLocalUnit({ ...ctx, dir: copy })).toEqual({ ok: false, code: 'duplicate_id' })
    expect(readLocalUnitRegistry(registryFile)).toMatchObject({ registry: { units: [{ path: dir }] } })

    const moved = join(root, 'moved')
    renameSync(dir, moved)
    expect(await addExistingLocalUnit({ ...ctx, dir: moved })).toMatchObject({ ok: true, unit: { path: moved } })
    expect(readLocalUnitRegistry(registryFile)).toMatchObject({ registry: { units: [{ id: ID(1), path: moved, addedAt: 5 }] } })
  })

  it('原路径还在、但那里的标记已不是这个 id → 也当搬家', async () => {
    const r = await create()
    const dir = join(parent, 'Bench A')
    const copy = join(root, 'copy')
    cpSync(dir, copy, { recursive: true })
    writeLocalUnitMarker(dir, { ...readLocalUnitMarker(dir)!, id: ID(99) })
    expect(r.ok && await addExistingLocalUnit({ ...ctx, dir: copy })).toMatchObject({ ok: true, unit: { path: copy } })
  })

  it('没标记 → not_a_unit;别的通道 → channel_mismatch;子目录是软链 → not_a_unit', async () => {
    mkdirSync(join(root, 'plain'))
    expect(await addExistingLocalUnit({ ...ctx, dir: join(root, 'plain') })).toEqual({ ok: false, code: 'not_a_unit' })
    expect(await addExistingLocalUnit({ ...ctx, dir: 'relative' })).toEqual({ ok: false, code: 'not_a_unit' })
    await create()
    const dir = join(parent, 'Bench A')
    expect(await addExistingLocalUnit({ ...ctx, channel: 'stable', dir })).toEqual({ ok: false, code: 'channel_mismatch' })
    rmSync(join(dir, 'home'), { recursive: true })
    symlinkSync(root, join(dir, 'home'))
    expect((await addExistingLocalUnit({ ...ctx, dir })).ok).toBe(false)
  })
})

describe('改名 / 移除 / 列表', () => {
  it('改名只写标记;名字不行 → name_invalid;不在名册 → not_found', async () => {
    await create()
    const dir = join(parent, 'Bench A')
    expect(await renameLocalUnit({ ...ctx, id: ID(1), patch: { name: '  New name ', icon: '🚀' } })).toMatchObject({ ok: true, unit: { name: 'New name', icon: '🚀' } })
    expect(readLocalUnitMarker(dir)).toMatchObject({ id: ID(1), name: 'New name', icon: '🚀', createdAt: 1000 })
    expect(existsSync(dir)).toBe(true) // 文件夹名不跟着改
    expect(await renameLocalUnit({ ...ctx, id: ID(1), patch: { name: '' } })).toEqual({ ok: false, code: 'name_invalid' })
    expect(await renameLocalUnit({ ...ctx, id: ID(7), patch: { icon: 'x' } })).toEqual({ ok: false, code: 'not_found' })
    expect(await renameLocalUnit({ ...ctx, id: ID(1), patch: { icon: 'folder' } })).toMatchObject({ ok: true, unit: { name: 'New name', icon: 'folder' } })
  })

  it('移除只删名册条目;对自己 → is_self', async () => {
    await create()
    const dir = join(parent, 'Bench A')
    expect(await removeLocalUnit({ ...ctx, self: { id: ID(1), dir }, id: ID(1) })).toEqual({ ok: false, code: 'is_self' })
    expect(await removeLocalUnit({ ...ctx, id: ID(1) })).toEqual({ ok: true })
    expect(registryIds()).toEqual([])
    expect(readLocalUnitMarker(dir)?.id).toBe(ID(1))
    expect(await removeLocalUnit({ ...ctx, id: ID(1) })).toEqual({ ok: false, code: 'not_found' })
  })

  it('状态:running / stopped / missing / mismatch,current 标自己', async () => {
    for (const n of ['R', 'S', 'M', 'X']) await create(n)
    const dirOf = (n: string) => join(parent, n)
    writeLocalUnitRunRecord(localUnitPaths(dirOf('R')).appData, 4242)
    writeLocalUnitRunRecord(localUnitPaths(dirOf('S')).appData, 4243)
    rmSync(dirOf('M'), { recursive: true })
    writeLocalUnitMarker(dirOf('X'), { ...readLocalUnitMarker(dirOf('X'))!, channel: 'stable' })
    const alive = (pid: number) => pid === 4242
    const snap = listLocalUnits({ ...ctx, alive, self: { id: ID(2), dir: dirOf('S') } })
    expect(snap.registry).toBe('ok')
    expect(snap.self).toMatchObject({ kind: 'folder', id: ID(2), name: 'S' })
    expect(snap.units.map((u) => [u.name, u.state, u.current])).toEqual([['R', 'running', false], ['S', 'running', true], ['M', 'missing', false], ['X', 'mismatch', false]])
    expect(snap.defaultParentDisplay).toBe('~/default-parent')
    expect(lookupLocalUnit(ctx, ID(3))).toMatchObject({ ok: false, code: 'not_a_unit' })
    expect(lookupLocalUnit(ctx, ID(4))).toMatchObject({ ok: false, code: 'channel_mismatch' })
    expect(lookupLocalUnit(ctx, 'nope')).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('运行记录', () => {
  it('写 / 判活 / 只删自己那份', () => {
    const ad = join(root, 'ad')
    writeLocalUnitRunRecord(ad, process.pid)
    expect(localUnitRunningPid(ad)).toBe(process.pid)
    clearLocalUnitRunRecord(ad, process.pid + 1)
    expect(localUnitRunningPid(ad)).toBe(process.pid)
    clearLocalUnitRunRecord(ad, process.pid)
    expect(localUnitRunningPid(ad)).toBeNull()
    writeLocalUnitRunRecord(ad, 999_999_99)
    expect(localUnitRunningPid(ad)).toBeNull() // 进程没了
    writeFileSync(join(ad, 'local-unit-run.json'), '')
    expect(localUnitRunningPid(ad)).toBeNull()
  })
})

describe('启动核对:不对就拒,盘上不留东西', () => {
  it('对上了 → 路径;名册读不出 / 没这个 id / 文件夹没了 / 标记 id 或通道不对 / 子目录是软链 → 各自的拒绝原因', async () => {
    for (const n of ['Good', 'Gone', 'Forged', 'Other', 'Linked']) await create(n)
    const go = (id: string | null, channel: 'dev' | 'stable' = 'dev') => resolveLocalUnitLaunch({ id, registryFile, channel })
    const good = go(ID(1))
    expect(good).toMatchObject({ ok: true, id: ID(1), paths: { dir: join(parent, 'Good'), appData: join(parent, 'Good', 'app-data'), home: join(parent, 'Good', 'home'), workspace: join(parent, 'Good', 'Forsion') } })
    expect(go(null)).toEqual({ ok: false, reason: 'bad_arg' })
    expect(go(ID(42))).toEqual({ ok: false, reason: 'not_found' })
    rmSync(join(parent, 'Gone'), { recursive: true })
    expect(go(ID(2))).toEqual({ ok: false, reason: 'missing' })
    expect(existsSync(join(parent, 'Gone'))).toBe(false)
    writeLocalUnitMarker(join(parent, 'Forged'), { ...readLocalUnitMarker(join(parent, 'Forged'))!, id: ID(77) })
    expect(go(ID(3))).toEqual({ ok: false, reason: 'mismatch' })
    expect(go(ID(4), 'stable')).toEqual({ ok: false, reason: 'channel_mismatch' })
    rmSync(join(parent, 'Linked', 'app-data'), { recursive: true })
    symlinkSync(join(root, 'default-ud'), join(parent, 'Linked', 'app-data'))
    expect(go(ID(5))).toEqual({ ok: false, reason: 'unsafe' })
    writeFileSync(registryFile, '{')
    expect(go(ID(1))).toEqual({ ok: false, reason: 'registry_unreadable' })
  })
})

describe('拉起别的实例', () => {
  it('环境变量:清掉这一份的身份与重定向,别的原样', () => {
    const env = localUnitSpawnEnv({
      PATH: '/bin', HOME: '/h', TANGU_HARNESS_QUIET: '1', TANGU_HOME: '/x', FORSION_WORKSPACE_DIR: '/w', FORSION_SANDBOX: '1', FORSION_SANDBOX_SOCK: 's',
      PI_CU_SOCKET_PATH: '/s', TANGU_BACKEND_URL: 'http://x', TANGU_BROWSER_EXTENSION: '0', TANGU_BROWSER_EXTENSION_PORT: '1', FORSION_UNIT_AUTO_PAIR: '1',
      ELECTRON_RUN_AS_NODE: '1', FORSION_CLIP_ENTRANCE: '0',
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', TANGU_HARNESS_QUIET: '1', FORSION_CLIP_ENTRANCE: '0' })
  })

  it('参数:appPath + 转交的 --user-data-dir + id / 退出 / 转交的链接', () => {
    expect(localUnitSpawnArgs({ appArgs: ['/app'], userDataDirSwitch: '/ud', unitId: ID(1) })).toEqual(['/app', '--user-data-dir=/ud', `--forsion-unit=${ID(1)}`])
    expect(localUnitSpawnArgs({ appArgs: [], unitId: ID(1), quit: true })).toEqual([`--forsion-unit=${ID(1)}`, '--forsion-unit-quit'])
    expect(localUnitSpawnArgs({ appArgs: [], forward: ['forsion://space/a'] })).toEqual(['forsion://space/a'])
    expect(() => localUnitSpawnArgs({ appArgs: [], unitId: '../x' })).toThrow()
  })
})

describe('添加到桌面:本机 Unit 这一种', () => {
  const opts = { id: ID(1), name: 'My "Unit" $(x)', execPath: '/Applications/Forsion\'s.app/Contents/MacOS/Forsion', appBundle: "/Applications/Forsion's.app" }
  it('mac:脚本 App 用 open -n -a 带 --forsion-unit=<id>;安装包路径单引号转义,名字不进脚本', () => {
    const plan = windowShortcutPlan(LOCAL_UNIT_SHORTCUT, 'darwin', opts)
    expect(plan?.kind).toBe('bundle')
    const script = plan?.kind === 'bundle' ? String(plan.files.find((f) => f.rel === 'Contents/MacOS/launch')!.content) : ''
    expect(script).toContain(`exec /usr/bin/open -n -a '/Applications/Forsion'\\''s.app' --args --forsion-unit=${ID(1)}`)
    expect(script).not.toContain('forsion://')
    expect(script).not.toContain('My')
    expect(windowShortcutPlan(LOCAL_UNIT_SHORTCUT, 'darwin', { ...opts, appBundle: undefined })).toBeNull()
  })
  it('Windows:.lnk 参数只有 --forsion-unit=<id>,AUMID 与进程一致;Linux:Exec 带同一个参数', () => {
    const lnk = windowShortcutPlan(LOCAL_UNIT_SHORTCUT, 'win32', opts)
    expect(lnk).toMatchObject({ kind: 'lnk', args: `--forsion-unit=${ID(1)}`, appUserModelId: localUnitAppUserModelId(ID(1)) })
    expect(localUnitAppUserModelId(ID(1))).toBe(`com.forsion.tangu.unit.${ID(1)}`)
    const desk = windowShortcutPlan(LOCAL_UNIT_SHORTCUT, 'linux', { ...opts, execPath: '/opt/Forsion/forsion' })
    expect(desk?.kind === 'file' && desk.content).toContain(`Exec="/opt/Forsion/forsion" "--forsion-unit=${ID(1)}"`)
    expect(() => windowShortcutPlan(LOCAL_UNIT_SHORTCUT, 'linux', { ...opts, id: '../x' })).toThrow()
  })
  it('真写一次(mac 形态):桌面上多出 .app,开发版拒绝', async () => {
    const desktop = join(root, 'Desktop')
    mkdirSync(desktop)
    const deps = { platform: 'darwin' as const, isPackaged: true, desktopDir: desktop, execPath: opts.execPath, appBundle: opts.appBundle, iconDir: join(root, 'icons') }
    expect(await createWindowShortcut(LOCAL_UNIT_SHORTCUT, { id: ID(1), name: 'Work' }, deps)).toEqual({ ok: true, path: join(desktop, 'Work.app') })
    expect(readFileSync(join(desktop, 'Work.app', 'Contents', 'Info.plist'), 'utf8')).toContain(`<key>ForsionLocalUnitId</key>\t<string>${ID(1)}</string>`)
    expect(await createWindowShortcut(LOCAL_UNIT_SHORTCUT, { id: ID(1), name: 'Work' }, { ...deps, isPackaged: false })).toEqual({ ok: false, code: 'unpackaged' })
    expect(macAppBundleOf('/Applications/Forsion.app/Contents/MacOS/Forsion')).toBe('/Applications/Forsion.app')
    expect(macAppBundleOf('/opt/forsion/forsion')).toBeUndefined()
  })
})

describe('mutateLocalUnitRegistry', () => {
  it('fn 不回 next 就不写(连文件都不建)', async () => {
    const r = await mutateLocalUnitRegistry(registryFile, () => ({ result: 1 }))
    expect(r).toEqual({ ok: true, result: 1 })
    expect(existsSync(registryFile)).toBe(false)
  })
})
