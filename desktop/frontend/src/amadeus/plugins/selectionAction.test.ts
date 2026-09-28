// 正文 AI 的插件接缝(评审 G3-07):ctx.tangu.complete 与 ctx.registerSelectionAction 的闸与吊销。
//  ① complete 只在探针给得出时注入;请求一律按 custom + 指令转给探针,空指令拒;停用时在飞请求被中止并 reject;
//  ② registerSelectionAction 进 store、同 id 覆盖、缺字段忽略;插件停用即撤。
// 负对照(已实跑红):去掉 complete 里 tanguUnsubs.add(stop) → ①「停用即中止」红;selectionActions 的停用 filter 去掉 → ②红。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../api', () => ({ amadeus: undefined }))

const { usePluginStore } = await import('./pluginStore')
const { setTanguProbe } = await import('./tanguSeam')
type Ctx = import('./types').PluginContext
type Probe = import('./tanguSeam').TanguProbe

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, selectionActions: [] })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return ref!
}
const baseProbe = (over: Partial<Probe> = {}): Probe => ({ activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {}, ...over })

afterEach(() => setTanguProbe(null))

describe('ctx.tangu.complete', () => {
  beforeEach(() => setTanguProbe(baseProbe()))

  it('探针没有 complete → 不注入', () => {
    expect(ctxOf('p1').tangu?.complete).toBeUndefined()
  })

  it('转成 custom + 指令交给探针,流式增量透传,返回 { text }', async () => {
    const seen: unknown[] = []
    setTanguProbe(baseProbe({
      complete: async (req, opts) => { seen.push(req); opts?.onDelta?.('he'); opts?.onDelta?.('llo'); return { text: 'hello', toolCallText: false } },
    }))
    const ctx = ctxOf('p2')
    const deltas: string[] = []
    const r = await ctx.tangu!.complete!({ prompt: ' Shorten ', selection: 'abc', onDelta: (d) => deltas.push(d) })
    expect(r).toEqual({ text: 'hello' })
    expect(deltas.join('')).toBe('hello')
    expect(seen[0]).toEqual({ action: 'custom', instruction: 'Shorten', selection: 'abc', before: undefined, after: undefined })
    await expect(ctx.tangu!.complete!({ prompt: '  ' })).rejects.toThrow(/prompt is required/)
  })

  it('插件停用:在飞请求被中止并 reject', async () => {
    let signal: AbortSignal | undefined
    setTanguProbe(baseProbe({
      complete: (_req, opts) => new Promise((_res, rej) => {
        signal = opts?.signal
        opts?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
      }),
    }))
    const ctx = ctxOf('p3')
    const p = ctx.tangu!.complete!({ prompt: 'x' })
    usePluginStore.getState().disable('p3')
    await expect(p).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
  })
})

describe('ctx.registerSelectionAction', () => {
  beforeEach(() => setTanguProbe(baseProbe()))

  it('注册进 store;同 id 覆盖;缺字段忽略;停用即撤', () => {
    const ctx = ctxOf('p4')
    const run = () => 'x'
    ctx.registerSelectionAction({ id: 'a', title: 'A', run })
    ctx.registerSelectionAction({ id: 'a', title: 'A2', run })
    ctx.registerSelectionAction({ id: 'b', title: 'B' } as never)
    const list = usePluginStore.getState().selectionActions
    expect(list.map((o) => `${o.pluginId}:${o.item.id}:${o.item.title}`)).toEqual(['p4:a:A2'])
    usePluginStore.getState().disable('p4')
    expect(usePluginStore.getState().selectionActions).toEqual([])
  })
})
