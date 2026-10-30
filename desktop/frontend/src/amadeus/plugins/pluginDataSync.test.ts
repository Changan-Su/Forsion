/**
 * 插件数据跨设备同步:几台设备(各自的 localStorage + 本机文件)对同一个假云端(服务端同款语义:按账号分行、
 * version 乐观锁、409 回当前版本与编辑时刻、owner 对不上就拒)。
 * 钉:① 第一次上传、换设备拉到;② 本机没推的那次编辑更晚 → 本机赢;③ 推送撞 409 且本机更晚 → 以云端版本为基重推;
 *   ④ 比的是编辑时刻不是上传时刻(离线改的晚上传);⑤ 同步关着期间的修改重新打开后不被云端盖掉;
 *   ⑥ 换了账号:本机这份不传进新账号,新账号有就拉;⑦ 拉取等云端时插件又存了 → 不拿云端的盖本机;
 *   ⑧ 没登录 / 断网 → 照旧只用本机;⑨ 开关;⑩ 卸载清云端:只在本机那份不比云端旧时删,恢复后推回去。
 * Codex 评审(10-18)的四个 P1 各对应 ④⑤⑥⑦。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface Row { value: string; version: number; updatedAt: string; editedAt: number }
let rows: Map<string, Row>
let online: boolean
let account: string
let clock: number
/** 设了就把下一次 GET /plugin-data/:id 挂住,直到测试放行 */
let holdGet: Promise<void> | null

const meta = (r: Row) => ({ version: r.version, updatedAt: r.updatedAt, editedAt: r.editedAt })
async function cloudFetch({ path, method, body }: { path: string; method?: string; body?: any }) {
  if (!online) throw new Error('offline')
  const [route, query] = path.split('?')
  const id = decodeURIComponent(route.replace(/^\/plugin-data\/?/, ''))
  const mine = [...rows].filter(([k]) => k.startsWith(`${account}:`))
  if (!id) return { status: 200, json: { owner: account, items: Object.fromEntries(mine.map(([k, r]) => [k.slice(account.length + 1), meta(r)])) } }
  const key = `${account}:${id}`
  const cur = rows.get(key)
  if (method === 'PUT') {
    if (body.owner !== undefined && body.owner !== account) return { status: 409, json: { code: 'owner_mismatch' } }
    if ((cur?.version ?? 0) !== body.base) return { status: 409, json: cur ? meta(cur) : { version: 0, updatedAt: null, editedAt: null } }
    const next = { value: body.value, version: (cur?.version ?? 0) + 1, updatedAt: new Date(clock).toISOString(), editedAt: body.editedAt }
    rows.set(key, next)
    return { status: 200, json: { owner: account, ...meta(next) } }
  }
  if (method === 'DELETE') {
    const q = new URLSearchParams(query)
    if (q.get('owner') !== account) return { status: 409, json: { code: 'owner_mismatch' } }
    if (!cur) return { status: 404, json: { detail: 'Not found' } }
    if (cur.version !== Number(q.get('base'))) return { status: 409, json: meta(cur) }
    rows.delete(key)
    return { status: 200, json: { ok: true } }
  }
  if (holdGet) await holdGet
  return cur ? { status: 200, json: { value: cur.value, ...meta(cur) } } : { status: 404, json: { detail: 'Not found' } }
}
const step = (ms: number) => { clock += ms; vi.setSystemTime(clock) }

/** 一台设备 = 一份新求值的模块 + 自己的 localStorage + 自己的本机文件。 */
async function device(from?: { ls: Map<string, string>; file: string | null }) {
  vi.resetModules()
  const ls = new Map(from?.ls ?? [])
  const stubLs = () => vi.stubGlobal('localStorage', { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v) }, removeItem: (k: string) => { ls.delete(k) } })
  stubLs()
  vi.stubGlobal('window', { tangu: { cloudFetch } })
  const m = await import('./pluginDataSync')
  let file: string | null = from?.file ?? null
  const local = { read: async () => file, write: async (t: string) => { file = t } }
  return {
    ls, m, local,
    get file() { return file },
    /** 切到这台设备(几台设备共用一个全局 localStorage 桩) */
    use: stubLs,
    /** 和 pluginStore 的 saveData 同一顺序:先记编辑、再写本机、再推 */
    async save(text: string) { m.notePluginDataEdit('p'); file = text; await m.pushPluginData('p', local) },
    /** 同步关着 / 推不上去时的保存:只记编辑、写本机 */
    saveOnly(text: string) { m.notePluginDataEdit('p'); file = text },
    load: () => m.loadSyncedPluginData('p', local),
    /** 等后台那次推送收尾(已对上则不重推) */
    settle: () => m.pushPluginData('p', local),
  }
}

beforeEach(() => {
  rows = new Map(); online = true; account = 'u-a'; holdGet = null
  clock = Date.parse('2026-10-17T12:00:00Z'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const cloudValue = () => rows.get(`${account}:p`)

describe('pluginDataSync', () => {
  it('第一次上传;换设备拉到这份并写进本机;之后两边都不再多传', async () => {
    const a = await device()
    await a.save('{"n":1}')
    expect(cloudValue()).toMatchObject({ value: '{"n":1}', version: 1 })

    const b = await device()
    expect(await b.load()).toBe('{"n":1}')
    expect(b.file).toBe('{"n":1}')
    expect(await b.load()).toBe('{"n":1}')
    await b.settle()
    expect(cloudValue()!.version).toBe(1)
  })

  it('A 又改了但 B 不知道,B 离线时那次编辑更晚 → B 重启后本机赢、推上去', async () => {
    const a = await device()
    await a.save('v1')
    const b = await device()
    await b.load()
    a.use(); step(61_000)
    await a.save('v2-from-a') // B 没再激活,不知道这一版
    b.use(); step(1000)
    b.saveOnly('v3-offline-b') // 比 A 的 v2 晚
    const b2 = await device({ ls: b.ls, file: b.file }) // 重启
    expect(await b2.load()).toBe('v3-offline-b')
    await b2.settle()
    expect(cloudValue()).toMatchObject({ value: 'v3-offline-b', version: 3 })
  })

  it('推送撞 409(别的设备先写了)且本机这次更晚 → 以云端版本为基重推', async () => {
    const a = await device()
    await a.save('base')
    const b = await device()
    await b.load()
    a.use(); step(1000)
    await a.save('a-wrote')
    b.use(); step(1000)
    await b.save('b-later')
    expect(cloudValue()).toMatchObject({ value: 'b-later', version: 3 })
  })

  it('比的是编辑时刻:A 12:01 离线改、B 12:02 离线改,A 12:03 先传上去 → B 的仍然赢', async () => {
    const a = await device()
    await a.save('base')
    const b = await device()
    await b.load()
    a.use(); step(60_000); a.saveOnly('a-12:01')
    b.use(); step(60_000); b.saveOnly('b-12:02')
    a.use(); step(60_000); await a.settle() // A 12:03 才联网
    expect(cloudValue()).toMatchObject({ value: 'a-12:01', version: 2 })
    b.use(); step(1000); await b.settle()
    expect(cloudValue()).toMatchObject({ value: 'b-12:02', version: 3 })
    expect(b.file).toBe('b-12:02')
  })

  it('同步关着期间的修改:重新打开后不被云端盖掉', async () => {
    const a = await device()
    await a.save('v1')
    const b = await device()
    await b.load()
    a.use(); step(61_000); await a.save('v2-from-a')
    b.use(); step(1000); b.saveOnly('b-edited-while-off') // 关着同步时存的:只记编辑
    const b2 = await device({ ls: b.ls, file: b.file })
    expect(await b2.load()).toBe('b-edited-while-off')
    await b2.settle()
    expect(cloudValue()!.value).toBe('b-edited-while-off')
  })

  it('卸载清云端:本机是最新的就删;回收站放回本机文件和同步状态后,按第一次上传推回去', async () => {
    const a = await device()
    await a.save('mine')
    const synced = new Map(a.ls), kept = a.file // 回收站收走的那两样
    await a.m.dropPluginCloudData('p')
    expect(cloudValue()).toBeUndefined()
    step(61_000)
    const restored = await device({ ls: synced, file: kept })
    expect(await restored.load()).toBe('mine')
    await restored.settle()
    expect(cloudValue()).toMatchObject({ value: 'mine', version: 1 })
  })

  it('卸载清云端:别的设备写过更新的一版 → 不删(回收站里这份已不是最新,删了找不回来)', async () => {
    const a = await device()
    await a.save('v1')
    const b = await device()
    await b.load()
    await b.save('v2-from-b')
    a.use()
    await a.m.dropPluginCloudData('p')
    expect(cloudValue()).toMatchObject({ value: 'v2-from-b', version: 2 })
  })

  it('卸载清云端:换了账号不删新账号的;没对上过云端不发请求', async () => {
    const a = await device()
    await a.save('alice')
    account = 'u-b'
    rows.set('u-b:p', { value: 'bob', version: 1, updatedAt: new Date(clock).toISOString(), editedAt: clock })
    await a.m.dropPluginCloudData('p')
    expect(cloudValue()!.value).toBe('bob')
    const fresh = await device()
    await fresh.m.dropPluginCloudData('p')
    expect(cloudValue()!.value).toBe('bob')
  })

  it('换了账号:本机这份不传进新账号;新账号云端有就拉下来', async () => {
    const a = await device()
    await a.save('alice-private')
    a.saveOnly('alice-unpushed') // 还没推就换账号
    account = 'u-b'
    step(61_000)
    const a2 = await device({ ls: a.ls, file: a.file })
    expect(await a2.load()).toBe('alice-unpushed')
    await a2.settle()
    expect(cloudValue()).toBeUndefined() // 没传进 B
    rows.set('u-b:p', { value: 'bob-data', version: 4, updatedAt: new Date(clock).toISOString(), editedAt: clock })
    step(61_000)
    const a3 = await device({ ls: a2.ls, file: a2.file })
    expect(await a3.load()).toBe('bob-data')
    expect(rows.get('u-a:p')!.value).toBe('alice-private')
  })

  it('拉取等云端时插件又存了 → 不拿云端的盖本机,改去推本机这份', async () => {
    const a = await device()
    await a.save('v1')
    const b = await device()
    let release!: () => void
    holdGet = new Promise((r) => { release = r })
    const loading = b.load()
    await new Promise((r) => setTimeout(r, 0))
    step(1000)
    b.saveOnly('b-newer')
    release()
    expect(await loading).toBe('b-newer')
    expect(b.file).toBe('b-newer')
    holdGet = null
    await b.settle()
    expect(cloudValue()).toMatchObject({ value: 'b-newer', version: 2 })
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
