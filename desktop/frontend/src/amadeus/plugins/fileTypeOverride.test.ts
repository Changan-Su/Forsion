// @vitest-environment happy-dom
/**
 * 可覆盖的内置文件类型(2026-10-05 用户定:内置视图是兜底,插件可以覆盖;目前只放开 `.pdf`)。
 * 钉四件事:
 *  ① 注册:可覆盖后缀 + 显式 override: true 才收;不写 override 照旧拒;不可覆盖的内置后缀写了 override 也拒。
 *  ② 查表:findFileType 对可覆盖后缀只认 override 贡献;插件一停,同一路径立刻查不到(= 回落内置)。
 *  ③ 毁档防线:页表面的 loadPage 只放行 `.md` 类后缀 —— 插件对 `x.pdf` 调 loadPage 必须被拒
 *     (放行 = PDF 被拽进笔记管线,一存就是 markdown)。
 *  ④ 开发副本:`.md` 类后缀照旧拒(笔记管线不保护开发根),非 md 后缀可以注册。
 * 负对照(2026-10-05 实跑):findFileType 去掉 `o.item.override === true` → ② 红;viewSurface 去掉 `.md` 过滤 → ③ 红;
 * registerFileType 的 taken() 去掉 override 判定 → ① 红。
 */
import { createContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ amadeus: undefined }))
vi.mock('../components/BlockHost', () => ({ BlockHost: () => null, BlockSurfaceContext: createContext(null) }))
vi.mock('../components/PageView', () => ({ PageView: () => null }))
vi.mock('../chrome/pageChrome', () => ({ NoteCover: () => null }))
vi.mock('../../amadeusViews', () => ({ Breadcrumb: () => null, NoteTitle: () => null }))
vi.mock('../../amadeusProperties', () => ({ AmadeusPropertiesPanel: () => null }))

const { usePluginStore, findFileType, matchFileType, fileTypeBaseName } = await import('./pluginStore')
const { createPluginViewSurface } = await import('./viewSurface')
const { pageStoreFor } = await import('../store/pageStore')
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

describe('④ 开发副本', () => {
  it('.md 类后缀照旧拒;非 md 后缀(含覆盖 .pdf)可以注册', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ctxOf('dev-md', { dev: true }).registerFileType(ft(['.foo.md']))).toBe(false)
    expect(ctxOf('dev-mixed', { dev: true }).registerFileType(ft(['.pdf', '.foo.md'], true))).toBe(false)
    expect(ctxOf('dev-pdf', { dev: true }).registerFileType(ft(['.pdf'], true))).toBe(true)
  })
})
