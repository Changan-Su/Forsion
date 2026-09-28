import { afterEach, describe, expect, it, vi } from 'vitest'

// 评审 C-10:命令面板的「收藏」「在文件管理器中显示」读 activePage —— v4 统一页不设 activePage,两条对 v4 笔记静默无效。
const reveal = vi.fn((_p: string) => Promise.resolve())
vi.mock('@amadeus/api', () => ({ amadeus: { revealInFileManager: (p: string) => reveal(p), reindex: () => Promise.resolve() } }))

const { CMDS } = await import('./amadeusCommands')
const { usePageStore } = await import('@amadeus/store/pageStore')
const { useAmadeusPrefs } = await import('./amadeusPrefs')

const run = (id: string): void => { void CMDS.find((c) => c.id === id)!.run() }

describe('note commands act on the v4 note of the active pane', () => {
  afterEach(() => { reveal.mockClear() })
  it('reveal in file manager uses activeNotePath when there is no activePage', () => {
    usePageStore.setState({ activePage: null, activeNotePath: 'notes/V4.md' })
    run('amadeus-reveal')
    expect(reveal).toHaveBeenCalledWith('notes/V4.md')
  })
  it('toggle star uses activeNotePath when there is no activePage', () => {
    const toggle = vi.spyOn(useAmadeusPrefs.getState(), 'toggleStar').mockImplementation(() => {})
    usePageStore.setState({ activePage: null, activeNotePath: 'notes/V4.md' })
    run('amadeus-toggle-star')
    expect(toggle).toHaveBeenCalledWith('notes/V4.md')
    toggle.mockRestore()
  })
})
