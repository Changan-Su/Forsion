import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  page: { vaultSide: 'local', vaultRoot: 'C:\\Vault' } as { vaultSide: string; vaultRoot: string },
  panels: [] as Array<{ id: string; params: Record<string, unknown> }>,
  activate: vi.fn(), note: vi.fn(), file: vi.fn(), external: vi.fn(),
}))
vi.mock('@lcl/engine', () => ({ useWorkspace: { getState: () => ({ api: { panels: m.panels }, activateLeaf: m.activate }) } }))
vi.mock('@amadeus/store/pageStore', () => ({ usePageStore: { getState: () => m.page } }))
vi.mock('./amadeusNav', () => ({ openNote: m.note, openFile: m.file, opensAsTab: () => true }))
vi.mock('./views/wsFileNav', () => ({ openWsFile: m.external, hostTargetFor: (path: string) => path }))
vi.mock('./deepLinkInstall', () => ({ whenWorkspaceReady: async () => {} }))
vi.mock('./amadeusPlugins', () => ({ ensureAmadeusReady: () => {}, whenAmadeusPluginsReady: async () => {} }))
vi.mock('./windowKind', () => ({ windowKind: () => 'main' }))
import { openExternalFile } from './openFileInstall'

beforeEach(() => {
  vi.clearAllMocks()
  m.page = { vaultSide: 'local', vaultRoot: 'C:\\Vault' }
  m.panels = [{ id: 'existing', params: { notePath: 'Folder/Inside.md' } }]
})
describe('system file open identity', () => {
  it('reuses a Windows note after its absolute path changes case and separators', () => {
    openExternalFile('c:\\vault\\folder\\inside.md')
    expect(m.activate).toHaveBeenCalledWith('existing')
    expect(m.note).not.toHaveBeenCalled()
    expect(m.external).not.toHaveBeenCalled()
  })
  it('reuses a Windows PDF with the same case-insensitive identity', () => {
    m.panels = [{ id: 'pdf', params: { pdfPath: 'Folder/Document.pdf' } }]
    openExternalFile('c:/vault/FOLDER/document.PDF')
    expect(m.activate).toHaveBeenCalledWith('pdf')
    expect(m.file).not.toHaveBeenCalled()
  })
  it('recognizes case-insensitive UNC vault roots', () => {
    m.page.vaultRoot = '\\\\Server\\Share\\Vault'
    openExternalFile('\\\\server\\SHARE\\vault\\folder\\inside.md')
    expect(m.activate).toHaveBeenCalledWith('existing')
    expect(m.external).not.toHaveBeenCalled()
  })
  it('keeps distinct paths on case-sensitive filesystems', () => {
    m.page.vaultRoot = '/vault'
    openExternalFile('/vault/folder/inside.md')
    expect(m.activate).not.toHaveBeenCalled()
    expect(m.note).toHaveBeenCalledWith('folder/inside.md', { newTab: true })
  })
  it('does not confuse a label with a path or a sibling vault with this vault', () => {
    m.panels = [{ id: 'unrelated', params: { name: 'Folder/Inside.md', filePath: 'Other.md' } }]
    openExternalFile('C:/Vault/Folder/Inside.md')
    expect(m.activate).not.toHaveBeenCalled()
    expect(m.note).toHaveBeenCalledOnce()
    openExternalFile('C:/Vault-other/Folder/Inside.md')
    expect(m.external).toHaveBeenCalledWith('C:/Vault-other/Folder/Inside.md')
  })
  it('does not match a local path against a cloud vault', () => {
    m.page.vaultSide = 'cloud'
    openExternalFile('C:/Vault/Folder/Inside.md')
    expect(m.activate).not.toHaveBeenCalled()
    expect(m.external).toHaveBeenCalled()
  })
})

it('system Open With sends an external PDF through the default opener without a vault', () => {
  m.page.vaultRoot = ''
  openExternalFile('C:\\Downloads\\Paper.PDF')
  expect(m.file).toHaveBeenCalledWith('C:/Downloads/Paper.PDF', { newTab: true })
  expect(m.external).not.toHaveBeenCalled()
})

it('reuses an external PDF tab when Open With is repeated', () => {
  m.page.vaultRoot = ''
  m.panels = [{ id: 'external-pdf', params: { filePath: 'C:/Downloads/Paper.PDF' } }]
  openExternalFile('c:\\downloads\\paper.pdf')
  expect(m.activate).toHaveBeenCalledWith('external-pdf')
  expect(m.file).not.toHaveBeenCalled()
})
