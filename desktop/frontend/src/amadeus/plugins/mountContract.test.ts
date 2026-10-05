// @vitest-environment happy-dom
/**
 * 「dispose 之后 el 立刻归还插件」逐接口各钉一条(2026-10-04,隔离层下沉到 mountHostReact 之后)。
 * mountHostReact 与 React 都是真的;只把各接口最里面那棵重组件(BlockHost / PageView / 多维表 / 仪表盘格子 / Markdown 编辑器)
 * 换成桩 —— 这里钉的是「容器归谁」,不是它们画什么。容器契约本身见 mountHostReact.test.ts;ctx.tangu.mountChat 那条在 views/pluginChat.test.ts。
 * 负对照(2026-10-04 / 10-05 实跑):mountHostReact 换回「root 直接建在 el 上」→ 除 mountFloatingToc 外六个接口全红,三处断言都中
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
const { hasPageScope } = await import('../store/pageStore')

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

it('ctx.dashboard.mount 配方无效:提示住在宿主自己的节点里,dispose 只收它,插件放进 el 的节点不动', async () => {
  const own = el.appendChild(document.createElement('p'))
  let mounted!: ReturnType<typeof mountPluginDashboard>
  await act(async () => { mounted = mountPluginDashboard('contract', el, { recipe: { cards: 'nope' } as never }) })
  expect(mounted.scope).toBe('')
  expect(el.textContent).toContain('仪表盘配方无效')
  expect(own.isConnected).toBe(true)
  await act(async () => { mounted.dispose() })
  expect([...el.children]).toEqual([own])
})

// 所有权跟着句柄走(2026-10-05):插件没 dispose 上一份,就把同一个 el 交给了别的挂载 —— 上一份被收掉,它的句柄此后是哑的。
// 改之前 mountHostReact 认的是容器:旧句柄再 update() 一次就把后来那份换掉了(这四条在改之前实跑红;
// 改之后的负对照:再挂时不收前一份 / render 不看句柄死活 → 四条都红)。
const tableSpec = (name: string) => ({ id: 't', columns: [{ key: 'name', label: 'Name', kind: 'text' as const }], rows: [{ id: 'r1', cells: { name } }] })
describe.each<[name: string, start: (el: HTMLElement) => () => void]>([
  ['ctx.ui.mountChatBox → update', (el) => { const h = mountPluginChatBox(el, { value: '', onSubmit: async () => true }); return () => h.update({ placeholder: 'late' }) }],
  ['ctx.ui.mountMarkdownEditor → update', (el) => { const h = mountPluginMarkdownEditor(el, { value: 'a' }); return () => h.update({ value: 'late' }) }],
  ['ctx.ui.mountMarkdownEditor → insertMarkdown', (el) => { const h = mountPluginMarkdownEditor(el, { value: 'a' }); return () => h.insertMarkdown('late') }],
  ['ctx.table.mount → update', (el) => { const h = mountPluginTable('contract', el, tableSpec('x')); return () => h.update(tableSpec('late')) }],
])('旧句柄在 el 被后来的挂载接走之后是哑的:%s', (_name, start) => {
  it('后来那份原样留着,el 里只有它一层,它自己的 dispose 收得掉', async () => {
    let late!: () => void
    let disposeOther!: () => void
    await act(async () => { late = start(el) })
    await act(async () => { disposeOther = view.surface.mountNoteView(el) })
    const other = el.querySelector('.plugin-note-surface')
    expect(other?.isConnected).toBe(true)
    expect(el.childElementCount).toBe(1)

    await act(async () => { late() })
    expect(el.querySelector('.plugin-note-surface')).toBe(other)
    expect(el.childElementCount).toBe(1)

    await act(async () => { disposeOther() })
    expect(el.childElementCount).toBe(0)
    expect(errors).toEqual([])
  })
})

// 被后来的挂载收掉 = 完整的卸载,与显式 dispose 走同一条清理(2026-10-05 评审):不只是摘掉 React 树。
// 负对照(实跑红):各表面不接 mountHostReact 的 onDispose(只在自己的 dispose() 里清理)→ 三条都红。
describe('被后来的挂载收掉 = 完整的卸载', () => {
  it('Markdown 编辑器:旧句柄不再回写(onChange 不响),getValue 留着被收掉时的值', async () => {
    const onChange = vi.fn()
    let editor!: ReturnType<typeof mountPluginMarkdownEditor>
    let disposeOther!: () => void
    await act(async () => { editor = mountPluginMarkdownEditor(el, { value: 'a', onChange }) })
    await act(async () => { disposeOther = view.surface.mountNoteView(el) })
    await act(async () => { editor.insertMarkdown('late'); editor.update({ value: 'late' }); editor.focus() })
    expect(onChange).not.toHaveBeenCalled()
    expect(editor.getValue()).toBe('a')
    await act(async () => { editor.dispose(); disposeOther() })
    expect(el.childElementCount).toBe(0)
  })

  it('原生表:body 级弹层宿主一并收掉', async () => {
    const pops = () => document.querySelectorAll('body > .amx-plugtable-pops').length
    let disposeOther!: () => void
    await act(async () => { mountPluginTable('contract', el, tableSpec('x')) })
    expect(pops()).toBe(1)
    await act(async () => { disposeOther = view.surface.mountNoteView(el) })
    expect(pops()).toBe(0)
    await act(async () => { disposeOther() })
  })

  it('仪表盘:内存作用域的 pageStore 一并回收;配方无效的提示也是一份挂载(收掉前一份,自己也被后来的收掉)', async () => {
    const recipe = { cards: [{ kind: 'stat' as const, id: 'k', label: 'L', value: '1', w: 4, h: 2 }] }
    let first!: ReturnType<typeof mountPluginDashboard>
    await act(async () => { first = mountPluginDashboard('contract', el, { recipe }) })
    expect(hasPageScope(first.scope)).toBe(true)
    await act(async () => { mountPluginDashboard('contract', el, { recipe: { cards: 'nope' } as never }) })
    await vi.waitFor(() => expect(hasPageScope(first.scope)).toBe(false))
    expect(el.querySelector('[data-stub="dashboard"]')).toBeNull()
    expect(el.textContent).toContain('仪表盘配方无效')
    expect(el.childElementCount).toBe(1)
    let disposeOther!: () => void
    await act(async () => { disposeOther = view.surface.mountNoteView(el) })
    expect(el.textContent).not.toContain('仪表盘配方无效')
    await act(async () => { disposeOther() })
    expect(el.childElementCount).toBe(0)
  })
})
