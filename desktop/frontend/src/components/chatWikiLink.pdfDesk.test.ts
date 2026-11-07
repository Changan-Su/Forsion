// @vitest-environment happy-dom
/** 对话里的文件引用条点开本机 .pdf、Desk 收文件时(对话旁那一格):插件认领了 → 那一格开插件视图;没认领照旧 wsfile。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ show: vi.fn(), match: vi.fn(), rel: null as string | null }))
vi.mock('../stores/appStore', () => ({
  useApp: { getState: () => ({ activeId: 's1', desktopConfig: { agentDeskEnabled: true }, deskBySession: {}, deskShowFile: m.show }) },
}))
vi.mock('../services/engine/targets', () => ({ refForSession: () => ({ kind: 'local' }) }))
vi.mock('../amadeus/plugins/deskCompanion', () => ({ deskAcceptsFiles: () => true }))
vi.mock('../amadeus/plugins/pluginStore', () => ({ matchFileType: m.match }))
vi.mock('../openFileInstall', () => ({ vaultRelOf: () => m.rel }))
vi.mock('../amadeus/store/pageStore', () => ({ usePageStore: Object.assign(() => null, { getState: () => ({}) }) }))
import { openFileCitation } from './ChatWikiLink'

beforeEach(() => { vi.clearAllMocks(); m.rel = null })

describe('openFileCitation × Desk × 本机 PDF', () => {
  it('插件认领了 → 那一格开 amadeus-plugin-file', async () => {
    m.match.mockReturnValue({ id: 'pdf' })
    await openFileCitation('/Users/a/Book.pdf', 'Book.pdf', null)
    expect(m.show).toHaveBeenCalledWith('s1', '/Users/a/Book.pdf', { type: 'amadeus-plugin-file', params: { filePath: '/Users/a/Book.pdf' } })
  })
  it('库里的那份:那一格按库内路径开插件视图', async () => {
    m.match.mockReturnValue({ id: 'pdf' })
    m.rel = 'Papers/Book.pdf'
    await openFileCitation('/Users/a/Vault/Papers/Book.pdf', 'Book.pdf', null)
    expect(m.match).toHaveBeenCalledWith('Papers/Book.pdf')
    expect(m.show).toHaveBeenCalledWith('s1', '/Users/a/Vault/Papers/Book.pdf', { type: 'amadeus-plugin-file', params: { filePath: 'Papers/Book.pdf' } })
  })
  it('没认领 → 照旧 wsfile', async () => {
    m.match.mockReturnValue(undefined)
    await openFileCitation('/Users/a/Book.pdf', 'Book.pdf', null)
    expect(m.show).toHaveBeenCalledWith('s1', '/Users/a/Book.pdf', { type: 'wsfile', params: { path: '/Users/a/Book.pdf', name: 'Book.pdf' } })
  })
  it('别的后缀不查插件', async () => {
    await openFileCitation('/Users/a/a.ts', 'a.ts', { from: 3 } as never)
    expect(m.match).not.toHaveBeenCalled()
    expect(m.show).toHaveBeenCalledWith('s1', '/Users/a/a.ts', { type: 'wsfile', params: { path: '/Users/a/a.ts', name: 'a.ts', line: 3 } })
  })
})
