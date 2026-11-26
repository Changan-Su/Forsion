import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, userInfo } from 'node:os'
import { join, sep } from 'node:path'
import { LOCAL_UNIT_MARKER } from '../shared/localUnits'
import {
  addExistingLocalUnit, clearLocalUnitRunRecord, createLocalUnit, dropStaleLocalUnitRunRecord, defaultUserDataDir, listLocalUnits, localUnitDisplayPath,
  localUnitPaths, localUnitRunningPid, localUnitSpawnArgs, localUnitSpawnEnv, localUnitsDefaultParent, lookupLocalUnit,
  mutateLocalUnitRegistry, parseLocalUnitArgs, readLocalUnitMarker, readLocalUnitRegistry, removeLocalUnit, renameLocalUnit,
  resolveLocalUnitLaunch, writeLocalUnitMarker, writeLocalUnitRunRecord, type LocalUnitsContext,
  localUnitGuard, localUnitRunState, withRegistryLock, localUnitEnvOutside, localUnitEnvFile, parseTanguEnvText,
  LOCAL_UNIT_SHORTCUT, localUnitAppUserModelId, macAppBundleOf, quitLocalUnitsForInstall,
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

function denyMarkerRead(marker: string): () => void {
  if (process.platform !== 'win32') {
    chmodSync(marker, 0o000)
    return () => chmodSync(marker, 0o644)
  }
  const account = [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join('\\')
  const setAcl = (args: string[]): void => { execFileSync('icacls.exe', [marker, ...args, '/Q'], { windowsHide: true }) }
  setAcl(['/deny', `${account}:(R)`])
  return () => setAcl(['/remove:d', account])
}

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
    const home = join(root, 'Users', 'x')
    const outside = join(root, 'Users', 'xy', 'A')
    expect(localUnitsDefaultParent(true, home)).toBe(join(home, 'Forsion Units'))
    expect(localUnitsDefaultParent(false, home)).toBe(join(home, '.forsion-dev-units')) // 不在开发版 home(~/.forsion-dev)里面
    expect(localUnitDisplayPath(join(home, 'Forsion Units', 'A'), home)).toBe(join('~', 'Forsion Units', 'A'))
    expect(localUnitDisplayPath(outside, home)).toBe(outside)
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
    expect(await create('Bench B')).toEqual({ ok: false, code: 'registry_unreadable', detail: expect.any(String) }) // 解析错误是原文:只进 detail,不当成给人看的 message
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

  it('陈旧的锁:持锁进程死了 → 立刻回收;内容不是 <pid>-<uuid>(还没写进 token)→ 10 秒没动才回收', async () => {
    mkdirSync(join(root, 'default-ud'), { recursive: true })
    const lock = `${registryFile}.lock`
    writeFileSync(lock, `99999999-${ID(9)}`) // 死进程,mtime 是新的
    expect((await create()).ok).toBe(true)
    expect(existsSync(lock)).toBe(false)
    writeFileSync(lock, 'garbage')
    const old = (Date.now() - 20_000) / 1000
    utimesSync(lock, old, old)
    expect((await create('Bench B')).ok).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  it('持锁进程还活着:锁再旧也不回收(等到期限报 io,名册不动)', async () => {
    mkdirSync(join(root, 'default-ud'), { recursive: true })
    const lock = `${registryFile}.lock`
    const live = `${process.pid}-${ID(8)}`
    writeFileSync(lock, live)
    const old = (Date.now() - 60_000) / 1000
    utimesSync(lock, old, old)
    const r = await create('Waits', { lockOptions: { waitMs: 300 } })
    expect(r).toMatchObject({ ok: false, code: 'io' })
    expect(readFileSync(lock, 'utf8')).toBe(live)
    expect(existsSync(join(parent, 'Waits'))).toBe(false) // 登记失败,刚建的文件夹收掉
  })

  it('回收的交错:B 判了陈旧、还没挪,A 先回收并拿到新锁 → B 挪走的不是那一份,原样放回;A 的锁一直在,两次提交都在', async () => {
    mkdirSync(join(root, 'default-ud'), { recursive: true })
    writeFileSync(registryFile, JSON.stringify({ schema: 1, units: [] }))
    const lock = `${registryFile}.lock`
    const dead = `99999999-${ID(9)}`
    writeFileSync(lock, dead)
    const tokenA = `${process.pid}-${ID(7)}`
    const seen: string[] = []
    let fired = false
    const b = mutateLocalUnitRegistry(registryFile, (reg) => ({ next: { schema: 1, units: [...reg.units, { id: ID(2), path: '/b', addedAt: 2 }] }, result: 'b' }), {
      waitMs: 3000,
      beforeReclaim: (l, stale) => {
        if (fired) return
        fired = true
        expect(stale).toBe(dead)
        // A 在这一刻回收了死锁、拿到新锁,并在锁内提交了自己的一条
        rmSync(l)
        writeFileSync(l, tokenA)
        writeFileSync(registryFile, JSON.stringify({ schema: 1, units: [{ id: ID(1), path: '/a', addedAt: 1 }] }))
        setTimeout(() => { seen.push(readFileSync(l, 'utf8')); rmSync(l) }, 100) // A 过一会儿放锁
      },
    })
    expect(await b).toEqual({ ok: true, result: 'b' })
    expect(seen).toEqual([tokenA]) // B 没把 A 的锁挪走(挪了也放回来了)
    expect(registryIds()).toEqual([ID(1), ID(2)]) // 两次提交都在,没有互相盖掉
    expect(readdirSync(join(root, 'default-ud')).filter((f) => f !== 'local-units.json')).toEqual([])
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

  it('原文件夹的标记读不出(坏 JSON / 没权限)→ io,名册路径不改;选的文件夹自己的标记读不出 → not_a_unit', async () => {
    await create()
    const dir = join(parent, 'Bench A')
    const copy = join(root, 'copy')
    cpSync(dir, copy, { recursive: true })
    writeFileSync(join(dir, LOCAL_UNIT_MARKER), '{"schema":1,') // 原处写坏了
    expect(await addExistingLocalUnit({ ...ctx, dir: copy, text: (k) => `t:${k}` })).toEqual({ ok: false, code: 'io', message: 't:originalMarkerUnreadable' })
    expect(readLocalUnitRegistry(registryFile)).toMatchObject({ registry: { units: [{ id: ID(1), path: dir }] } })
    cpSync(join(copy, LOCAL_UNIT_MARKER), join(dir, LOCAL_UNIT_MARKER))
    const restoreRead = denyMarkerRead(join(dir, LOCAL_UNIT_MARKER))
    try {
      expect(await addExistingLocalUnit({ ...ctx, dir: copy })).toMatchObject({ ok: false, code: 'io' })
      expect(readLocalUnitRegistry(registryFile)).toMatchObject({ registry: { units: [{ id: ID(1), path: dir }] } })
      expect(await addExistingLocalUnit({ ...ctx, dir })).toMatchObject({ ok: false, code: 'not_a_unit' })
      expect(resolveLocalUnitLaunch({ id: ID(1), registryFile, channel: 'dev' })).toEqual({ ok: false, reason: 'mismatch' })
    } finally { restoreRead() }
  })

  it('文件夹和默认那台的数据沾边:加入 / 新建 / 打开 / 启动都拒;旧的开发版位置 ~/.forsion-dev/units 里的老 Unit 照样能开', async () => {
    const home = join(root, 'h')
    mkdirSync(home)
    const guard = localUnitGuard({ home, startupUserData: join(root, 'App Support', 'forsion-desktop'), envWorkspace: join(root, 'ws') })
    const g = { ...ctx, guard, text: (k: string) => `t:${k}` }
    // 家目录本身放了标记 → 加入被拒(工作区会变成 ~/Forsion)
    const other = { ...ctx, registryFile: join(root, 'other-ud', 'local-units.json') }
    await createLocalUnit({ ...other, name: 'H', icon: '', parentDir: home, newId })
    cpSync(join(home, 'H', LOCAL_UNIT_MARKER), join(home, LOCAL_UNIT_MARKER))
    expect(await addExistingLocalUnit({ ...g, dir: home })).toEqual({ ok: false, code: 'not_a_unit', message: 't:overlapsDefault' })
    // 在默认那台的 home / userData / 启动时重定向的工作区里
    for (const bad of [join(home, '.forsion'), join(root, 'App Support', 'forsion-desktop-dev'), join(root, 'ws')]) {
      mkdirSync(bad, { recursive: true })
      expect(await createLocalUnit({ ...g, name: 'Bad', icon: '', parentDir: bad, newId })).toEqual({ ok: false, code: 'parent_invalid', message: 't:overlapsDefault' })
      expect(existsSync(join(bad, 'Bad'))).toBe(false)
    }
    // 名册里已有的一条后来沾边了(软链把 ~/Forsion 指进它里面)→ 打开、启动都拒
    const ok = await createLocalUnit({ ...g, name: 'Fine', icon: '', parentDir: parent, newId })
    expect(ok.ok).toBe(true)
    const id = ok.ok ? ok.unit.id : ''
    expect(resolveLocalUnitLaunch({ id, registryFile, channel: 'dev', guard })).toMatchObject({ ok: true })
    symlinkSync(join(parent, 'Fine', 'Forsion'), join(home, 'Forsion'))
    expect(resolveLocalUnitLaunch({ id, registryFile, channel: 'dev', guard })).toEqual({ ok: false, reason: 'overlap' })
    expect(lookupLocalUnit(g, id)).toEqual({ ok: false, code: 'not_a_unit', message: 't:overlapsDefault' })
    // 旧的开发版缺省位置:在开发版 home 里面,但只在 units/ 下 → 照样能开
    const legacyParent = join(home, '.forsion-dev', 'units')
    mkdirSync(legacyParent, { recursive: true })
    const legacy = await createLocalUnit({ ...ctx, name: 'Old', icon: '', parentDir: legacyParent, newId })
    expect(legacy.ok && resolveLocalUnitLaunch({ id: legacy.unit.id, registryFile, channel: 'dev', guard })).toMatchObject({ ok: true })
    // 但 ~/.forsion-dev 里别的地方不行
    expect(await createLocalUnit({ ...g, name: 'Nope', icon: '', parentDir: join(home, '.forsion-dev'), newId })).toMatchObject({ ok: false, code: 'parent_invalid' })
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
    writeLocalUnitMarker(dir, { ...readLocalUnitMarker(dir)!, id: ID(5) })
    expect(await renameLocalUnit({ ...ctx, id: ID(1), patch: { icon: 'y' } })).toEqual({ ok: false, code: 'not_a_unit', detail: 'marker id does not match' }) // 内部原因只在 detail
    writeLocalUnitMarker(dir, { ...readLocalUnitMarker(dir)!, id: ID(1) })
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

  it('移除:它正开着 / 运行记录读不出(说不准)→ io + 说明,名册不动;关了才能移除', async () => {
    await create()
    const ad = localUnitPaths(join(parent, 'Bench A')).appData
    writeLocalUnitRunRecord(ad, 4242)
    const t = { ...ctx, text: (k: string) => `t:${k}` }
    expect(await removeLocalUnit({ ...t, id: ID(1), alive: (p) => p === 4242 })).toEqual({ ok: false, code: 'io', message: 't:removeRunning' })
    writeFileSync(join(ad, 'local-unit-run.json'), '{"pid":')
    expect(await removeLocalUnit({ ...t, id: ID(1) })).toEqual({ ok: false, code: 'io', message: 't:removeRunning' })
    expect(registryIds()).toEqual([ID(1)])
    rmSync(join(ad, 'local-unit-run.json'))
    expect(await removeLocalUnit({ ...t, id: ID(1) })).toEqual({ ok: true })
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
    expect(snap.defaultParentDisplay).toBe(`~${sep}default-parent`)
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
  it('运行状态:没记录 = stopped;活的 pid = running;死的 = stopped;读不出 / 写坏 / 没 pid = unknown', () => {
    const ad = join(root, 'rs')
    expect(localUnitRunState(ad)).toEqual({ state: 'stopped' })
    writeLocalUnitRunRecord(ad, 77)
    expect(localUnitRunState(ad, (p) => p === 77)).toEqual({ state: 'running', pid: 77 })
    expect(localUnitRunState(ad, () => false)).toEqual({ state: 'stopped' })
    for (const bad of ['', '{"pid":', '{"startedAt":1}', '{"pid":"7"}']) {
      writeFileSync(join(ad, 'local-unit-run.json'), bad)
      expect(localUnitRunState(ad).state).toBe('unknown')
    }
    rmSync(join(ad, 'local-unit-run.json'))
    mkdirSync(join(ad, 'local-unit-run.json')) // 读的时候报 EISDIR:不是「没有」
    expect(localUnitRunState(ad).state).toBe('unknown')
  })

  it('拿到锁的退出请求删掉崩溃留下的记录,哪怕记的 pid 被别的活进程复用了', () => {
    const ad = join(root, 'stale')
    writeLocalUnitRunRecord(ad, process.pid) // 复用:记录里的 pid 恰好是个活进程
    expect(localUnitRunningPid(ad)).toBe(process.pid)
    dropStaleLocalUnitRunRecord(ad)
    expect(existsSync(join(ad, 'local-unit-run.json'))).toBe(false)
    dropStaleLocalUnitRunRecord(join(root, 'nothing-here')) // 没有也不抛
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

describe('启动前核文件夹 Unit 自己的 .env', () => {
  it('读法和引擎一致:注释、空行、没有 = 的跳过,成对引号去掉', () => {
    expect(parseTanguEnvText('# c\n\nA=1\n =x\nB = "two words" \nC=\'q\'\nD="half\nE=a=b\nnoeq')).toEqual([['A', '1'], ['B', 'two words'], ['C', 'q'], ['D', '"half'], ['E', 'a=b']])
  })
  it('指路径的变量指出了文件夹(或不是绝对路径)→ 回那一条;都在文件夹里 / 空值 / 别的变量 / 没有 .env → null', async () => {
    await create()
    const p = localUnitPaths(join(parent, 'Bench A'))
    expect(localUnitEnvOutside(p)).toBeNull() // 没有 .env
    const file = localUnitEnvFile(p)
    expect(file).toBe(join(p.home, 'tangu', '.env'))
    mkdirSync(join(p.home, 'tangu'), { recursive: true })
    writeFileSync(file, `TANGU_CLOUD_URL=https://x\nFORSION_DEFAULT_CALENDAR=\nTANGU_DATA_DIR=${join(p.home, 'tangu', 'state.db')}\n`)
    expect(localUnitEnvOutside(p)).toBeNull()
    writeFileSync(file, `TANGU_DATA_DIR=${join(p.home, 'tangu', 'state.db')}\nTANGU_TOKEN_FILE="${join(root, 'default-home', 'token')}"\n`)
    expect(localUnitEnvOutside(p)).toEqual({ key: 'TANGU_TOKEN_FILE', value: join(root, 'default-home', 'token'), file })
    writeFileSync(file, 'FORSION_AMADEUS_VAULT=relative/vault\n')
    expect(localUnitEnvOutside(p)?.key).toBe('FORSION_AMADEUS_VAULT')
    // 软链别名:字面在文件夹里,真身在外面
    symlinkSync(join(root, 'units'), join(p.dir, 'Forsion', 'escape'))
    writeFileSync(file, `FORSION_DEFAULT_CALENDAR=${join(p.dir, 'Forsion', 'escape', 'Calendar.db')}\n`)
    expect(localUnitEnvOutside(p)?.key).toBe('FORSION_DEFAULT_CALENDAR')
  })
})

describe('装更新前关掉文件夹 Unit', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms } } }
  it('没有在跑的 → 0,不发请求;自己那一份不算', async () => {
    await create('Self')
    writeLocalUnitRunRecord(localUnitPaths(join(parent, 'Self')).appData, 111)
    const asked: string[] = []
    expect(await quitLocalUnitsForInstall({ registryFile, selfId: ID(1), requestQuit: (id) => asked.push(id), alive: () => true, ...clock() })).toBe(0)
    expect(asked).toEqual([])
  })
  it('都按请求退了 → 0;有一台过了期限还在 → 1(只数在跑的)', async () => {
    for (const n of ['A', 'B', 'C']) await create(n)
    writeLocalUnitRunRecord(localUnitPaths(join(parent, 'A')).appData, 101)
    writeLocalUnitRunRecord(localUnitPaths(join(parent, 'B')).appData, 102) // C 没在跑
    const live = new Set([101, 102])
    const asked: string[] = []
    const ok = await quitLocalUnitsForInstall({ registryFile, requestQuit: (id) => { asked.push(id); live.delete(id === ID(1) ? 101 : 102) }, alive: (p) => live.has(p), ...clock() })
    expect(ok).toBe(0)
    expect(asked).toEqual([ID(1), ID(2)])
    const stubborn = new Set([101, 102])
    const c = clock()
    const left = await quitLocalUnitsForInstall({ registryFile, timeoutMs: 15_000, requestQuit: (id) => { if (id === ID(1)) stubborn.delete(101) }, alive: (p) => stubborn.has(p), ...c })
    expect(left).toBe(1)
    expect(c.now()).toBeGreaterThanOrEqual(15_000)
  })
  it('运行记录读不出 = 说不准:照样发退出请求,到期还说不准就算没关(挡住安装)', async () => {
    await create('U')
    const ad = localUnitPaths(join(parent, 'U')).appData
    writeFileSync(join(ad, 'local-unit-run.json'), '{"pid":')
    const asked: string[] = []
    expect(await quitLocalUnitsForInstall({ registryFile, requestQuit: (id) => asked.push(id), alive: () => false, ...clock() })).toBe(1)
    expect(asked).toEqual([ID(1)])
    // 退出请求拿到了那台的锁(它根本没在跑)→ 删掉坏记录 → 下一轮就判成没在跑,不等满
    const c = clock()
    expect(await quitLocalUnitsForInstall({ registryFile, requestQuit: () => rmSync(join(ad, 'local-unit-run.json')), alive: () => false, ...c })).toBe(0)
    expect(c.now()).toBeLessThan(1000)
  })

  it('记录里的 pid 被别的活进程复用:退出请求删掉陈旧记录后立刻从等待里拿掉(不盯着那个 pid 等 15 秒)', async () => {
    await create('Crashed')
    const ad = localUnitPaths(join(parent, 'Crashed')).appData
    writeLocalUnitRunRecord(ad, 555)
    const c = clock()
    const left = await quitLocalUnitsForInstall({ registryFile, requestQuit: () => rmSync(join(ad, 'local-unit-run.json')), alive: (p) => p === 555, ...c })
    expect(left).toBe(0)
    expect(c.now()).toBeLessThan(1000)
  })

  it('名册读不出 → -1(不知道,不当成没有在跑的)', async () => {
    mkdirSync(join(root, 'default-ud'), { recursive: true })
    writeFileSync(registryFile, '')
    expect(await quitLocalUnitsForInstall({ registryFile, requestQuit: () => {}, ...clock() })).toBe(-1)
  })
})

describe('拉起别的实例', () => {
  it('环境变量:清掉这一份的身份与重定向,别的原样', () => {
    const env = localUnitSpawnEnv({
      PATH: '/bin', HOME: '/h', TANGU_HARNESS_QUIET: '1', TANGU_HOME: '/x', FORSION_WORKSPACE_DIR: '/w', FORSION_SANDBOX: '1', FORSION_SANDBOX_SOCK: 's',
      PI_CU_SOCKET_PATH: '/s', TANGU_BACKEND_URL: 'http://x', TANGU_BROWSER_EXTENSION: '0', TANGU_BROWSER_EXTENSION_PORT: '1', FORSION_UNIT_AUTO_PAIR: '1',
      ELECTRON_RUN_AS_NODE: '1', FORSION_CLIP_ENTRANCE: '0',
      TANGU_TOKEN_FILE: '/x/token', FORSION_DEFAULT_CALENDAR: '/x/Calendar.db', TANGU_TOKEN: 't', TANGU_LOCAL_TOKEN: 'l', TANGU_REMOTE_MARK_SECRET: 's',
      TANGU_DATA_DIR: '/x/db', TANGU_DEFAULT_WORKSPACE: '/w', FORSION_AMADEUS_VAULT: '/v', FORSION_AMADEUS_CONFIG: '/c', FORSION_DESKTOP_CONFIG: '/d',
      FORSION_REMOTE_LOCK_FILE: '/r', TANGU_PORT: '1', TANGU_HOST: '0.0.0.0', TANGU_USER_ID: 'u', TANGU_SANDBOX: 'none', FORSION_HOST_STDIN: '1',
      TANGU_CLOUD_URL: 'https://cloud', TANGU_NODE_BIN: '/node', TANGU_BROWSER_EXTENSION_DIR: '/ext',
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', TANGU_HARNESS_QUIET: '1', FORSION_CLIP_ENTRANCE: '0', TANGU_CLOUD_URL: 'https://cloud', TANGU_NODE_BIN: '/node', TANGU_BROWSER_EXTENSION_DIR: '/ext' })
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
    const appBundle = join(root, 'Applications', 'Forsion.app')
    expect(macAppBundleOf(join(appBundle, 'Contents', 'MacOS', 'Forsion'))).toBe(appBundle)
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
