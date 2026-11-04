// @vitest-environment happy-dom
/** 工作区文件预览里的本机 .pdf 听「默认打开方式」(2026-11-04):插件认领了库外 PDF(声明 external)→ openFile 进它的视图;
 *  没认领照旧 wsfile;远程会话的文件没有 path,不走这条;别的后缀照旧同步开。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  panels: [] as Array<{ id: string; params: Record<string, unknown> }>,
  openView: vi.fn(), activate: vi.fn(), openFile: vi.fn(), claimed: false,
  match: vi.fn(),
}))
vi.mock('@lcl/engine', () => ({ useWorkspace: { getState: () => ({ api: { panels: m.panels }, openView: m.openView, activateLeaf: m.activate }) } }))
vi.mock('../builtins', () => ({ openLocalHtml: () => false }))
vi.mock('../services/fileKinds', () => ({ b64ToBytes: () => new Uint8Array() }))
vi.mock('../amadeus/plugins/pluginStore', () => ({ matchFileType: m.match }))
vi.mock('../amadeusNav', () => ({ openFile: m.openFile }))
import { openWsFile } from './wsFileNav'

const settle = () => new Promise((r) => setTimeout(r, 0))
const target = (path?: string) => ({ name: path?.split('/').pop() ?? 'x.pdf', path, load: async () => null })

beforeEach(() => {
  vi.clearAllMocks()
  m.panels = []
  m.match.mockImplementation(() => (m.claimed ? { id: 'pdf' } : undefined))
  m.claimed = false
})

describe('openWsFile × 本机 PDF', () => {
  it('插件认领了 → openFile(绝对路径),不开 wsfile', async () => {
    m.claimed = true
    openWsFile(target('/Users/a/Desktop/Book.PDF'), { newTab: true })
    await settle()
    expect(m.match).toHaveBeenCalledWith('/Users/a/Desktop/Book.PDF')
    expect(m.openFile).toHaveBeenCalledWith('/Users/a/Desktop/Book.PDF', { newTab: true })
    expect(m.openView).not.toHaveBeenCalled()
  })
  it('没认领 → 照旧 wsfile 标签', async () => {
    openWsFile(target('/Users/a/Desktop/Book.pdf'))
    await settle()
    expect(m.openFile).not.toHaveBeenCalled()
    expect(m.openView).toHaveBeenCalledWith('wsfile', { path: '/Users/a/Desktop/Book.pdf', name: 'Book.pdf' }, 'main', { newTab: true })
  })
  it('没认领、同一份已开着 → 聚焦那个标签', async () => {
    m.panels = [{ id: 'p1', params: { __type: 'wsfile', path: '/Users/a/Book.pdf' } }]
    openWsFile(target('/Users/a/Book.pdf'))
    await settle()
    expect(m.activate).toHaveBeenCalledWith('p1')
    expect(m.openView).not.toHaveBeenCalled()
  })
  it('远程会话的文件(没有 path)→ 瞬态 wsfile,不查插件', async () => {
    m.claimed = true
    openWsFile(target(undefined))
    await settle()
    expect(m.match).not.toHaveBeenCalled()
    expect(m.openView).toHaveBeenCalledWith('wsfile', expect.objectContaining({ tkey: expect.any(String) }), 'main', { newTab: true })
  })
  it('别的后缀照旧同步开(不多等一拍)', () => {
    m.claimed = true
    openWsFile(target('/Users/a/notes.txt'))
    expect(m.openView).toHaveBeenCalledWith('wsfile', { path: '/Users/a/notes.txt', name: 'notes.txt' }, 'main', { newTab: true })
    expect(m.match).not.toHaveBeenCalled()
  })
})
