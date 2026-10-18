// @vitest-environment happy-dom
/**
 * ctx.saveData 的接线(pluginStore):声明了 syncData 的插件,**同步关着也记编辑**,并且**先记、后写本机**
 * (拉取落盘前靠这个代号判断插件有没有又存过,Codex 评审 P1)。开着同步时写完本机再推。没声明的插件不碰同步状态。
 */
import { describe, it, expect, vi } from 'vitest'

const seenAtWrite: Array<string | null> = []
const puts: unknown[] = []
const files = new Map<string, string>()
;(window as any).amadeus = {
  readPluginData: async (id: string) => files.get(id) ?? null,
  writePluginData: async (id: string, text: string) => { seenAtWrite.push(localStorage.getItem('forsion.pluginSync.syncy')); files.set(id, text) },
}
;(window as any).tangu = {
  cloudFetch: async (req: { method?: string; body?: unknown }) => {
    if (req.method === 'PUT') puts.push(req.body)
    return { status: 401, json: { detail: 'Unauthorized' } }
  },
}
const { usePluginStore } = await import('./pluginStore')
const { setPluginDataSyncUserOff } = await import('./pluginDataSync')
type Ctx = import('./types').PluginContext

function ctxOf(id: string, syncData?: boolean): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', ...(syncData ? { syncData } : {}), setup: (c) => { ref = c } }])
  return ref!
}
const state = (id: string) => JSON.parse(localStorage.getItem(`forsion.pluginSync.${id}`) || 'null')

describe('saveData 接线', () => {
  it('同步关着:照样记编辑,且在写本机之前记;不推', async () => {
    setPluginDataSyncUserOff('syncy', true)
    const ctx = ctxOf('syncy', true)
    await ctx.saveData!({ a: 1 })
    expect(JSON.parse(seenAtWrite.at(-1)!).gen).toBe(1) // 写本机那一刻代号已经 +1
    expect(state('syncy')).toMatchObject({ gen: 1 })
    expect(typeof state('syncy').dirty).toBe('number')
    await new Promise((r) => setTimeout(r, 0))
    expect(puts).toEqual([])
  })

  it('同步开着:写完本机再推', async () => {
    setPluginDataSyncUserOff('syncy', false)
    const ctx = ctxOf('syncy', true)
    await ctx.saveData!({ a: 2 })
    await vi.waitFor(() => expect(puts.length).toBe(1))
    expect(state('syncy').gen).toBe(2)
  })

  it('没声明 syncData:不碰同步状态', async () => {
    const ctx = ctxOf('plain')
    await ctx.saveData!({ a: 1 })
    expect(state('plain')).toBeNull()
  })
})
