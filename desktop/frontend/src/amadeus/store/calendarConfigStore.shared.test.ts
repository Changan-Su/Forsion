/** store 接上共享那半之后:各个写入点在加载闸下不写共享文件、读到之后才合;留本机的库和以前一样一个请求都不发。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
import type { SettingsRead, SettingsWrite } from './calendarSettingsIo'
import type { SettingsKey } from './calendarSettingsSync'

const V = '/Users/me/Vault'
const KEY = 'amadeus.calendar.cfg'
const srv = {
  doc: null as DbFile | null,
  ver: 0,
  mode: 'absent' as 'ok' | 'absent',
  key: { kind: 'sync', acct: 'A' } as SettingsKey,
}
const read = vi.fn(async (): Promise<SettingsRead> => {
  if (srv.mode !== 'ok') return { status: 'unknown' } // 旧引擎:这条接口 404
  return srv.doc ? { status: 'ok', data: JSON.parse(JSON.stringify(srv.doc)), version: `v${srv.ver}` } : { status: 'missing' }
})
const write = vi.fn(async (data: DbFile, version: string | null): Promise<SettingsWrite> => {
  if (srv.mode !== 'ok') return { status: 'unknown' }
  if (version !== (srv.doc ? `v${srv.ver}` : null)) return { status: 'conflict', current: await read() }
  srv.doc = JSON.parse(JSON.stringify(data))
  srv.ver++
  return { status: 'ok', version: `v${srv.ver}` }
})
const resolveKey = vi.fn(async (): Promise<SettingsKey> => srv.key)
vi.mock('./calendarSettingsIo', () => ({ engineSettingsTransport: { read: () => read(), write: (d: DbFile, v: string | null) => write(d, v) } }))
vi.mock('./calendarSettingsKey', () => ({ resolveCalendarSettingsKey: () => resolveKey() }))
// 登录的账号:同步那半每个 await 之后都核对它(和库键里的账号对不上 = 整轮作废)
vi.mock('../../services/engine/targets', async (orig) => ({
  ...(await orig<typeof import('../../services/engine/targets')>()),
  accountStorageId: () => (srv.key.kind === 'sync' ? srv.key.acct : 'A'),
  homeKind: () => 'local',
}))

const boot = async () => import('./calendarConfigStore')
const disk = (): Record<string, Record<string, unknown>> => JSON.parse(localStorage.getItem(KEY) ?? '{}')

const data = new Map<string, string>()
beforeEach(() => {
  data.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
  })
  vi.resetModules()
  srv.doc = null; srv.ver = 0; srv.mode = 'absent'; srv.key = { kind: 'sync', acct: 'A' }
  read.mockClear(); write.mockClear(); resolveKey.mockClear()
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const settle = async (m: Awaited<ReturnType<typeof boot>>): Promise<void> => {
  await vi.runOnlyPendingTimersAsync()
  await m.calendarSettingsSync.tick(V)
}

describe('加载闸(接口不存在 = 旧引擎)', () => {
  it('migrate / 定色播种 / ensureMember / addMember / migratePath / 颜色显隐缺省 都不写共享文件;镜像照写,界面照旧', async () => {
    const m = await boot()
    const st = m.useCalendarConfig.getState
    st().migrate(V, [{ dbPath: 'old.db', dateCol: 'd' }])
    st().ensureColors(V, ['human://CALENDAR.db', 'old.db', 'ics://1'], true)
    st().addMember(V, 'plug.db', 'pd', undefined, { auto: true }) // 插件 ensureMember 的口径
    st().addMember(V, 'mine.db', 'md') // 日历设置 / 数据库块里的「加入日历」
    st().migratePath(V, 'old.db', 'renamed.db') // dbFileOps 改名
    st().setColor(V, 'mine.db', '#abcdef')
    st().toggleHidden(V, 'renamed.db')
    st().setDefault(V, 'mine.db')
    await settle(m)
    await settle(m)
    expect(write).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalled()
    const v = st().byVault[V]
    expect(Object.keys(v.members).sort()).toEqual(['mine.db', 'plug.db', 'renamed.db'])
    expect(v.colors).toEqual({ 'mine.db': '#abcdef' })
    expect(disk()[V]).toMatchObject({ members: v.members, colors: v.colors, hidden: ['renamed.db'], defaultDbPath: 'mine.db', migrated: true })
    expect(localStorage.getItem('amadeus.calendar.cfg.merged')).toBeNull()

    // 接口上线(引擎升级):读到之后才合,一次写进去
    srv.mode = 'ok'
    await settle(m)
    expect(write).toHaveBeenCalledTimes(1)
    const { docToVaultCfg } = await import('./calendarSettingsDoc')
    const shared = docToVaultCfg(srv.doc!)
    expect(Object.keys(shared.members).sort()).toEqual(['mine.db', 'plug.db', 'renamed.db'])
    expect(shared.colors).toEqual({ 'mine.db': '#abcdef' })
    expect(shared.hidden).toEqual(['renamed.db'])
    expect(shared.defaultDbPath).toBe('mine.db')
    expect(Object.keys(shared.autoColors ?? {}).sort()).toEqual(['human://CALENDAR.db', 'renamed.db'])
    expect(JSON.stringify(srv.doc)).not.toContain('ics://')
    expect(JSON.parse(localStorage.getItem('amadeus.calendar.cfg.merged')!)).toEqual({ A: true })
    expect(st().byVault[V].autoColors?.['ics://1']).toBeTruthy() // 本机独有的留在内存和镜像里
    expect(disk()[V].owner).toBe('A')
  })
})

describe('读到之后', () => {
  const seeded = async () => {
    srv.mode = 'ok'
    const m = await boot()
    const st = m.useCalendarConfig.getState
    st().migrate(V, [])
    st().ensureColors(V, ['a.db'], true)
    await settle(m)
    expect(m.calendarSettingsSync.isShared(V)).toBe(true)
    return m
  }
  it('定色:随账号走的库不拿盘上旧镜像的自动色盖内存', async () => {
    const m = await seeded()
    const st = m.useCalendarConfig.getState
    const d = disk()
    d[V] = { ...d[V], autoColors: { ...(d[V].autoColors as object), 'n.db': '#5c9bd1' } } // 旧镜像里留着的别的色
    localStorage.setItem(KEY, JSON.stringify(d))
    st().ensureColors(V, ['a.db', 'n.db'], false)
    const planned = m.planAutoColors({ colors: {}, autoColors: { 'a.db': m.EVENT_PALETTE[0] } }, ['a.db', 'n.db'], false)!
    expect(st().byVault[V].autoColors?.['n.db']).toBe(planned['n.db'])
    expect(planned['n.db']).not.toBe('#5c9bd1')
  })
  it('别的窗口写的镜像不盖从共享文件读到的更新值,本机独有项照收', async () => {
    const m = await seeded()
    const st = m.useCalendarConfig.getState
    st().setColor(V, 'a.db', '#111111')
    await settle(m)
    // 另一台设备把它改了,这个窗口重读到了
    const { applySettingOps } = await import('./calendarSettingsDoc')
    srv.doc = applySettingOps(srv.doc!, [{ t: 'set', k: 'sync|color|a.db', v: '#222222' }])
    srv.ver++
    await settle(m)
    expect(st().byVault[V].colors['a.db']).toBe('#222222')
    // 同一台机器的另一个窗口还拿着旧内存,整份写了镜像
    const d = disk()
    localStorage.setItem(KEY, JSON.stringify({ ...d, [V]: { ...d[V], colors: { 'a.db': '#111111', 'ics://x': '#333333' } } }))
    const seen: string[] = []
    const off = m.useCalendarConfig.subscribe((x) => { seen.push(x.byVault[V]?.colors['a.db']) })
    m.onCalendarCfgStorage(KEY)
    off()
    expect(st().byVault[V].colors).toEqual({ 'a.db': '#222222', 'ics://x': '#333333' })
    expect(seen).not.toContain('#111111') // 中间也不闪回旧值
  })
})

describe('留本机的库:和以前一样', () => {
  it('不读不写共享文件,也不多写 localStorage 别的键', async () => {
    srv.key = { kind: 'local' }
    srv.mode = 'ok'
    const m = await boot()
    const st = m.useCalendarConfig.getState
    st().addMember(V, 'a.db', 'd')
    await settle(m)
    st().setColor(V, 'a.db', '#123123')
    st().migrate(V, [{ dbPath: 'b.db', dateCol: 'x' }])
    st().ensureColors(V, ['a.db', 'b.db'], true)
    st().migratePath(V, 'b.db', 'c.db')
    st().addMember(V, 'p.db', 'd', undefined, { auto: true })
    await settle(m)
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect([...data.keys()].filter((k) => k.startsWith(KEY))).toEqual([KEY])
    expect(m.calendarSettingsSync.isShared(V)).toBe(false)
  })
  it('别的窗口写的镜像照旧整份收(不是随账号走的库)', async () => {
    srv.key = { kind: 'local' }
    const m = await boot()
    m.useCalendarConfig.getState().setColor(V, 'a.db', '#000000')
    await settle(m)
    localStorage.setItem(KEY, JSON.stringify({ [V]: { colors: { 'a.db': '#ffffff' }, hidden: [], defaultDbPath: null, members: {} } }))
    m.onCalendarCfgStorage(KEY)
    expect(m.useCalendarConfig.getState().byVault[V].colors).toEqual({ 'a.db': '#ffffff' })
  })
})
