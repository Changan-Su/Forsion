// @vitest-environment happy-dom
// 插件结果卡片的挂载与挪位置(对话 ↔ Desk):
//  ① 对话里挂渲染器,call 带 id / 工具名 / 解开的入参 / 结果 / 落点;卸载跑插件的清理;mount 抛错画 fallback(通用记录);
//  ② 「在 Desk 打开」:对话里那份先清理、换成占位卡,Desk 里重新 mount(surface=desk)并拿回 state;「收回到对话」反过来;
//  ③ 没有 Desk(context 为 null)只画卡片,不给「在 Desk 打开」;
//  ④ 落点 desk 的直播结果自动进 Desk 一次,收回之后同一次调用不再弹回去;手机 / Desk 关着不进。
// 负对照(已实跑红):showToolCardInDesk 不写 tool 字段 → ②「占位卡」红;placeLiveToolCard 去掉 autoPlaced 判断 → ④「不再弹回去」红。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolEvent, UiMessage } from '../types'

// 引擎插件名单:台架里由 listPlugins 的桩给(真实现走 HTTP)
const engineList: { current: Array<Record<string, unknown>> } = { current: [] }
vi.mock('../services/backendService', async (orig) => ({ ...(await orig<object>()), listPlugins: async () => engineList.current }))

const { usePluginStore } = await import('../amadeus/plugins/pluginStore')
const { setTanguProbe } = await import('../amadeus/plugins/tanguSeam')
const { useEngineTools, cardStateHandle, __resetToolCards } = await import('../amadeus/plugins/toolResultCards')
const { useApp } = await import('../stores/appStore')
const { PluginToolCard, ToolCardDeskContext, placeLiveToolCard, returnToolCardToChat, __resetToolCardPlacement } = await import('./PluginToolCard')
const { DeskToolCardPane } = await import('../views/chat2/DeskToolCardPane')
type Contribution = import('../amadeus/plugins/types').ToolResultRendererContribution
type Call = import('../amadeus/plugins/types').ToolResultCall

const SID = 's1'
const ev: ToolEvent = { id: 'call-1', name: 'make_chart', arguments: '{"rows":3}', result: 'chart ok', done: true }
const log: string[] = []
let lastCall: Call | null = null

function install(over: Partial<Contribution> = {}): Contribution {
  const item: Contribution = {
    tool: 'make_chart',
    surface: 'inline',
    title: '图表',
    mount: (el, call) => {
      lastCall = call
      log.push(`mount:${call.surface}:${String(call.state.get() ?? '')}`)
      el.textContent = `chart for ${call.id}`
      if (call.surface === 'inline') call.state.set('zoom=2')
      return () => { log.push(`cleanup:${call.surface}`) }
    },
    ...over,
  }
  usePluginStore.setState({
    plugins: [{ id: 'chart', name: '图表插件', version: '0', setup: () => {}, bundle: { agents: [], enginePlugins: ['chart-engine'], skills: [], spaces: [] } }],
    toolResultRenderers: [{ pluginId: 'chart', item }],
  })
  useEngineTools.setState({ byEngine: { 'chart-engine': ['make_chart'] } })
  return item
}

let host: HTMLDivElement
let root: Root
const OWNED = [{ id: 'chart-engine', enabled: true, active: true, tools: ['make_chart'] }]
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  __resetToolCards()
  __resetToolCardPlacement()
  // 宿主刷名单时(渲染器一注册就刷)拿到的与 install() 塞进去的是同一份;拉不到会清空(fail closed)
  engineList.current = OWNED
  setTanguProbe({ activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {}, waitBackend: async () => ({ backendUrl: 'http://127.0.0.1:1', token: 't' }) as never })
  log.length = 0
  lastCall = null
  const msg = { id: 'm1', role: 'assistant', content: '', status: 'done', timestamp: 1, toolEvents: [ev] } as unknown as UiMessage
  useApp.setState({ messagesBySession: { [SID]: [msg] }, deskBySession: {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setTanguProbe(null)
})

/** 一块对话 + 它的 Desk(同 ChatView:context 给会话 id,Desk 条目里有这次调用才画 Desk 那格)。 */
function Chat({ desk = true, onQuote }: { desk?: boolean; onQuote?: (t: string) => void }) {
  const claim = { pluginId: 'chart', item: usePluginStore((s) => s.toolResultRenderers[0]?.item) }
  const inDesk = useApp((s) => s.deskBySession[SID]?.items.some((it) => it.tool?.callId === ev.id))
  return React.createElement(ToolCardDeskContext.Provider, { value: desk ? SID : null },
    claim.item && React.createElement(PluginToolCard, { event: ev, claim: claim as never, onQuote, fallback: React.createElement('div', { 'data-fallback': '' }, 'generic') }),
    inDesk && React.createElement('div', { 'data-desk': '' }, React.createElement(DeskToolCardPane, { sessionId: SID, callId: ev.id })))
}
const render = (props: { desk?: boolean; onQuote?: (t: string) => void } = {}) => act(async () => root.render(React.createElement(Chat, props)))
const click = (sel: string) => act(async () => { (host.querySelector(sel) as HTMLButtonElement).click() })

describe('① 对话里挂载', () => {
  it('call 的字段;卸载跑清理', async () => {
    install()
    await render()
    expect(host.querySelector('[data-plugin-tool-card-body="inline"]')?.textContent).toBe('chart for call-1')
    expect(host.querySelector('.sketch-card-title')?.textContent).toBe('图表 · 图表插件')
    expect(lastCall).toMatchObject({ id: 'call-1', tool: 'make_chart', args: { rows: 3 }, result: 'chart ok', surface: 'inline' })
    await act(async () => root.render(React.createElement('div')))
    expect(log).toEqual(['mount:inline:', 'cleanup:inline'])
  })

  it('mount 抛错 → 画 fallback(通用记录)', async () => {
    install({ mount: () => { throw new Error('boom') } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render()
    expect(host.querySelector('[data-fallback]')).not.toBeNull()
    expect(host.querySelector('[data-plugin-tool-card-body]')).toBeNull()
    // 插件重载、换上好的渲染器 → 自动挂回来(不能卡在 fallback 上)
    await act(async () => { install() })
    expect(host.querySelector('[data-fallback]')).toBeNull()
    expect(host.querySelector('[data-plugin-tool-card-body="inline"]')?.textContent).toBe('chart for call-1')
    err.mockRestore()
  })

  it('quote 走调用方给的引用口,截掉首尾空白', async () => {
    install()
    const quotes: string[] = []
    await render({ onQuote: (t) => quotes.push(t) })
    lastCall!.quote('  选中的两行  ')
    lastCall!.quote('   ')
    expect(quotes).toEqual(['选中的两行'])
  })
})

describe('② 挪位置', () => {
  it('在 Desk 打开 → 旧的先清理、留占位卡、Desk 里拿回 state;收回到对话 → 反过来', async () => {
    install()
    await render()
    await click('[data-act="tool-card-desk"]')
    expect(useApp.getState().deskBySession[SID]).toMatchObject({ mode: 'open', size: 'half', items: [{ tool: { callId: 'call-1' }, name: '图表' }] })
    expect(host.querySelector('[data-plugin-tool-stub]')?.textContent).toContain('正在 Desk 中显示')
    expect(host.querySelector('[data-desk] [data-plugin-tool-card-body="desk"]')?.textContent).toBe('chart for call-1')
    expect(log).toEqual(['mount:inline:', 'cleanup:inline', 'mount:desk:zoom=2'])

    await click('[data-act="tool-card-back"]')
    expect(useApp.getState().deskBySession[SID]).toMatchObject({ items: [], mode: undefined })
    expect(host.querySelector('[data-plugin-tool-stub]')).toBeNull()
    expect(host.querySelector('[data-desk]')).toBeNull()
    expect(log.slice(3)).toEqual(['cleanup:desk', 'mount:inline:zoom=2'])
  })

  it('用户拖过 Desk 宽度就不改宽度;Desk 里原有的第二格留着', async () => {
    install()
    useApp.setState({ deskBySession: { [SID]: { items: [{ key: 'a', path: '/a.md', name: 'a.md', at: 1 }, { key: 'b', path: '/b.md', name: 'b.md', at: 1 }], size: 'wide', userResized: true } } })
    await render()
    await click('[data-act="tool-card-desk"]')
    const d = useApp.getState().deskBySession[SID]
    expect(d.size).toBe('wide')
    expect(d.items.map((x) => x.tool?.callId ?? x.key)).toEqual(['call-1', 'b'])
    returnToolCardToChat(SID, 'call-1')
    expect(useApp.getState().deskBySession[SID].items.map((x) => x.key)).toEqual(['b'])
    expect(useApp.getState().deskBySession[SID].mode).toBe('open') // 还有别的格:侧板留着
  })
})

describe('③ 没有 Desk', () => {
  it('只画卡片;Desk 快照里有这次调用也不画占位卡', async () => {
    install()
    useApp.setState({ deskBySession: { [SID]: { items: [{ key: 'tool:call-1', path: '', name: '图表', at: 1, tool: { callId: 'call-1' } }], size: 'half' } } })
    await act(async () => root.render(React.createElement(ToolCardDeskContext.Provider, { value: null },
      React.createElement(PluginToolCard, { event: ev, claim: { pluginId: 'chart', item: usePluginStore.getState().toolResultRenderers[0].item }, fallback: null })))
    )
    expect(host.querySelector('[data-plugin-tool-stub]')).toBeNull()
    expect(host.querySelector('[data-act="tool-card-desk"]')).toBeNull()
    expect(host.querySelector('[data-plugin-tool-card-body="inline"]')).not.toBeNull()
  })
})

describe('④ 落点 desk 的直播结果', () => {
  it('自动进 Desk 一次;收回之后不再弹回去', async () => {
    install({ surface: 'desk' })
    useApp.setState({ desktopConfig: { agentDeskEnabled: true } as never })
    await placeLiveToolCard(SID, 'call-1')
    expect(useApp.getState().deskBySession[SID]?.items[0]?.tool).toEqual({ callId: 'call-1' })
    returnToolCardToChat(SID, 'call-1')
    await placeLiveToolCard(SID, 'call-1') // SSE 重放 / 又来一次
    expect(useApp.getState().deskBySession[SID].items).toEqual([])
  })

  it('结果先到、名单后到(引擎半身晚激活):重拉一次名单再放进 Desk', async () => {
    install({ surface: 'desk' })
    useEngineTools.setState({ byEngine: {} })
    useApp.setState({ desktopConfig: { agentDeskEnabled: true } as never })
    await placeLiveToolCard(SID, 'call-1')
    expect(useApp.getState().deskBySession[SID]?.items[0]?.tool).toEqual({ callId: 'call-1' })
  })

  it('落点 inline、Desk 关着、或者引擎不报这个工具的都不进', async () => {
    install()
    useApp.setState({ desktopConfig: { agentDeskEnabled: true } as never })
    await placeLiveToolCard(SID, 'call-1')
    install({ surface: 'desk' })
    useApp.setState({ desktopConfig: { agentDeskEnabled: false } as never })
    await placeLiveToolCard(SID, 'call-1')
    useApp.setState({ desktopConfig: { agentDeskEnabled: true } as never })
    useEngineTools.setState({ byEngine: {} })
    engineList.current = [] // 重拉一次也拿不到
    await placeLiveToolCard(SID, 'call-1')
    expect(useApp.getState().deskBySession[SID]).toBeUndefined()
    expect(cardStateHandle('call-1').get()).toBeUndefined()
  })
})
