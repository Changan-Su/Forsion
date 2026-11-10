/** 共享那半的状态机:假 server(带票据的比对交换写)× 两台「设备」(各自一份内存 + 一份 localStorage)。
 *  设备的写动作按 store 的口径:同步改内存,再把前后差交给 record。 */
import { describe, expect, it, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
import { createCalendarSettingsSync, MERGED_KEY, PENDING_KEY, type SettingsKey, type SettingsStorage } from './calendarSettingsSync'
import { diffVaultCfg, docToVaultCfg, emptySettingsDoc, rowIdOf, type VaultCfg } from './calendarSettingsDoc'
import type { SettingsRead, SettingsTransport, SettingsWrite } from './calendarSettingsIo'
import { planAutoColors, EVENT_PALETTE as P } from './calendarConfigStore'

const R = '/Users/me/Vault'
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const vc = (o: Partial<VaultCfg> = {}): VaultCfg => ({ colors: {}, hidden: [], defaultDbPath: null, members: {}, ...o })

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
  return Object.assign(s, { io, shared: (): VaultCfg => docToVaultCfg(s.doc ?? emptySettingsDoc()) })
}

function memStorage(): SettingsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}

function device(server: ReturnType<typeof fakeServer>, opts: { acct?: string; key?: () => SettingsKey; local?: VaultCfg } = {}) {
  const mem = new Map<string, VaultCfg>()
  if (opts.local) mem.set(R, clone(opts.local))
  const storage = memStorage()
  let acct = opts.acct ?? 'A'
  const sync = createCalendarSettingsSync({
    io: server.io,
    storage,
    resolveKey: async () => (opts.key ? opts.key() : { kind: 'sync', acct }),
    getVc: (r) => mem.get(r),
    applyVc: (r, v) => { mem.set(r, v) },
    schedule: () => {},
  })
  const act = (fn: (v: VaultCfg) => VaultCfg, auto = false): void => {
    const prev = mem.get(R)
    const next = fn(clone(prev ?? vc()))
    mem.set(R, next)
    sync.record(R, diffVaultCfg(prev, next, auto))
  }
  /** 照 store 的 ensureColors:planAutoColors 定色,setIfAbsent 进队列 */
  const seedColors = (paths: string[]): void => act((v) => ({ ...v, autoColors: planAutoColors(v, paths, true) ?? v.autoColors ?? {} }), true)
  return {
    mem, storage, sync, act, seedColors,
    vc: () => mem.get(R),
    tick: () => sync.tick(R),
    switchAccount: (a: string) => { acct = a },
    merged: () => JSON.parse(storage.data.get(MERGED_KEY) ?? '{}') as Record<string, true>,
    pending: () => (JSON.parse(storage.data.get(PENDING_KEY) ?? '{"acct":{}}') as { acct: Record<string, unknown[]> }).acct,
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
    await d.tick()
    expect(d.merged()).toEqual({ A: true })
    expect(srv.shared().colors).toEqual({ 'a.db': '#121212' })
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
    expect(d2.vc()?.hidden).toEqual([])
    expect(d2.vc()?.owner).toBe('B')
    expect(d2.merged()).toEqual({ B: true })
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
    await d2.tick() // 两台都合过了(都没东西),共享里还没播种
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
