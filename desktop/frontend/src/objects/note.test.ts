// 库内文件对象的菜单在各处长什么样 + 删除的执行边界(LCL 对象层第一期)。
// 钉住:树上笔记 / 资源 / 多选 / 笔记「⋯」各列哪几项;删除只确认一次、用对 store;
// 改名后旧路径被新文件占了,弹菜单时那个文件已经不在 → 不删新文件。
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  deleteNoteFlow: vi.fn(async (_p: string, _store: unknown, _o?: unknown) => true),
  canTrash: vi.fn(() => true),
  openVaultFile: vi.fn(async () => {}),
  reveal: vi.fn(async () => {}),
  openNote: vi.fn(), openPdf: vi.fn(), openFile: vi.fn(),
  fileTypes: [] as Array<{ extensions: string[] }>,
  starred: [] as string[],
  scopedDelete: vi.fn(async () => {}),
}))

vi.mock('@amadeus/store/pageStore', async () => {
  const { create: mk } = await import('zustand')
  const usePageStore = mk(() => ({ pages: [] as string[], files: [] as string[], vaultSide: 'local', vaultRoot: '/v', deletePage: vi.fn(async () => {}) }))
  return { usePageStore, pageStoreFor: (_scope: string) => ({ getState: () => ({ ...usePageStore.getState(), deletePage: h.scopedDelete }) }) }
})
vi.mock('@amadeus/api', () => ({ amadeus: { openVaultFile: h.openVaultFile, revealInFileManager: h.reveal } }))
vi.mock('@amadeus/plugins/pluginStore', () => ({
  usePluginStore: { getState: () => ({ fileTypes: h.fileTypes }) },
  findFileType: (types: Array<{ extensions: string[] }>, p: string) => types.find((t) => t.extensions.some((e) => p.endsWith(e))),
}))
vi.mock('@amadeus-shared/dashboard', () => ({ isDashboardPath: (p: string) => p.endsWith('.dashboard.md') }))
vi.mock('../amadeusNav', () => ({ openNote: h.openNote, openDb: vi.fn(), openPdf: h.openPdf, openImage: vi.fn(), openDrawing: vi.fn(), openDashboard: vi.fn(), openFile: h.openFile }))
vi.mock('../amadeusPrefs', () => ({ useAmadeusPrefs: { getState: () => ({ starred: h.starred, toggleStar: vi.fn() }) } }))
vi.mock('../stores/entrySyncStore', () => ({ isSyncedEntry: () => false }))
vi.mock('../components/CloudSyncDialog', () => ({ openCloudSyncDialog: vi.fn() }))
vi.mock('../noteDelete', () => ({
  canTrash: h.canTrash, deleteNoteFlow: h.deleteNoteFlow,
  deleteNoteMsg: (p: string) => `删除笔记「${p}」？`, deleteFileMsg: (p: string) => `删除文件「${p}」？`,
}))

import { buildObjectMenu, executeAction, freezeRefs, setObjectHost, type ObjectCaps, type Place } from '@lcl/engine'
import { usePageStore } from '@amadeus/store/pageStore'
import { installNoteObject, noteRef, noteSheetRows } from './note'

const CAPS: ObjectCaps = { openWindow: true, desktopShortcut: true, pinHome: false, revealFile: true, singleColumn: false }
let caps = CAPS
const confirm = vi.fn(async (_req: unknown) => true)
const report = vi.fn()
const setFiles = (pages: string[], files: string[] = []): void => { (usePageStore as unknown as { setState: (p: object) => void }).setState({ pages, files }) }

beforeAll(() => {
  setObjectHost({ caps: () => caps, confirm, report })
  installNoteObject()
})
beforeEach(() => {
  caps = CAPS
  h.fileTypes = []; h.starred = []
  for (const f of [confirm, report, h.deleteNoteFlow, h.scopedDelete, h.openVaultFile, h.openPdf, h.openFile]) f.mockClear()
  h.canTrash.mockReturnValue(true)
  setFiles(['A.md', 'B.md', 'Board.dashboard.md'], ['doc.pdf', 'data.db', 'pic.png', 'notes.zip'])
})

const TREE: Place = { kind: 'tree' }
const ids = (paths: string[], place: Place = TREE, here: string[] = []): string[][] =>
  buildObjectMenu({ refs: paths.map(noteRef), place, placeSections: here.length ? [{ items: here.map((id) => ({ id, label: id })) }] : [] })
    .sections.map((s) => s.items.map((i) => i.id))
const labels = (paths: string[], place: Place = TREE): string[] =>
  buildObjectMenu({ refs: paths.map(noteRef), place }).sections.flatMap((s) => s.items.map((i) => i.label))

describe('库内文件的菜单', () => {
  it('树上的笔记:新标签页打开 | 收藏 | 本处(新建子笔记、重命名) | 在文件管理器中显示、复制路径 | 删除', () => {
    expect(ids(['A.md'], TREE, ['new-child', 'rename'])).toEqual([
      ['note.openInNewTab'], ['note.star'], ['new-child', 'rename'], ['note.reveal', 'note.copyPath'], ['note.delete'],
    ])
    expect(labels(['A.md'])).toEqual(['在新标签页打开', '收藏', '在文件管理器中显示', '复制路径', '删除'])
  })

  it('PDF 被插件接管:打开 / 用内置阅读器打开 / 用系统程序打开;没接管就没有内置阅读器那条', () => {
    h.fileTypes = [{ extensions: ['.pdf'] }]
    expect(ids(['doc.pdf'])[0]).toEqual(['note.open', 'note.openBuiltinReader', 'note.openWithSystem'])
    h.fileTypes = []
    expect(ids(['doc.pdf'])[0]).toEqual(['note.open', 'note.openWithSystem'])
  })

  it('认不出的附件:「打开」就是交系统程序,不再重复一条', () => {
    expect(ids(['notes.zip'])[0]).toEqual(['note.open'])
  })

  it('笔记「⋯」:不列打开(这篇已经开着),删除叫「删除笔记」', () => {
    const more: Place = { kind: 'note-more', container: 'leaf-1' }
    expect(ids(['A.md'], more)).toEqual([['note.star'], ['note.reveal', 'note.copyPath'], ['note.delete']])
    expect(labels(['A.md'], more).at(-1)).toBe('删除笔记')
  })

  it('多选:只有对整批说得通的两件(在新标签页打开 N 项、删除 N 项)', () => {
    expect(labels(['A.md', 'doc.pdf'])).toEqual(['在新标签页打开 2 项', '删除 2 项'])
  })

  it('宿主没有文件管理器(手机本地库):不列「在文件管理器中显示」', () => {
    caps = { ...CAPS, revealFile: false, singleColumn: true }
    expect(ids(['A.md']).flat()).not.toContain('note.reveal')
  })

  it('手机 sheet 的行:同一份动作,收藏开着时高亮', () => {
    h.starred = ['A.md']
    const rows = noteSheetRows('A.md', { kind: 'note-more', container: 'leaf-1' })
    expect(rows.map((r) => r.id)).toEqual(['note.star', 'note.reveal', 'note.copyPath', 'note.delete'])
    expect(rows[0]).toMatchObject({ label: '取消收藏', on: true })
    expect(rows.at(-1)).toMatchObject({ label: '删除笔记', danger: true })
  })
})

describe('删除', () => {
  it('有回收站的单个删除不问;笔记走 deleteNoteFlow 且告诉它「已确认」,用「⋯」所在面板那份 store', async () => {
    const [r] = await executeAction('note.delete', [noteRef('A.md')], { place: { kind: 'note-more', container: 'leaf-1' }, caps })
    expect(r).toMatchObject({ ok: true })
    expect(confirm).not.toHaveBeenCalled()
    expect(h.deleteNoteFlow).toHaveBeenCalledTimes(1)
    expect(h.deleteNoteFlow.mock.calls[0]?.[2]).toEqual({ confirmed: true })
    const store = h.deleteNoteFlow.mock.calls[0]?.[1] as () => { deletePage: unknown }
    expect(store().deletePage).toBe(h.scopedDelete)
  })

  it('没有回收站:问一次(笔记的文案),之后流程里不再问', async () => {
    h.canTrash.mockReturnValue(false)
    await executeAction('note.delete', [noteRef('A.md')], { place: TREE, caps })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ title: '删除笔记「A.md」？', danger: true })
    expect(h.deleteNoteFlow.mock.calls[0]?.[2]).toEqual({ confirmed: true })
  })

  it('多选删除:先问一次,笔记走笔记流程、其它文件直接删', async () => {
    const del = vi.fn(async () => {})
    ;(usePageStore as unknown as { setState: (p: object) => void }).setState({ deletePage: del })
    const rs = await executeAction('note.delete', [noteRef('A.md'), noteRef('doc.pdf')], { place: TREE, caps })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(h.deleteNoteFlow).toHaveBeenCalledWith('A.md', expect.any(Function), { confirmed: true })
    expect(del).toHaveBeenCalledWith('doc.pdf')
  })

  it('附件对话框里取消 = 这一项取消,不报错', async () => {
    h.deleteNoteFlow.mockResolvedValueOnce(false)
    const [r] = await executeAction('note.delete', [noteRef('A.md')], { place: TREE, caps })
    expect(r).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(report).not.toHaveBeenCalled()
  })

  it('改名后旧路径被新文件占了:弹菜单时冻结的是旧文件 → 不删新文件', async () => {
    const frozen = freezeRefs([noteRef('A.md')])
    setFiles(['B.md', 'A renamed.md'], []) // A.md 改名走了
    setFiles(['B.md', 'A renamed.md', 'A.md'], []) // 又有一篇新的 A.md
    const [r] = await executeAction('note.delete', frozen, { place: TREE, caps })
    expect(r.ok).toBe(false)
    expect(h.deleteNoteFlow).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('弹菜单之后换了库(另一个库里也有 A.md):不动另一个库的文件', async () => {
    const frozen = freezeRefs([noteRef('A.md')])
    ;(usePageStore as unknown as { setState: (p: object) => void }).setState({ vaultRoot: '/w' })
    try {
      const [r] = await executeAction('note.delete', frozen, { place: TREE, caps })
      expect(r).toMatchObject({ ok: false, reason: '已经换了智库，请重新打开菜单再试' })
      expect(h.deleteNoteFlow).not.toHaveBeenCalled()
    } finally {
      ;(usePageStore as unknown as { setState: (p: object) => void }).setState({ vaultRoot: '/v' })
    }
  })

  it('批量删两项、其中一项已被别处删掉:剩下那项照样先问(按当初选了几个算)', async () => {
    const frozen = freezeRefs([noteRef('A.md'), noteRef('B.md')])
    setFiles(['A.md', 'Board.dashboard.md'], ['doc.pdf'])
    const rs = await executeAction('note.delete', frozen, { place: TREE, caps })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(rs.find((r) => r.ref.id === 'A.md')).toMatchObject({ ok: true })
    expect(rs.find((r) => r.ref.id === 'B.md')).toMatchObject({ ok: false })
  })

  it('弹菜单之后文件被删了:不执行,报「已经不在了」', async () => {
    const frozen = freezeRefs([noteRef('A.md')])
    setFiles(['B.md'], [])
    const [r] = await executeAction('note.delete', frozen, { place: TREE, caps })
    expect(r).toMatchObject({ ok: false, reason: '这个文件已经不在了' })
    expect(h.deleteNoteFlow).not.toHaveBeenCalled()
  })
})
