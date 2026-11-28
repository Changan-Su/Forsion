/** 共享那半的状态机:假 server(带票据的比对交换写)× 两台「设备」(各自一份内存 + 一份 localStorage)。
 *  设备的写动作按 store 的口径:同步改内存,再把前后差交给 record。
 *  「同一台机器的两个窗口」= 两个实例共享同一份假 localStorage、同一份镜像、同一把锁(各自一份内存)。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
import {
  createCalendarSettingsSync, MERGED_KEY, OP_PREFIX, PENDING_KEY,
  type SettingsKey, type SettingsLock, type SettingsStorage,
} from './calendarSettingsSync'
import { diffVaultCfg, docToVaultCfg, emptySettingsDoc, rowIdOf, type VaultCfg } from './calendarSettingsDoc'
import type { SettingsRead, SettingsTransport, SettingsWrite } from './calendarSettingsIo'
import { planAutoColors, EVENT_PALETTE as P } from './calendarConfigStore'

const R = '/Users/me/Vault'
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const vc = (o: Partial<VaultCfg> = {}): VaultCfg => ({ colors: {}, hidden: [], defaultDbPath: null, members: {}, ...o })
const deferred = <T = void>() => { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r }); return { p, resolve } }
/** 让挂着的 promise 链都走完(不用假定时器的用例)。 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

type Mode = 'ok' | 'absent' | 'corrupt' | 'down'
function fakeServer() {
  const s = {
    doc: null as DbFile | null,
    ver: 0,
    mode: 'ok' as Mode,
    puts: [] as Array<{ data: DbFile; version: string | null }>,
    /** 写进去之前插一手(模拟另一台在读写之间写了):返回 true 就消耗掉 */
    beforeWrite: [] as Array<() => void>,
    writeResult: null as SettingsWrite | null,
  }
  const now = (): SettingsRead =>
    s.mode === 'corrupt' ? { status: 'corrupt' } : s.doc ? { status: 'ok', data: clone(s.doc), version: `v${s.ver}` } : { status: 'missing' }
  const io: SettingsTransport = {
    read: vi.fn(async () => (s.mode === 'ok' || s.mode === 'corrupt' ? now() : { status: 'unknown' } as SettingsRead)),
    write: vi.fn(async (data: DbFile, version: string | null): Promise<SettingsWrite> => {
      s.puts.push({ data: clone(data), version })
      if (s.writeResult) return s.writeResult
      if (s.mode === 'absent' || s.mode === 'down') return { status: 'unknown' }
      s.beforeWrite.shift()?.()
      if (s.mode === 'corrupt') return { status: 'conflict', current: { status: 'corrupt' } }
      const cur = s.doc ? `v${s.ver}` : null
      if (version !== cur) return { status: 'conflict', current: now() }
      s.doc = clone(data)
      s.ver++
      return { status: 'ok', version: `v${s.ver}` }
    }),
  }
  return Object.assign(s, { io, now, shared: (): VaultCfg => docToVaultCfg(s.doc ?? emptySettingsDoc()) })
}
type Srv = ReturnType<typeof fakeServer>

type MemStorage = SettingsStorage & { data: Map<string, string>; failSet: ((k: string) => boolean) | null; onAccess: ((k: string) => void) | null }
function memStorage(): MemStorage {
  const data = new Map<string, string>()
  const s: MemStorage = {
    data,
    failSet: null,
    onAccess: null,
    getItem: (k) => { const v = data.get(k) ?? null; s.onAccess?.(k); return v },
    setItem: (k, v) => { if (s.failSet?.(k)) throw new Error('QuotaExceededError'); data.set(k, v) },
    removeItem: (k) => { data.delete(k) },
    keys: () => { s.onAccess?.('*'); return [...data.keys()] },
  }
  return s
}
/** 一把互斥(各设备 / 各窗口自带一把;两个窗口共享同一把 = 有 Web Locks)。 */
function mutex(): SettingsLock {
  let tail: Promise<unknown> = Promise.resolve()
  return <T,>(_name: string, fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}
/** 不互斥(模拟两个窗口之间没有锁)。 */
const noLock: SettingsLock = (_n, fn) => fn()

interface DevOpts {
  acct?: string
  key?: () => SettingsKey
  local?: VaultCfg
  trusted?: () => boolean
  loginAcct?: () => string | null
  storage?: MemStorage
  /** 两个窗口共用的本机镜像(applyVc / 动作都照写它) */
  mirror?: Map<string, VaultCfg>
  /** 'default' = 不传(走自动探测) */
  lock?: SettingsLock | null | 'default'
  io?: SettingsTransport
  remote?: () => boolean
}
function device(server: Srv, opts: DevOpts = {}) {
  const mem = new Map<string, VaultCfg>()
  if (opts.local) mem.set(R, clone(opts.local))
  const storage = opts.storage ?? memStorage()
  let acct = opts.acct ?? 'A'
  const setVc = (r: string, v: VaultCfg): void => { mem.set(r, v); opts.mirror?.set(r, clone(v)) }
  const sync = createCalendarSettingsSync({
    io: opts.io ?? server.io,
    storage,
    resolveKey: async () => (opts.key ? opts.key() : { kind: 'sync', acct }),
    getVc: (r) => mem.get(r),
    applyVc: setVc,
    hadLocalAtStart: () => !!opts.local,
    ...(opts.trusted ? { localTrusted: opts.trusted } : {}),
    ...(opts.loginAcct ? { account: opts.loginAcct } : {}),
    ...(opts.lock === 'default' ? {} : { lock: opts.lock === undefined ? mutex() : opts.lock }),
    ...(opts.remote ? { remote: opts.remote } : {}),
    schedule: () => {},
  })
  const act = (fn: (v: VaultCfg) => VaultCfg, auto = false, inferred = false): void => {
    const prev = mem.get(R)
    const next = fn(clone(prev ?? vc()))
    setVc(R, next)
    sync.record(R, diffVaultCfg(prev, next, auto), { inferred })
  }
  /** 照 store 的 migrate:有日期列的表推断为成员 */
  const migrate = (paths: string[]): void => act((v) => {
    if (v.migrated) return v
    const members = { ...v.members }
    for (const p of paths) members[p] ??= { dateCol: 'd' }
    return { ...v, members, migrated: true }
  }, true, true)
  /** 照 store 的 ensureColors:planAutoColors 定色,setIfAbsent 进队列 */
  const seedColors = (paths: string[]): void => act((v) => ({ ...v, autoColors: planAutoColors(v, paths, true) ?? v.autoColors ?? {} }), true)
  return {
    mem, storage, sync, act, seedColors, migrate,
    vc: () => mem.get(R),
    tick: () => sync.tick(R),
    switchAccount: (a: string) => { acct = a },
    merged: () => JSON.parse(storage.data.get(MERGED_KEY) ?? '{}') as Record<string, true>,
    /** 已认领的挂起改动,按账号(每条一个键) */
    pending: () => {
      const out: Record<string, unknown[]> = {}
      for (const [k, v] of storage.data) {
        if (!k.startsWith(`${OP_PREFIX}`)) continue
        const r = JSON.parse(v) as { acct: string; u?: true }
        if (!r.u) (out[r.acct] ??= []).push(r)
      }
      return out
    },
  }
}
const ready = (o: Partial<VaultCfg> = {}): VaultCfg => vc({ migrated: true, autoColors: {}, ...o })

describe('加载闸:共享那份没读到时一个字都不写', () => {
  it('接口不存在(旧引擎 404 → unknown):不写、不记合过了、内存照旧;接口上线之后再合', async () => {
    const srv = fakeServer()
    srv.mode = 'absent'
    const d = device(srv, { local: ready({ colors: { 'a.db': '#111111' } }) })
    d.act((v) => ({ ...v, hidden: ['a.db'] }))
    await d.tick()
    await d.tick()
    expect(srv.puts).toEqual([])
    expect(d.merged()).toEqual({})
    expect(d.vc()?.hidden).toEqual(['a.db'])
    expect(d.vc()?.colors).toEqual({ 'a.db': '#111111' })
    srv.mode = 'ok'
    await d.tick()
    expect(srv.puts.length).toBe(1)
    expect(srv.shared().hidden).toEqual(['a.db'])
    expect(srv.shared().colors).toEqual({ 'a.db': '#111111' })
    expect(d.merged()).toEqual({ A: true })
  })
  it('坏了(corrupt):永不覆盖、不记合过了', async () => {
    const srv = fakeServer()
    srv.mode = 'corrupt'
    const d = device(srv, { local: ready({ hidden: ['x.db'] }) })
    d.act((v) => ({ ...v, colors: { 'x.db': '#222222' } }))
    for (let i = 0; i < 3; i++) await d.tick()
    expect(srv.puts).toEqual([])
    expect(d.merged()).toEqual({})
    expect(d.vc()?.colors).toEqual({ 'x.db': '#222222' })
  })
  it('写的时候对端变成坏了(409 带回 corrupt):停手', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready({ hidden: ['x.db'] }) })
    srv.beforeWrite.push(() => { srv.mode = 'corrupt' })
    await d.tick()
    expect(srv.puts.length).toBe(1)
    expect(d.merged()).toEqual({})
  })
  it('库键不知道 / 留本机:不读不写;留本机的改动丢出队列', async () => {
    const srv = fakeServer()
    let key: SettingsKey = { kind: 'unknown' }
    const d = device(srv, { key: () => key, local: ready() })
    d.act((v) => ({ ...v, hidden: ['a.db'] }))
    await d.tick()
    expect(srv.io.read).not.toHaveBeenCalled()
    key = { kind: 'local' }
    await d.tick()
    key = { kind: 'sync', acct: 'A' }
    await d.tick()
    expect(srv.shared().hidden).toEqual(['a.db']) // 第一次合并按本机这份带上去的,不是靠队列
    expect(d.pending()).toEqual({})
  })
  it('库键还不知道时的改动,算出是 sync 之后归到账号的队列(已合过的设备不被下一次重读冲掉)', async () => {
    const srv = fakeServer()
    let key: SettingsKey = { kind: 'sync', acct: 'A' }
    const d = device(srv, { key: () => key, local: ready({ hidden: ['a.db'] }) })
    await d.tick()
    expect(d.merged()).toEqual({ A: true })
    key = { kind: 'unknown' }
    await d.tick()
    d.act((v) => ({ ...v, hidden: [] }))
    key = { kind: 'sync', acct: 'A' }
    await d.tick()
    expect(srv.shared().hidden).toEqual([])
    expect(d.vc()?.hidden).toEqual([])
  })
})

describe('第一次合并', () => {
  it('规则:成员并集(同路径用共享的映射)、颜色 / 自动色只补、隐藏并集、缺省表共享优先、已迁移 / 已播种取或', async () => {
    const srv = fakeServer()
    const d1 = device(srv, { local: ready({
      members: { 'a.db': { dateCol: 'd1' }, 'b.db': { dateCol: 'd' } },
      colors: { 'a.db': '#aaaaaa' }, autoColors: { 'a.db': P[0], 'b.db': P[1] }, hidden: ['a.db'], defaultDbPath: 'a.db',
    }) })
    await d1.tick()
    const d2 = device(srv, { local: ready({
      members: { 'a.db': { dateCol: 'OTHER' }, 'c.db': { dateCol: 'd' } },
      colors: { 'a.db': '#bbbbbb', 'c.db': '#cccccc' }, autoColors: { 'a.db': P[5], 'c.db': P[2] }, hidden: ['c.db'], defaultDbPath: 'c.db',
    }) })
    await d2.tick()
    const s = srv.shared()
    expect(s.members).toEqual({ 'a.db': { dateCol: 'd1' }, 'b.db': { dateCol: 'd' }, 'c.db': { dateCol: 'd' } })
    expect(s.colors).toEqual({ 'a.db': '#aaaaaa', 'c.db': '#cccccc' })
    expect(s.autoColors).toEqual({ 'a.db': P[0], 'b.db': P[1], 'c.db': P[2] })
    expect([...s.hidden].sort()).toEqual(['a.db', 'c.db'])
    expect(s.defaultDbPath).toBe('a.db')
    expect(s.migrated).toBe(true)
    // 合并之后内存 = 合并结果(带账号标记,镜像据此回写)
    expect(d2.vc()).toEqual({ ...s, owner: 'A' })
  })
  it('缺省表:共享没有才用本机的', async () => {
    const srv = fakeServer()
    await device(srv, { local: ready() }).tick()
    const d2 = device(srv, { local: ready({ defaultDbPath: 'x.db' }) })
    await d2.tick()
    expect(srv.shared().defaultDbPath).toBe('x.db')
  })
  it('顺序:本机还没迁移 / 还没播种就先等,跑完再合', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: vc({ hidden: ['h.db'] }) })
    await d.tick()
    expect(srv.puts).toEqual([])
    expect(d.merged()).toEqual({})
    d.act((v) => ({ ...v, members: { ...v.members, 'old.db': { dateCol: 'd' } }, migrated: true }), true) // migrate
    await d.tick()
    expect(srv.puts).toEqual([]) // 还没播种
    d.seedColors(['old.db', 'human://CALENDAR.db'])
    await d.tick()
    expect(srv.puts.length).toBe(1)
    expect(srv.shared().members).toEqual({ 'old.db': { dateCol: 'd' } })
    expect(srv.shared().autoColors).toEqual({ 'old.db': P[0], 'human://CALENDAR.db': P[1] })
    expect(d.merged()).toEqual({ A: true })
  })
  it('本机什么都没有:不等迁移,直接合(共享那份原样到内存)', async () => {
    const srv = fakeServer()
    await device(srv, { local: ready({ members: { 'a.db': { dateCol: 'd' } } }) }).tick()
    const d = device(srv)
    await d.tick()
    expect(d.vc()?.members).toEqual({ 'a.db': { dateCol: 'd' } })
    expect(d.vc()?.migrated).toBe(true)
    expect(srv.puts.length).toBe(1) // 第二台没东西可补,不写
    expect(d.merged()).toEqual({ A: true })
  })
  it('「合过了」只在写成功之后记:不知道写没写进去 / 被拒 都不记,改动留着', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready({ hidden: ['a.db'] }) })
    d.act((v) => ({ ...v, colors: { 'a.db': '#121212' } }))
    srv.writeResult = { status: 'unknown' }
    await d.tick()
    expect(d.merged()).toEqual({})
    srv.writeResult = { status: 'rejected', error: 'HUMAN_SETTINGS_TOO_LARGE' }
    await d.tick()
    expect(d.merged()).toEqual({})
    expect(d.pending().A?.length).toBe(1)
    srv.writeResult = null
    const puts = srv.puts.length
    await d.tick()
    expect(srv.puts.length).toBe(puts) // 同一份内容对同一个基线被拒过:挂起内容 / 基线没变就不再撞
    d.act((v) => ({ ...v, colors: { 'a.db': '#121212', 'b.db': '#343434' } })) // 挂起内容变了:再写
    await d.tick()
    expect(d.merged()).toEqual({ A: true })
    expect(srv.shared().colors).toEqual({ 'a.db': '#121212', 'b.db': '#343434' })
    expect(d.pending()).toEqual({})
  })
  it('换账号:别的账号的本机那份不带进新账号;没带标记的老数据算当前账号的', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready({ hidden: ['legacy.db'] }) }) // 没有 owner
    await d.tick()
    expect(srv.shared().hidden).toEqual(['legacy.db'])
    expect(d.vc()?.owner).toBe('A')
    const srvB = fakeServer()
    const d2 = device(srvB, { acct: 'B', local: d.vc() }) // 同一台机器换成 B 登录:镜像带着 A 的标记
    await d2.tick()
    expect(srvB.puts).toEqual([])
    expect(srvB.doc).toBeNull()
    // B 那份确认没有、B 也没东西可补:不建文件、不记合过了(E),内存不拿「没有」去盖(还是 A 那份,标记照旧是 A)
    expect(d2.merged()).toEqual({})
    expect(d2.vc()?.owner).toBe('A')
    // B 有了第一个手势:写成之后才记合过了,内存换成 B 那份(A 的隐藏不带过去)
    d2.act((v) => ({ ...v, colors: { ...v.colors, 'b.db': '#0b0b0b' } }))
    await d2.tick()
    expect(srvB.shared().hidden).toEqual([])
    expect(srvB.shared().colors).toEqual({ 'b.db': '#0b0b0b' })
    expect(d2.merged()).toEqual({ B: true })
    expect(d2.vc()?.owner).toBe('B')
    expect(d2.vc()?.hidden).toEqual([])
  })
  it('同一个设备上换账号(运行中):上一个账号的投影不进新账号', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready({ hidden: ['mine.db'] }) })
    await d.tick()
    d.switchAccount('B')
    const before = srv.puts.length
    await d.tick()
    expect(srv.puts.length).toBe(before) // B 读到的是同一个假 server 上 A 的那份(现实里各账号各一份);B 这边没东西可补,不写
    expect(d.merged()).toEqual({ A: true, B: true })
  })
})

describe('挂起改动与 409 重放', () => {
  it('读写之间别人写了:409 → 用带回的那份重放再写,两边的改动都在', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready({ hidden: ['a.db'] }) })
    await d.tick()
    d.act((v) => ({ ...v, colors: { ...v.colors, 'mine.db': '#010101' } }))
    srv.beforeWrite.push(() => { srv.doc = { ...srv.doc!, rows: [...srv.doc!.rows, { id: rowIdOf('sync|color|theirs.db'), cells: { k: 'sync|color|theirs.db', v: '#020202' } }] }; srv.ver++ })
    await d.tick()
    expect(srv.shared().colors).toEqual({ 'mine.db': '#010101', 'theirs.db': '#020202' })
    expect(d.vc()?.colors).toEqual({ 'mine.db': '#010101', 'theirs.db': '#020202' })
    expect(d.pending()).toEqual({})
  })
  it('连续两次 409 仍能写成', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready() })
    await d.tick()
    d.act((v) => ({ ...v, hidden: ['z.db'] }))
    const bump = (): void => { srv.ver++ }
    srv.beforeWrite.push(bump, bump)
    await d.tick()
    expect(srv.shared().hidden).toEqual(['z.db'])
    expect(srv.puts.length).toBe(1 + 3)
  })
  it('一直撞(超过重试上限):停手,改动留在队列里,下次再写', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready() })
    await d.tick()
    d.act((v) => ({ ...v, hidden: ['z.db'] }))
    const bump = (): void => { srv.ver++ }
    srv.beforeWrite.push(bump, bump, bump, bump, bump, bump)
    await d.tick()
    expect(srv.shared().hidden).toEqual([])
    expect(d.pending().A?.length).toBe(1)
    expect(d.vc()?.hidden).toEqual(['z.db']) // 界面上照旧是用户改过的
    srv.beforeWrite.length = 0
    await d.tick()
    expect(srv.shared().hidden).toEqual(['z.db'])
    expect(d.pending()).toEqual({})
  })
  it('改动跨重启留着(队列在 localStorage):重开后先重放再投影,不被共享那份盖回', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready() })
    await d.tick()
    srv.mode = 'down'
    d.act((v) => ({ ...v, hidden: ['late.db'] }))
    await d.tick()
    // 「重启」:同一份 localStorage、新的内存与实例
    const d2 = device(srv, { local: d.vc() })
    for (const [k, v] of d.storage.data) d2.storage.data.set(k, v)
    srv.mode = 'ok'
    await d2.tick()
    expect(srv.shared().hidden).toEqual(['late.db'])
    expect(d2.vc()?.hidden).toEqual(['late.db'])
  })
  it('认不出的行在写回时原样保留', async () => {
    const srv = fakeServer()
    srv.doc = { ...emptySettingsDoc(), rows: [{ id: 'x', cells: { k: 'future|thing|a', v: '1' } }] }
    srv.ver = 1
    const d = device(srv, { local: ready({ hidden: ['a.db'] }) })
    await d.tick()
    expect(srv.doc!.rows.find((r) => r.id === 'x')).toEqual({ id: 'x', cells: { k: 'future|thing|a', v: '1' } })
  })
})

describe('之后:共享那份是真源', () => {
  it('第二台不会把第一台后来改的值盖回去', async () => {
    const srv = fakeServer()
    const d1 = device(srv, { local: ready({ colors: { 'a.db': '#000001' } }) })
    await d1.tick()
    const d2 = device(srv, { local: ready({ colors: { 'a.db': '#000002' } }) })
    await d2.tick()
    expect(d2.vc()?.colors['a.db']).toBe('#000001') // 先同步上去的说了算
    d1.act((v) => ({ ...v, colors: { 'a.db': '#000003' } }))
    await d1.tick()
    const puts = srv.puts.length
    await d2.tick()
    await d2.tick()
    expect(srv.puts.length).toBe(puts) // 第二台没改什么:不写
    expect(srv.shared().colors['a.db']).toBe('#000003')
    expect(d2.vc()?.colors['a.db']).toBe('#000003')
  })
  it('本机独有的(otherside: / ics://)重投时不丢,也不进共享文件', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready({ colors: { 'ics://1': '#0000aa', 'a.db': '#0000bb' }, hidden: ['otherside:/X/b.db'] }) })
    await d.tick()
    await d.tick()
    expect(d.vc()?.colors).toEqual({ 'a.db': '#0000bb', 'ics://1': '#0000aa' })
    expect(d.vc()?.hidden).toEqual(['otherside:/X/b.db'])
    expect(JSON.stringify(srv.doc)).not.toMatch(/ics:|otherside:/)
  })
  it('两台同时播种:颜色不来回跳,收敛到同一套,写的次数有界', async () => {
    const srv = fakeServer()
    const d1 = device(srv)
    const d2 = device(srv)
    await d1.tick()
    await d2.tick() // 两台都还没东西:共享那份确认没有,谁也不建空文件、不记合过了
    expect(d1.vc()?.autoColors).toBeUndefined()
    d1.seedColors(['a.db', 'b.db', 'c.db'])
    d2.seedColors(['c.db', 'b.db', 'a.db']) // 另一台的顺序不一样
    const seen: string[] = []
    for (let i = 0; i < 6; i++) {
      await d1.tick()
      await d2.tick()
      seen.push(JSON.stringify(d2.vc()?.autoColors))
      // 照 store:内存一变就再跑一次定色看守(已有色的不动)
      if (planAutoColors(d1.vc(), ['a.db', 'b.db', 'c.db'], true)) d1.seedColors(['a.db', 'b.db', 'c.db'])
      if (planAutoColors(d2.vc(), ['c.db', 'b.db', 'a.db'], true)) d2.seedColors(['c.db', 'b.db', 'a.db'])
    }
    expect(d1.vc()?.autoColors).toEqual(d2.vc()?.autoColors)
    expect(d1.vc()?.autoColors).toEqual({ 'a.db': P[0], 'b.db': P[1], 'c.db': P[2] }) // 先写上去的那台
    expect(new Set(seen.slice(1)).size).toBe(1) // 换过一次之后再没变
    expect(srv.puts.length).toBeLessThanOrEqual(4)
  })
  it('别的窗口写了镜像:随账号走的库不拿镜像的旧值盖内存,只叠本机独有项', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready({ colors: { 'a.db': '#old000' } }) })
    await d.tick()
    srv.doc = { ...srv.doc!, rows: srv.doc!.rows.map((r) => (r.cells.k === 'sync|color|a.db' ? { ...r, cells: { ...r.cells, v: '#new000' } } : r)) }
    srv.ver++
    await d.tick()
    expect(d.vc()?.colors['a.db']).toBe('#new000')
    const staleMirror = ready({ colors: { 'a.db': '#old000', 'ics://9': '#icsics' } })
    d.sync.onMirrorChanged(R, staleMirror)
    expect(d.vc()?.colors).toEqual({ 'a.db': '#new000', 'ics://9': '#icsics' })
  })
})

describe('读失败 ≠ 空(评审补)', () => {
  it('合过之后共享那份不见了(missing):不拿空的盖内存,用本账号的镜像按只补重建', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready({ hidden: ['a.db'], colors: { 'a.db': '#0a0a0a' } }) })
    await d.tick()
    srv.doc = null // 引擎换了家目录 / 文件被隔离
    await d.tick()
    expect(d.vc()?.hidden).toEqual(['a.db'])
    expect(d.vc()?.colors).toEqual({ 'a.db': '#0a0a0a' })
    expect(srv.shared().hidden).toEqual(['a.db'])
  })
  it('本机镜像启动时读不出来:不做第一次合并、不记合过了', async () => {
    const srv = fakeServer()
    let trusted = false
    const d = device(srv, { local: ready({ hidden: ['a.db'] }), trusted: () => trusted })
    await d.tick()
    expect(srv.puts).toEqual([])
    expect(d.merged()).toEqual({})
    trusted = true
    await d.tick()
    expect(d.merged()).toEqual({ A: true })
  })
  it('缓存的库键还是上一个账号:改动不进上一个账号的队列,算出新账号后归到新账号', async () => {
    const srvA = fakeServer()
    let login: string | null = 'A'
    let key: SettingsKey = { kind: 'sync', acct: 'A' }
    const d = device(srvA, { local: ready(), key: () => key, loginAcct: () => login })
    await d.tick()
    login = 'B' // 换号了,但这个库的键还没重算
    d.act((v) => ({ ...v, hidden: ['b-only.db'] }))
    expect(d.pending().A).toBeUndefined()
    key = { kind: 'sync', acct: 'B' }
    await d.tick()
    expect(d.pending().A).toBeUndefined()
    expect(srvA.shared().hidden).toEqual(['b-only.db']) // 假 server 只有一份;要点是它进的是 B 的队列(A 的队列始终是空的)
  })
  it('新设备:不管日历先打开(迁移先跑)还是共享先读到,迁移推断的成员都不并进共享', async () => {
    for (const order of ['migrate-first', 'shared-first'] as const) {
      const srv = fakeServer()
      await device(srv, { local: ready({ members: { 'kept.db': { dateCol: 'd' } } }) }).tick() // 第一台(删过 implicit.db)
      const d = device(srv) // 本机没有这个库的设置
      if (order === 'migrate-first') d.migrate(['implicit.db'])
      await d.tick()
      if (order === 'shared-first') { d.migrate(['implicit.db']); await d.tick() }
      expect(Object.keys(srv.shared().members)).toEqual(['kept.db'])
      expect(Object.keys(d.vc()?.members ?? {})).toEqual(['kept.db'])
    }
  })
})

// ── 评审返修(第二轮):每条按评审描述的场景原样复现 ──

/** 照这个账号路由到各自那份文件的 io(同一个 io,登录换了就打到另一份)。 */
function routed(byAcct: Record<string, Srv>, login: () => string | null): SettingsTransport {
  const cur = (): Srv => byAcct[login() ?? ''] ?? byAcct.A
  return { read: () => cur().io.read(), write: (d, v) => cur().io.write(d, v) }
}
/** 读的时候先拍下当时那份,放行之后才返回(慢 GET)。 */
function slowRead(srv: Srv): { io: SettingsTransport; started: Promise<void>; release: () => void } {
  const gate = deferred()
  const begun = deferred()
  return {
    io: {
      read: async () => { const snap = srv.mode === 'ok' ? srv.now() : ({ status: 'unknown' } as SettingsRead); begun.resolve(); await gate.p; return snap },
      write: (d, v) => srv.io.write(d, v),
    },
    started: begun.p,
    release: () => gate.resolve(),
  }
}

describe('A. 一轮绑定账号 + 库键 + 代次', () => {
  it('第 1 条:A 的 GET 回 missing 时已换到 B → 不写(不拿 A 的东西写进 B 那份)、不记合过了、不改内存', async () => {
    const srvA = fakeServer()
    const srvB = fakeServer()
    let login: string | null = 'A'
    const slow = slowRead(srvA)
    const io: SettingsTransport = { read: () => (login === 'A' ? slow.io.read() : srvB.io.read()), write: (d, v) => (login === 'A' ? srvA : srvB).io.write(d, v) }
    const d = device(srvA, { io, loginAcct: () => login, key: () => ({ kind: 'sync', acct: login ?? 'A' }), local: ready({ hidden: ['a-secret.db'] }) })
    const p = d.tick()
    await slow.started
    login = 'B'
    slow.release()
    await p
    expect(srvA.puts).toEqual([])
    expect(srvB.puts).toEqual([])
    expect(d.merged()).toEqual({})
  })
  it('第 2 条:库键未知时 A 改的,换到 B 后算出 B 的同步库 → 不归 B(镜像带 A 标记 / 没标记 两种)', async () => {
    for (const owner of ['A', undefined]) {
      const srvA = fakeServer()
      const srvB = fakeServer()
      let login: string | null = 'A'
      let key: SettingsKey = { kind: 'unknown' }
      const d = device(srvA, { io: routed({ A: srvA, B: srvB }, () => login), loginAcct: () => login, key: () => key, local: ready({ ...(owner ? { owner } : {}) }) })
      d.act((v) => ({ ...v, hidden: ['a-only.db'] }))
      await d.tick()
      login = 'B'
      key = { kind: 'sync', acct: 'B' }
      await d.tick()
      await d.tick()
      expect(srvB.puts.map((x) => JSON.stringify(x.data))).not.toContainEqual(expect.stringContaining('a-only.db'))
      expect(srvB.shared().hidden).toEqual([])
    }
  })
  it('第 3 条:A 第一次读失败期间改的设置,换到 B 后不被当成「升级前的老数据」合进 B', async () => {
    const srvA = fakeServer()
    srvA.mode = 'down'
    const srvB = fakeServer()
    let login: string | null = 'A'
    const d = device(srvA, { io: routed({ A: srvA, B: srvB }, () => login), loginAcct: () => login, key: () => ({ kind: 'sync', acct: login ?? 'A' }), local: ready({ hidden: ['legacy.db'] }) })
    await d.tick() // A 的库键算出来了,读失败
    expect(d.vc()?.owner).toBe('A') // 账号一确定就打上
    d.act((v) => ({ ...v, colors: { 'a-made.db': '#a0a0a0' } }))
    login = 'B'
    await d.tick()
    d.act((v) => ({ ...v, colors: { ...v.colors, 'b-made.db': '#b0b0b0' } }))
    await d.tick()
    const b = srvB.shared()
    expect(b.colors['a-made.db']).toBeUndefined()
    expect(b.hidden).not.toContain('legacy.db')
    expect(b.colors['b-made.db']).toBe('#b0b0b0')
    expect(d.pending().A?.length).toBe(1) // A 的改动还在 A 名下
  })
})

describe('B. 多窗口之间不丢、不互盖', () => {
  it('第 4 条:两个窗口同时追加 / 一边 ack 一边追加,两边的改动都到共享文件', async () => {
    const srv = fakeServer()
    const storage = memStorage()
    const mirror = new Map<string, VaultCfg>()
    const lock = mutex()
    const w1 = device(srv, { storage, mirror, lock, local: ready() })
    await w1.tick()
    const w2 = device(srv, { storage, mirror, lock, local: w1.vc() })
    await w2.tick()
    // 追加:w1 读队列的时候 w2 插进来追加
    let once = true
    storage.onAccess = (k) => {
      if (!once || !(k === '*' || k.startsWith('amadeus.calendar.cfg.'))) return
      once = false
      w2.act((v) => ({ ...v, colors: { ...v.colors, 'two.db': '#222222' } }))
    }
    w1.act((v) => ({ ...v, colors: { ...v.colors, 'one.db': '#111111' } }))
    storage.onAccess = null
    // ack:w1 写成、删自己那条的时候 w2 又追加了一条
    const write = srv.io.write
    srv.io.write = async (d, v) => {
      const res = await write(d, v)
      let armed = true
      storage.onAccess = (k) => {
        if (!armed || !(k === '*' || k.startsWith('amadeus.calendar.cfg.'))) return
        armed = false
        storage.onAccess = null
        w2.act((x) => ({ ...x, hidden: ['three.db'] }))
      }
      return res
    }
    await w1.tick()
    srv.io.write = write
    storage.onAccess = null
    await w2.tick()
    await w1.tick()
    const s = srv.shared()
    expect(s.colors).toMatchObject({ 'one.db': '#111111', 'two.db': '#222222' })
    expect(s.hidden).toEqual(['three.db'])
  })
  for (const [label, mk] of [['共享一把锁(Web Locks)', () => mutex()], ['没有 Web Locks:进程内互斥', () => null]] as const) {
    it(`第 8 条:两个窗口同时做第一次合并,先合完的那个随后取消了隐藏,迟到的 PUT 不把隐藏带回来 —— ${label}`, async () => {
      const srv = fakeServer()
      const storage = memStorage()
      const mirror = new Map<string, VaultCfg>()
      const lock = mk()
      const gate = deferred()
      const lateIo: SettingsTransport = { read: () => srv.io.read(), write: async (d, v) => { await gate.p; return srv.io.write(d, v) } }
      const w2 = device(srv, { storage, mirror, lock, io: lateIo, local: ready({ hidden: ['x.db'] }) })
      const w1 = device(srv, { storage, mirror, lock, local: ready({ hidden: ['x.db'] }) })
      const p2 = w2.tick()
      await flush()
      const p1 = w1.tick()
      await flush()
      w1.act((v) => ({ ...v, hidden: [] }))
      const p1b = w1.tick()
      await flush()
      gate.resolve()
      await Promise.all([p1, p1b, p2])
      await w1.tick()
      await w2.tick()
      expect(srv.shared().hidden).toEqual([])
      expect(w1.vc()?.hidden).toEqual([])
      expect(w2.vc()?.hidden).toEqual([])
    })
  }
  const blueRed = async (lockOf: () => SettingsLock) => {
    const srv = fakeServer()
    const storage = memStorage()
    const mirror = new Map<string, VaultCfg>()
    const slow = slowRead(srv)
    const lockA = lockOf()
    const lockB = lockOf === mutex ? lockA : lockOf()
    const wa = device(srv, { storage, mirror, lock: lockA, io: { read: () => srv.io.read(), write: (d, v) => srv.io.write(d, v) }, local: ready({ colors: { 'a.db': '#ff0000' } }) })
    await wa.tick() // 合过,共享 = 红
    const wb = device(srv, { storage, mirror, lock: lockB, local: wa.vc() })
    await wb.tick()
    // A 起一次慢 GET(读到红);用户在 A 里改成蓝(进共用的队列),B 把这条写进去并 ack
    const wa2 = device(srv, { storage, mirror, lock: lockA, io: slow.io, local: wa.vc() })
    const pa = wa2.tick()
    await slow.started
    wa2.act((v) => ({ ...v, colors: { 'a.db': '#0000ff' } }))
    const pb = wb.tick()
    await flush()
    slow.release()
    await Promise.all([pa, pb])
    return { srv, mirror, wa2 }
  }
  it('第 10 条(共享锁):A 迟到的 GET(红)不在 B 写了蓝并 ack 之后投影到 A 的内存和镜像', async () => {
    const { srv, mirror, wa2 } = await blueRed(mutex)
    expect(srv.shared().colors['a.db']).toBe('#0000ff')
    expect(wa2.vc()?.colors['a.db']).toBe('#0000ff')
    expect(mirror.get(R)?.colors['a.db']).toBe('#0000ff')
  })
  it('第 10 条(两个窗口之间没有锁):靠「本机最后写成」标记,A 发现 B 写过就丢掉这次读', async () => {
    const { srv, mirror, wa2 } = await blueRed(() => noLock)
    expect(srv.shared().colors['a.db']).toBe('#0000ff')
    expect(mirror.get(R)?.colors['a.db']).toBe('#0000ff')
    expect(wa2.vc()?.colors['a.db']).toBe('#0000ff') // 这次过时的读被丢掉了,没把红投影到 A 的内存(下一轮重读)
    await wa2.tick()
    expect(wa2.vc()?.colors['a.db']).toBe('#0000ff')
  })
  it('navigator.locks 在的时候用它,按账号一把锁', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb())
    vi.stubGlobal('navigator', { locks: { request } })
    try {
      const srv = fakeServer()
      const d = device(srv, { lock: 'default', local: ready({ hidden: ['a.db'] }) })
      await d.tick()
      expect(request).toHaveBeenCalledWith('amadeus.calendar.cfg.sync.A', expect.any(Function))
      expect(srv.shared().hidden).toEqual(['a.db'])
    } finally { vi.unstubAllGlobals() }
  })
  it('没有 navigator.locks:退回进程内互斥,照常合并', async () => {
    const srv = fakeServer()
    const d = device(srv, { lock: 'default', local: ready({ hidden: ['a.db'] }) })
    await d.tick()
    expect(srv.shared().hidden).toEqual(['a.db'])
    expect(d.merged()).toEqual({ A: true })
  })
  it('旧的整份队列:迁成单条记录重放,迁完删掉旧键', async () => {
    const srv = fakeServer()
    await device(srv, { local: ready() }).tick()
    const storage = memStorage()
    storage.data.set(MERGED_KEY, JSON.stringify({ A: true }))
    storage.data.set(PENDING_KEY, JSON.stringify({ acct: { A: [{ id: 'old1', t: 'set', k: 'sync|hidden|q.db', v: 'true' }] } }))
    const d = device(srv, { storage, local: ready({ owner: 'A' }) })
    await d.tick()
    expect(srv.shared().hidden).toEqual(['q.db'])
    expect(storage.data.has(PENDING_KEY)).toBe(false)
    expect(d.pending()).toEqual({})
  })
})

describe('C. 改动的持久性', () => {
  it('第 5 条:合过的设备,启动时库键还不知道就把红改成蓝、随即重启 → 蓝不丢、不被共享的红盖回', async () => {
    const srv = fakeServer()
    const d1 = device(srv, { local: ready({ colors: { 'a.db': '#ff0000' } }) })
    await d1.tick()
    let key: SettingsKey = { kind: 'unknown' }
    const d2 = device(srv, { storage: d1.storage, key: () => key, local: d1.vc() })
    await d2.tick()
    d2.act((v) => ({ ...v, colors: { 'a.db': '#0000ff' } }))
    // 重启:同一份 localStorage、镜像是蓝
    key = { kind: 'sync', acct: 'A' }
    const d3 = device(srv, { storage: d1.storage, key: () => key, local: d2.vc() })
    await d3.tick()
    expect(srv.shared().colors['a.db']).toBe('#0000ff')
    expect(d3.vc()?.colors['a.db']).toBe('#0000ff')
  })
  it('第 7 条:挂起改动写不进 localStorage(配额满)→ 留在内存覆盖层照样重放,不被共享的旧值投影盖掉', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready({ colors: { 'a.db': '#ff0000' } }) })
    await d.tick()
    d.storage.failSet = (k) => k.startsWith('amadeus.calendar.cfg.op.') || k === PENDING_KEY
    srv.mode = 'down'
    d.act((v) => ({ ...v, colors: { 'a.db': '#0000ff' } }))
    await d.tick()
    expect(d.vc()?.colors['a.db']).toBe('#0000ff')
    srv.mode = 'ok'
    await d.tick()
    expect(d.vc()?.colors['a.db']).toBe('#0000ff')
    expect(srv.shared().colors['a.db']).toBe('#0000ff')
  })
})

describe('D. 同一个账号「留本机 → 又变回同步库」', () => {
  it('第 6 条:合过后关同步(留本机)把红改成蓝,再打开同步 → 蓝重放进共享,不被红盖回', async () => {
    const srv = fakeServer()
    let key: SettingsKey = { kind: 'sync', acct: 'A' }
    const d = device(srv, { key: () => key, local: ready({ colors: { 'a.db': '#ff0000' } }) })
    await d.tick()
    key = { kind: 'local' }
    await d.tick()
    d.act((v) => ({ ...v, colors: { 'a.db': '#0000ff' } }))
    key = { kind: 'sync', acct: 'A' }
    await d.tick()
    expect(srv.shared().colors['a.db']).toBe('#0000ff')
    expect(d.vc()?.colors['a.db']).toBe('#0000ff')
  })
  it('回来的是别的账号:留本机期间的改动不写进它那份;那个账号认领这个库后丢掉', async () => {
    const srvA = fakeServer()
    const srvB = fakeServer()
    let login: string | null = 'A'
    let key: SettingsKey = { kind: 'sync', acct: 'A' }
    const d = device(srvA, { io: routed({ A: srvA, B: srvB }, () => login), loginAcct: () => login, key: () => key, local: ready({ colors: { 'a.db': '#ff0000' } }) })
    await d.tick()
    key = { kind: 'local' }
    await d.tick()
    d.act((v) => ({ ...v, colors: { 'a.db': '#0000ff' } }))
    expect(d.pending().A?.length).toBe(1)
    login = 'B'
    key = { kind: 'sync', acct: 'B' }
    await d.tick()
    d.act((v) => ({ ...v, hidden: ['b.db'] }))
    await d.tick()
    expect(srvB.shared().colors['a.db']).toBeUndefined()
    expect(srvA.shared().colors['a.db']).toBe('#ff0000')
    expect(d.pending().A).toBeUndefined() // B 认领了这个库:A 留本机期间那条丢掉
  })
  it('从没合过的库留本机:改动一个键都不多写', async () => {
    const srv = fakeServer()
    const d = device(srv, { key: () => ({ kind: 'local' }), local: ready({ owner: 'A' }) })
    await d.tick()
    d.act((v) => ({ ...v, colors: { 'a.db': '#0000ff' } }))
    await d.tick()
    expect([...d.storage.data.keys()]).toEqual([])
    expect(srv.io.read).not.toHaveBeenCalled()
  })
})

describe('E. 「合过了」只在真的写成 / 读到之后记', () => {
  it('第 9 条:全新设备读到 missing、没东西可补 → 不建文件、不记合过了;第一次真写成之后才记', async () => {
    const srv = fakeServer()
    const d = device(srv)
    await d.tick()
    expect(srv.puts).toEqual([])
    expect(d.merged()).toEqual({})
    d.act((v) => ({ ...v, hidden: ['n.db'] }))
    await d.tick()
    expect(srv.shared().hidden).toEqual(['n.db'])
    expect(d.merged()).toEqual({ A: true })
  })
})

describe('F. 轮询与重试', () => {
  afterEach(() => { vi.useRealTimers() })
  it('第 12 条:轮中再来的触发并成一次尾随,不排队堆积', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready() })
    await d.tick()
    const slow = slowRead(srv)
    const d2 = device(srv, { io: slow.io, storage: d.storage, local: d.vc() })
    const read = vi.spyOn(slow.io, 'read')
    const all = Promise.all([d2.tick(), d2.tick(), d2.tick(), d2.tick(), d2.tick()])
    await slow.started
    slow.release()
    await all
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('第 12 条:慢请求 + 轮询不积压;最后一个视图卸载后纯轮询的尾随取消、定时器清零', async () => {
    vi.useFakeTimers()
    const srv = fakeServer()
    const reads: number[] = []
    const io: SettingsTransport = {
      read: () => { reads.push(Date.now()); return new Promise((r) => setTimeout(() => r(srv.now()), 15_000)) },
      write: (d, v) => srv.io.write(d, v),
    }
    const d = device(srv, { io, local: ready() })
    const release = d.sync.acquire(() => R)
    await vi.advanceTimersByTimeAsync(120_000)
    const during = reads.length
    expect(during).toBeLessThanOrEqual(5) // 每轮 15 秒读 + 至少 15 秒间隔
    release()
    const at = reads.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads.length - at).toBeLessThanOrEqual(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('第 11 条:HUMAN_SETTINGS_TOO_LARGE 被拒后,挂起内容和共享基线都没变就不再重试', async () => {
    const srv = fakeServer()
    const d = device(srv, { local: ready() })
    await d.tick()
    d.act((v) => ({ ...v, hidden: ['big.db'] }))
    srv.writeResult = { status: 'rejected', error: 'HUMAN_SETTINGS_TOO_LARGE' }
    await d.tick()
    const puts = srv.puts.length
    for (let i = 0; i < 4; i++) await d.tick()
    expect(srv.puts.length).toBe(puts)
    srv.writeResult = null
    srv.doc = { ...srv.doc!, rows: [...srv.doc!.rows, { id: rowIdOf('sync|color|o.db'), cells: { k: 'sync|color|o.db', v: '#0f0f0f' } }] }
    srv.ver++ // 共享基线变了:再试一次
    await d.tick()
    expect(srv.shared().hidden).toEqual(['big.db'])
  })
  it('接口不存在(连续 unknown):重读间隔逐级拉长(15s → 30s → 2min → 5min 封顶),读到一次有效回答后恢复', async () => {
    vi.useFakeTimers()
    const srv = fakeServer()
    srv.mode = 'absent'
    const d = device(srv, { local: ready() })
    const read = srv.io.read as ReturnType<typeof vi.fn>
    const release = d.sync.acquire(() => R)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(read.mock.calls.length).toBeLessThanOrEqual(6) // 0, 15s, 45s, 165s, 465s
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(4)
    srv.mode = 'ok'
    await vi.advanceTimersByTimeAsync(300_000) // 下一次读到了
    const n = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read.mock.calls.length - n).toBeGreaterThanOrEqual(3) // 恢复到 15 秒一次
    release()
  })
  it('远端(网页 / 手机打 server):常规重读不低于 60 秒;本机引擎不低于 15 秒', async () => {
    vi.useFakeTimers()
    for (const [remote, max] of [[true, 6], [false, 21]] as const) {
      const srv = fakeServer()
      const d = device(srv, { local: ready(), remote: () => remote })
      const read = srv.io.read as ReturnType<typeof vi.fn>
      const release = d.sync.acquire(() => R)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(read.mock.calls.length).toBeLessThanOrEqual(max)
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(max - 1)
      release()
    }
  })
})

describe('返修后的 Codex 复核', () => {
  it('挂起改动列不出来:不拿共享的旧值投影盖掉用户刚改的', async () => {
    const srv = fakeServer()
    let deny = false
    const io: SettingsTransport = { read: async () => { const r = await srv.io.read(); deny = true; return r }, write: (x, v) => srv.io.write(x, v) }
    const d = device(srv, { io, local: ready({ colors: { 'a.db': '#ff0000' } }) })
    await d.tick()
    deny = false
    d.act((v) => ({ ...v, colors: { 'a.db': '#0000ff' } }))
    const keys = d.storage.keys
    d.storage.keys = () => { if (deny) throw new Error('denied'); return keys() } // GET 之后才列不出来
    await d.tick()
    d.storage.keys = keys
    expect(d.vc()?.colors['a.db']).toBe('#0000ff')
    expect(srv.shared().colors['a.db']).toBe('#ff0000')
  })
  it('换到 B 时 A 还没认领的改动不丢:B 读失败没投影,回到 A 照样重放', async () => {
    const srvA = fakeServer()
    const srvB = fakeServer()
    srvB.mode = 'down'
    let login: string | null = 'A'
    let key: SettingsKey = { kind: 'sync', acct: 'A' }
    const d = device(srvA, { io: routed({ A: srvA, B: srvB }, () => login), loginAcct: () => login, key: () => key, local: ready({ colors: { 'a.db': '#ff0000' } }) })
    await d.tick()
    key = { kind: 'unknown' }
    await d.tick()
    d.act((v) => ({ ...v, colors: { 'a.db': '#0000ff' } }))
    login = 'B'; key = { kind: 'sync', acct: 'B' }
    await d.tick()
    login = 'A'; key = { kind: 'sync', acct: 'A' }
    await d.tick()
    expect(srvA.shared().colors['a.db']).toBe('#0000ff')
    expect(srvB.puts).toEqual([])
  })
  it('旧队列没迁完(有一条写不进新键):这一程不写共享那份', async () => {
    const srv = fakeServer()
    await device(srv, { local: ready() }).tick()
    const storage = memStorage()
    storage.data.set(MERGED_KEY, JSON.stringify({ A: true }))
    storage.data.set(PENDING_KEY, JSON.stringify({ acct: { A: [{ id: 'ok1', t: 'set', k: 'sync|hidden|q.db', v: 'true' }, { id: 'bad', t: 'set', k: 'sync|hidden|r.db', v: 'true' }] } }))
    storage.failSet = (k) => k.endsWith('.legacy-bad')
    const puts = srv.puts.length
    const d = device(srv, { storage, local: ready({ owner: 'A' }) })
    await d.tick()
    expect(srv.puts.length).toBe(puts)
    expect(storage.data.has(PENDING_KEY)).toBe(true)
  })
  it('读的时候关了同步(库键变成留本机):这一轮不写', async () => {
    const srv = fakeServer()
    let key: SettingsKey = { kind: 'sync', acct: 'A' }
    const d0 = device(srv, { local: ready() })
    await d0.tick()
    const slow = slowRead(srv)
    const d = device(srv, { io: slow.io, storage: d0.storage, key: () => key, local: d0.vc() })
    d.act((v) => ({ ...v, hidden: ['x.db'] }))
    const p = d.tick()
    await slow.started
    key = { kind: 'local' }
    slow.release()
    await p
    expect(srv.shared().hidden).toEqual([])
  })
  it('没主的镜像、库键一直不知道:同一项反复改不堆积', () => {
    const srv = fakeServer()
    const d = device(srv, { key: () => ({ kind: 'unknown' }), local: ready() })
    for (let i = 0; i < 50; i++) d.act((v) => ({ ...v, colors: { 'a.db': `#0000${(i % 100).toString().padStart(2, '0')}` } }))
    expect(d.sync.debugState(R).limbo).toBe(1)
  })
})
