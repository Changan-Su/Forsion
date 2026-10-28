// 插件工具结果卡片(ctx.registerToolResultRenderer)的认领与分段:
//  ① 只认本插件捆绑包里引擎插件此刻名下的工具;别家插件的、核心的、名单没拉到的一律不认(fail closed);
//  ② 注册形状校验、落点缺省 inline;停用插件 = 渲染器跟着切片摘掉;
//  ③ 分段:认领了的成功调用画卡片代替通用记录,运行中 / 出错 / 挂起 / 没认领的留在工具组;
//  ④ state 句柄按调用 id 交还。
// 负对照(已实跑红):claimToolCard 去掉 enginePlugins 那半(只比工具名)→ ①「别家插件的工具」红;
// cardEligible 去掉 !ev.isError → ③「出错的留通用记录」红;dropSlices 的 SLICE_KEYS 去掉 toolResultRenderers → ②「停用即摘」红。
import { describe, expect, it, beforeEach } from 'vitest'
import type { ToolEvent } from '../../types'

const { usePluginStore } = await import('./pluginStore')
const { claimToolCard, cardStateHandle, toolCardOf, useEngineTools, parseToolArgs, toolCardTitle, __resetToolCards } = await import('./toolResultCards')
const { partitionToolSegment } = await import('../../views/chat2/EditorialMessage')
type Ctx = import('./types').PluginContext
type Plugin = import('./types').AmadeusPlugin

const bundle = (enginePlugins: string[]) => ({ agents: [], enginePlugins, skills: [], spaces: [] })
const mount = (): void => {}

function ctxOf(id: string, over: Partial<Plugin> = {}): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c }, ...over }])
  return ref!
}

const done = (id: string, name: string, over: Partial<ToolEvent> = {}): ToolEvent => ({ id, name, done: true, result: 'ok', ...over })

beforeEach(() => __resetToolCards())

describe('① 认领:只认自家引擎半身名下的工具', () => {
  const plugins = [{ id: 'chart', bundle: bundle(['chart-engine']) }, { id: 'other', bundle: bundle(['other-engine']) }, { id: 'nobundle' }]
  const r = (pluginId: string, tool: string) => ({ pluginId, item: { tool, mount } })
  const engine = { 'chart-engine': ['make_chart'], 'other-engine': ['make_table'] }

  it('自家工具认;别家插件的工具、核心工具(引擎不报)不认', () => {
    expect(claimToolCard([r('chart', 'make_chart')], plugins, engine, 'make_chart')?.pluginId).toBe('chart')
    expect(claimToolCard([r('chart', 'make_table')], plugins, engine, 'make_table'), '别家插件的工具').toBeUndefined()
    expect(claimToolCard([r('chart', 'write_file')], plugins, engine, 'write_file'), '核心工具').toBeUndefined()
    expect(claimToolCard([r('nobundle', 'make_chart')], plugins, engine, 'make_chart'), '没有捆绑引擎半身').toBeUndefined()
  })

  it('名单没拉到 / 拉失败(空表)一律不认', () => {
    expect(claimToolCard([r('chart', 'make_chart')], plugins, {}, 'make_chart')).toBeUndefined()
  })

  it('两个插件抢同一个名字:只有真归它的那个认得上;都合法时注册序先到先得', () => {
    expect(claimToolCard([r('other', 'make_chart'), r('chart', 'make_chart')], plugins, engine, 'make_chart')?.pluginId).toBe('chart')
    const both = { 'chart-engine': ['x'], 'other-engine': ['x'] }
    expect(claimToolCard([r('other', 'x'), r('chart', 'x')], plugins, both, 'x')?.pluginId).toBe('other')
  })
})

describe('①b 官方插件画核心工具(网页卡片 A + D)', () => {
  const plugins = [{ id: 'forsion-extend', bundle: bundle(['store-update']) }, { id: 'third', bundle: bundle(['third-engine']) }]
  const r = (pluginId: string, tool: string, match?: (c: { tool: string; args: unknown }) => boolean) => ({ pluginId, item: { tool, mount, ...(match ? { match } : {}) } })
  const engine = { 'store-update': ['store_submit_update'], 'third-engine': ['x'] }

  it('名单里的官方插件 + 捆绑包里有官方引擎插件在跑 → 认;任一条不满足都不认', () => {
    expect(claimToolCard([r('forsion-extend', 'publish_web_page')], plugins, engine, 'publish_web_page', { official: ['store-update'] })?.pluginId).toBe('forsion-extend')
    expect(claimToolCard([r('forsion-extend', 'publish_web_page')], plugins, engine, 'publish_web_page', { official: [] }), '引擎没判官方').toBeUndefined()
    expect(claimToolCard([r('forsion-extend', 'write_file')], plugins, engine, 'write_file', { official: ['store-update'] }), '不在名单里的核心工具').toBeUndefined()
    expect(claimToolCard([r('third', 'publish_web_page')], plugins, engine, 'publish_web_page', { official: ['third-engine'] }), '不在名单里的插件').toBeUndefined()
  })

  it('match 按参数收窄;返回 false / 抛错 = 不认', () => {
    const webOnly = (c: { args: unknown }) => (c.args as { section?: string }).section === 'web_pages'
    const o = (args: unknown) => ({ official: ['store-update'], args })
    expect(claimToolCard([r('forsion-extend', 'forsion_account', webOnly)], plugins, engine, 'forsion_account', o({ section: 'web_pages' }))).toBeDefined()
    expect(claimToolCard([r('forsion-extend', 'forsion_account', webOnly)], plugins, engine, 'forsion_account', o({ section: 'usage' }))).toBeUndefined()
    expect(claimToolCard([r('forsion-extend', 'forsion_account', () => { throw new Error('x') })], plugins, engine, 'forsion_account', o({}))).toBeUndefined()
    expect(claimToolCard([r('forsion-extend', 'store_submit_update', () => false)], plugins, engine, 'store_submit_update', o({})), '自家工具同样过 match').toBeUndefined()
  })
})

describe('② ctx.registerToolResultRenderer', () => {
  it('收下形状对的,落点缺省 inline;缺 tool / mount 的拒收', () => {
    const ctx = ctxOf('chart', { bundle: bundle(['chart-engine']) })
    ctx.registerToolResultRenderer!({ tool: ' make_chart ', mount })
    ctx.registerToolResultRenderer!({ tool: 'make_board', surface: 'desk', mount })
    ctx.registerToolResultRenderer!({ tool: '', mount })
    ctx.registerToolResultRenderer!({ tool: 'x' } as never)
    expect(usePluginStore.getState().toolResultRenderers.map((o) => [o.pluginId, o.item.tool, o.item.surface])).toEqual([
      ['chart', 'make_chart', 'inline'], ['chart', 'make_board', 'desk'],
    ])
  })

  it('停用插件即摘;摘掉之后同一次调用不再认领(退回通用记录)', () => {
    const ctx = ctxOf('chart', { bundle: bundle(['chart-engine']) })
    ctx.registerToolResultRenderer!({ tool: 'make_chart', mount })
    useEngineTools.setState({ byEngine: { 'chart-engine': ['make_chart'] } })
    const ev = done('c1', 'make_chart')
    expect(toolCardOf(ev)?.pluginId).toBe('chart')
    usePluginStore.getState().disable('chart')
    expect(usePluginStore.getState().toolResultRenderers).toEqual([])
    expect(toolCardOf(ev)).toBeUndefined()
    ctx.registerToolResultRenderer!({ tool: 'make_chart', mount }) // 停用后迟到的注册
    expect(usePluginStore.getState().toolResultRenderers).toEqual([])
  })
})

describe('③ 分段:卡片代替通用记录', () => {
  const card = { pluginId: 'chart', item: { tool: 'make_chart', mount } }
  const cardOf = (ev: ToolEvent) => (ev.name === 'make_chart' && ev.done && !ev.isError && !ev.parked ? card : undefined)

  it('成功的调用单独成卡,前后的工具各成一组', () => {
    const a = done('a', 'read_file'), c = done('c', 'make_chart'), b = done('b', 'run_bash')
    expect(partitionToolSegment([a, c, b], [], false, cardOf)).toEqual([
      { t: 'tools', events: [a] },
      { t: 'pluginCard', event: c, claim: card },
      { t: 'tools', events: [b] },
    ])
  })

  it('运行中 / 出错 / 挂起的留在工具组(cardEligible 把关)', async () => {
    const { cardEligible } = await import('./toolResultCards')
    const running: ToolEvent = { id: 'r', name: 'make_chart', done: false }
    const failed = done('f', 'make_chart', { isError: true, result: 'Error: boom' })
    const parked = done('p', 'make_chart', { parked: true })
    const interrupted: ToolEvent = { id: 'i', name: 'make_chart', done: true } // 历史里中断的调用:done 但没有结果
    for (const ev of [running, failed, parked, interrupted]) expect(cardEligible(ev), ev.id).toBe(false)
    const gated = (ev: ToolEvent) => (cardEligible(ev) ? cardOf(ev) : undefined)
    expect(partitionToolSegment([running, failed, parked], [], true, gated)).toEqual([{ t: 'tools', events: [running, failed, parked] }])
  })
})

describe('⑤ 名单刷新', () => {
  it('拉不到(后端没起)就清空,不留旧表继续认领', async () => {
    const { setTanguProbe } = await import('./tanguSeam')
    const { refreshEngineTools } = await import('./toolResultCards')
    useEngineTools.setState({ byEngine: { 'chart-engine': ['make_chart'] } })
    setTanguProbe({ activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {}, waitBackend: async () => null })
    try {
      await refreshEngineTools()
      expect(useEngineTools.getState().byEngine).toEqual({})
    } finally {
      setTanguProbe(null)
    }
  })
})

describe('④ 其余', () => {
  it('state 句柄按调用 id 交还', () => {
    cardStateHandle('c1').set({ zoom: 2 })
    expect(cardStateHandle('c1').get()).toEqual({ zoom: 2 })
    expect(cardStateHandle('c2').get()).toBeUndefined()
  })

  it('入参解析与卡片名', () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 })
    expect(parseToolArgs('not json')).toBe('not json')
    expect(parseToolArgs(undefined)).toEqual({})
    expect(toolCardTitle({ tool: 'make_chart', mount })).toBe('make_chart')
    expect(toolCardTitle({ tool: 'make_chart', title: () => '图表', mount })).toBe('图表')
    expect(toolCardTitle({ tool: 'make_chart', title: () => { throw new Error('x') }, mount })).toBe('make_chart')
  })
})
