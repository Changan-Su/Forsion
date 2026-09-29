/** 新建入口统一素文件出生(评审 G4-12):快切「新建」(createWikiPage)、未解析链接确认(confirmWikiCreate 的
 *  路径限定 / .fd 子笔记两支)、/page 与「新建子笔记」(createChildNote)、笔记视图加行(noteViewStore.addNote)
 *  此前都调 `amadeus.newPage`,生出 v3(amadeus_page 三键 + `<!-- a 1 -->`),还绕开 openNote 门面直装 v3 store。
 *  契约:一律 writeTextFile(path, '', {create, base}) 出生、绝不调 newPage;磁盘上已有同名 → 不写,只打开。 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const disk = new Map<string, string>()
const writes: Array<{ path: string; text: string; opts?: { create?: boolean; base?: string } }> = []
const dispatched: Array<{ type: string; path?: string; text?: string }> = []
/** 宿主写口的行为开关:'ok' = 仅新建语义照常建;'raced' = 读后写前别处刚建了同名(交回现文);'failed' = 没建成且拿不出现文;
 *  'throw' = 写抛错。 */
let hostMode: 'ok' | 'raced' | 'failed' | 'throw' = 'ok'
const newPage = vi.fn(async () => {
  throw new Error('新建入口不许再走 newPage(v3 出生)')
})
const loadPage = vi.fn(async (path: string) => ({
  manifest: {
    schema: 'amadeus.page/3', id: 'pg_t', title: path, createdAt: '', updatedAt: '',
    compiler: { version: 't' }, root: { type: 'stack', children: [] }, blocks: {},
  },
  blocks: {},
}))

async function fresh(opts: { hostNavigates?: boolean } = {}) {
  vi.resetModules()
  disk.clear()
  writes.length = 0
  dispatched.length = 0
  hostMode = 'ok'
  newPage.mockClear()
  loadPage.mockClear()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; defaultPrevented = false
    constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail }
    preventDefault() { this.defaultPrevented = true }
  })
  vi.stubGlobal('window', {
    amadeus: {
      readTextFile: async (p: string) => disk.get(p) ?? null,
      writeTextFile: async (p: string, text: string, o?: { create?: boolean; base?: string }) => {
        writes.push({ path: p, text, opts: o })
        if (hostMode === 'throw') throw new Error('EACCES: permission denied')
        if (hostMode === 'failed') return { ok: false, current: null }
        if (hostMode === 'raced') { disk.set(p, '# 别处刚建的\n'); return { ok: false, current: '# 别处刚建的\n' } }
        disk.set(p, text)
        return o?.create ? { ok: true } : undefined
      },
      newPage,
      loadPage,
      listPages: async () => [...disk.keys()].filter((k) => k.endsWith('.md')),
      listFolders: async () => [],
      listFiles: async () => [...disk.keys()],
      backlinks: async () => [],
      listPageProps: async () => [],
      setPageFrontmatter: async () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (e: { type: string; detail?: { path?: string; text?: string }; defaultPrevented: boolean }) => {
      dispatched.push({ type: e.type, path: e.detail?.path, ...(e.detail?.text ? { text: e.detail.text } : {}) })
      return opts.hostNavigates ? false : !e.defaultPrevented
    },
  })
  const ps = await import('./pageStore')
  ps.usePageStore.setState({ vaultRoot: '/v', pages: [], files: [], folders: [], status: 'ready' })
  return ps
}

afterEach(() => { vi.unstubAllGlobals() })

const bornPlain = (path: string) => {
  const w = writes.find((x) => x.path === path)
  expect(w, `${path} 应经 writeTextFile 出生`).toBeTruthy()
  expect(w!.text).toBe('') // 素文件:零 frontmatter 零块标记
  expect(w!.opts?.create).toBe(true)
  expect(typeof w!.opts?.base).toBe('string') // 比对交换写:别处刚建了同名有内容的文件时不覆盖
}

describe('G4-12 新建入口素文件出生', () => {
  it('快切「新建」createWikiPage:素文件 + 交给宿主 openNote 门面导航,不直装 v3 store', async () => {
    const { usePageStore, claimTitleFocus } = await fresh({ hostNavigates: true })
    await usePageStore.getState().createWikiPage('Quick New')
    expect(newPage).not.toHaveBeenCalled()
    bornPlain('Quick New.md')
    expect(dispatched).toContainEqual({ type: 'amadeus:navigate-note', path: 'Quick New.md' })
    expect(loadPage).not.toHaveBeenCalled()
    expect(usePageStore.getState().activePage).not.toBe('Quick New.md') // 没有绕开门面直装 v3 快照
    expect(claimTitleFocus('Quick New.md')).toBe(true) // 新建 = 先命名
  })

  it('未解析链接确认:路径限定 → 按路径出生;裸名 + 源笔记 → .fd 子笔记出生,都走门面', async () => {
    const { usePageStore } = await fresh({ hostNavigates: true })
    usePageStore.setState({ pendingWikiCreate: { name: 'dir/Deep', sourcePath: null } })
    await usePageStore.getState().confirmWikiCreate()
    bornPlain('dir/Deep.md')
    usePageStore.setState({ pages: ['Parent.md'], pendingWikiCreate: { name: 'Kid', sourcePath: 'Parent.md' } })
    await usePageStore.getState().confirmWikiCreate()
    bornPlain('Parent.fd/Kid.md')
    expect(newPage).not.toHaveBeenCalled()
    expect(dispatched.filter((d) => d.type === 'amadeus:navigate-note').map((d) => d.path)).toEqual(['dir/Deep.md', 'Parent.fd/Kid.md'])
    expect(loadPage).not.toHaveBeenCalled()
  })

  it('/page 与「新建子笔记」createChildNote:素文件出生', async () => {
    const { usePageStore } = await fresh()
    usePageStore.setState({ pages: ['A.md'] })
    const p = await usePageStore.getState().createChildNote('A.md', 'Child')
    expect(p).toBe('A.fd/Child.md')
    bornPlain('A.fd/Child.md')
    expect(newPage).not.toHaveBeenCalled()
  })

  it('笔记视图加行 addNote:素文件出生', async () => {
    await fresh()
    const { useNoteViewStore } = await import('./noteViewStore')
    const p = await useNoteViewStore.getState().addNote('Folder')
    bornPlain(p)
    expect(newPage).not.toHaveBeenCalled()
  })

  it('磁盘上已有同名(pages[] 落后)→ 不写不覆盖,只打开、不抢标题焦点', async () => {
    const { usePageStore, claimTitleFocus } = await fresh({ hostNavigates: true })
    disk.set('Exists.md', '# 已有内容\n')
    await usePageStore.getState().createWikiPage('Exists')
    expect(writes).toEqual([])
    expect(disk.get('Exists.md')).toBe('# 已有内容\n')
    expect(dispatched).toContainEqual({ type: 'amadeus:navigate-note', path: 'Exists.md' })
    expect(claimTitleFocus('Exists.md')).toBe(false)
  })

  // Codex 复核返修 P1-1:宿主的 create = 原子仅新建。只有「交回了现文」才算已存在;没建成又拿不出现文 / 写抛错 = 失败:
  // 提示,**不导航**到一篇不存在的笔记(上一轮的回归:新建被宿主拒掉,却按已存在打开)。
  // 负对照(实跑过):birthNoteFile 换回「ok:false 一律 exists」→ failed / throw 两条红。
  it('读后写前别处刚建了同名(宿主交回现文)→ 按已存在打开,不抢标题焦点', async () => {
    const { usePageStore, claimTitleFocus } = await fresh({ hostNavigates: true })
    hostMode = 'raced'
    await usePageStore.getState().createWikiPage('Raced')
    expect(dispatched).toContainEqual({ type: 'amadeus:navigate-note', path: 'Raced.md' })
    expect(claimTitleFocus('Raced.md')).toBe(false)
  })
  for (const mode of ['failed', 'throw'] as const) {
    it(`宿主没建成(${mode === 'failed' ? 'current:null' : '写抛错'})→ 提示,不导航、不抢标题;子笔记 / 笔记视图加行抛错不交出路径`, async () => {
      const { usePageStore, claimTitleFocus, birthNoteFile } = await fresh({ hostNavigates: true })
      hostMode = mode
      expect(await birthNoteFile('Nope.md')).toBe('failed')
      await usePageStore.getState().createWikiPage('Nope2')
      expect(dispatched.some((d) => d.type === 'amadeus:navigate-note')).toBe(false)
      expect(dispatched.filter((d) => d.type === 'amadeus:toast' && d.text?.includes('Nope'))).toHaveLength(2)
      expect(claimTitleFocus('Nope2.md')).toBe(false)
      usePageStore.setState({ pages: ['A.md'] })
      await expect(usePageStore.getState().createChildNote('A.md', 'Child')).rejects.toThrow(/create failed/)
      const { useNoteViewStore } = await import('./noteViewStore')
      await expect(useNoteViewStore.getState().addNote('Folder')).rejects.toThrow(/create failed/)
    })
  }
})
