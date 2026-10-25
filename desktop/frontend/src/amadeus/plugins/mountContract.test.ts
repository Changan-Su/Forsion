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
// 白板引擎是运行时用 <script> 装的 6 MB 单文件,这里换成桩(ctx.ui.mountBoard,2026-10-10)
vi.mock('../blocks/excalidraw/forkRuntime', () => ({
  Excalidraw: () => h('div', { 'data-stub': 'board' }), MainMenu: () => null, CaptureUpdateAction: { NEVER: 'never' },
  restoreElements: (e: unknown[]) => e, newElementWith: (e: unknown) => e, serializeAsJSON: () => '', exportToSvg: async () => null, getCommonBounds: () => [0, 0, 0, 0],
}))

const { createPluginViewSurface } = await import('./viewSurface')
const { mountPluginChatBox } = await import('./chatBoxSurface')
const { mountPluginMarkdownEditor } = await import('./markdownEditorSurface')
const { mountPluginTable } = await import('./tableSurface')
const { mountPluginDashboard } = await import('./dashboardSurface')
const { mountPluginFloatingToc } = await import('./floatingTocSurface')
const { mountPluginBoard } = await import('./boardSurface')
const { mountPluginSettingsPage, mountPluginSettingsItem } = await import('./settingsPageSurface')
const { useApp } = await import('../../stores/appStore')
await import('../../tangu/store/standalone')
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
  ['ctx.ui.mountBoard', (el) => mountPluginBoard(el, { scene: { elements: [] }, viewport: { scrollX: 0, scrollY: 0, zoom: 1 } }).dispose, '[data-stub="board"]'],
  ['ctx.ui.mountSettingsPage', (el) => mountPluginSettingsPage(el, { groups: [{ id: 'g', title: 'G', items: [{ type: 'value', id: 'v', title: 'V', value: '1' }] }] }).dispose, '.settings-panel'],
  ['ctx.ui.mountSettingsItem', (el) => mountPluginSettingsItem(el, { type: 'value', id: 'v', title: 'V', value: '1' }).dispose, '.settings-value'],
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

// 不带模式切换排(2026-10-12):插件把编辑器放进自己的卡片 / 单元格里时,只要编辑器本身。
// 负对照(实跑):不认 modes 的旧实现 → 第一条「0 个按钮」就红。
it('ctx.ui.mountMarkdownEditor modes:false:不画「编辑 / 源码 / 预览」那一排;update 能关能开,关的那一刻停在源码档也回到可视编辑器', async () => {
  const row = () => el.querySelectorAll<HTMLElement>('button[aria-pressed]')
  let handle!: ReturnType<typeof mountPluginMarkdownEditor>
  await act(async () => { handle = mountPluginMarkdownEditor(el, { value: '# a', modes: false }) })
  expect(el.querySelector('.amx-publishing-editor')).not.toBeNull()
  expect(row().length).toBe(0)

  await act(async () => { handle.update({ modes: true }) })
  expect(row().length, '缺省(以及显式打开)是三档').toBe(3)
  await act(async () => { row()[1].click() }) // 切到源码档
  expect(el.querySelector('textarea')).not.toBeNull()

  await act(async () => { handle.update({ modes: false }) })
  expect(row().length).toBe(0)
  expect(el.querySelector('textarea'), '没有切换排就不该停在源码档').toBeNull()
  await act(async () => { handle.dispose() })

  await act(async () => { handle = mountPluginMarkdownEditor(el, { value: '# a' }) })
  expect(row().length, '不传这个选项:三档照旧').toBe(3)
  await act(async () => { handle.dispose() })
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

// 划线条(2026-10-13):条和结果卡是 body 下的浮层,插件的元素里一个节点都不加(所以不在上面那张「el 归还」的表里)。
// 走真的 ctx.ui.mountSelectionBar:表面是懒加载的,装好之前的 show() 要补上;停用插件 = 条和它的宿主层一起收。
// 负对照(2026-10-13 实跑):pluginStore 里那份挂载不进 scope.own → 「停用即收」红;装好之后不补 show() → 第一条「出条」红。
it('ctx.ui.mountSelectionBar:不往插件的元素里加节点;show() 出条、视图工具拿到选中的文字;hide() 收;停用插件连宿主层一起收', async () => {
  const { usePluginStore } = await import('./pluginStore')
  const bar = () => document.querySelector<HTMLElement>('[data-testid="selection-bar"]')
  const layers = () => document.querySelectorAll('body > div[hidden]').length
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const rect = { left: 10, right: 60, top: 100, bottom: 120 }
  const before = layers()
  const run = vi.fn()
  let ctx!: import('./types').PluginContext
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, selectionActions: [] })
  usePluginStore.getState().init([{ id: 'selbar', name: 'selbar', version: '0', setup: (c) => { ctx = c } }])

  let handle!: import('./types').PluginSelectionBarHandle
  await act(async () => {
    handle = ctx.ui!.mountSelectionBar!(el, { view: 'reader', watch: false, ask: false, tools: [{ id: 'yellow', title: 'Yellow', color: '#fd0', run }] })
    handle.show({ text: ' hello ', rect }) // 表面还没装好:记着,装好补上
  })
  await vi.waitFor(async () => { await settle(); expect(bar()).not.toBeNull() })
  expect(bar()!.dataset.view).toBe('selbar:reader')
  expect(el.childElementCount).toBe(0)
  expect(layers()).toBe(before + 1)

  await act(async () => { bar()!.querySelector('[data-act="yellow"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
  expect(run).toHaveBeenCalledWith({ text: 'hello' })

  await act(async () => { handle.hide() })
  expect(bar()).toBeNull()
  await act(async () => { handle.show({ text: '', rect }) }) // 没有文字:不出
  expect(bar()).toBeNull()

  await act(async () => { handle.show({ text: 'again', rect }) })
  expect(bar()).not.toBeNull()
  await act(async () => { usePluginStore.getState().disable('selbar') })
  expect(bar(), '停用即收').toBeNull()
  expect(layers(), '宿主层也摘掉').toBe(before)
  await act(async () => { handle.show({ text: 'late', rect }) }) // 收掉之后句柄是哑的
  expect(bar()).toBeNull()
  expect(errors).toEqual([])
})

// 评审(2026-10-14)指出的四处,各钉一条。负对照(实跑,逐条改回去):主动报的选区滚动时不跟着收 → 「滚动即收」红;
// 右键也执行 → 「右键不触发」红;Esc 不看焦点在哪 → 「别处输入框的 Esc」红;markdown 照 2000 字截 → 最后一条红。
it('ctx.ui.mountSelectionBar(缺省看选区):show() 报的也随滚动收;右键不触发工具;别处输入框里的 Esc 不被吃;markdown 不截断', async () => {
  const { mountPluginSelectionBar } = await import('./selectionBarSurface')
  const bar = () => document.querySelector<HTMLElement>('[data-testid="selection-bar"]')
  const rect = { left: 10, right: 60, top: 100, bottom: 120 }
  const md = 'm'.repeat(3000)
  const run = vi.fn()
  let handle!: ReturnType<typeof mountPluginSelectionBar>
  await act(async () => { handle = mountPluginSelectionBar(el, 'contract', { ask: false, tools: [{ id: 'note', title: 'Note', icon: 'annotate', run }] }) })
  await act(async () => { handle.show({ text: 'hello', markdown: md, rect }) })
  const tool = bar()!.querySelector('[data-act="note"]')!

  await act(async () => { tool.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 })) })
  expect(run, '右键不触发').not.toHaveBeenCalled()
  await act(async () => { tool.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })) })
  expect(run).toHaveBeenCalledWith({ text: 'hello', markdown: md })

  // 焦点在别处的输入框(命令面板、搜索框):Esc 是它的,条不吃也不收
  const input = document.body.appendChild(document.createElement('input'))
  input.focus()
  const esc = (): KeyboardEvent => { const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); input.dispatchEvent(e); return e }
  let e1!: KeyboardEvent
  await act(async () => { e1 = esc() })
  expect(e1.defaultPrevented, '别处输入框的 Esc').toBe(false)
  expect(bar()).not.toBeNull()
  input.blur()
  input.remove()
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(bar(), '焦点不在输入框里:Esc 收条').toBeNull()

  await act(async () => { handle.show({ text: 'hello', rect }) })
  expect(bar()).not.toBeNull()
  await act(async () => { el.dispatchEvent(new Event('scroll')) })
  expect(bar(), '滚动即收').toBeNull()
  await act(async () => { handle.dispose() })
  expect(errors).toEqual([])
})

// 自己报选区的视图(PDF 阅读器)滚动 / 缩放时都要 hide():只收条,已经开着的结果卡留着(和聊天里滚动时一样)。
// 负对照(2026-10-14 实跑):hide() 照旧无条件重挂 → 「卡还在」红。
it('ctx.ui.mountSelectionBar({ watch: false }):hide() 只收条,开着的结果卡不跟着没', async () => {
  const { mountPluginSelectionBar } = await import('./selectionBarSurface')
  const { usePluginStore } = await import('./pluginStore')
  const bar = () => document.querySelector<HTMLElement>('[data-testid="selection-bar"]')
  const card = () => document.querySelector<HTMLElement>('[data-testid="inline-ai-panel"]')
  const press = (n: Element) => act(async () => { n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
  usePluginStore.setState({ selectionActions: [{ pluginId: 'contract', item: { id: 'sum', title: 'Sum', scope: 'own', run: async () => 'summary' } }] })
  let handle!: ReturnType<typeof mountPluginSelectionBar>
  await act(async () => { handle = mountPluginSelectionBar(el, 'contract', { watch: false, ask: false }) })
  await act(async () => { handle.show({ text: 'hello', rect: { left: 10, right: 60, top: 100, bottom: 120 } }) })
  await press(bar()!.querySelector('[data-act="more"]')!)
  await press(document.querySelector('[data-testid="selbar-more"] [role="menuitem"]')!)
  expect(card()).not.toBeNull()
  expect(bar(), '开卡时条收起').toBeNull()
  await act(async () => { handle.hide() })
  expect(card(), '卡还在').not.toBeNull()
  await act(async () => { handle.dispose() })
  expect(card()).toBeNull()
  usePluginStore.setState({ selectionActions: [] })
  expect(errors).toEqual([])
})

// 落点提示(2026-10-24):ctx.ui.dropIndicator 是 LCL 那一份;传视口坐标落位,停用插件即收、句柄变哑。
it('ctx.ui.dropIndicator:线 / 描边按视口坐标落位,停用插件即收,之后句柄是哑的', async () => {
  const { usePluginStore } = await import('./pluginStore')
  const ind = () => document.querySelector<HTMLElement>('.lcl-drop-ind')
  let ctx!: import('./types').PluginContext
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, selectionActions: [] })
  usePluginStore.getState().init([{ id: 'dropper', name: 'dropper', version: '0', setup: (c) => { ctx = c } }])
  const d = ctx.ui!.dropIndicator!()
  d.line({ x: 12, y: 40, w: 200 }, { key: 'row-2' })
  expect(ind()!.style.display).toBe('block')
  expect([ind()!.style.left, ind()!.style.top, ind()!.style.width]).toEqual(['12px', '40px', '200px'])
  d.zone({ x: 0, y: 0, w: 80, h: 30 }, { key: 'folder-1' })
  expect(ind()!.classList.contains('lcl-drop-ind--zone')).toBe(true)
  d.hide()
  expect(ind()!.style.display).toBe('none')
  await act(async () => { usePluginStore.getState().disable('dropper') })
  expect(ind(), '停用即收').toBeNull()
  d.line({ x: 1, y: 1, w: 10 })
  expect(ind(), '句柄已哑').toBeNull()
  expect(() => ctx.ui!.dropIndicator!().line({ x: 0, y: 0, w: 1 })).not.toThrow() // 停用之后:哑句柄,不抛
  expect(errors).toEqual([])
})

// 松手落位(2026-10-25):句柄上的 land 是 LCL 那一份;给元素就落,给查找函数就等它换了地方再落;停用时飞着的、等着的一起收。
it('ctx.ui.dropIndicator().land:落位写内联过渡、停用即还原,之后是哑的', async () => {
  const { usePluginStore } = await import('./pluginStore')
  let ctx!: import('./types').PluginContext
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, selectionActions: [] })
  usePluginStore.getState().init([{ id: 'lander', name: 'lander', version: '0', setup: (c) => { ctx = c } }])
  const row = document.createElement('div')
  document.body.appendChild(row)
  row.getBoundingClientRect = () => ({ left: 0, top: 100, x: 0, y: 100, width: 200, height: 28, right: 200, bottom: 128, toJSON() {} }) as DOMRect
  const d = ctx.ui!.dropIndicator!()
  expect(typeof d.land).toBe('function')
  d.land!(row, { x: 0, y: 40 })
  expect(row.style.transition, '在飞').toContain('transform')
  d.land!(row, { x: Number.NaN, y: 0 } as { x: number; y: number }) // 坏坐标:不抛、不动
  d.land!(() => { throw new Error('boom') }, { x: 0, y: 0 }) // 查找函数抛错:吞掉
  await act(async () => { usePluginStore.getState().disable('lander') })
  expect(row.style.transition, '停用即还原').toBe('')
  d.land!(row, { x: 0, y: 40 })
  expect(row.style.transition, '句柄已哑').toBe('')
  row.remove()
  expect(errors).toEqual([])
})

// 提示框(2026-10-23):ctx.ui.attachTooltip 用的是宿主那一份(LCL hoverSurface),插件元素里不加节点;停用插件即收、句柄变哑。
// 负对照(实跑):pluginStore 里那份不进 scope.own → 「停用即收」红。
it('ctx.ui.attachTooltip:悬停出宿主提示框、不往插件元素里加节点;停用插件即收,之后句柄是哑的', async () => {
  const { usePluginStore } = await import('./pluginStore')
  const tip = () => document.querySelector<HTMLElement>('.lcl-tip[data-open]')
  let ctx!: import('./types').PluginContext
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, selectionActions: [] })
  usePluginStore.getState().init([{ id: 'tipper', name: 'tipper', version: '0', setup: (c) => { ctx = c } }])
  const handle = ctx.ui!.attachTooltip!(el, ['Export', 'Saves a copy'], { side: 'bottom' })
  el.dispatchEvent(new MouseEvent('mouseenter'))
  await vi.waitFor(() => expect(tip()).not.toBeNull(), { timeout: 1000 })
  expect(tip()!.textContent).toBe('ExportSaves a copy')
  expect(el.childElementCount).toBe(0)
  handle.update('Export now')
  await vi.waitFor(() => expect(tip()!.textContent).toBe('Export now'))
  await act(async () => { usePluginStore.getState().disable('tipper') })
  await vi.waitFor(() => expect(document.querySelector('.lcl-tip'), '停用即收').toBeNull())
  el.dispatchEvent(new MouseEvent('mouseleave'))
  el.dispatchEvent(new MouseEvent('mouseenter'))
  await new Promise((r) => setTimeout(r, 400))
  expect(document.querySelector('.lcl-tip'), '句柄已哑').toBeNull()
  expect(() => ctx.ui!.attachTooltip!({} as HTMLElement, 'x')).not.toThrow() // 停用之后:哑句柄,不抛
  expect(errors).toEqual([])
})
