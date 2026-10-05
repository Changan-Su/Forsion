// @vitest-environment happy-dom
/**
 * 可覆盖的内置文件类型(2026-10-05 用户定:内置视图是兜底,插件可以覆盖;目前只放开 `.pdf`)。
 * 钉四件事:
 *  ① 注册:可覆盖后缀 + 显式 override: true 才收;不写 override 照旧拒;不可覆盖的内置后缀写了 override 也拒。
 *  ② 查表:findFileType 对可覆盖后缀只认 override 贡献;插件一停,同一路径立刻查不到(= 回落内置)。
 *  ③ 毁档防线:页表面的 loadPage 只放行 `.md` 类后缀 —— 插件对 `x.pdf` 调 loadPage 必须被拒
 *     (放行 = PDF 被拽进笔记管线,一存就是 markdown)。
 *  ④ 开发副本:`.md` 类后缀照旧拒(笔记管线不保护开发根),非 md 后缀可以注册。
 *  ⑤ 默认打开方式:用户设成内置 → 有插件接管也查不到;指定某个插件 → 它赢过先注册的;
 *     指定的插件不在了 → 回到自动(设置页的下拉框也按自动报,不吃匹配不上的值)。
 * 负对照(2026-10-05 实跑):findFileType 去掉 `o.item.override === true` → ② 红;viewSurface 的 claims 去掉
 * isPagePipelinePath → ③ / ③b 红;registerFileType 的 taken() 去掉 override 判定 → ① 红;ctx.app.loadPage 去掉闸 → ③b 红。
 * ⑤ 的负对照(同日实跑):findFileType 去掉「设成内置就不给」那一行 → 「设成内置」红;候选里不按选择挑、
 * 一律取第一个 → 「指定第二个插件」红;fileOpenerChoice 原样报存着的值 → 「指定的插件不在了」红。
 */
import { createContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ amadeus: undefined }))
vi.mock('../components/BlockHost', () => ({ BlockHost: () => null, BlockSurfaceContext: createContext(null) }))
vi.mock('../components/PageView', () => ({ PageView: () => null }))
vi.mock('../chrome/pageChrome', () => ({ NoteCover: () => null }))
vi.mock('../../amadeusViews', () => ({ Breadcrumb: () => null, NoteTitle: () => null }))
vi.mock('../../amadeusProperties', () => ({ AmadeusPropertiesPanel: () => null }))
const nav = vi.hoisted(() => ({ openNote: vi.fn(), openFile: vi.fn() }))
vi.mock('../../amadeusNav', () => nav)

const { usePluginStore, findFileType, matchFileType, fileTypeBaseName, setFileOpener, syncFileOpeners, fileOpenerChoice, FILE_OPENERS_KEY, BUILTIN_OPENER } = await import('./pluginStore')
const { createPluginViewSurface } = await import('./viewSurface')
const { pageStoreFor, usePageStore } = await import('../store/pageStore')
await import('../../amadeusNav') // 先把桩模块求值一次:两次并发的首次动态 import 在 vitest 里拿到的不是同一份导出
type Ctx = import('./types').PluginContext
type FileType = import('./types').FileTypeContribution

function ctxOf(id: string, extra?: { dev?: boolean }): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, fileTypes: [] })
  usePluginStore.getState().init([{ id, name: id, version: '0', ...extra, setup: (c) => { ref = c } }])
  return ref!
}
const ft = (extensions: string[], override?: boolean): FileType => ({ id: 't', extensions, ...(override === undefined ? {} : { override }), mount: () => {} })

afterEach(() => { vi.restoreAllMocks() })

describe('① registerFileType:覆盖必须是显式的,而且只对可覆盖的后缀', () => {
  it('.pdf + override: true → 注册成功', () => {
    expect(ctxOf('pdf-edit').registerFileType(ft(['.pdf'], true))).toBe(true)
    expect(usePluginStore.getState().fileTypes).toHaveLength(1)
  })

  it('.pdf 不写 override → 照旧拒(旧插件碰巧声明同名后缀不得接管)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ctxOf('old').registerFileType(ft(['.pdf']))).toBe(false)
    expect(ctxOf('old2').registerFileType(ft(['.pdf'], false))).toBe(false)
    expect(usePluginStore.getState().fileTypes).toHaveLength(0)
  })

  it('不可覆盖的内置后缀写了 override 也拒', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const ext of ['.db', '.excalidraw.md', '.png']) {
      expect(ctxOf('greedy').registerFileType(ft([ext], true)), ext).toBe(false)
    }
  })

  it('混着声明:认领不了的内置后缀从贡献里剔掉,只留认领得了的', () => {
    expect(ctxOf('mixed').registerFileType(ft(['.pdf', '.excalidraw.md', '.db', '.foo.md'], true))).toBe(true)
    expect(usePluginStore.getState().fileTypes[0].item.extensions).toEqual(['.pdf', '.foo.md'])
    expect(ctxOf('mixed2').registerFileType(ft(['.pdf', '.foo.md']))).toBe(true) // 没写 override:.pdf 也剔掉
    expect(usePluginStore.getState().fileTypes[0].item.extensions).toEqual(['.foo.md'])
  })
})

describe('② findFileType:可覆盖后缀只认 override 贡献,其余内置后缀谁也抢不到', () => {
  const overriding = { item: ft(['.pdf'], true) }
  const plain = { item: ft(['.pdf', '.foo']) }
  const greedy = { item: ft(['.pdf', '.db', '.png'], true) }

  it('命中 override 贡献;同后缀但没写 override 的贡献不算', () => {
    expect(findFileType([plain, overriding], '论文/A.PDF')).toBe(overriding.item)
    expect(findFileType([plain], 'A.pdf')).toBeUndefined()
    expect(findFileType([plain], 'x.foo')).toBe(plain.item) // 它自己的非内置后缀不受影响
  })

  it('混着声明不可覆盖后缀的 override 贡献:.pdf 归它,.db / 图片照旧归内置', () => {
    expect(findFileType([greedy], 'a.pdf')).toBe(greedy.item)
    expect(findFileType([greedy], '库.db')).toBeUndefined()
    expect(findFileType([greedy], '图.png')).toBeUndefined()
  })

  it('库外的 PDF(绝对路径,聊天引用里的本机文件)不归插件:插件只读得到库内路径', () => {
    expect(findFileType([overriding], '/Users/me/Downloads/a.pdf')).toBeUndefined()
    expect(findFileType([overriding], 'C:\\docs\\a.pdf')).toBeUndefined()
  })

  it('插件停用 → 同一路径立刻查不到(打开动作回落到内置阅读器)', () => {
    ctxOf('pdf-edit').registerFileType(ft(['.pdf'], true))
    expect(matchFileType('a.pdf')).toBeDefined()
    usePluginStore.getState().disable('pdf-edit')
    expect(matchFileType('a.pdf')).toBeUndefined()
  })
})

describe('显示名:被覆盖的内置类型照旧带后缀', () => {
  it('书.pdf 归了插件也还叫「书.pdf」(树 / 标签页 / 最近使用共用这一个口);插件自己的复合后缀照旧剥掉', () => {
    expect(fileTypeBaseName('资料/书.pdf', ['.pdf'])).toBe('书.pdf')
    expect(fileTypeBaseName('资料/导图.mindmap.md', ['.mindmap.md'])).toBe('导图')
  })
})

describe('③ 毁档防线:页表面只放行 .md 类后缀', () => {
  it('对 x.pdf 调 loadPage 被拒,笔记管线碰不到它;.md 类后缀照常放行', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const load = vi.fn(async () => {})
    const scope = 'plug:ft-override'
    pageStoreFor(scope).setState({ loadPage: load })
    const view = createPluginViewSurface('pdf-edit', scope, ['.pdf', '.deck.md'])
    view.surface.loadPage('论文.pdf')
    expect(load).not.toHaveBeenCalled()
    view.surface.loadPage('卡片.deck.md')
    expect(load).toHaveBeenCalledWith('卡片.deck.md')
    view.dispose()
  })
})

describe('③b 毁档防线:插件够得着的另外两个页加载入口', () => {
  it('页表面:哪怕声明里混着白板后缀,也加载不了白板(页表面拿到的是原始声明时的纵深兜底)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const load = vi.fn(async () => {})
    const scope = 'plug:ft-mixed'
    pageStoreFor(scope).setState({ loadPage: load })
    const view = createPluginViewSurface('mixed', scope, ['.pdf', '.excalidraw.md', '.deck.md'])
    view.surface.loadPage('画板.excalidraw.md')
    view.surface.loadPage('书.pdf')
    expect(load).not.toHaveBeenCalled()
    view.dispose()
  })

  it('ctx.app.loadPage:PDF / 白板被拒,普通笔记与插件自己的 .x.md 照常', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const load = vi.fn(async (_path: string) => {})
    const orig = usePageStore.getState().loadPage
    usePageStore.setState({ loadPage: load })
    try {
      const ctx = ctxOf('pdf-load') // 别复用 'pdf-edit':上面那条把它停用了,偏好留在 localStorage 里
      ctx.app.loadPage('资料/书.pdf')
      ctx.app.loadPage('画板.excalidraw.md')
      expect(load).not.toHaveBeenCalled()
      ctx.app.loadPage('日记.md')
      ctx.app.loadPage('导图.mindmap.md')
      expect(load.mock.calls.map((c) => c[0])).toEqual(['日记.md', '导图.mindmap.md'])
    } finally {
      usePageStore.setState({ loadPage: orig })
    }
  })

  it('ctx.app.openNote:非笔记路径不进笔记编辑器,改走 openFile 开对的视图', async () => {
    nav.openNote.mockClear(); nav.openFile.mockClear()
    const ctx = ctxOf('pdf-open')
    ctx.app.openNote?.('资料/书.pdf')
    await vi.waitFor(() => expect(nav.openFile).toHaveBeenCalledWith('资料/书.pdf'))
    expect(nav.openNote).not.toHaveBeenCalled()
    ctx.app.openNote?.('日记.md', { activate: false })
    await vi.waitFor(() => expect(nav.openNote).toHaveBeenCalledWith('日记.md', { activate: false }))
    expect(nav.openFile).toHaveBeenCalledTimes(1)
  })
})

describe('⑤ 默认打开方式:谁来开可覆盖的内置类型由用户定', () => {
  const a = { pluginId: 'a', item: { ...ft(['.pdf'], true), id: 'a' } }
  const b = { pluginId: 'b', item: { ...ft(['.pdf'], true), id: 'b' } }
  afterEach(() => setFileOpener('.pdf', ''))

  it('没设 = 自动:归先注册的那个接管插件', () => {
    expect(findFileType([a, b], '书.pdf')).toBe(a.item)
    expect(fileOpenerChoice([a, b], '.pdf')).toEqual({ pick: '', pluginIds: ['a', 'b'] })
  })

  it('设成内置:有插件接管也查不到(打开动作落到内置阅读器);别的类型不受影响', () => {
    const other = { pluginId: 'a', item: ft(['.foo']) }
    setFileOpener('.pdf', BUILTIN_OPENER)
    expect(findFileType([a, b, other], '书.pdf')).toBeUndefined()
    expect(findFileType([a, b, other], 'x.foo')).toBe(other.item)
    expect(fileOpenerChoice([a, b], '.pdf').pick).toBe(BUILTIN_OPENER)
    expect(JSON.parse(localStorage.getItem(FILE_OPENERS_KEY)!)).toEqual({ '.pdf': BUILTIN_OPENER })
  })

  it('指定第二个插件:它赢过先注册的', () => {
    setFileOpener('.pdf', 'b')
    expect(findFileType([a, b], '论文/A.PDF')).toBe(b.item)
    expect(fileOpenerChoice([a, b], '.pdf').pick).toBe('b')
  })

  it('指定的插件不在了(停用 / 卸载):打开动作与设置页都回到自动', () => {
    setFileOpener('.pdf', 'b')
    expect(findFileType([a], '书.pdf')).toBe(a.item)
    expect(fileOpenerChoice([a], '.pdf')).toEqual({ pick: '', pluginIds: ['a'] })
    expect(findFileType([], '书.pdf')).toBeUndefined()
  })

  it('改偏好会换一个 fileTypes 引用(订阅它的树 / 菜单 / 文件视图据此重算);别的窗口改的经 syncFileOpeners 跟上', () => {
    ctxOf('pdf-pref').registerFileType(ft(['.pdf'], true))
    const before = usePluginStore.getState().fileTypes
    setFileOpener('.pdf', BUILTIN_OPENER)
    expect(usePluginStore.getState().fileTypes).not.toBe(before)
    expect(matchFileType('a.pdf')).toBeUndefined()
    localStorage.setItem(FILE_OPENERS_KEY, '{}') // 另一个窗口改回了自动
    syncFileOpeners()
    expect(matchFileType('a.pdf')).toBeDefined()
    localStorage.setItem(FILE_OPENERS_KEY, 'not json') // 存坏了按没设算
    syncFileOpeners()
    expect(matchFileType('a.pdf')).toBeDefined()
  })
})

describe('④ 开发副本', () => {
  it('.md 类后缀照旧拒;非 md 后缀(含覆盖 .pdf)可以注册', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ctxOf('dev-md', { dev: true }).registerFileType(ft(['.foo.md']))).toBe(false)
    expect(ctxOf('dev-mixed', { dev: true }).registerFileType(ft(['.pdf', '.foo.md'], true))).toBe(false)
    expect(ctxOf('dev-pdf', { dev: true }).registerFileType(ft(['.pdf'], true))).toBe(true)
  })
})
