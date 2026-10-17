/**
 * 插件数据跨设备同步:两台设备(各自的 localStorage + 本机文件)对同一个假云端(服务端同款语义:version 乐观锁、409 回当前版本)。
 * 钉:① 第一次上传;② 换设备拉到新的那份并写进本机;③ 本机没推上去的那次更晚 → 本机赢、推上去;
 *   ④ 推送撞 409 且本机这次更晚 → 以云端版本为基重推;⑤ 没登录 / 断网 → 照旧只用本机;⑥ 用户关掉 / 没声明 → 不同步。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface Row { value: string; version: number; updatedAt: string }
let rows: Map<string, Row>
let online: boolean
let clock: number

function cloudFetch({ path, method, body }: { path: string; method?: string; body?: any }) {
  if (!online) return Promise.reject(new Error('offline'))
  const id = decodeURIComponent(path.replace(/^\/plugin-data\/?/, ''))
  if (!id) return Promise.resolve({ status: 200, json: { items: Object.fromEntries([...rows].map(([k, r]) => [k, { version: r.version, updatedAt: r.updatedAt }])) } })
  const cur = rows.get(id)
  if (method === 'PUT') {
    if ((cur?.version ?? 0) !== body.base) return Promise.resolve({ status: 409, json: cur ? { version: cur.version, updatedAt: cur.updatedAt } : { version: 0, updatedAt: null } })
    const next = { value: body.value, version: (cur?.version ?? 0) + 1, updatedAt: new Date(clock).toISOString() }
    rows.set(id, next)
    return Promise.resolve({ status: 200, json: { version: next.version, updatedAt: next.updatedAt } })
  }
  return Promise.resolve(cur ? { status: 200, json: cur } : { status: 404, json: { detail: 'Not found' } })
}

/** 一台设备 = 一份新求值的模块 + 自己的 localStorage + 自己的本机文件。 */
async function device() {
  vi.resetModules()
  const ls = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v) }, removeItem: (k: string) => { ls.delete(k) } })
  vi.stubGlobal('window', { tangu: { cloudFetch } })
  const m = await import('./pluginDataSync')
  let file: string | null = null
  const local = { read: async () => file, write: async (t: string) => { file = t } }
  return {
    ls, m, local,
    get file() { return file },
    /** 切到这台设备(两台设备共用一个全局 window / localStorage 桩) */
    use() { vi.stubGlobal('localStorage', { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v) }, removeItem: (k: string) => { ls.delete(k) } }) },
    async save(text: string) { file = text; await m.notePluginDataSaved('p', local) },
    load: () => m.loadSyncedPluginData('p', local),
  }
}

beforeEach(() => { rows = new Map(); online = true; clock = Date.parse('2026-10-17T12:00:00Z'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('pluginDataSync', () => {
  it('第一次上传;换设备拉到这份并写进本机;之后两边都不再多传', async () => {
    const a = await device()
    await a.save('{"n":1}')
    expect(rows.get('p')).toMatchObject({ value: '{"n":1}', version: 1 })

    const b = await device()
    expect(await b.load()).toBe('{"n":1}')
    expect(b.file).toBe('{"n":1}')
    expect(JSON.parse(b.ls.get('forsion.pluginSync.p')!)).toEqual({ v: 1 })
    expect(await b.load()).toBe('{"n":1}')
    expect(rows.get('p')!.version).toBe(1)
  })

  it('A 改了 → B 下次激活拉到;A 又改了但 B 不知道,B 离线时存的那次更晚 → B 重启后本机赢、推上去', async () => {
    const step = (ms: number) => { clock += ms; vi.setSystemTime(clock) }
    const a = await device()
    await a.save('v1')
    const b = await device()
    await b.load()

    a.use(); step(61_000) // 过了清单的缓存期
    await a.save('v2-from-a')
    b.use()
    expect(await b.load()).toBe('v2-from-a')

    a.use(); step(61_000)
    await a.save('v3-from-a') // B 没再激活,不知道这一版
    b.use(); online = false; step(1000)
    await b.save('v4-offline-b') // 推不上去,dirty 留着;比 A 的 v3 晚
    online = true
    const b2 = await device() // 重启:新模块,同一份 localStorage / 本机文件
    for (const [k, v] of b.ls) b2.ls.set(k, v)
    await b2.local.write('v4-offline-b')
    b2.use()
    expect(await b2.load()).toBe('v4-offline-b')
    await b2.m.pushPluginData('p', b2.local) // 等后台那次推完(已对上则不重推)
    expect(rows.get('p')).toMatchObject({ value: 'v4-offline-b', version: 4 })
  })

  it('推送撞 409(别的设备先写了)且本机这次更晚 → 以云端版本为基重推', async () => {
    const a = await device()
    await a.save('base')
    const b = await device()
    await b.load()
    a.use(); clock += 1000; vi.setSystemTime(clock)
    await a.save('a-wrote')
    b.use(); clock += 1000; vi.setSystemTime(clock)
    await b.save('b-later')
    expect(rows.get('p')).toMatchObject({ value: 'b-later', version: 3 })
  })

  it('没登录 / 断网 → 照旧只用本机', async () => {
    const a = await device()
    await a.local.write('local-only')
    online = false
    expect(await a.load()).toBe('local-only')
    vi.stubGlobal('window', { tangu: { cloudFetch: async () => ({ status: 401, json: { detail: 'Unauthorized' } }) } })
    expect(await a.load()).toBe('local-only')
    expect(rows.size).toBe(0)
  })

  it('开关:没声明 / 用户关掉 / 宿主没有 cloudFetch → 不同步', async () => {
    const a = await device()
    expect(a.m.pluginDataSyncOn({ id: 'p', syncData: true })).toBe(true)
    expect(a.m.pluginDataSyncOn({ id: 'p' })).toBe(false)
    a.m.setPluginDataSyncUserOff('p', true)
    expect(a.m.pluginDataSyncOn({ id: 'p', syncData: true })).toBe(false)
    a.m.setPluginDataSyncUserOff('p', false)
    vi.stubGlobal('window', { tangu: {} })
    expect(a.m.pluginDataSyncOn({ id: 'p', syncData: true })).toBe(false)
  })
})
