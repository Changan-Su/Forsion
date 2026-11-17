// @vitest-environment happy-dom
/**
 * 插件数据「读失败 ≠ 没写过」(2026-11-17)。在插件真正调到的 ctx.loadData / saveData 这一层钉:
 *  ① 没写过 → null;② 零字节、③ 写到一半(截断的 JSON)、④ 读出错(权限 / I/O)→ reject,err.code = 'plugin-data-unreadable';
 *  宿主自己分好的 reason(手机双槽)原样透传;合法内容照常解析;宿主没有这条桥 → null。
 * 云同步:
 *  ⑤ 本机内容坏了(invalid-json)且云端有一份 → 拉下来恢复(写盘前宿主另存原件);本机读出错(read-failed)→ 不拉、照实报;
 *  ⑥ 推送遇到读不出来的本机不推半截内容、也不 reject;⑦ 云端那份本身不是合法 JSON → 不拿它盖本机;
 *  ⑧ 读失败没恢复成、插件照样 saveData → 不推、不记「本机更新」,下次连上云端时云端那份赢;
 *  ⑨ 本机写失败 → 撤回刚记下的「本机更新」记号。
 * 负对照:pluginStore 的读改回 `.catch(() => null)` → ②③④ 红;去掉 restoreFromCloud → ⑤ 红;
 *  saveData 不分「读失败后的写」→ ⑧ 红;不撤回记号 → ⑨ 红。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const files = new Map<string, string>()
const failing = new Map<string, unknown>()
const failWrite = new Set<string>()
const writes: Array<[string, string]> = []
const puts: unknown[] = []
const cloudRows = new Map<string, { value: string; version: number }>()
let online = true
;(window as any).amadeus = {
  readPluginData: async (id: string) => {
    const err = failing.get(id)
    if (err) throw err
    return files.get(id) ?? null
  },
  writePluginData: async (id: string, text: string) => {
    if (failWrite.has(id)) throw new Error('could not be read or backed up; not overwriting it')
    writes.push([id, text]); files.set(id, text)
  },
}
;(window as any).tangu = {
  cloudFetch: async (req: { path: string; method?: string; body?: unknown }) => {
    if (!online) throw new Error('offline')
    if (req.method === 'PUT') { puts.push(req.body); return { status: 500 } }
    if (req.path === '/plugin-data') {
      return { status: 200, json: { owner: 'acct', items: Object.fromEntries([...cloudRows].map(([k, r]) => [k, { version: r.version, updatedAt: '2026-11-17T00:00:00Z', editedAt: Date.now() - 60_000 }])) } }
    }
    const id = decodeURIComponent(req.path.replace('/plugin-data/', ''))
    const row = cloudRows.get(id)
    return row ? { status: 200, json: { value: row.value, version: row.version } } : { status: 404 }
  },
}
const { usePluginStore } = await import('./pluginStore')
const { pushPluginData, notePluginDataEdit } = await import('./pluginDataSync')
const { readLocalPluginData } = await import('./pluginLocalData')
type Ctx = import('./types').PluginContext

function ctxOf(id: string, syncData?: boolean): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', ...(syncData ? { syncData } : {}), setup: (c) => { ref = c } }])
  return ref!
}

const unreadable = (reason: string) => expect.objectContaining({ code: 'plugin-data-unreadable', reason })
const state = (id: string) => JSON.parse(localStorage.getItem(`forsion.pluginSync.${id}`) || 'null')
const setState = (id: string, s: object) => localStorage.setItem(`forsion.pluginSync.${id}`, JSON.stringify(s))
const settle = () => new Promise((r) => setTimeout(r, 0))

// 同步模块把云端清单缓存 60 秒(模块级):每条用例把时钟往后拨一分多钟,别吃到上一条用例的清单
const realNow = Date.now.bind(Date)
let clockOffset = 0
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)

beforeEach(() => {
  files.clear(); failing.clear(); failWrite.clear(); writes.length = 0; puts.length = 0; cloudRows.clear(); online = true
  localStorage.clear()
  clockOffset += 61_000
})

describe('ctx.loadData:没写过 vs 读不出来', () => {
  it('① 没写过 → null', async () => {
    await expect(ctxOf('p').loadData!()).resolves.toBeNull()
  })

  it('合法内容照常解析', async () => {
    files.set('p', '{"snippets":"keep me"}')
    await expect(ctxOf('p').loadData!()).resolves.toEqual({ snippets: 'keep me' })
  })

  it('② 零字节 → reject(invalid-json),不是 null', async () => {
    files.set('p', '')
    await expect(ctxOf('p').loadData!()).rejects.toEqual(unreadable('invalid-json'))
  })

  it('③ 写到一半(截断的 JSON)→ reject(invalid-json)', async () => {
    files.set('p', '{"snippetsSourceText":"[{trigger:\\"mk\\"')
    await expect(ctxOf('p').loadData!()).rejects.toEqual(unreadable('invalid-json'))
  })

  it('④ 读出错(权限 / I/O)→ reject(read-failed),带上原错误', async () => {
    failing.set('p', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    const err: any = await ctxOf('p').loadData!().catch((e: unknown) => e)
    expect(err).toEqual(unreadable('read-failed'))
    expect(err.cause?.message).toMatch(/EACCES/)
  })

  it('宿主自己分好的 reason(手机双槽信封坏了 = invalid-json)原样透传', async () => {
    failing.set('p', Object.assign(new Error('plugin-data-unreadable'), { code: 'plugin-data-unreadable', reason: 'invalid-json' }))
    await expect(ctxOf('p').loadData!()).rejects.toEqual(unreadable('invalid-json'))
  })

  it('读不出来时 loadData 本身不写盘', async () => {
    files.set('p', '{"half":')
    await ctxOf('p').loadData!().catch(() => {})
    expect(writes).toEqual([])
    expect(files.get('p')).toBe('{"half":')
  })

  it('宿主没有这条桥 → null(老宿主 / 网页没接数据时的口径不变)', async () => {
    const saved = (window as any).amadeus.readPluginData
    delete (window as any).amadeus.readPluginData
    try {
      await expect(ctxOf('p').loadData!()).resolves.toBeNull()
    } finally {
      ;(window as any).amadeus.readPluginData = saved
    }
  })
})

describe('云同步:本机读不出来时不当「本机没有」', () => {
  it('⑤ 本机内容坏了、云端有一份 → 拉云端恢复(就算本机记着没推的编辑),对上云端版本、清掉 dirty', async () => {
    files.set('s', '{"trunc')
    setState('s', { v: 2, owner: 'acct', gen: 0, dirty: Date.now() - 1000 })
    cloudRows.set('s', { value: '{"from":"cloud"}', version: 3 })
    await expect(ctxOf('s', true).loadData!()).resolves.toEqual({ from: 'cloud' })
    expect(writes).toEqual([['s', '{"from":"cloud"}']])
    expect(state('s')).toEqual({ v: 3, owner: 'acct', gen: 0 })
  })

  it('本机读出错(read-failed:本机那份可能是好的、还更新)→ 不拉云端,照实报', async () => {
    failing.set('s', new Error('EIO'))
    cloudRows.set('s', { value: '{"from":"cloud"}', version: 3 })
    await expect(ctxOf('s', true).loadData!()).rejects.toEqual(unreadable('read-failed'))
    expect(writes).toEqual([])
  })

  it('云端那份属于另一个账号 → 不拿来恢复', async () => {
    files.set('s', '{"trunc')
    setState('s', { v: 2, owner: 'someone-else', gen: 0 })
    cloudRows.set('s', { value: '{"from":"cloud"}', version: 3 })
    await expect(ctxOf('s', true).loadData!()).rejects.toEqual(unreadable('invalid-json'))
    expect(writes).toEqual([])
  })

  it('⑥ 有待推的编辑、本机文件坏了 → 推送不推半截内容,也不 reject', async () => {
    files.set('s', '{"half":')
    notePluginDataEdit('s')
    const local = { read: () => readLocalPluginData('s', () => (window as any).amadeus.readPluginData('s')), write: async () => {} }
    await expect(pushPluginData('s', local)).resolves.toBeUndefined()
    expect(puts).toEqual([])
    expect(state('s').dirty).toEqual(expect.any(Number))
  })

  it('⑦ 云端那份本身不是合法 JSON → 不拿它盖本机,loadData 回本机这份', async () => {
    files.set('s', '{"mine":1}')
    cloudRows.set('s', { value: '{"bad', version: 5 })
    await expect(ctxOf('s', true).loadData!()).resolves.toEqual({ mine: 1 })
    expect(writes).toEqual([])
    expect(files.get('s')).toBe('{"mine":1}')
  })

  it('⑧ 读失败没恢复成(离线)、插件照样存默认值 → 不推、不记本机更新;连上后云端那份赢', async () => {
    files.set('s', '{"trunc')
    setState('s', { v: 2, owner: 'acct', gen: 0 })
    cloudRows.set('s', { value: '{"good":"cloud"}', version: 3 })
    online = false
    const ctx = ctxOf('s', true)
    await expect(ctx.loadData!()).rejects.toEqual(unreadable('invalid-json'))
    await ctx.saveData!({ defaults: 1 }) // 不守规矩的插件:接住错误照样存
    await settle()
    expect(puts).toEqual([])
    expect(state('s')).toEqual({ v: 0, owner: 'acct', gen: 1 })
    online = true
    await expect(ctxOf('s', true).loadData!()).resolves.toEqual({ good: 'cloud' }) // 云端那份没被盖,拉回来
    expect(puts).toEqual([])
  })

  it('⑨ 本机写失败(宿主拒写)→ 撤回「本机更新」记号', async () => {
    setState('s', { v: 3, owner: 'acct', gen: 4 })
    failWrite.add('s')
    await expect(ctxOf('s', true).saveData!({ a: 1 })).rejects.toThrow(/not overwriting/)
    expect(state('s').dirty).toBeUndefined()
    expect(puts).toEqual([])
  })
})
