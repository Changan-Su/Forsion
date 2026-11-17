// @vitest-environment happy-dom
/**
 * 插件数据「读失败 ≠ 没写过」(2026-11-17)。在插件真正调到的 ctx.loadData 这一层钉:
 *  ① 没写过 → null;② 零字节、③ 写到一半(截断的 JSON)、④ 读出错(权限 / I/O)→ reject,err.code = 'plugin-data-unreadable';
 *  合法内容照常解析;宿主没有这条桥 → null。
 * 云同步:⑤ 本机读不出来时不拉云端那份写盘盖它;⑥ 推送遇到读不出来的本机不推半截内容、也不 reject;
 *  ⑦ 云端那份本身不是合法 JSON 时不拿它盖本机。
 * 负对照:把 pluginStore 的 readLocal 改回 `.catch(() => null)`、或把 pluginLocalData 的 JSON 校验去掉,②③④⑤ 变红。
 */
import { describe, it, expect, beforeEach } from 'vitest'

const files = new Map<string, string>()
const failing = new Map<string, Error>()
const writes: Array<[string, string]> = []
const puts: unknown[] = []
const cloudRows = new Map<string, { value: string; version: number }>()
;(window as any).amadeus = {
  readPluginData: async (id: string) => {
    const err = failing.get(id)
    if (err) throw err
    return files.get(id) ?? null
  },
  writePluginData: async (id: string, text: string) => { writes.push([id, text]); files.set(id, text) },
}
;(window as any).tangu = {
  cloudFetch: async (req: { path: string; method?: string; body?: unknown }) => {
    if (req.method === 'PUT') { puts.push(req.body); return { status: 500 } }
    if (req.path === '/plugin-data') {
      return { status: 200, json: { owner: 'acct', items: Object.fromEntries([...cloudRows].map(([k, r]) => [k, { version: r.version, updatedAt: '2026-11-17T00:00:00Z', editedAt: Date.now() + 60_000 }])) } }
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

beforeEach(() => {
  files.clear(); failing.clear(); writes.length = 0; puts.length = 0; cloudRows.clear()
  localStorage.clear()
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
  it('⑤ 云端有更新的那份、本机是坏文件 → loadData reject,不拉云端写盘盖掉本机', async () => {
    files.set('s', '{"trunc')
    cloudRows.set('s', { value: '{"from":"cloud"}', version: 3 })
    await expect(ctxOf('s', true).loadData!()).rejects.toEqual(unreadable('invalid-json'))
    expect(writes).toEqual([])
    expect(files.get('s')).toBe('{"trunc')
  })

  it('本机读出错(不是坏 JSON)同样不拉云端', async () => {
    failing.set('s', new Error('EIO'))
    cloudRows.set('s', { value: '{"from":"cloud"}', version: 3 })
    await expect(ctxOf('s', true).loadData!()).rejects.toEqual(unreadable('read-failed'))
    expect(writes).toEqual([])
  })

  it('⑥ 有待推的编辑、本机文件坏了 → 推送不推半截内容,也不 reject', async () => {
    files.set('s', '{"half":')
    notePluginDataEdit('s')
    const local = { read: () => readLocalPluginData('s', () => (window as any).amadeus.readPluginData('s')), write: async () => {} }
    await expect(pushPluginData('s', local)).resolves.toBeUndefined()
    expect(puts).toEqual([])
    expect(JSON.parse(localStorage.getItem('forsion.pluginSync.s')!).dirty).toEqual(expect.any(Number))
  })

  it('⑦ 云端那份本身不是合法 JSON → 不拿它盖本机,loadData 回本机这份', async () => {
    files.set('s', '{"mine":1}')
    cloudRows.set('s', { value: '{"bad', version: 5 })
    await expect(ctxOf('s', true).loadData!()).resolves.toEqual({ mine: 1 })
    expect(writes).toEqual([])
    expect(files.get('s')).toBe('{"mine":1}')
  })
})
