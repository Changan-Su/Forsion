// @vitest-environment happy-dom
/**
 * 「dispose 之后 el 立刻归还插件」逐接口各钉一条(2026-10-04,隔离层下沉到 mountHostReact 之后)。
 * mountHostReact 与 React 都是真的;只把各接口最里面那棵重组件(BlockHost / PageView / 多维表 / 仪表盘格子 / Markdown 编辑器)
 * 换成桩 —— 这里钉的是「容器归谁」,不是它们画什么。容器契约本身见 mountHostReact.test.ts;ctx.tangu.mountChat 那条在 views/pluginChat.test.ts。
 * 负对照(2026-10-04 实跑):mountHostReact 换回「root 直接建在 el 上」→ 除 mountFloatingToc 外六个接口全红,三处断言都中
 * (el 里还留着宿主的节点 / 同一拍再挂的那份不在文档里 / 卸载抛 NotFoundError)。mountFloatingToc 一直挂在它自己加的 layer 里,
 * 旧实现下也是绿的,这条只是把契约钉住。最后一条(配方无效的提示)的负对照:改回 `el.textContent = …` + `el.replaceChildren()` → 红(实跑)。
 */
import { act, createContext, createElement as h } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ amadeus: undefined }))
vi.mock('../components/BlockHost', () => ({
  BlockHost: ({ blockId }: { blockId: string }) => h('div', { 'data-stub': 'block' }, blockId),
  BlockSurfaceContext: createContext(null),
}))
vi.mock('../components/PageView', () => ({ PageView: () => null }))
vi.mock('../chrome/pageChrome', () => ({ NoteCover: () => null }))
vi.mock('../../amadeusViews', () => ({ Breadcrumb: () => null, NoteTitle: () => null }))
vi.mock('../../amadeusProperties', () => ({ AmadeusPropertiesPanel: () => null }))
vi.mock('../../views/DashboardGridView', () => ({ DashboardGridView: () => h('div', { 'data-stub': 'dashboard' }) }))
vi.mock('../blocks', () => ({}))
vi.mock('../blocks/database/DatabaseEmbed', () => ({ DatabaseEmbed: () => null }))
vi.mock('../blocks/markdown/MarkdownBlock', () => ({ PlainMarkdownEditor: () => null }))

const { createPluginViewSurface } = await import('./viewSurface')
const { mountPluginChatBox } = await import('./chatBoxSurface')
const { mountPluginMarkdownEditor } = await import('./markdownEditorSurface')
const { mountPluginTable } = await import('./tableSurface')
const { mountPluginDashboard } = await import('./dashboardSurface')
const { mountPluginFloatingToc } = await import('./floatingTocSurface')
const { useApp } = await import('../../stores/appStore')

// 插件文件类型的视图表面:mountBlocks 与 mountNoteView 都从它身上来
const view = createPluginViewSurface('contract', 'plug:mount-contract', ['.mindmap.md'])
afterAll(() => view.dispose())

type Mount = (el: HTMLElement) => () => void
const cases: Array<[name: string, mount: Mount, selector: string]> = [
  ['ctx.app.mountBlocks', (el) => view.surface.mountBlocks(el, { blockId: 'b1', token: view.surface.getPage().token }), '[data-stub="block"]'],
  ['mountNoteView(插件文件视图)', (el) => view.surface.mountNoteView(el), '.plugin-note-surface'],
  ['ctx.ui.mountChatBox', (el) => mountPluginChatBox(el, { value: '', onSubmit: async () => true }).dispose, 'textarea'],
  ['ctx.ui.mountMarkdownEditor', (el) => mountPluginMarkdownEditor(el, { value: '# a' }).dispose, '.amx-publishing-editor'],
  ['ctx.table.mount', (el) => mountPluginTable('contract', el, { id: 't', columns: [{ key: 'name', label: 'Name', kind: 'text' }], rows: [{ id: 'r1', cells: { name: 'x' } }] }).dispose, '.amx-plugtable'],
  ['ctx.dashboard.mount', (el) => mountPluginDashboard('contract', el, { recipe: { cards: [{ kind: 'stat', id: 'k', label: 'L', value: '1', w: 4, h: 2 }] } }).dispose, '[data-stub="dashboard"]'],
  ['ctx.ui.mountFloatingToc', (el) => mountPluginFloatingToc(el, { scrollContainer: el }).dispose, '.lcl-ftoc-mount-layer'],
]

let el: HTMLDivElement
const errors: unknown[] = []
const onError = (e: ErrorEvent): void => { errors.push(e.error ?? e.message); e.preventDefault() }
const flush = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  useApp.setState({ newChatModel: 'm', modelsResp: { directProviders: [], models: [{ id: 'm', name: 'M', provider: 'test', source: 'direct' }], defaultModelId: 'm' } })
  el = document.createElement('div')
  document.body.append(el)
  errors.length = 0
  window.addEventListener('error', onError)
})
afterEach(() => {
  window.removeEventListener('error', onError)
  el.remove()
  vi.unstubAllGlobals()
})

describe.each(cases)('%s', (_name, mount, selector) => {
  it('dispose → 清空 el → 同一拍再挂:新的那份在文档里;再 dispose → 清空 el、不再挂:卸载不报错', async () => {
    let dispose!: () => void
    await act(async () => { dispose = mount(el) })
    const first = el.querySelector(selector)
    expect(first?.isConnected).toBe(true)

    await act(async () => {
      dispose()
      expect.soft(el.childElementCount, 'dispose 之后 el 里不留宿主的节点').toBe(0)
      el.replaceChildren()
      dispose = mount(el)
    })
    const second = el.querySelector(selector)
    expect.soft(second?.isConnected, '同一拍再挂的那份在文档里').toBe(true)
    expect.soft(second).not.toBe(first)

    let thrown: unknown = null
    try {
      await act(async () => { dispose(); el.replaceChildren() })
      await flush()
    } catch (e) { thrown = e }
    expect.soft([thrown, ...errors].filter(Boolean).map(String), '卸载不报错').toEqual([])
    expect.soft(el.childElementCount).toBe(0)
  })
})

it('ctx.dashboard.mount 配方无效:提示住在宿主自己的节点里,dispose 只收它,插件放进 el 的节点不动', () => {
  const own = el.appendChild(document.createElement('p'))
  const mounted = mountPluginDashboard('contract', el, { recipe: { cards: 'nope' } as never })
  expect(mounted.scope).toBe('')
  expect(el.textContent).toContain('仪表盘配方无效')
  expect(own.isConnected).toBe(true)
  mounted.dispose()
  expect([...el.children]).toEqual([own])
})
